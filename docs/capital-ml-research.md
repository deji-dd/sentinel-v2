# Blasted Stocks — ML feasibility research

Status: research. No model is wired in. Companion to [capital-ml.md](capital-ml.md);
this document supersedes its "not enough data" verdict with measured results and a
revised recommendation.

Data used: 35 Torn stocks + tornsy's TCSE index, 1-minute/daily bars from
**2021-04-15** to **2026-11-11**, pulled 2026-11-11. All findings below are
reproducible from that public series; the scripts were scratch work, not committed.

---

## Verdict (short version)

1. **The history problem is solved.** A public, free, keyless API (`tornsy.com`)
   has minute-level OHLC for every Torn stock going back to launch (April 2021),
   and I verified it is a byte-exact mirror of Torn's own minute prices. You do
   not need to wait 6–12 months to train. Backfilling 18 months of minute bars is
   roughly 9k requests and ~1.5 GB; a full 5.5-year hourly series is ~875 requests.
2. **The market is strongly mean-reverting, and the current engine is on the
   wrong side of it.** Cross-sectional 20-day momentum has an IC of **−0.18**
   against forward 20-day returns, stable across both halves of the sample and
   across 29–30 of 35 stocks. A long-only "buy the 20-day losers" portfolio
   returned **22.6% CAGR after fees** with a 1.5% max drawdown in a daily
   backtest, in every sub-period. The deployed scoring rule's forward returns are
   **monotonically decreasing in its own score**: the 90–100 score bucket earns
   **−0.24%** over the next 20 days; the 30–40 bucket earns **+0.61%**. Its
   `negative_trend` block excludes the single best-performing group (+0.51%).
3. **ML is worth doing, but not for price prediction.** The learnable structure
   is ranking and sizing a reversal trade, not forecasting direction. The first
   model should be a calibrated meta-label on the reversal candidate set
   ("will this dip revert +2% before −2%?"). Even a linear/GBM model has a clear
   job; a deep sequence model does not.
4. **Fix the alpha before adding ML.** A model layered on top of an inverted
   rule will confidently choose the wrong stocks. The order should be: validate
   the reversal finding on minute data → re-sign the rule → then add ML as a
   ranking/sizing overlay.
5. **Treat the 22% CAGR / Sharpe 6–8 as an upper bound.** The backtest executes
   at the daily close with only the 0.1% sale fee and no price impact. The
   smoothness is a property of a game's synthetic price process, not of a real
   market, and the edge is visibly decaying (61% → 35% → 18% CAGR across
   successive sub-periods).

## Implementation status (2026-11)

The data, signal and shadow-ML layers are implemented; live ML ranking is not.

| Item                                                                  | Status                                      |
| --------------------------------------------------------------------- | ------------------------------------------- |
| `signal_mode` per book, default `reversal`                            | done — migration `0076`                     |
| Reversal score (stretch + shares flow + risk) and mean-reversion exit | done — `capital-signals.ts`, tested         |
| Reversal uses **daily** bars; momentum keeps hourly                   | done — the engine builds both feature maps  |
| 1-minute candle collection from the 60s poll                          | done                                        |
| One-time history backfill with Torn-anchor validation                 | done — `bun run stocks:backfill`            |
| Audit reports per-interval readiness                                  | done — `bun run capital:ml:audit`           |
| Dataset builder + triple-barrier labels                               | done — `bun run capital:ml:train`           |
| Logistic meta-label, time-ordered split, embargo, Platt calibration   | done — test AUC **0.577**                   |
| Shadow predictions + outcome scoring                                  | done — `capital:ml` worker                  |
| Automatic retrain (boot + every 30 days, shadow activation only)      | done — `capital:ml:train` worker            |
| Capped deployment (`ml_enabled`)                                      | not enabled — the first model ties the rule |

The engine still runs the same risk overlay (stops, trailing, scale-out, drawdown
halts, reserve, position caps); only the entry score and the thesis exit change
with the mode. Flip a book back with a settings `PATCH`
(`{ "signalMode": "momentum" }`) without a deploy.

**First model result (2026-11-11).** Trained on 13,273 candidates from
2021-07 to 2026-10, 7,762 train / 2,333 validation / 2,482 test with a 25-day
embargo. Test AUC 0.577, Brier 0.188, log loss 0.563, calibration error 0.056,
base hit rate 24.9% (the recent period is lower than the 41% training base
rate). On the test slice, re-ranking the rule's candidates by the model produced
**7.5% CAGR vs 7.3% for the rule** over 17 non-overlapping 20-day blocks — a tie,
not a win. It is activated for shadow logging only; `ml_enabled` stays false.

That is the honest state: the pipeline works end to end and retrains itself, but
the gate refuses live deployment. The next iteration should add features that
explain the base-rate shift (regime, dispersion) or a better label, not a bigger
model.

**First model result (2026-11-11).** Trained on 13,273 candidates from
2021-07 to 2026-10, 7,762 train / 2,333 validation / 2,482 test with a 25-day
embargo. Test AUC 0.577, Brier 0.188, log loss 0.563, calibration error 0.059,
base hit rate 24.9% (the recent period is lower than the 41% training base
rate). On the test slice, re-ranking the rule's candidates by the model produced
**7.5% CAGR vs 7.3% for the rule** over 17 non-overlapping 20-day blocks — a tie,
not a win. It is activated for shadow logging only; `ml_enabled` stays false.

That is the honest state: the pipeline works end to end, the gate refuses to
deploy, and the next iteration should add features that explain the base-rate
shift (regime, dispersion) or a better label, not a bigger model.

---

## 1. Is there enough history? Yes.

### What Torn itself gives

- `GET /v2/torn/stocks` — all 35 stocks, one price per stock, updates every
  minute. Requires only a public key.
- `GET /v2/torn/{stockId}/stocks` — the chart object:
  - `chart.history`: exactly **60 points, 60 s apart**, newest first, covering
    the last 59 minutes. I probed `selections`, `limit`, `from`, `timestamp`,
    `interval`, `range` — all ignored. There is no deeper history behind it.
  - `chart.performance`: `last_hour`, `last_day`, `last_week`, `last_month`,
    `last_year`, `all_time`, each with `start`, `end`, `high`, `low`, `change`.
- Verified live with the key in `.env.development` (16-char key, HTTP 200).

The `performance` object is more useful than it looks: it is **six retroactive
anchor points per stock** (price 1 h / 1 d / 1 w / 1 m / 1 y ago, plus launch).
One call today recovers the price at 2025-11-11, 2026-11-04, etc. Collecting
daily turns that into a slow but self-owned long-horizon series, and it is the
perfect cross-check for any external dataset.

### What the external source gives

[`tornsy.com`](https://tornsy.com/api) is a public, free, keyless API that
collects stock data from Torn once a minute. It is open source
([bbenejc/tornsy](https://github.com/bbenejc/tornsy)) and documents:

```
GET https://tornsy.com/api/{TICKER}?interval={m1|m5|m15|m30|h1|h2|h4|h6|h12|d1|w1|n1|y1|all}
                                     &from={ts}&to={ts}&limit={1..2000}
GET https://tornsy.com/api/stocks     # 35 stocks + tornsy's TCSE index
```

Rows are `[timestamp, price, total_shares]` for `m1`, and
`[timestamp, open, high, low, close, total_shares]` for every other interval.
`to` is exclusive and pages backwards, so the full series is walkable. The docs
warn that a minute can be missing if Torn's API was down during collection.

Measured depth (TSB, and confirmed for all 35):

| Interval | First bar        | Bars   | Notes                                      |
| -------- | ---------------- | ------ | ------------------------------------------ |
| `d1`     | 2021-04-15 00:00 | 2,034  | launch of Stock Market 3.0; 1 four-day gap |
| `h1`     | 2021-04-16       | ~48.8k | 24 bars/day, no weekend skips              |
| `m1`     | 2021-04-16 05:12 | ~2.9M  | 60 s spacing; occasional 120 s gaps        |

Newer stocks start at their listing date (MUN 2021-07-06, ASS 2021-06-29,
CBD 2022-11-01, LOS 2022-11-15, PTS 2022-11-29), which is itself a good sign the
source is real rather than reconstructed.

### Validation against Torn (this is the important part)

I did not take the data on faith. Three independent checks:

1. **Minute prices.** For 10 stocks, I matched Torn's own `chart.history`
   (60 points each) against tornsy `m1` at the same timestamps: **60/60 exact
   matches on every stock**, zero mismatches, zero missing.
2. **Current price.** tornsy's last daily close equals Torn's `market.price`
   exactly for **35/35** stocks.
3. **Full-history extremes.** Over the complete 5.5-year series, tornsy's daily
   maximum high equals Torn's `all_time.high` exactly for **35/35** stocks, and
   its daily minimum low equals `all_time.low` for **29/35**. The six misses are
   all cases where Torn's all-time low is _below_ tornsy's (by 0.4–7.9%), i.e.
   the extreme happened in the first hours of launch day before tornsy's first
   bar — consistent, not contradictory. The `all_time.start` values also line up
   with tornsy's first bars once that launch-day gap is accounted for.

That `all_time.high` agreement is the strongest signal available: matching Torn's
exact all-time high to the cent for all 35 stocks over 5.5 years is not something
a fabricated dataset would do.

### Recommended data strategy: both, not either

- **Start storing minute bars now.** The collector already polls `/torn/stocks`
  every 60 s, so a 1-minute observation per stock already exists in memory and is
  currently collapsed into 5 m/60 m candles. Persisting the raw tick (one row per
  stock per minute ≈ 50k rows/day) costs almost nothing and gives you a series
  you own. Keep the 5 m/60 m aggregates for the engine.
- **Backfill from tornsy for the baseline**, then keep using it only as a gap
  filler and cross-check. Validate every backfill chunk against the `performance`
  anchors you can fetch at the same time (year-ago price, all-time high/low).
- **Do not make tornsy a hard runtime dependency.** The engine should keep
  working from your own store; tornsy is an ingestion-time source.

Volume and cost estimates:

| Scope                      |   Rows | Requests @2k/page | Notes                      |
| -------------------------- | -----: | ----------------: | -------------------------- |
| Daily, full history, 35    |   ~71k |               ~70 | trivial                    |
| Hourly, full history, 35   |  ~1.7M |              ~875 | the research workhorse     |
| Minute, last 12 months, 35 | ~18.4M |            ~9,200 | ~1.5 GB; ~1–2 h at 2 req/s |
| Minute, full history, 35   |  ~102M |           ~51,000 | possible, expensive        |

Start with daily + hourly full history and 12 months of minutes. That is enough
for every experiment below and fits comfortably in Postgres.

---

## 2. Is there a learnable signal? Yes — and it is not the one being traded.

### Market structure (2021-04-15 → 2026-11-11)

| Property                     | Measurement                                       |
| ---------------------------- | ------------------------------------------------- |
| Universe                     | 35 stocks, 30 from launch                         |
| Per-stock annualised vol     | median **8.6%** (min 7.8%, max 10.1%)             |
| Pairwise daily correlation   | mean **0.000**, median 0.003, range −0.08 to 0.11 |
| Equal-weight index           | ~1.5% annualised vol, Sharpe ~3.5                 |
| TCSE index (tornsy-computed) | 11,747 → 16,443 (**+40%** over 5.5 years)         |
| Return distribution          | ~normal, 1 move >5% in 47k stock-days             |

The near-zero cross-correlation is why the equal-weight portfolio is so smooth,
and why a _cross-sectional_ model is the right frame: there is almost no market
factor to forecast, but there is a lot of relative movement.

### The dominant effect: cross-sectional reversal

Variance ratios (per stock, pooled). `<1` means mean reversion:

| Horizon | VR    |
| ------- | ----- |
| 2 d     | 0.973 |
| 5 d     | 0.922 |
| 10 d    | 0.803 |
| 20 d    | 0.610 |
| 60 d    | 0.469 |

AR(1) on log deviation from a moving average gives a reversion half-life of
**16–25 days** (R² 0.005–0.009 — small per day, but it compounds).

Cross-sectional rank IC (Spearman) of trailing return vs forward return:

| Lookback → Horizon |     IC |    IR | t (naive) |
| ------------------ | -----: | ----: | --------: |
| 20 d → 20 d        | −0.180 | −1.09 |       −41 |
| 20 d → 5 d         | −0.171 | −1.07 |       −40 |
| 5 d → 5 d          | −0.129 | −0.77 |       −29 |
| 60 d → 20 d        | −0.129 | −0.72 |       −27 |

Split-sample stability (20 d → 5 d): first half **−0.170**, second half
**−0.169**. It is not a regime.

Forward 20-day return by trailing-20-day-return decile:

| Decile (worst → best past) |   Fwd 20 d |
| -------------------------- | ---------: |
| 1 (biggest losers)         | **+0.65%** |
| 2                          |     +0.51% |
| 3                          |     +0.41% |
| 4                          |     +0.36% |
| 5                          |     +0.27% |
| 6                          |     +0.22% |
| 7                          |     +0.12% |
| 8                          |     +0.04% |
| 9                          |     −0.04% |
| 10 (biggest winners)       | **−0.16%** |

Monotonic, every decile in order.

### The deployed rule is inverted

I replicated `scoreStock` with its real defaults (`minEntryScore 65`, `maxRsi 75`,
`overboughtSigma 2`) on hourly bars, evaluating at daily boundaries, and measured
forward returns of what the rule would have bought:

| Engine score bucket |   Fwd 20 d |     n |
| ------------------- | ---------: | ----: |
| 30–40               | **+0.61%** | 1,940 |
| 40–50               |     +0.47% | 2,777 |
| 50–60               |     +0.24% | 3,432 |
| 60–70               |     +0.13% | 4,222 |
| 70–80               |     +0.10% | 2,542 |
| 80–90               |     −0.13% | 3,591 |
| 90–100              | **−0.24%** |   524 |

The higher the score, the worse the next 20 days. The eligible set
(score ≥ 65, no flags) earns **−0.013%** over 20 days against a universe
**+0.191%** — a **−0.20 pp** selection penalty. Over 5 days it is −0.073% vs
+0.047%.

The flags make it worse, not better:

| Group                       |   Fwd 20 d |     n |
| --------------------------- | ---------: | ----: |
| Blocked by `negative_trend` | **+0.51%** | 4,875 |
| Blocked by `overbought`     |     +0.07% | 2,176 |
| Eligible (what it buys)     |     −0.01% | 7,655 |

The single most profitable group in the sample is exactly the group the rule
labels `negative_trend` and refuses to buy. The trend block
(`ema20 < ema50 && d30 < 0`) is a filter against the alpha.

This is the most important finding in the document: **the current momentum
scoring is not neutral, it is anti-predictive on 5.5 years of data**, with a
t-stat around −12 on the selection edge.

Caveat: the simulation uses the same feature formulas but on hourly bars and a
daily evaluation cadence; the live engine also has stops, trailing exits and a
20-day time stop. Those affect the distribution of outcomes but cannot flip the
sign of the selection edge. It should still be re-run against the paper engine's
actual decisions before changing production behaviour.

### What actually predicts

Daily cross-sectional IC vs forward 20-day return (whole universe):

| Feature                           |         IC |    t |
| --------------------------------- | ---------: | ---: |
| `zscore20` (below its 20 d mean)  | **−0.207** |  −45 |
| `mom5` (5 d return)               |     −0.167 |  −36 |
| `rel30` (30 d relative strength)  |     −0.169 |  −34 |
| `dd90` (drawdown from 90 d high)  |     −0.150 |  −32 |
| **7 d shares-outstanding change** | **+0.116** |  +25 |
| 30 d shares-outstanding change    |     +0.109 |  +23 |
| `vol60`                           |     −0.017 | −3.4 |
| price level                       |     −0.010 | −2.1 |

Within the bottom quintile, conditioning improves the edge monotonically:

| Split (bottom quintile, 5 buckets) |   Fwd 20 d, best bucket | Fwd 20 d, worst bucket |
| ---------------------------------- | ----------------------: | ---------------------: |
| z-score                            |  +0.89% (most oversold) |         +0.26% (least) |
| drawdown from 90 d high            |        +0.74% (deepest) |    +0.33% (shallowest) |
| 5 d momentum                       |  +0.93% (most negative) |         +0.36% (least) |
| 7 d shares-outstanding change      | +0.92% (highest inflow) |       +0.39% (outflow) |
| 30 d relative strength             |        +0.84% (weakest) |     +0.32% (strongest) |

The shares-outstanding feature is genuinely new information: it is the only
proxy for flow the API exposes, the engine currently stores `shares` only for
display, and it has an IC comparable to price momentum. A 7-day rise in shares
outstanding (net investment inflow) predicts reversion.

### What is forecastable: volatility

Volatility clusters, so it is predictable even though direction is not:

- `corr(log RV20, log RV5 forward) = 0.477`, OLS R² **0.228**.
- `autocorr(|r_t|, |r_{t−1}|) = 0.19`.

That is enough to size positions, set stop distance, and decide when a name is
too volatile to hold. The current engine derives ATR and a 20-day vol, but uses
them only in the risk score — not as a forecast.

---

## 3. What the backtest says (with caveats)

Daily bars, weekly rebalance, 0.1% sale fee on turnover, execution at the signal
close, long-only, equal weight:

| Strategy                             |      CAGR | Sharpe | Max DD | Fees (total) | Yearly (23/24/25/26)  |
| ------------------------------------ | --------: | -----: | -----: | -----------: | --------------------- |
| Buy & hold equal weight              |      5.2% |   3.60 |   1.3% |           0% | 7% / 5% / 5% / 2%     |
| Bottom-5 by 20 d return, weekly      | **22.6%** |   6.38 |   1.5% |          15% | 32% / 19% / 23% / 10% |
| Bottom-5 by 20 d z-score, weekly     |     21.2% |   6.41 |   1.7% |          20% | 30% / 16% / 17% / 15% |
| Top-10 oversold + flow + rel, weekly |     19.8% |   8.06 |   1.0% |          13% | 29% / 17% / 15% / 13% |
| Flow only (top-10 shares change)     |     14.3% |   6.34 |   1.8% |          15% | 19% / 11% / 11% / 11% |

Sub-period decay (bottom-5 by 20 d return):

| Period            | Buy & hold |  Reversal |
| ----------------- | ---------: | --------: |
| 2021-04 → 2023-01 |      10.1% | **61.1%** |
| 2023-01 → 2024-07 |       8.1% | **34.9%** |
| 2024-07 → 2026-11 |       4.1% | **17.7%** |

Every sub-period works; the magnitude is shrinking. That is what a maturing or
partially arbitraged edge looks like, and it is a reason to move sooner rather
than later.

**Caveats that must be resolved before this is trusted:**

1. **Execution.** I buy at the close of the signal day. The live engine would buy
   at the next minute (0–60 s later). At 0.45% daily vol that is small, but it
   must be simulated minute-by-minute, not assumed.
2. **Price impact.** Buying the five most oversold names will move them. Torn has
   no order book and no volume field, so impact can only be estimated from the
   fund's own fills. This is the biggest unknown in the whole analysis.
3. **Fees.** 0.1% per sale is included; the buy side is free. Rebalancing weekly
   already costs 4–5%/yr, which is why the more diversified monthly variants
   underperform on a net basis despite a higher gross edge.
4. **Smoothness.** A Sharpe of 6–8 and a 1.5% drawdown are not credible as a
   forward expectation. They are a consequence of a game whose price process is
   strongly mean-reverting and nearly uncorrelated across names. Expect
   materially worse live numbers.
5. **Third-party data.** Even with the validation above, the source can change,
   rate-limit, or disappear. Own the series you depend on.

---

## 4. What I think ML should do

Not "predict the price". Four jobs, in order of value:

### 4.1 Meta-label the reversal (first model)

The rule already generates candidates (bottom quintile / oversold + inflow). The
model answers one narrow question: **given this candidate, did it hit +2% before
−2% within 20 days, after the 0.1% fee?**

- Label: triple barrier (+2% / −2% / 20-day time), fee-adjusted, long-only.
- Features: `zscore20`, `dd90`, `mom5`, `mom20`, `mom60`, `rel30`, 7 d/30 d
  shares change, realised vol, ATR, distance to 52-week high/low, index regime,
  hour-of-day/day-of-week of entry.
- Model: **logistic regression or LightGBM**, calibrated (isotonic/Platt).
  Probabilistic output, never a hard BUY/SELL.
- Why it can work: the univariate edges are real (IC 0.10–0.21) but the
  interaction (deep dip + inflow + low vol) is not linear in a hand-written
  score. This is exactly the kind of low-dimensional, monotone-ish problem that
  gradient boosting handles well and deep learning does not improve on.

Baseline to beat is the rule, not the market: bottom-quintile expectancy is about
+0.6% per 20 days. If the model cannot lift the top decile of candidates above
that **out of sample and after fees**, it is not worth deploying.

### 4.2 Expected reversion magnitude (sizing)

A regression on the same features predicting the 20-day forward return (or the
+2% barrier hit time) lets you size by edge and by volatility, not by a fixed
risk budget. Combine with 4.3.

### 4.3 Volatility forecast (risk)

A HAR-style model on log realised vol (5/20/60-day components) to set stop
distance and position size. R² ~0.23 is available from persistence alone; a
small model should beat it. This is the least glamorous and most reliable use of
ML here.

### 4.4 Regime / cash allocation (lower priority)

With cross-correlation ≈ 0, "risk-on vs risk-off" is much less important than in
a real market. The equal-weight index is smooth. A regime model is only worth it
if it identifies the rare broad drawdowns; do not spend the first model on it.

### What not to do

- Do not predict next-minute or next-hour direction. ICs at 1 h horizons are
  −0.002 to −0.014; the signal-to-noise is not there.
- Do not use an LSTM/Transformer. 35 assets, 5.5 years, ~20 useful features. The
  data will not support it and it will overfit.
- Do not let a model override stops, drawdown halts, reserve, or position caps.
  The model adjusts or vetoes a rule signal; the risk overlay always wins.

---

## 5. Concrete plan

### Phase 0 — verify and re-sign the rule (2–3 days)

1. Backfill daily + 1-year hourly from tornsy into a scratch store.
2. Re-run the score-bucket table against **minute-level** execution with a 1–5
   minute delay, and against the paper engine's actual historical decisions.
3. If the inversion holds, change the signal: drop the `negative_trend` block,
   stop buying momentum, and make oversold + inflow the entry condition.
4. Keep the existing risk overlay unchanged.

This phase needs no ML and is likely worth more than the model.

### Phase 1 — own the data (1 week)

1. Persist a raw 1-minute tick per stock per collector poll (new table, or add
   `interval_minutes = 1` with a retention policy). ~50k rows/day.
2. Backfill 18 months of `m1`, full `h1`, full `d1` from tornsy.
3. Keep `capital_market_candles` for 1 m / 5 m / 60 m / 1 d aggregates; add a
   `samples` sanity column (already present) and a gap report.
4. Add a validator that compares the backfilled year-ago price and all-time
   high/low against `/torn/{id}/stocks` `performance` on every ingest.
5. Record `total_shares` history — it is the only flow feature available.

### Phase 2 — dataset builder and baselines (1–2 weeks)

1. One row per `(decision_time, stock_id)` at the engine's decision cadence.
2. Triple-barrier labels, fee-adjusted, purged and embargoed walk-forward; never
   a random split.
3. Baselines first: buy & hold, the current rule, the simple reversal rule,
   equal-weight.
4. Then logistic/ridge, then LightGBM. Report net Sharpe, MaxDD, turnover,
   Brier/log loss, calibration curve.
5. Pre-register the feature list and label definition before looking at the
   holdout.

### Phase 3 — shadow (8–12 weeks)

Run predictions with no effect on orders. Compare predicted vs realised, monitor
IC and calibration drift. Only then consider a capped live weight (≤20–30% of the
score), behind a kill switch.

### Data model (suggested)

```
capital_ml_models       id, version, trained_at, data_range, feature_spec,
                        metrics jsonb, artifact_ref, active
capital_ml_predictions  id, created_at, stock_id, model_version, horizon,
                        probability, expected_return, expected_vol, feature_hash
capital_ml_outcomes     prediction_id, realised_return, barrier_hit, evaluated_at
capital_ml_runs         id, kind, started_at, finished_at, gate_results jsonb
```

Operational controls: `ml_enabled`, `ml_weight`, `ml_min_confidence`,
`ml_max_allocation`; automatic disable on rolling IC / calibration / drawdown
breach; monthly or quarterly retrain, never online learning.

### Gates before deployment

1. **Data**: ≥180 days of owned 5 m/1 m bars after backfill, no unexplained
   multi-hour gaps, backfill validated against Torn anchors.
2. **Skill**: beats both the simple reversal rule and the current rule out of
   sample, after the 0.1% fee and a 1–5 minute execution delay, with confidence
   intervals excluding zero.
3. **Calibration**: Brier/log loss acceptable, reliability curve close to the
   diagonal (calibration error < 0.05).
4. **Risk**: drawdown and turnover no worse than the simple rule.
5. **Shadow**: 8–12 weeks, stable calibration, positive relative performance.
6. **Capped deployment**: ≤20–30% weight, risk overlay unchanged, kill switch
   armed.
7. **Monitoring**: weekly IC, hit rate, calibration, feature drift, live-vs-
   backtest divergence.

---

## 6. Risks and failure modes

| Risk                      | Why it matters here                                                              | Mitigation                                                                        |
| ------------------------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **Game algorithm change** | The edge is a property of Torn's price process. A patch can remove it overnight. | Monitor rolling IC; kill switch; retrain on a fixed cadence.                      |
| **Third-party data**      | tornsy can change, rate-limit, or vanish.                                        | Own the series; use tornsy only at ingest; validate against Torn anchors.         |
| **Execution lag**         | Signals are evaluated on a minute cadence but the desk is manual.                | Simulate 1–5 min delay; measure live slippage from fills.                         |
| **Price impact**          | No order book or volume data; the fund's own flow moves the price.               | Cap position size vs market cap; measure impact from `capital_fills`.             |
| **Overfitting**           | 35 assets, 5.5 years, many candidate features.                                   | Purged walk-forward, pre-registration, deflated Sharpe, one holdout.              |
| **Decaying edge**         | CAGR fell 61% → 35% → 18% across sub-periods.                                    | Re-estimate quarterly; do not extrapolate the early sample.                       |
| **Regime shift**          | A future Torn update or real-world event changes the process.                    | Drift monitoring; retrain; cash is a valid position.                              |
| **Model risk**            | A confident model overrides a risk limit.                                        | The overlay always wins; model can only adjust or veto.                           |
| **Data discontinuity**    | Splits/merges or missed polls create fake returns.                               | Corporate-action adjustment; gap-aware features; never forward-fill long outages. |

---

## 7. Open questions for the owner

1. Is the fund's capital large enough relative to stock market caps that price
   impact matters? That determines whether the 22% backtest is even reachable.
2. Are you willing to depend on `tornsy.com` for backfill, or should we only use
   it once and keep the result?
3. Should the engine's signal be changed before any ML work, or do you want the
   ML model to be evaluated against the current rule as-is?
4. Is hourly cadence enough, or do you want minute-level decisions? (Minute-level
   increases turnover and fee drag without adding much IC at 1 h horizons.)
5. What is the acceptable drawdown for the fund? The backtest's 1.5% is not a
   planning number.

---

## 8. Reproducing this

- Torn checks: `GET https://api.torn.com/v2/torn/stocks?key=…`,
  `GET https://api.torn.com/v2/torn/1/stocks?key=…`.
- History: `GET https://tornsy.com/api/TSB?interval=m1&limit=2000&to=…`, page
  backwards with `to` until empty.
- The existing audit (`bun run capital:ml:audit`) reads only the local candle
  store; it will keep reporting "not trainable" until Phase 1 lands the backfill.
- Scratch analysis used daily and hourly bars for all 35 stocks plus TCSE, and a
  faithful port of `scoreStock` from `packages/utils/src/capital-signals.ts`.
  If useful, those can be committed as `scripts/capital-ml-backfill.ts` and
  `scripts/capital-ml-research.ts` so the numbers are re-runnable in CI.
