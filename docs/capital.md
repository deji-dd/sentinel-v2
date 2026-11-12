# Blasted Stocks

Managed Torn City stock trading fund. Code prefix: `capital`. Host: `stocks.blasted-labs.tech`. The existing `/stocks` dashboard page is unrelated (market alerts).

## Surfaces

- `/` — public fund page: **Live** and **Simulation** tabs. Live shows NAV, current positions with marked-to-market P/L, recent live fills and the fee schedule; Simulation shows simulated NAV, current positions with P/L, test-investor results (no cadence/payout columns) and fills. The legacy `/paper` link still opens the Simulation tab.
- `/portfolio` — Discord-authenticated investor view: lots, payouts, withdrawals.
- `/desk` — owner/admin desk with **Live** and **Simulation** tabs. Live has cash/deployed cards, open positions with frozen stops/targets, open orders (accept/cancel), investor, deposit, payout, withdrawal, risk-overlay and settings controls. Simulation has a permanent `SIMULATION` banner, the same positions/orders/risk cards, a **Send test alert** button and the reset control. The legacy `/desk/paper` link still opens the Simulation tab.

The app lives in `web/stocks`. The API serves it by `Host` header from `services/api/src/middleware/static-spa.ts`; DNS/TLS for the subdomain is an external deployment prerequisite.

All three surfaces stay live over `/api/ws/capital` (`view=public|portfolio|admin`, `book=live|paper`). The socket pushes a fresh snapshot every 10 seconds and on connect; the page header shows the connection state and last-updated time, so there is no refresh button. The initial REST load remains the fallback when the socket is reconnecting.

## Data and accounting

- `capital_books` + `capital_book_configs`: live/paper books and typed settings.
- `capital_investors`, `capital_investor_contacts`, `capital_investments`: one **lot per deposit**; multiple deposits are expected. Cadence (`frequency`) and profit handling (`payout_mode`, `cash` or `reinvest`) are investor-level settings; every new lot inherits them, and changing them updates the investor's active lots. Live investors are `user`/`faction`/`operator` and require a Torn ID; paper investors are `test` only and may omit the Torn ID.
- `capital_transactions`: append-only signed cash ledger; `capital_positions` is a rebuildable materialized view.
- `capital_orders`, `capital_fills`, `capital_order_outcomes`: recommendations, execution, and variance.
- `capital_payout_obligations`, `capital_withdrawal_requests`: profit distributions and capital exits.
- `capital_payment_intents`: reference-coded money-transfer verification.
- `capital_nav_snapshots`: public/admin charts.
- `capital_market_latest`, `capital_market_candles`: global Torn price data.
- `capital_reconciliation_issues`, `capital_access`, `capital_audit_log`, `capital_smoke_reports`.

NAV is `(cash + positions at last price) / units`. A deposit issues units at the pre-deposit NAV. Payouts distribute NAV gains above a lot's high-water mark and charge the lot's cadence fee. A `cash` lot redeems units for the net cash paid; a `reinvest` lot compounds the net payout back into the lot (principal rises, the fee is booked to the owner, and no in-game transfer is needed).

Payout dates are shared per cadence: daily at 00:00 UTC, weekly Monday 00:00 UTC, monthly on the 1st at 00:00 UTC. New deposits and post-payout rescheduling use the same aligned calendar; migration `0074` backfilled existing active lots.

Withdrawals are quoted first; the performance fee applies only to a positive profit portion and is waived on a loss, with an optional exit fee (default 0).

## Workers

- `capital:engine` — every 60s: `/torn/stocks`, 1m/5m/60m candles, share-level signals, recommendations, paper auto-fill, one rotating detail refresh per cycle.
- `capital:history` — hourly check that seeds missing stock history once on a fresh deploy, then idles. Disable with `CAPITAL_AUTO_BACKFILL=false`.
- `capital:ml` — hourly: fills realized return and barrier outcome for shadow ML predictions. Never trades, never trains.
- `capital:accounting` — every 5 minutes: payout obligations, payment intents, NAV snapshots, recommendation outcomes (1d/5d/20d) and the daily 1-minute-candle retention sweep.
- `capital:reconcile` — every 5 minutes: live account position/cash sanity.
- `capital:payments` — event-driven `4810`/`4800` money-log matching, plus completed trades (`4430`) paired with their `4440`/`4441` money lines.
- `capitalFills` subscriber — event-driven stock-log matching, unmatched-buy decisions.

Market data uses the Subversive key pool in parallel (`pool-key-request.ts`); account-specific calls use the personal key. `TORN_API_KEY` is a last-resort fallback only when the pool is empty.

## Market data

The scheduler owns collection: every 60s poll records a 1-minute tick plus the 5m/60m/1d aggregates, and the rotating detail call also feeds its one-minute history. The daily bar matters: the reversal signal is built on daily features, and the old engine never updated `interval_minutes = 1440`, so the newest daily bar froze at the backfill date. `capitalHistoryReadiness` now treats a daily bar older than 48h as not ready and refills it. Torn itself exposes only the last 60 one-minute points, so a fresh install starts empty.

The `capital:history` worker seeds it automatically on boot, 15 seconds after
start (it does not wait for the next `:17` tick): daily and hourly full history
plus one week of minutes, from the public tornsy.com mirror
(minute OHLC back to the 2021 launch). It validates every stock against Torn's
own `chart.performance` all-time high/low, writes in resumable chunks, and goes
quiet once coverage is ready. After the init the mirror is not used at runtime;
the scheduler is the source of truth.

The command remains for larger manual windows and audits:

```bash
bun run stocks:backfill                  # daily + hourly, full history
bun run stocks:backfill --intervals=m1 --m1-days=365
bun run stocks:backfill --validate-only  # compare stored extremes with Torn
bun run capital:ml:audit                 # coverage + label readiness
```

Readiness (>= 30 stocks, 365 daily days, 60 hourly days, fresh minutes) is
recomputed hour by hour; a gap (e.g. the scheduler was down for two days) is
refilled on the next run. See [the ML research assessment](capital-ml-research.md)
for the data audit.

## Signal modes

`capital_book_configs.signal_mode` selects the alpha:

- `reversal` (default) — buys names stretched below their 20-period daily mean, weighted by shares-outstanding inflow. The thesis exit is the z-score recovering to **+1σ** (upper band), not merely back to the mean: stopping at the mean capped the win at ~0.3–1.4% against a 4% stop. This is the mode the 5.5-year study supports (docs/capital-ml-research.md).
- `momentum` — the original trend-following score (EMA20/50, RSI, relative strength). Kept so the two can be compared on the paper book.

Both use the same risk overlay; only the entry score and the thesis exit differ.

### Scoring

The reversal score is `0.50 × stretch + 0.25 × flow + 0.20 × risk + 0.05 × regime`.

- **Flow** is the 7-day shares-outstanding change (the study's strongest
  predictor, IC +0.116) on a ±1% band. It still saturates for most candidates —
  Torn issuance moves in whole percent — so it acts as an outflow filter.
- **Risk** is 100 at ≤10% annualised volatility, falling to 0 at 60%. Most Torn
  names sit under 10%, so this is a low-vol gate.

The stretch term therefore dominates the ranking. That was measured, not
assumed: widening flow to ±5% or switching risk to ATR% (both tried) cut the
exact-ladder backtest from 15.6% to 10.9% CAGR and Sharpe from 4.9 to 4.3. The
saturation is deliberate until a genuinely different component (not a rescaled
linear one) is validated. Confidence sizing still uses the score, so the six
buy candidates that used to receive an identical 12.5% now receive 10.5–11.1%.

### Sizing and the exit ladder

Position count and per-name weight are **code-level policy**, not dashboard
settings (`packages/utils/src/capital-policy.ts`):

- 7 positions max, 12% of NAV per name, 85% max equity, 15% cash reserve.
  7 × 12% = 84%, so every slot can fill; the old 12 × 12.5% = 150% was capped
  at ~6–7 positions by `max_equity_pct` and the other five slots were decorative.
- Entry stop = `clamp(2.5 × ATR, 2%, 2.5%)`. Torn daily ATR is ~0.55%, so the 2%
  floor binds for most names. The stop, target and **initial risk are frozen on
  the position at entry** (`capital_positions.stop_price/target_price/entry_price`);
  the engine never recomputes the stop from today's ATR. That keeps R stable:
  ATR moves widen the trail, not the risk budget.
- First third off at **+1R**, full exit at the stored **+2R target**. The order's
  `target_price` is now an exit the engine actually takes.
- The trailing stop uses the **since-entry high-water mark** (`peak_price`),
  updated every cycle. It is separate from the hard stop. The old code derived a
  "peak" from the 30-day high, which could be a pre-entry price and trigger a
  trail on a position that never made a new high.
- Time stop after 20 days without +1R.
- Confidence sizing: `0.5 + score/100` → 0.5–1.5× on an 8% base weight (4–12%
  of NAV). It is applied only because the R:R is now positive; the score range
  that used to produce identical 12.5% positions now produces 10.5–11.1%.

The exact ladder is replayed by `bun run scripts/capital-ladder-backtest.ts`
(read-only, local daily candles). On 2021-2026 data the current ladder returns
15.6% CAGR / Sharpe 4.9 / max drawdown 1.1% / 70% wins / +0.59R average, versus
14.9% / 3.7 / 1.9% / 58% / +0.21R for the legacy 4%-stop, mean-exit ladder.

### Risk overlay (enforced, not cosmetic)

`capital:engine` reads every risk setting:

- `stale_data_seconds` — new entries pause when the last market tick is older
  than the limit or the fetch failed. Exits still run against the last known
  price, so a stop or trail is never switched off by an outage.
- `stop_cooldown_days` — a name stopped out inside the window is not re-bought,
  however oversold it still screens.
- `daily_loss_halt_pct` — entries pause when NAV per unit is down that much
  since the UTC day's last snapshot.
- `drawdown_derisk_pct` / `drawdown_halt_pct` — new entries are halved at the
  de-risk threshold and paused at the halt. Drawdown uses NAV per unit, so
  deposits and withdrawals do not look like performance.
- `regime_sma_days` — an equal-weight index of the stored daily closes is
  compared with its N-day SMA. The previous code used the median 30-day return
  and ignored the setting.

The current overlay state is exposed on the desk (`engine.risk`) and the thresholds are editable on both desks under **Risk overlay**. A pause/resume transition sends a Discord risk alert.

### Data and order safety

- Every market poll compares each print with the last accepted price. A move above **25%** in one cycle is treated as a corrupt tick: the stock is skipped for entries, exits use the last accepted quote, the run is marked degraded, and the owner gets a throttled risk alert.
- Open orders past `expires_at` are marked `expired` at the start of each book cycle. Without that sweep a recommendation nobody executed would block that stock's entry and exit forever.
- Manual fills validate the order's book, stock and side, and a sell is clamped to the held shares. A manual over-sell can no longer book cash for shares the fund does not own.
- The engine cycle takes a PostgreSQL advisory lock, so the cron tick, the manual API trigger and the smoke test cannot run concurrently.

## ML shadow layer

The `capital:ml:train` worker builds a meta-label dataset from the stored daily
candles (candidates with z <= -entry sigma, triple barrier +2%/-2% over 20 days),
fits an L2 logistic regression with a time-ordered split and embargo, and
activates the result for shadow logging when it clears the ranking gates. It runs
on boot once history is ready (checked 10 minutes after start) and retrains when
the active model is older than 30 days — no command needed. `bun run capital:ml:train` remains for an immediate
run or an experiment (`--activate` to store it). Disable with
`CAPITAL_AUTO_ML_TRAIN=false`.

Activation is safe by default: the engine computes a probability for every
reversal candidate and writes it to `capital_ml_predictions`, but does **not**
change orders until the book sets `ml_enabled = true`. `ml_weight` blends the
probability into the ranking, `ml_min_confidence` is the probability floor, and
`ml_max_model_age_days` expires a stale model. The active model is ignored
automatically if its feature spec does not match the running code.

The first model trained on 2021-2026 data reaches a test AUC of ~0.58 and is
within ~0.06 of the calibration target; it ties the rule on the test slice, so it
is activated for shadow logging only. Do not enable it until the shadow results
and calibration improve.

## Bot

No new slash commands. The bot receives `capital_alert` and `capital_paper_alert` IPC messages. Every capital alert is delivered to the owner's Discord DMs — there is no channel-ID setting.

Paper trade and risk alerts **are** sent, deliberately: they are the only way to watch the strategy work without risking capital. The **Send test alert** button on the Simulation tab of `/desk` exercises the full scheduler → IPC → bot → DM path without creating an order or touching the book. Trade alerts are titled `[ACRONYM] Buy/Sell N shares` and carry Mode (`Simulation`/`Live`), Stock, Fill, Score, Size, Stop and Target fields; neither the title nor the fields include a numeric stock id. Unmatched stock buys expose **Personal — ignore** / **Record as fund trade** buttons; payment issues expose Ignore + desk link.

## Resetting the simulation book

`POST /v2/capital/admin/paper/reset` (the **Reset simulation** button on the
Simulation tab of `/desk`) deletes every simulation investor, lot, position, order, fill, payout,
snapshot, engine run, ML prediction and audit row. It seeds **nothing** — no
operator, no starting cash — and resets the book's `started_at`. Add simulation
investors and record their deposits on the desk to fund it. The live book is
never touched.

The smoke test still uses the seeded reset (`resetCapitalPaperBook`): it needs
a funded book to exercise a full cycle.

## Enabling live

1. Apply migrations (`bun run db:migrate`).
2. Exercise the simulation book until NAV, fills, and accounting behave. The Simulation tab is simulation-only and hides live settings; the `POST /v2/capital/admin/paper/smoke-test` endpoint remains available for scripted checks.
3. Set `capital_book_configs.live_enabled = true` from the live desk settings.
4. Seed operator cash (recorded deposit/seed) and onboard investors.
5. Keep `/desk` open for unfunded payouts, reconciliation issues, and withdrawal quotes.

## Known limits / next steps

- Signals need self-recorded candle history: `d7` needs ~7 days, `d30` ~30 days.
- An off-recommendation buy recorded as an **error trade** is flagged `is_unplanned`; the engine uses half the normal stop distance and exits immediately if the setup does not qualify, otherwise it manages the position normally with a tighter risk budget.
- Payout/withdrawal log matches currently verify the transfer and alert the owner; the desk confirmation records the ledger settlement.
- Rule thresholds are configured defaults; the position count, per-name weight,
  max equity and risk-per-trade are fixed policy and are not editable on the
  desk. Re-run `scripts/capital-ladder-backtest.ts` before changing them.
- Sells persist an `exit_reason` (`stop`, `trail`, `scale_out`, `target`,
  `tighten_trail`, `reversal`, `time`, `error_review`) on the order and the fill;
  the desk and the public fills table display it.
- The reversal signal and the history backfill are implemented (see **Signal modes** and **Market data**); the ML meta-label layer is still deferred. See [the ML research assessment](capital-ml.md) and the [empirical feasibility study](capital-ml-research.md) for the evidence behind the mode default.
- 1-minute candles are retained for **180 days** and pruned once a day by the accounting worker. Daily/hourly bars are kept indefinitely; they are what the signals and the research use.
- DNS/TLS/edge routing for `stocks.blasted-labs.tech` is outside this repository. Point the tunnel hostname at the existing API service port; the API selects `web/stocks/dist` by Host header. Static assets do not bleed between apps. API data is protected by session/access checks plus a browser-Origin allowlist on `/v2/capital`: the capital public endpoints are intentionally public, investor views need a linked investor/allowlist entry, and admin views need owner/admin. Another dashboard origin is rejected with 403.
