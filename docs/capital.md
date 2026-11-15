# Blasted Stocks

Managed Torn City stock trading fund. Code prefix: `capital`. Host: `stocks.blasted-labs.tech`. The existing `/stocks` dashboard page is unrelated (market alerts).

## Surfaces

- `/` — public fund page: **Live** and **Simulation** tabs. Live shows NAV, current positions with marked-to-market P/L, recent live fills and the fee schedule; Simulation shows simulated NAV, current positions with P/L, test-investor results (no cadence/payout columns) and fills. The legacy `/paper` link still opens the Simulation tab.
- `/portfolio` — Discord-authenticated investor view: lots, payouts, withdrawals.
- `/desk` — owner/admin desk with **Live** and **Simulation** tabs. Live has cash/deployed/retained-fee cards, open positions with frozen stops/targets, open orders (accept/cancel), investor, deposit, payout, withdrawal, risk-overlay and settings controls. Simulation has a permanent `SIMULATION` banner, the same positions/orders/risk cards, a **Send test alert** button and the reset control. The legacy `/desk/paper` link still opens the Simulation tab.

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

Performance and exit fees are booked as `fee`/`exit_fee` cash rows, so they leave the fund's NAV and are retained by the owner; they are not reinvested. The desk's **Retained fees** card shows the lifetime amount. To put retained fees back into the fund, record a deposit under an operator lot — that issues units at the current NAV and re-enters the cash. A `reinvest` lot still compounds the investor's net payout automatically; switch the investor to `cash` if you want every payout to be a manual transfer.

Payout dates are shared per cadence: daily at 00:00 UTC, weekly Monday 00:00 UTC, monthly on the 1st at 00:00 UTC. New deposits and post-payout rescheduling use the same aligned calendar; migration `0074` backfilled existing active lots. A period must accrue at least half a cadence before it can settle (`MIN_PAYOUT_ACCRUAL_FRACTION`), so a deposit made just before a boundary rolls to the following boundary instead of paying a stub period — the batch itself is unchanged. Set the fraction to `1` for a strict one-full-period rule.

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

- `reversal` (default) — buys names stretched **1.25σ or more** below their 20-period daily mean, weighted by shares-outstanding inflow. The 1.25σ floor was set on 14 Nov from the path-consistent backtest: 18.3% CAGR / Sharpe 5.6 / 1.05% max DD, versus 17.9% / 5.5 / 1.17% at −1σ, and it excludes the marginal names that sat exactly on the old boundary. The thesis exit is the z-score recovering to **+1σ** (upper band), not merely back to the mean: stopping at the mean capped the win at ~0.3–1.4% against a 4% stop. This is the mode the 5.5-year study supports (docs/capital-ml-research.md).
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
assumed: widening flow to ±5% or switching risk to ATR% (both tried on the older
close-only replay) cut that replay from 15.6% to 10.9% CAGR and Sharpe from 4.9
to 4.3. Those two component experiments predate the path-consistent rebuild, so
treat the absolute numbers as indicative and re-measure before relying on them.
The saturation is deliberate until a genuinely different component (not a
rescaled linear one) is validated. Confidence sizing still uses the score, so
the six buy candidates that used to receive an identical 12.5% now receive
10.5–11.1%.

### Sizing and the exit ladder

Position count and per-name weight are **code-level policy**, not dashboard
settings (`packages/utils/src/capital-policy.ts`):

- **7 to 12 slots, scaled with NAV.** At inception the book runs 7 slots at a
  12% per-name cap (7 × 12% = 84%, under the 85% equity cap). As NAV grows the
  slot count grows with it — one slot per ~1/7th growth over the first funded
  snapshot — up to 12. The per-name cap falls to `min(12%, 85% / slots)`
  (7.08% at 12 slots), so the book still fits under the equity cap.
  `capitalSlotPolicy` in `packages/utils/src/capital-policy.ts` owns the rule.
  The anchor is the first non-zero NAV snapshot, not a hard-coded dollar
  amount, so a later deposit adds slots instead of diluting the existing
  positions while the new cash sits idle. The old fixed 7-slot cap could not
  absorb new capital at all; a fixed 12 × 12.5% = 150% was capped at ~6–7
  positions by `max_equity_pct`, leaving the other five slots decorative.
- The per-name cap is the hard 12%; the effective cap for a cycle is the slot
  policy value. Confidence sizing derives its base from that cap, so the
  strongest signal still reaches the cap and a weak one uses a third of it.
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
- Confidence sizing: `0.5 + score/100` → 0.5–1.5× on a base of `slot cap / 1.5`
  (8% when the cap is 12%). The entry floor is 65, so the _effective_ range is
  1.15–1.5× of that base, not the full 0.5–1.5× it implies at score 0.
  Rescaling over 65–100 was tested and rejected: it cuts deployment to ~40% of
  NAV and CAGR from 18.3% to 10.5% because the low-score names it halves are
  still profitable. At 12 slots the base falls with the cap, so the confidence
  spread is preserved instead of being clipped by the per-name cap.
- The thesis (z-score) exit is **not** gated behind +1R. Gating it was tested:
  average R rises from +0.49 to +0.63, but CAGR falls from 18.3% to 16.0% and
  the 20-day time stops go from 121 to 372. The early z-exit is where the
  mean-reversion edge is realised. `CAPITAL_EXIT.zExitMinR` remains as a knob
  for future testing; production keeps it at 0.

The exact ladder is replayed by `bun run scripts/capital-ladder-backtest.ts`
(read-only, local daily candles). The replay is **path-consistent**: every exit
level is compared on the same bar (open → stop → each upside level in ascending
price order → close for trail/time), because the engine checks the whole ladder
on the same 60-second path. The earlier version checked the +2R target against
the daily high but the z-exit only against the close, and it leaked the final
20-day mean/σ into every historical bar. On 2021-2026 data the current ladder
(entry −1.25σ) returns **18.3% CAGR / Sharpe 5.6 / max drawdown 1.05% / 79.5%
wins / +0.50R average / 10-day hold**, versus 18.9% / 4.9 / 1.6% / 79.2% /
+0.13R for the legacy 4%-stop, mean-exit ladder. The legacy configuration
deploys more (72% vs 60%) but earns a quarter of the R per trade.

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

The live book is **disabled** (`capital_book_configs.live_enabled = false`) as of
14 Nov 2026. Do not re-enable it until the simulation book has 30–50 closed
trades and the realized R distribution, `exit_reason` mix and the share of
winners that stop out first have been reviewed.

1. Apply migrations (`bun run db:migrate`).
2. Exercise the simulation book until NAV, fills, and accounting behave. The Simulation tab is simulation-only and hides live settings; the `POST /v2/capital/admin/paper/smoke-test` endpoint remains available for scripted checks.
3. Set `capital_book_configs.live_enabled = true` from the live desk settings.
4. Seed operator cash (recorded deposit/seed) and onboard investors.
5. Keep `/desk` open for unfunded payouts, reconciliation issues, and withdrawal quotes.

## Known limits / next steps

- Signals need self-recorded candle history: `d7` needs ~7 days, `d30` ~30 days.
- An off-recommendation buy recorded as an **error trade** is flagged `is_unplanned`; the engine uses half the normal stop distance and exits immediately if the setup does not qualify, otherwise it manages the position normally with a tighter risk budget.
- Payout/withdrawal log matches currently verify the transfer and alert the owner; the desk confirmation records the ledger settlement.
- Rule thresholds are configured defaults; the slot policy, per-name weight,
  max equity and risk-per-trade are fixed policy and are not editable on the
  desk. Re-run `scripts/capital-ladder-backtest.ts` before changing them; the
  10-slot (8.5%) and 12-slot (7.08%) variants are included for the breadth
  trade-off.
- Dynamic slots change entries only. Existing positions keep their original
  size until they exit; the engine does not rebalance a position up or down.
- Slots are anchored on the first funded snapshot, so a large withdrawal does
  not shrink the slot count below 7, and a reset re-anchors the book.
- `risk_per_trade_pct = 0.5` never binds: even a 12% weight × a ~2.05% stop is
  0.20–0.23% of NAV per name, so portfolio heat is ~1.5%, not 3.5%. The weight
  cap, not the risk budget, is the real sizing constraint.
- Sells persist an `exit_reason` (`stop`, `trail`, `scale_out`, `target`,
  `tighten_trail`, `reversal`, `time`, `error_review`) on the order and the fill;
  the desk and the public fills table display it.
- The reversal signal and the history backfill are implemented (see **Signal modes** and **Market data**); the ML meta-label layer is still deferred. See [the ML research assessment](capital-ml.md) and the [empirical feasibility study](capital-ml-research.md) for the evidence behind the mode default.
- 1-minute candles are retained for **180 days** and pruned once a day by the accounting worker. Daily/hourly bars are kept indefinitely; they are what the signals and the research use.
- DNS/TLS/edge routing for `stocks.blasted-labs.tech` is outside this repository. Point the tunnel hostname at the existing API service port; the API selects `web/stocks/dist` by Host header. Static assets do not bleed between apps. API data is protected by session/access checks plus a browser-Origin allowlist on `/v2/capital`: the capital public endpoints are intentionally public, investor views need a linked investor/allowlist entry, and admin views need owner/admin. Another dashboard origin is rejected with 403.
