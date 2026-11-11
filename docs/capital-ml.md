# Blasted Stocks — ML research assessment

Status: research / pre-data. No ML model is wired into the live engine.

> **Update (2026-11): the data premise below is no longer true.** A validated
> external source (tornsy.com) has minute-level history back to launch, and that
> history shows the market mean-reverts cross-sectionally — the current momentum
> scoring is on the wrong side of it. See
> **[capital-ml-research.md](capital-ml-research.md)** for the measured results,
> the backfill plan, and the revised recommendation. This document remains valid
> for its labels/features/deployment sections; its "not enough data" verdict and
> its confidence in momentum are superseded.

## Bottom line

- **There is not enough _self-collected_ data to train anything meaningful
  today.** The audit found ~1.6 hours of 5-minute history across 35 stocks (528
  rows), 70 hourly candles, and only 140 constructible 1-hour labels. The 4h/1d/7d
  label sets are empty. This is a collector-age problem, not a fundamental one:
  the public tornsy API carries the same series back to 2021-04-15 and has been
  validated against Torn's own minute prices and all-time extremes.
- A useful first experiment needs **6–12 months** of candles, which a backfill
  provides immediately. At full coverage that is ~1.8M five-minute rows for 180
  days (35 × 288 × 180), or ~151k hourly rows at an hourly decision cadence.
- The most plausible ML targets are **meta-labeling a cross-sectional reversal
  entry, reversion-magnitude regression, and volatility forecasting** — not raw
  minute-level price direction. “Ensure accuracy” is not possible; the only
  honest goal is to measure out-of-sample, cost-adjusted skill and refuse to
  deploy without it.

## Why Torn is a hard prediction problem

| Constraint                             | Consequence                                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 35 stocks                              | Small cross-section; pooled/cross-sectional models beat per-stock deep models.                                                   |
| Prices update every minute             | High noise, but the API only preserves 60 one-minute points plus aggregate performance windows. We must build history ourselves. |
| No volume, order book, or spread       | No microstructure features. Do not invent volume.                                                                                |
| Long-only, no shorting                 | A model can only choose stocks or cash; broad downtrends become cash, not alpha.                                                 |
| 0.1% sale fee                          | Frequent trading must clear the fee; turnover is a first-class cost.                                                             |
| Manual execution                       | A recommendation can be minutes late. Backtests must include execution delay, not fill at the signal price.                      |
| Real-world tether, undisclosed mapping | External market features are unverified. They must prove incremental value, not be assumed.                                      |
| Splits/merges and benefit events       | Raw price history contains discontinuities; corporate actions must be adjusted before ML.                                        |
| Game updates / regime shifts           | Stationarity is not guaranteed; models need drift monitoring and retraining.                                                     |

Torn’s own release note describes minute price updates, a 0.1% sale fee, and
real-world-linked prices with the mapping deliberately undisclosed:
[Torn City Times — Stock Market 3.0](https://torncitynewspaper.blogspot.com/2021/04/stock-market-30-released.html).
The API surface (`/torn/stocks`, `/torn/{id}/stocks`, `/user/stocks`) is in the
[Torn API spec](https://www.torn.com/swagger/openapi.json). Third-party bots
such as [TornStonksLive](https://github.com/Jordach/TornStonksLive) already keep
minute-level history, which confirms that collecting it is possible; it is not a
dataset we can rely on.

## Current data audit

Run `bun run capital:ml:audit` (script: `scripts/capital-ml-audit.ts`).

| Interval | Rows | Stocks | First             | Last              |
| -------- | ---: | -----: | ----------------- | ----------------- |
| 5m       |  528 |     35 | 2026-11-11T17:20Z | 2026-11-11T18:35Z |
| 60m      |   70 |     35 | 2026-11-11T17:00Z | 2026-11-11T18:00Z |

- 15–16 five-minute candles per stock; largest gap 10 minutes.
- 1h labels: 140 rows. 4h/1d/7d labels: 0.
- Detail performance seeded for 35 stocks; 4 engine runs; 4 NAV snapshots.
- Verdict: **smoke-test sample, not a research dataset.**

The collector is already correct for the long game: `/torn/stocks` every 60s,
5m/60m candles retained, one rotating detail refresh per cycle. What it needs now
is time, not a model.

## What to predict

| Candidate                               | Signal quality                    | Data appetite           | Recommendation                        |
| --------------------------------------- | --------------------------------- | ----------------------- | ------------------------------------- |
| Next-minute direction                   | Very low (near noise)             | Huge                    | Do not start here.                    |
| 1h–1d absolute return                   | Low/medium                        | High                    | Only as a secondary score.            |
| Cross-sectional relative return / rank  | Medium                            | Moderate                | Good candidate for top-k selection.   |
| Volatility / expected range             | Medium/high (volatility clusters) | Moderate                | **Start here** for sizing and risk.   |
| Regime / risk-on vs risk-off            | Medium                            | Moderate                | Good candidate for cash allocation.   |
| Meta-label: will this rule signal work? | Medium                            | Lower (fewer decisions) | **Best first production experiment.** |

The existing deterministic engine already produces a bounded number of
decisions. A meta-label model learns, for those decisions, whether the trade is
likely to hit its target before its stop. That is a much smaller and cleaner
problem than predicting the whole market, and it directly improves the current
system instead of replacing it.

## Labels

Use **triple-barrier labels** rather than raw next-price regression:

- Upper barrier: `+k × ATR` (or a fixed %).
- Lower barrier: `−k × ATR`.
- Time barrier: 1h / 4h / 1d / 7d.
- Label: target hit first, stop hit first, or time expiry.
- Subtract the 0.1% sale fee and an execution-delay adjustment from long returns.
- Long-only: a “short” label is not tradeable; treat it as “stay in cash”.

For meta-labeling, the label is simply “did the existing rule’s trade hit its
target before its stop/time barrier?”. For volatility, the label is realized
range/standard deviation over the horizon.

## Features

Price-derived, point-in-time only:

- Returns: 5m, 15m, 1h, 4h, 1d, 3d, 7d, 30d.
- Volatility: realized 5m/1h/1d, ATR, range, downside deviation.
- Trend/mean reversion: EMA distances, RSI, Bollinger z-score, distance to
  20/50-period means, drawdown from 30d/90d highs.
- Relative strength: stock minus equal-weight universe, cross-sectional rank,
  beta/correlation to the universe.
- Regime: universe above/below its 50-day SMA, cross-sectional dispersion,
  average correlation.
- Flow proxies: change in shares outstanding and investor count (not volume).
- Time: hour-of-day, day-of-week, session/regime bucket.
- External: only after a documented mapping hypothesis and an incremental-value
  test. Torn does not publish the real-world mapping; correlation without mapping
  is not evidence.

Data hygiene:

- Adjust or exclude split/merge discontinuities.
- Drop stale/gapped candles; never forward-fill across a long outage.
- Align timestamps to UTC buckets and decision time.
- Do not use the current candle’s high/low after the decision time in a feature.

## Dataset construction

- **Panel**: one row per `(decision_time, stock_id)`. At an hourly cadence, 35
  stocks × 24 × 180 days ≈ 151k rows. At 5m cadence, ~1.8M rows for 180 days.
- Decision cadence should match the engine (e.g., hourly) rather than every
  minute; fewer overlapping labels and less turnover.
- Split by time, never randomly: walk-forward train → validation → test.
- Purge/embargo at least the label horizon around each fold to prevent leakage.
- Keep a final untouched holdout that is never used for tuning.
- Version the feature list and label definition with every experiment.

## Models

Start simple:

1. **Baselines**: current rule engine, random walk, momentum, buy-and-hold,
   equal-weight universe.
2. **Logistic regression / ridge** for meta-labels and volatility buckets.
3. **LightGBM / XGBoost** for tabular features and non-linear interactions.
4. **Sequence models** only after at least 6–12 months and a strong tabular
   baseline. They are not a shortcut around small data.

Outputs must be probabilistic and calibrated (isotonic/Platt). A model should
produce a probability, expected return, or expected volatility — not a hard
BUY/SELL label. Calibration matters more than raw accuracy.

## Validation and backtesting

- Walk-forward, purged, embargoed; no lookahead.
- Compare every model against the deterministic engine and the naive baselines
  on the same dates and costs.
- Execution assumption: next available candle, plus a random 1–5 minute delay;
  include the 0.1% sale fee and a conservative slippage assumption.
- Long-only, cash allowed, same position sizing/risk limits as the live engine.
- Metrics: net Sharpe, Sortino, max drawdown, Calmar, profit factor, hit rate,
  average win/loss, turnover, exposure, and calibration (Brier/log loss).
- Statistical discipline: bootstrap confidence intervals, deflated Sharpe ratio
  for multiple trials, probability of backtest overfitting; pre-register the
  feature set and model family before looking at the test set.
- A model that does not beat the rules **after costs and delay** is not deployed.

## Deployment architecture (when the gates pass)

```
offline Python research (pandas / scikit-learn / LightGBM)
        │ export ONNX or JSON trees + feature spec + model card
        ▼
capital_ml_models  ──►  capital:ml worker (hourly inference)
        │                       │
        │                       ▼
        │              capital_ml_predictions
        │                       │
        ▼                       ▼
capital:engine reads prediction as an optional factor (weight cap)
        │
        ▼
orders still pass through the existing risk overlay and manual execution
```

Suggested tables:

- `capital_ml_models`: version, trained_at, data_range, feature_spec, metrics,
  artifact reference, active flag.
- `capital_ml_predictions`: created_at, stock_id, model_version, horizon,
  probability, expected_return, expected_volatility, feature_hash.
- `capital_ml_outcomes`: prediction_id, realized_return, barrier_hit,
  evaluated_at.
- `capital_ml_runs`: training/evaluation run metadata and gate results.

Operational controls:

- `ml_enabled`, `ml_weight` (e.g. 0–30%), `ml_min_confidence`,
  `ml_max_allocation`.
- The model can only **adjust or veto** a rule signal; it cannot override stops,
  drawdown halts, reserve, or position caps.
- Kill switch: if rolling IC/calibration/drawdown breaches a threshold, disable
  the model automatically and alert the owner.
- Retrain on a fixed cadence (monthly/quarterly), not online against live
  outcomes.

## Adoption gates

Proposed, tunable after the first real dataset:

1. **Data**: at least 180 days of 5m candles; 90+ days after corporate-action
   adjustment; no unexplained multi-hour gaps.
2. **Out-of-sample skill**: beats the rule engine and naive baselines after the
   0.1% fee and execution delay, with confidence intervals excluding zero edge.
3. **Calibration**: Brier/log loss acceptable and reliability curve close to the
   diagonal (e.g. calibration error < 0.05).
4. **Risk**: max drawdown and turnover no worse than the rules; no concentration
   surprise.
5. **Paper shadow**: 8–12 weeks of live predictions with no effect on orders;
   positive relative performance and stable calibration.
6. **Capped deployment**: first live weight ≤ 20–30% of the score; hard risk
   overlay unchanged; kill switch armed.
7. **Post-deployment**: weekly monitoring of IC, hit rate, calibration, feature
   drift, and live-vs-backtest divergence.

## Risks and failure modes

- **Overfitting** to 35 correlated assets and a short history.
- **Lookahead** from overlapping labels, future candles, or using post-decision
  highs/lows.
- **Regime shift** after a Torn update or real-world market change.
- **Data discontinuity** from splits/merges or missed polls.
- **Unverified external mapping** producing spurious features.
- **Execution lag** turning a backtest edge into a live loss.
- **Cost blindness**; 10 bps per sale plus delay is enough to erase small edges.
- **Model risk**: a confident model overriding a risk limit. The overlay must
  always win.
- **Operational drift**: model file/version mismatch between research and the
  scheduler.

## Roadmap

- **ML-0 (now)**: keep collecting; run the audit; add corporate-action handling;
  document feature/label specs. No production model.
- **ML-1 (90–180 days)**: dataset builder; triple-barrier labels; purged
  walk-forward; baselines; volatility and meta-label experiments.
- **ML-2**: pick the best family; full backtest report; model card; no live
  effect.
- **ML-3**: shadow predictions in the desk; 8–12 weeks.
- **ML-4**: capped ensemble behind a kill switch, only if every gate passes.

## Current verdict

Do not add ML to the live engine yet. The first move is to establish whether the
existing signal is even correctly signed: the empirical study in
[capital-ml-research.md](capital-ml-research.md) finds strong cross-sectional
mean reversion and a momentum/trend score whose forward returns fall
monotonically as the score rises. Once that is re-validated (Phase 0 there), the
first model worth trying is a **calibrated meta-label model on the reversal
candidates**, with volatility forecasting as a second candidate. Raw minute-level
price prediction is the least promising use of the data and the easiest place to
overfit.
