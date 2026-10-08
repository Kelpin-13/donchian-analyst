# Design notes — why the system works the way it does

Read this before changing the strategy, backtester, lab, agent or panel. Every
number below matches `Config.js` at the time of writing; if you change one, update it here.

The full human-facing guide (install steps and click-by-click walkthroughs) lives at
https://claude.ai/code/artifact/384d8bf0-0342-4cd2-b8be-8608a6b7b41a — this file is the
distilled version for working on the code.

---

## 1. The core idea: two brains, strictly separated

| Layer | Decides | Implemented by |
|---|---|---|
| Rules engine | Whether a signal fires | Plain JS, `decideAtBar_()` in `Strategy.js` |
| Analyst / agent | Nothing. Describes, investigates, grades | Claude via the API |

| AI gate (shadow) | Nothing. Records what it *would* have done | Claude via `AiGate.js` |

The model never generates, approves or vetoes a signal. Its job is to write a
**falsifiable** note (setup, invalidation, what to watch) and later grade that note
against what happened. Keep it that way: an LLM deciding trades can't be backtested.
The AI gate (§13) is the one place a model gives a trade opinion, and it is shadow-only
for exactly this reason.

## 2. Strategy (v1, long-only Donchian breakout)

```
Regime   close > EMA(100)                         -> longs allowed
Entry    close > highest high of the PRIOR 20 bars
Stop     entry - 2.0 x ATR(14) at entry, checked on the CLOSE
Exit     close < lowest low of the PRIOR 10 bars
Time     exit after 60 bars
Size     risk 1% of current equity / (entry - stop), capped at 100% exposure
```

Exit priority is stop, then channel, then time. Candles are 4h BTC-USD from Coinbase.

Optional entry filters in `entryBlockedBy_()`, **all off by default**:
`skipWeekendEntries`, `minVolumeRatio` (vs average volume of the prior `breakoutLookback`
bars), `minAtrPct`, `maxAtrPct`. They exist for the lab to test.

Observed behaviour worth knowing: the 10-bar channel exit is usually tighter than the
2×ATR stop, so the stop mostly binds only on single-bar gaps. Those gaps also produce
trades with R below −1, because the stop is checked on the close, not intrabar.

## 3. Correctness rules (look-ahead)

- **Closed candles only.** `trimToClosed_()` drops any bar whose open + interval is in the future.
- **Channels exclude the current bar** (`donchian_()` looks at `[i-period, i-1]`). If the
  current bar were included, "close above the 20-bar high" would be near-trivially true.
- **Signals decide on bar close; fills happen at the next bar's open** in the backtest
  (`fillAt: 'next_open'`). `'close'` exists only as a comparison experiment.
- **Coinbase has no 4h candle.** `Data.js` fetches 1h candles and merges them on UTC
  boundaries (00/04/08…), matching TradingView's `COINBASE:BTCUSD` 4h chart. Fetch start
  is aligned to a bucket boundary so the oldest bar isn't partial.
- **Same exchange everywhere.** Live feed, backtest history and TradingView chart all use
  Coinbase BTC-USD. Different exchanges print different highs and a breakout rule fires on
  different bars.

## 4. One strategy function

Live monitor, detailed backtest, sweep, walk-forward, Monte Carlo, lab and the paper-vs-
backtest comparison all call the same `decideAtBar_(candles, series, i, state, params)`.
`computeSeries_(candles, params)` and `decideAtBar_` take optional `params`, defaulting to
`CONFIG.STRATEGY`. Verified property: driving `runMonitor` bar by bar produced exactly the
same signals as `simulate_` over the same bars. Never fork the rules for one caller.

State flips on the **signal** bar (`applySignal_`), in live, backtest and Pine alike.

## 5. Backtesting (`Backtest.js`)

`simulate_()` engine: next-open fills, fee 0.10% and slippage 0.05% per side, sizing from
equity at the signal close, exposure cap, optional `closeAtEnd` for walk-forward windows.

| Stage | Function | Rule / setting |
|---|---|---|
| History | `buildHistory`, `updateHistory` | 1095 days from Coinbase into the History sheet; weekly run appends new bars only |
| Detailed | `runDetailedBacktest` | Full metrics: CAGR, max DD + duration, MAR, Sharpe, Sortino, PF, payoff, avg R, exposure, fees |
| Sweep | `runSweep` | breakout {10,15,20,30,40,55} × stop {1,1.5,2,2.5,3}; plateau check vs the 8 neighbouring cells |
| Walk-forward | `runWalkForward` | tune on 1,500 bars, test on next 500, slide by 500; objective = return ÷ max DD; ≥5 trades; WFE = mean OOS log-rate ÷ mean IS log-rate |
| Monte Carlo | `runMonteCarlo` | 2,000 runs, seed 42; shuffle (order luck in drawdown) + bootstrap (outcome range); needs ≥10 trades |
| TV compare | `compareTvTrades` | matches entries to a TradingView trade-list export; skips first 500 bars (indicator seed differences) |
| Live decay | `compareLiveVsBacktest` | backtests exactly the paper account's period with its own costs |

`AutoBacktest.js` runs every stage weekly (Sunday 09:00 KL) inside a 4.5-minute budget,
appends one row to **BT_Log** (never overwritten), and applies the verdict rules:

| Result | Verdict |
|---|---|
| Profit factor < 1, OR walk-forward fixed-param return < 0, OR WFE < 30% | FAILS |
| < 2 years of history OR < 30 trades | CAN'T JUDGE YET |
| Trails buy & hold with MAR < 0.5, OR sweep spike, OR MC 95th-pct DD > 25% | PASSES WITH WARNINGS |
| None of the above | PASSES SO FAR |

Thresholds live in `CONFIG.BACKTEST` and are meant to be set **before** looking at results.

## 6. Research lab (`Lab.js`)

Purpose: let the strategy improve without curve-fitting. Test enough variations on one
dataset and some will look great by luck; the lab exists to stop that.

- **Split never moves:** ~300 warm-up bars (unscored) → research period → **locked holdout
  = most recent 365 days**. Experiments never see the holdout.
- **Three tests, all required** on the research period, candidate vs current live strategy:
  1. Score (return ÷ max DD, floor 1) improves ≥10%.
  2. Wins ≥ 67% of 6 time blocks (per-block returns from one equity path).
  3. Neighbours: each changed number ±~20% (int step `max(1, round(0.2v))`) must
     **strictly beat** the baseline in ≥ 2/3 of cases. Ties don't count — a bug here once
     let spikes through.
- **Verdicts:** IMPROVES, FRAGILE (better but inconsistent or a spike), NO BETTER, WORSE,
  TOO FEW TRADES (< 30).
- **Whitelist `LAB_ALLOWED`:** breakoutLookback 5–100, exitLookback 3–60, atrPeriod 5–50,
  stopAtrMult 0.5–5, trendEmaPeriod 20–300, maxBarsInTrade 10–200, skipWeekendEntries bool,
  minVolumeRatio 0–3, minAtrPct 0–10, maxAtrPct 0–20. **Risk per trade is deliberately
  excluded** — raising risk inflates backtest returns without improving the strategy.
- **Claude proposals** land as `PROPOSED` and do not run until the owner sets `QUEUED`.
  Invalid keys and duplicates are rejected.
- **Promotion** is menu-only: one holdout test (counter `LAB_HOLDOUT_USES`), then a yes/no
  dialog. Accepted overrides go to Script Property `LIVE_STRATEGY`, layered over
  `CONFIG.STRATEGY` at load time; `Config.js` is never edited. Revert removes the layer.
- Every experiment increments `LAB_TRIED` so the number of tries behind any "winner" is visible.

On synthetic test data none of the 16 starter experiments reached IMPROVES (three were
FRAGILE). That is the expected behaviour, not a bug.

## 7. Live operation

`runMonitor` (every 15 min, script lock held):
1. Skip without fetching unless `now >= lastBarProcessed + 2 × interval` (~6 fetches/day).
2. Act once per closed candle (`lastBarProcessed` guard).
3. On a signal, **commit state first**, then crosscheck + paper fill (fast, price-sensitive),
   then the slow agent note, then journal + alert. A crash after step 3 cannot re-fire it.
4. Paper equity snapshot once per bar.

Paper account (`PaperBroker.js`): fills at the live ticker ± slippage with fees; sizing
uses the actual fill vs stop; capped by exposure and cash. Parity check: over 1,000 test
bars paper and same-period backtest made the same 10 trades, 0.07 pts apart.

Grader: 12 bars after each signal, the note is graded accurate / partly_accurate / wrong /
**unfalsifiable** (a note vague enough to be right either way — a prompt problem).

## 8. Agent (`Agent.js`)

Tool loop, max 6 turns, every call written to the Trace sheet. Tools are **read-only**:
market snapshot at any timeframe, price history, past signals, recent lessons, position
state. The tool list is the security boundary — no tool may place orders, edit config or
write signals. Tool errors return `{error}` to the model instead of crashing. On any
failure the note falls back to the one-shot `writePreTradeNote_`.

## 9. External inputs and the web panel

- `doPost` (`Webhook.js`) routes TradingView and Telegram. Apps Script can't read headers,
  so authentication is a secret inside the JSON body, compared with `safeEqual_`.
- **TradingView is a witness, not a decision-maker.** Its alerts only write Crosscheck rows;
  only Apps Script trades. Rows become MATCH when both engines report the same bar;
  `reconcileCrosscheck_` flags one-sided rows after 2 bars. (Free TradingView has no
  strategy alerts; this is off by default.)
- Telegram: dedupe on `update_id` (Apps Script answers POSTs with a 302 and senders may
  retry), questions queued and answered from a one-off trigger.
- **Panel** (`Dashboard.js`, `DashboardPage.html`): five tabs, read-only. The Live tab has a market
  switcher: the live strategy, or any enabled challenger market (e.g. gold) drawn the same way from
  its paper book (`getDashboardData(k, marketId)`). Challenger candles are cached until the next bar
  can close and the price for 5 minutes, so a panel left open all day stays near 300 Twelve Data
  requests (free plan: 800/day). The choice is remembered per browser. Every endpoint calls
  `requireKey_()`; `google.script.run` can't return Dates, so all cells go through `cell_()`.
  State-changing actions stay in the sheet menu behind Google login.

## 10. Platform constraints that shaped the design

- 6 min per execution, 90 min trigger runtime per day (consumer account), 20 triggers.
  4h candles + early exit keep the monitor at a few minutes a day.
- Web app `/exec` serves a frozen version; `/dev` serves latest saved code but only for the
  owner's logged-in account. Triggers always run latest saved code. Max 200 versions per
  project — which is why redeploy-on-every-save was rejected.
- A deployment must be type **Web app**, not Library.
- The HTML file is `DashboardPage`, not `Dashboard`, to avoid clashing with `Dashboard.js`.
- Menu items can't call functions ending in `_`; use a public wrapper (e.g. `resetBotState`).
- Binance often returns HTTP 451 to Google's IPs; Kraken's API serves only 720 bars.

## 11. Pine parity (`donchian_analyst.pine`)

Mirrors the rules exactly, including state flipping on the signal bar via its own `inTrade`
variable, close-based stop, and exit priority. It does **not** have the four optional
filters. Pine seeds EMA/ATR slightly differently, so the first ~500 bars may disagree;
after that, disagreement means a bug or a data mismatch.

## 12. How changes were verified during development

A Node harness with Apps Script mocks (SpreadsheetApp, PropertiesService, UrlFetchApp,
etc.) and seeded synthetic regime-switching price data. Checks that should be re-run after
related changes: indicator arrays align with candles; Donchian excludes the current bar;
EMA seed = SMA; state machine never double-enters; live monitor signals == backtest
signals; ledger reconciles with equity; no hidden leverage; filters-off parity; lab
verdict paths; every panel endpoint rejects a wrong key; no Date objects in panel payloads.
These now live in `tests/` (`node tests/run.js`, offline, ~45 s): a fake Apps Script world whose
UrlFetchApp serves Coinbase and OANDA responses from seeded synthetic prices, so the real data
adapters run. It checks live/challenger isolation, book reconciliation, no look-ahead, gold's
weekend handling, the AI gate, history, web-app links and the per-market backtest.
`--against <git ref>` also proves the live strategy's signals, fills and equity match that
commit. Each check was confirmed to fail when the code it guards is deliberately broken.

## 13. AI gate (`AiGate.js`) — shadow only

Source idea: a rules strategy with one "thinking if" — enter only when the rules fire AND a
fast model answers `{"action":"buy","conviction":≥X,"risk_flag":<Y}`; stops and exits stay
with the rules; a high risk score may argue for an early exit. "Rules manage the money, the
AI handles the reflexes."

What is built: on every rule entry bar and every bar while LONG, `runMonitor` asks Claude
(`CONFIG.GATE.model`, effort `low`, structured output with a JSON schema) for those three
fields, and logs them to the **Gate** sheet with what the gate *would* do:

```
FLAT + rule entry  -> ALLOW_ENTRY if action=buy, conviction >= 1.0, risk_flag < 0.5, else BLOCK_ENTRY
LONG, no signal    -> EXIT_EARLY  if action=sell and risk_flag >= 0.7, else STAY
```

When the trade closes, its real R is written to every Gate row of that trade (`FinalR`).
`showGateReport()` compares avg R of would-allow vs would-block entries, and R at the
first early-exit flag vs the rule exit. It refuses a verdict below 20 closed trades.

Why shadow, not live:
- **No honest backtest.** The model has seen BTC's history, so replaying past bars through
  it leaks the future. Forward logging is the only clean evidence. The snapshot carries no
  dates, but the price level alone can identify the period.
- **One strategy, Pine parity.** A live veto would make live differ from `decideAtBar_`, the
  backtest, the lab and the Pine script, and TradingView would flag every vetoed entry.
- Turning it into a real vote would be a new decision for the owner, with the §1 rule
  rewritten deliberately — not a config flip. `mode` only takes `'shadow'` or `'off'`.

Safety properties (verified with mocks): the gate never writes `BOT_STATE` or the paper
account; any API error or refusal becomes a `NO_VERDICT` row and the monitor carries on;
bar-by-bar monitor output with the gate on equals the output with it off (same signals,
state and paper account). Refusal fallback (`fallbacks: "default"`) is enabled.

Cost: one call per entry plus one per 4h bar in a trade — a few calls a day at most.

## 14. Challenger (`Challenger.js`) — multi-market

The live strategy trades BTC 4h only: 2–3 signals a month. The challenger runs the same
`decideAtBar_()` (with `CONFIG.STRATEGY + CHALLENGER.overrides`) on every enabled market in
`CHALLENGER.markets`. The owner's focus is **gold and major FX pairs** (XAU/USD, EUR/USD,
GBP/USD, USD/JPY, AUD/USD via Twelve Data). Six crypto markets stay listed but off: their
Oct 2023 – Sep 2026 backtest (untuned rules) was profitable on all six, +36% equal split, but
trailed buy & hold (+166%). **Every market starts `enabled: false`** and is switched on only after
its row in MM_Backtest has been reviewed — the rules were built and tested on crypto, not FX.

- One $1,000 paper book per market (`CH_PAPER_<ID>`), own position state (`CH_STATE_<ID>`), own
  start (`CH_START_<ID>`). The total is the equal-weighted average of the markets' returns, the
  same way the backtest combined them. Fills use the market's own price.
- Per-market costs (`feePct`, `slippagePct`) replace PAPER/BACKTEST costs. Gold and FX are
  spread-only on most brokers (0.01–0.02% per side assumed); crypto keeps 0.10% fee + 0.05% slip.
  Overnight swap/financing on CFDs is **not** modelled.
- Exposure stays capped at 100% of the book (no leverage). On FX a 2×ATR stop is often < 1% of
  price, so the 1% risk budget would need > 100% exposure and is capped: FX trades risk less
  than 1% and returns look small. Judge FX on profit factor, win rate and avg R, not % return.
  Allowing leverage is an owner decision, not a tuning knob.
- `PaperBroker.js` takes an optional book (with a `tag` → leading Market column, so every market
  shares MM_Trades / MM_Equity; and optional `feePct` / `slippagePct`), risk % and live price.
  The live account passes none of them.
- Renaming the challenger, or changing its interval or overrides, clears all `CH_` keys and starts
  a new comparison. Switching a market on later does not.
- Twelve Data: `/time_series` (4h, `timezone=UTC`, `order=ASC`, up to 5000 bars ≈ 3.2 years of 24/5
  data in one call) and `/price`. The key travels in the `Authorization: apikey …` header, never the
  URL. Errors arrive as HTTP 200 with `status: "error"`; `twelveGet_` treats both as errors. Free
  plan: 800 requests/day, 8/minute — the challenger needs ~6 a day per market. Whether the free
  plan serves 4h bars for XAU/USD was unconfirmed when built: Check installation fetches them.
- OANDA v20 is kept as an option (`provider: 'oanda'`), but OANDA Global Markets accounts are
  MT5-only and get no v20 token.
- Gold and FX are 24/5: no weekend bars; when no new bar has closed a market backs off 30 minutes.
- No agent note, AI gate, alert or cross-check: paper and log only.
- `challengerBacktest()` (menu) backtests every listed market, enabled or not, over 3 years into
  MM_Backtest, each with its own costs. It is how a market is vetted before it is switched on.
- `challengerWalkForward()` (menu) runs the live strategy's walk-forward engine (`walkForward_`,
  shared with `runWalkForward`) on each enabled market, with its own costs and as much history as
  one provider call gives (Twelve Data: 5000 4h bars, ~6 folds of 1500 train / 500 test bars).
  Pass rule = the weekly backtest's: current settings make money on unseen data and WFE ≥
  `BACKTEST.minWfePct`. A market needs HOLDS UP here before it is considered for live.

Switching live to multi-market is the owner's call, after the comparison and a review of
MM_Backtest — and it would need multi-symbol state in the live monitor, journal and Pine charts.
