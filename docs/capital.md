# Blasted Stocks

Managed Torn City stock trading fund. Code prefix: `capital`. Host: `stocks.blasted-labs.tech`. The existing `/stocks` dashboard page is unrelated (market alerts).

## Surfaces

- `/` — public fund page: NAV, current positions with marked-to-market P/L, recent live fills, fee schedule.
- `/paper` — public paper results: simulated NAV, current positions with P/L, test-investor results (no cadence/payout columns) and fills.
- `/portfolio` — Discord-authenticated investor view: lots, payouts, withdrawals.
- `/desk` — owner/admin live desk: investor, deposit, payout, withdrawal and settings controls.
- `/desk/paper` — owner/admin simulation desk with a permanent `SIMULATION` banner.

The app lives in `web/stocks`. The API serves it by `Host` header from `services/api/src/middleware/static-spa.ts`; DNS/TLS for the subdomain is an external deployment prerequisite.

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
- `capital:accounting` — every 5 minutes: payout obligations, payment intents, NAV snapshots.
- `capital:reconcile` — every 5 minutes: live account position/cash sanity.
- `capital:payments` — event-driven `4810`/`4800` money-log matching, plus completed trades (`4430`) paired with their `4440`/`4441` money lines.
- `capitalFills` subscriber — event-driven stock-log matching, unmatched-buy decisions.

Market data uses the Subversive key pool in parallel (`pool-key-request.ts`); account-specific calls use the personal key. `TORN_API_KEY` is a last-resort fallback only when the pool is empty.

## Market data

The scheduler owns collection: every 60s poll records a 1-minute tick plus the 5m/60m aggregates, and the rotating detail call also feeds its one-minute history. Torn itself exposes only the last 60 one-minute points, so a fresh install starts empty.

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

- `reversal` (default) — buys names stretched below their 20-period daily mean, weighted by shares-outstanding inflow; exits when price reverts to the mean. This is the mode the 5.5-year study supports (docs/capital-ml-research.md).
- `momentum` — the original trend-following score (EMA20/50, RSI, relative strength). Kept so the two can be compared on the paper book.

Both use the same risk overlay; only the entry score and the thesis exit differ.

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

No new slash commands. The bot receives `capital_alert` and `capital_paper_alert` IPC messages. Every capital alert is delivered to the owner's Discord DMs — there is no channel-ID setting. Paper recommendation alerts are not sent at all; paper activity stays visible on `/desk/paper`, so live and paper cannot double-notify. Unmatched stock buys expose **Personal — ignore** / **Record as fund trade** buttons; payment issues expose Ignore + desk link.

## Enabling live

1. Apply migrations (`bun run db:migrate`).
2. Exercise the paper book until NAV, fills, and accounting behave. The paper desk is simulation-only and hides live settings; the `POST /v2/capital/admin/paper/smoke-test` endpoint remains available for scripted checks.
3. Set `capital_book_configs.live_enabled = true` from the live desk settings.
4. Seed operator cash (recorded deposit/seed) and onboard investors.
5. Keep `/desk` open for unfunded payouts, reconciliation issues, and withdrawal quotes.

## Known limits / next steps

- Signals need self-recorded candle history: `d7` needs ~7 days, `d30` ~30 days.
- An off-recommendation buy recorded as an **error trade** is flagged `is_unplanned`; the engine uses half the normal stop distance and exits immediately if the setup does not qualify, otherwise it manages the position normally with a tighter risk budget.
- Payout/withdrawal log matches currently verify the transfer and alert the owner; the desk confirmation records the ledger settlement.
- Rule thresholds are configured defaults; tune from paper results.
- The reversal signal and the history backfill are implemented (see **Signal modes** and **Market data**); the ML meta-label layer is still deferred. See [the ML research assessment](capital-ml.md) and the [empirical feasibility study](capital-ml-research.md) for the evidence behind the mode default.
- 1-minute candles are retained indefinitely. That is ~18M rows/year for 35 stocks; add a retention policy once the research dataset is exported if the table growth becomes a problem.
- DNS/TLS/edge routing for `stocks.blasted-labs.tech` is outside this repository. Point the tunnel hostname at the existing API service port; the API selects `web/stocks/dist` by Host header. Static assets do not bleed between apps. API data is protected by session/access checks plus a browser-Origin allowlist on `/v2/capital`: the capital public endpoints are intentionally public, investor views need a linked investor/allowlist entry, and admin views need owner/admin. Another dashboard origin is rejected with 403.
