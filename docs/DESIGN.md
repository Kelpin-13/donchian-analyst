# Design notes — why the system works the way it does

Read this before changing the strategy, backtester, lab, agent or panel. Every
number below matches `Config.js` at the time of writing; if you change one, update it here.

Install steps and day-to-day running are in `docs/OPERATIONS.md`; this file is the
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
- Overnight swap (CFDs): per market `swapLongPctYear` (+ `swapDays`, `rolloverHourUtc`). MT5
  "percentage, current price" swap: units × price × rate ÷ 360, charged on the bar containing the
  rollover (21:00 UTC ≈ broker server midnight) on each listed weekday. Gold: −5.92%/yr, Mon–Fri
  once each, from the OANDA MT5 `XAUUSD.sml` specification. `swapForBar_()` is the one rule; the
  backtest (`simulate_`, off by default, so BTC is unchanged), walk-forward and the paper book
  (`paperChargeSwap_`) all use it, and it is part of each trade's P&L and R.
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

## 15. Morning map (`Morning.js`) — zones as a map, not signals

The owner asked (30 Oct 2026) for a daily phone message with supply and demand zones from a higher timeframe
and "high-probability" entries on a lower one. What was built, and why it looks the way it does:

- **The evidence first.** `research/supply_demand.js` (classic base zones on M15/H1, settled on M1 data) and
  `research/sd_lab.js` (69 versions collected from public sources: classic base zones on H1/H4, smart-money
  order blocks on H1/H4, fair value gaps on M15/H1; limit, rejection-candle and change-of-character entries;
  with and without the H4 trend; session, displacement, structure-trend and liquidity-sweep variants) found
  no supply-and-demand entry that passes the project's test. The only design-half candidate (H4 order blocks,
  limit at the block, with the H4 trend: 2023-24 PF 1.58, +27R) made -1R on 2025-26 (PF 0.99). Fair value
  gap limit entries lose heavily: tiny stops are eaten by the spread. So the message never calls a zone a
  signal or "high probability"; it says so in the text.
- **What it sends** (07:30 script time, Monday-Friday, only while gold trades): the 4-hour trend (EMA 100 of
  the broker's 4-hour bars), the nearest standing 4-hour order blocks (up to 3 above and 3 below, fresh or
  tested), the levels the EAs actually trade today (Dual Thrust from the intraday EA's DAY line in MT5 Log;
  the H4 EA's 20-bar breakout levels, computed from the same bars), the day's strategy times in the owner's
  clock, and a warning when an EA has not been heard from for an hour.
- **Order blocks** were chosen for the map because they are the standard definition in public tools
  (LuxAlgo / smart-money concepts), so the owner sees the same kind of zone on TradingView, and their record
  was the least bad. The rule is `orderBlocks()` in `research/sd_lab.js`; `morningOrderBlocks_()` must find
  the same zones (tests/run.js checks). A zone dies when a 4-hour bar closes beyond its far edge.
- **Bars match the broker:** Twelve Data's hourly XAU/USD is grouped into 4-hour bars on the broker's clock
  (New York + 7 h; UTC+3 in US summer time, UTC+2 otherwise), the same boundaries as MT5 and TradingView.
  Prices differ from the broker's by cents to about a dollar. Twelve Data also sends flat hourly bars while
  gold is shut (seen in the first live picture: flat weekend stretches, and an EMA 100 of 4078.8 against the
  broker's ~4102); `morningTrading_()` keeps only Monday 01:00 to Friday 24:00 broker time outside the
  00:00-01:00 break, and only bars with a range. Without that the map would also go out on weekends.
- **Picture:** Google's Charts service (a line chart of 4-hour closes with each zone's two edges). No
  third-party chart service: nothing leaves Google and Telegram. If the picture fails the text still goes.
- **Telegram:** the chat ID lives in Script Property `TELEGRAM_CHAT_ID` (set by Connect Telegram from the
  bot's latest private message), not in `Config.js`, so the public repo never holds it. The agent's
  Telegram handler and the old alerts read it through `telegramChatId_()`. Errors from the Bot API carry
  Telegram's description, never the URL (it contains the token).

## 16. Fixed trade size (owner decision, 30 Oct 2026)

Both EAs trade a fixed size, `InpFixedLots` = 0.01 lots (1 ounce), never below 0.01: they refuse to start
with a smaller non-zero value. `InpFixedLots` = 0 brings back the earlier percent sizing, with its inputs and
its ceilings. A fixed size over the leverage cap is not traded rather than cut. Entries, stops and exits are
unchanged, so results in R stay comparable; dollars do not.

What it changes. Stops are from the tester trades of April-October 2026; "size before" is what percent sizing gives on a $10,000 account at the median stop:

| Strategy | Size before | Median stop = cost at 0.01 lots | 90th percentile | Largest |
|---|---:|---:|---:|---:|
| New York opening range | 0.006 | $20 | $29 | $44 |
| Asian range breakout | 0.007 | $33 | $39 | $62 |
| Dual Thrust | 0.001-0.002 | $126 | $207 | $256 |
| R-Breaker | 0.004 | $52 | $61 | $80 |
| Momentum at 16:00 | 0.002 | $53 | $74 | $92 |
| Momentum at 20:00 | 0.004 | $52 | $71 | $92 |
| H4 swing (2 x ATR; broker stop at twice that) | 0.013 | $74 | $90 | $152 |

- Risk now follows the stop's width, not the account. Dual Thrust grows about 5x and carries the largest risk:
  one stop can pass the 2% daily limit, which only blocks new trades. H4 shrinks by about a quarter.
- Three things no longer apply at a fixed size: the half-risk weights on New York opening range and Momentum
  at 16:00 (chosen on 14 Oct to cut the 2015-22 drawdown), the 1% and 2% per-trade ceilings, and Dual Thrust
  sitting out days when its stop is too wide for the smallest size.
- The size does not change as the account grows or falls, and the same 1 ounce is a far bigger bet at $4,000
  gold than it was at $1,000.
- Replaying the tester's intraday trades at 0.01 lots from $10,000 (closed trades, with the 2% daily limit;
  percent sizing in brackets): 2008-14 +29.7% and 3.7% drawdown (+66.9%, 10.7%); 2015-22 +4.2%, 6.9% (+2.8%,
  17.7%); 2023-26 +37.7%, 5.8% (+31.2%, 6.7%); April-October 2026 +6.7%, 5.7%, worst day -$233 (+2.3%, 2.4%,
  -$63). The older periods flatter it because their stops were small in dollars; the last is closest to today.
  The H4 EA's tester journals were not kept, so its dollars are not in this replay.

## 17. Take-profit on every strategy (owner decision, 30 Oct 2026)

Every order now carries a take-profit at the broker, so a trade can bank a gain even with the EA off. The level is
a multiple of the trade's stop distance, set by inputs (0 = none) and chosen on 2023-2024 only, per strategy, as the
best total R / drawdown R (`research/tp_lab.js`):

| Strategy | Take-profit | Reached, 2025-26 | PF 2025-26, no target -> target |
|---|---:|---:|---:|
| New York opening range | 4R | 2% | 1.07 -> 1.08 |
| Asian range breakout | 1.5R | 26% | 0.87 -> 1.07 |
| Dual Thrust | 1.5R | 1% | 1.63 -> 1.68 |
| R-Breaker | 3R | 0% | 2.03 -> 2.03 |
| Momentum at 16:00 | 1.5R | 6% | 1.25 -> 1.20 |
| Momentum at 20:00 | 1.5R | 1% | 1.26 -> 1.25 |
| H4 swing | 1.5R (3 x ATR), then waits | 53% | 1.93 -> 2.08 |

H4 needs the wait. Without it 84 of its 107 targets were followed by a new trade the same way within two bars, the
same breakout bought again at a worse price, and the portfolio's drawdown rose from $959 to $1,214. After a target
that side now waits for a close back inside the 20-bar channel. This rule was added after seeing that on all the
data; only its level was chosen on 2023-2024 alone. Dual Thrust stops for the day after a target, as it does when
it runs out of trades, so its reversal order is cancelled at once.

At 0.01 lots, 2025-2026, the whole portfolio without and with the targets: PF 1.23 -> 1.28, +$3,136 -> +$4,698,
drawdown $959 -> $986, worst day -$428 -> -$268, worst trade -$212 both ways. 2023-2024: PF 1.21 -> 1.23, +$1,478 ->
+$1,512, drawdown $415 -> $368, worst day -$67 -> -$83.

- A target does not limit a loss: the stop does, which is why the worst trade does not move. The lever for that is
  the stop's size. Skipping trades whose stop costs over $150 (40 of 2,690) takes the worst trade to -$127 and the
  drawdown to $739; built on 4 Nov (section 19).
- The levels were tested on 2023-2026 only, the bars the research has. The 18-year figures in `Mt5.js` come from
  tester runs without targets, until the older eras are run again.
- The H4 tester run now needs "1 minute OHLC", so the target fires inside the bar as it does live.

## 18. Market closed: nothing is resent until gold has a new quote

Gold shuts for the daily break and the weekend. Both EAs used to resend a refused order on every tick and every timer
event until its bar ended, and no bar can end while no quotes come. Attached on Saturday 31 Oct 2026 at 13:05 local
with a short signal pending, DonchianGold sent a market sell every 30 seconds, about 5,000 until Monday. And its stop
and target came from the current bid and ask, so a timer event after the reopening but before the first tick priced
them from Friday, and that order would have been accepted.

The rule, in both EAs: at start-up and after a "market closed" reply nothing goes out until gold has a quote newer
than the last one seen (`WaitingForQuote()`, `NoteRefusal()`). The order stays pending meanwhile. On the first Monday
tick the old signal is dropped with a SKIP row and the newest closed bar is decided afresh, as before. Exits stay
pending until they are done, and GoldIntraday holds its stop orders and cancels back the same way.

- It reads gold's own quote time on purpose. `TimeCurrent()` stands still at Friday's last tick over a weekend, so
  a session check on it reads "open", and during gold's daily break other symbols' quotes can move it. The session
  table does not know holidays either: 30-odd days in 2023-2026 ended early (last bar 19:58 to 21:43 server).
- Only "market closed" waits. Any other failure, and any send with no such reply before it, works as before.
- Quotes can come before orders do: in the tester, history up to Feb 2024 starts at 01:03 while orders open at 01:05.
  Those entries are resent once per new quote and fill at 01:05:00, in the same bar. A fixed back-off would have moved
  those fills.
- **Strategy Tester: use "1 minute OHLC".** "Open prices" has no tick between bar opens, so what is refused at the
  00:00 bar can no longer fill at 01:05 on a stale quote, as it used to. Those entries now end in a SKIP row and those
  exits wait for the 04:00 bar.
- `tests/mql.js` runs the EAs' own MQL5 functions in Node against a fake broker, for the timelines the tester can't
  stage. Fed the real M1 history 2023-2026 that way, the old and new builds made the same trades at the same times and
  prices; that replay matched the real tester run's entries at 100% (H4) and 99.8% (intraday) of them. Only the wording
  moves: fewer failed attempts in an exit row, and in GoldIntraday one ERROR row per closed market, not one per strategy.
- DonchianGold writes the decided bar and a pending entry to disk at once, so a crash cannot decide that bar again. It also waits up to a minute for a position's closing deal to reach the terminal, because the wait after a take-profit depends on seeing it.
- **DonchianGold skips an entry it missed.** More than 15 minutes after its bar's first price, an entry ends in a SKIP
  row instead of an order, whether it is a new decision or a retry. Exits always go, and the next bar decides as usual.
  7 of the first 23 live decisions came over an hour late, after the PC or MT5 had been off, one by 239 minutes; the
  research only measures entries at the bar's first price, and GoldIntraday never chased. It is measured from the first
  M1 bar inside the bar, because the open time misleads: the 00:00 bar's first price comes about an hour later. The
  longest genuine wait in 2023-2026 is 2 minutes, so a run with no restarts should not change: in the replay every bar
  is decided within a minute of its first price. A closed market is asked about first, so a pending entry over a weekend
  still waits for Monday's SKIP row. Price moves little from the fill in that time (typically 0.07 of the stop after 15
  minutes, 0.25 after 4 hours, on the 199 entries of 2023-2026) and its average drift is close to zero, so this keeps
  live trading on the tested rules; it is not a measured gain.
- **Both EAs give MT5 a minute to catch up.** After a start, a sleep (no `Run()` for over 90 seconds) or a lost
  connection, nothing that reads bars runs for 60 seconds, or longer if `SERIES_SYNCHRONIZED` says MT5 isn't done, up to
  5 minutes. Of DonchianGold's 18 live decisions that could be checked against the full history, 3 used holes: 2 in the
  very second it started (29 Oct 2026, after 13 days off: channel low 4015.9, really 3988.9; EMA 4172, really 4102) and 1
  straight after a sleep (EMA 0.7 off). No order came from them, but any could have. GoldIntraday works out a day's levels
  once and keeps them all day, so a hole at that moment would last until the next day: at that same start its Dual Thrust
  levels were 4017.108-4114.212, really 4019.820-4111.500, put right only by a reload 18 seconds later. That also shows
  how quickly those 13 days were filled. The time comes first because the flag alone can't be trusted: forum tests show
  it reading true with data missing. What reads no bars never waits: an exit already decided, the kill switch, reports of
  fills and outside closes, and in GoldIntraday flat at 23:00. An exit that still needs a bar's numbers waits with the
  broker's stop in place, and GoldIntraday's resting orders are left alone until then. The tester skips all of this. Fed
  the M1 history with the timer running, each EA's live path made the same journal as its tester path. A real restart
  has not tested it yet.

## 19. A $150 stop cap, and every take-profit from the fill (owner decision, 4 Nov 2026)

**The cap.** Neither EA takes a trade whose stop would cost more than $150 at its size (`InpMaxStopUsd`, 0 = none).
It is measured before anything is sent, where the research measures it: a resting stop order from its level to its
stop, a market entry from its stop distance, and DonchianGold from its 2 x ATR strategy stop, not the 4 x ATR broker
stop. Over the cap the entry ends in a SKIP row ("its stop would cost $163.40, over the $150 cap"), in GoldIntraday once
a day per strategy. Nothing else changes: a DonchianGold signal dropped this way can come again on the next bar, as
it can in the research.

It is built into both research engines, not filtered afterwards: `S.maxStop` in `research/intraday.js` (`MAX_STOP`,
set by `portfolio()`), `cfg.maxStop` in `research/daytrade.js` and `research/parity_mt5.js`. At 0.01 lots it skips 40
of 2,690 trades in 2023-2026, 38 Dual Thrust and 2 H4, all in 2025-26:

| 2025-26, 0.01 lots | Without the cap | With it |
|---|---:|---:|
| Profit | +$4,698 | +$4,552 |
| Worst drawdown | $986 | $739 |
| Worst day | -$268 | -$236 |
| Worst trade | -$212 | -$127 |
| Largest stop | $735 | $150 |

- 2023-24 does not change (PF 1.23, +$1,512, drawdown $368): its largest stop was $106.
- Inside the engines it gives exactly what filtering the trades afterwards gave in section 17: no skipped trade moved a
  later one.
- $150 was picked after $100, $150 and $200 had been measured on both periods, so 2025-26 is no unseen test of it. It is
  a limit on what one trade can lose, not an edge.
- `research/tp_lab.js` runs without the cap (`portfolio(m15, { maxStop: 0 })`), so its 30 Oct results still reproduce.

**The take-profit from the fill.** The research has always measured a target from the fill: the fill plus the
multiple x (fill - stop). The EAs measured it from the price the order was sent at, a stop order's from its level, so
slippage changed the ratio. The New York ORB sell stop at 3942.150 on 3 Nov filled $1.085 lower, at 3941.065, and its
1:4 became 1:3.3 (target 3914.070). Now each EA puts the take-profit right once the position is there (`FixTargets()`
in GoldIntraday, `FixTarget()` in DonchianGold): exactly the strategy's multiple of the risk from the real fill. On
that trade, 3908.645. The stop is never touched.

- It runs on every tick, before the history wait, and sends only when the level differs. A "market closed" reply waits
  for a new quote, like every other send. A refusal for good (say the price is already past the new level) leaves the
  order's own take-profit in place, with one ERROR row. Each move is a TARGET row in the journal.
- DonchianGold measures from its strategy stop, 2 x ATR from the fill, so its target is 1.5 x that: 3 x ATR.
- Live, most take-profits move by a few cents to a dollar. In the tester an order fills at its price, so a move happens only
  when a bar gaps past a stop order's level, where the research also measures from the gapped fill. Parity should not
  change, but the Strategy Tester has not run these builds yet (DonchianGold 1.06, GoldIntraday 1.15).
- `tests/run.js` drives both on the fake broker with the 3 Nov and 2 Nov trades, the cap at exactly $150.00 and
  $150.01, a refusal, and a closed market. Ten deliberate breaks of the new code were each caught.

## 20. A trailing stop on H4, not on the intraday six (owner request, 5 Nov 2026)

The owner asked for a trailing stop. `research/trail_lab.js` tested seven choices, fixed before running, on the EAs as
they trade now (0.01 lots, take-profits from the fill, the $150 cap): none; move the stop to the fill once the trade is
0.5R or 1R up; or trail it 0.5R or 1R behind the best price since the fill once the trade is 0.5R or 1R up. R is the
strategy's own stop distance. Every take-profit stays. Rules: one choice for all six intraday strategies together
(moved at each M15 close), and one for H4, where either the strategy stop (checked on 4-hour closes) or the broker stop
(fires inside a bar) moves, moved at each 4-hour close. The pick is the best profit / worst drop on 2023-2024 only, and
it must beat "none" there; 2025-2026, seen once, must then show a better profit / worst drop and at least 90% of the
profit.

- **Intraday: none.** Every trailing choice made less money than "none" in both periods, so nothing was picked. Their
  targets are close (1.5R on four of them) and their trades are short: a trail mostly cuts trades that would have gone
  on to the target.
- **H4: the broker stop, 0.5R behind the best price from +1R.** On 2023-2024 it tied with 1R behind (2.413 against
  2.411 profit per dollar of drawdown, both well above 1.60 for none); the rule took the higher. 2025-2026:

| H4, 0.01 lots | None | Trailing | 
|---|---:|---:|
| 2023-24 profit / worst drop | +$261 / $163 | +$362 / $150 |
| 2025-26 profit / worst drop | +$2,153 / $367 | +$2,263 / $263 |
| 2025-26 trades, win rate | 95, 55% | 108, 67% |
| 2025-26 stopped by the trail | — | 37% |

  All seven strategies together, 2025-26: +$4,552 / $739 becomes +$4,662 / $607; 2023-24: +$1,512 / $368 becomes
  +$1,614 / $332. The worst trade is unchanged ($127): a trail never limits a loss, only a giveback.
- Caveats. About 90 H4 trades a half is a small sample. On 2023-2024 only the +1R start helped (starting at +0.75R or
  +1.25R did less well or worse than none); on 2025-2026 every nearby setting beat none. The older eras (2008-2014,
  2015-2022) are the honest next test and need the Strategy Tester: `InpTrailAtR = 0` runs the EA without it.
- How the EA does it (`TrailStop()`, DonchianGold 1.07, inputs `InpTrailAtR = 1.0`, `InpTrailDistR = 0.5`): after each
  4-hour bar has been decided it reads the closed bars since the fill bar, takes the highest high (lowest low for a
  short) and, once that is 1R in profit, moves the broker stop to 0.5R behind it. Only ever tighter; a gap past the
  new level closes at market (EXIT_TRAIL), which is what the research's fill at the open is. Worked out afresh from the
  bars each time, so a restart loses nothing. A broker-stop close after a move is journaled EXIT_TRAIL, before one
  EXIT_HARDSTOP. With the trail on, a lost strategy stop is rebuilt from the signal bar's ATR, not from the broker stop.
- The research reads shorts' best price from the Bid low, as the EA reads it from its bars (`research/daytrade.js`
  `cfg.trail`; the intraday engine has `S.trail` too, for the study only). Tests: 249 PASS; eleven deliberate breaks of
  the new code were each caught. The Strategy Tester has not run 1.07 yet.

## 21. Adding to a winning H4 trade: tested, not built (owner request, 5 Nov 2026)

The owner asked for more entries when the trend is going well, within the loss the account can bear. `research/pyramid_lab.js` tested it on H4 as it trades now (trail included), fixed before running: add 0.01 lots on (A) a new breakout close, the entry rule again, or (B) a close 1R beyond the newest entry; at most 2 or 3 positions; each add a trade of its own (own stop, take-profit, trail), the 10-bar channel exit closing them all; an add only if the loss with every open stop hit, the add included, stays within $150 (a trailed stop counts its locked-in gain). Its engine with adding off gives `research/daytrade.js`'s 222 trades exactly. Same pick and pass rules as section 20.

| H4, 0.01 lots a position | None | A: new breakout, up to 3 (picked) |
|---|---:|---:|
| 2023-24 profit / worst drop | +$362 / $150 | +$834 / $250 |
| 2025-26 profit / worst drop | +$2,263 / $263 | +$3,168 / $604 |
| 2025-26 worst day | -$125 | -$190 |

- **FAIL:** on 2025-26 the drawdown grows faster than the profit (profit per dollar of drawdown 5.25 against 8.61). 95 of 244 adds were stopped out: a breakout that comes again is often the top. Up to 2: +$3,030 / $423, also worse. B made less than none on 2023-24 (+$117 / $297).
- Not built: both EAs keep one position per strategy. The $150 budget is the owner's per-trade cap; other budgets were not tried.

## 22. Stress test: worst drawdowns, worse fills, volatile days (owner request, 6 Nov 2026)

The owner asked for each strategy's worst drawdown, whether the backtests include slippage and optimization, and whether the strategies survive imperfect entries and high pressure. `research/stress_lab.js` runs all seven as the EAs trade now (0.01 lots, take-profits from the fill, $150 cap, H4 on 1.06 without the trail) from 2023-04-03 to the end of `data/`, under five fill levels fixed before running. `research/stress_chart.js` draws the balance, the drawdown and gold's monthly candles into `data/reports/stress_chart.html` (git-ignored).

- **Slippage:** the research already charges the bar's real spread plus $0.05 a side (intraday) or 0.01% a side (H4, about $0.20-0.40). The Strategy Tester charges the spread only. Live demo stop-order entries, 12 Oct - 5 Nov 2026, slipped $0.29 on average (10 fills, median $0.13, worst $1.09), about six times the intraday assumption.
- **Optimization:** the Strategy Tester's optimizer is never used. Settings were chosen by hand on 2023-24 from short lists fixed in advance, then judged on 2025-26. That is still selection: every lab that looks at 2025-26 uses it up a little, so it is no longer truly unseen.

| 2023-04 to 2026-10, $ at 0.01 lots | Net | Worst drawdown | MC 99% | Net with +$0.50 a side |
|---|---:|---:|---:|---:|
| All seven | +$5,822 | $739 (7.4%) | $1,568 | +$3,273 |
| H4 Donchian | +$2,413 | $367 | $835 | +$2,216 |
| Dual Thrust | +$1,001 | $291 | $553 | +$709 |
| NY ORB | +$444 | $349 | $838 | -$153 |
| MOM_20 | +$435 | $225 | $591 | -$93 |

- **Fragile to fills:** NY ORB and MOM_20 lose money at +$0.50 a side, MOM_16 and Asian Narrow at +$1.00. H4, Dual Thrust and R-Breaker barely notice.
- **Profit comes from volatile days only:** on the 182 volatile days of 973 (range over 1.5x the median of the previous 60) the book made +$6,004; on the other days -$182.
- **Era:** the book lost $29 in 2023 (from April); H4 lost $117-178 over 2015-2022 in the Strategy Tester. The profit so far comes from the 2024-26 gold trend.
- **Retired (owner decision, 6 Nov 2026):** NY ORB and momentum at 20:00, the two that lost money at +$0.50 a side. GoldIntraday 1.16 has both off by default; `research/intraday.js` RETIRED drops them from `portfolio()` (`{ retired: true }` brings them back for the older studies, which keep their numbers). The book of five: +$4,943, worst drawdown $678, MC 99% $1,164; at +$1.00 a side +$2,343 (seven: +$964). `node research/stress_lab.js --all` reproduces the table above.
- **1% risk a trade (owner asked, 6 Nov 2026), five strategies:** worst drawdown 19% at research costs, 32% with live-like fills, 43% at +$0.50 a side; 0.25% gives 5% / 8% / 11%. Up to 4 trades are open at once. Not built.
- **Ranging:** on an efficiency ratio of the last 10 daily closes (under 0.25 range, over 0.45 trend), 45% of days were ranging; the book still made 0.12 R a day then (0.32 on trend days). The two mean-reversion strategies tested on 30 Oct (RSI(2) pullback, Asian Bollinger fade) lost money even at research costs.

## 23. 0.5% risk a trade and a 15% account stop (owner decision, 6 Nov 2026)

The owner chose 0.5% risk a trade (section 22: 1% gave a 19-43% worst drop) and a 15% account stop. DonchianGold 1.08 and GoldIntraday 1.16 default to `InpFixedLots = 0`, `InpRiskPct = 0.5` (the broker's volume step is 0.001 lots, so a $77 stop gets 0.006 lots) and `InpMaxDrawdownPct = 15`.

- **Account stop:** `mt5/AccountGuard.mqh`, included by both EAs. `DrawdownStop()` keeps the highest equity seen in the terminal global variable `DG_PEAK`; when equity falls more than 15% below it, it sets `DG_KILL = 1` (saved to disk at once) and returns one KILL_SWITCH row. Both EAs call it on every run just before their kill switch, which closes their trades and sends nothing new. The owner restarts by setting `DG_KILL` to 0 in F3 (and deleting `DG_PEAK` to count from the current equity).
- **The $150 cap is now a width:** the stop's cost at 0.01 lots (1 oz), whatever the size, so it skips the same trades as `maxStop` in the research. At 0.5% the dollar risk is capped by the size itself.
- The research still simulates 1 oz a trade: decisions do not depend on the size, so parity is unchanged. The daily loss limits (3% DonchianGold, 2% GoldIntraday) are not modelled; at 0.5% the five strategies' worst research day was 1.6%.
- With live-like fills (+$0.25 a side) the five strategies' worst drop at 0.5% was 16.1% (section 22), so the 15% stop would have fired once in 2023-26.

## 24. Random fills instead of one fixed cost (owner request, 6 Nov 2026)

The owner asked that the backtest not be perfect, with the same fixed costs every time. `research/realism_lab.js` runs the book as it trades now (five strategies, H4 with the trail, 0.5% risk = $50 a 1 R) 200 times; each fill that is not a take-profit draws its own extra slippage from the live demo's 10 stop-order fills ($0.02 to $1.09, mean $0.29), tripled within 30 minutes of a high-importance US release, and 2% of fills are late ($3 more). This comes on top of the research's own costs. `cost.slipFn` (intraday.js) and `cfg.slipFn` (daytrade.js) carry the draw; both default to none.

| 2023-04 to 2026-10, 0.5% risk | Research costs | Random fills: worst 5% | median | best 5% |
|---|---:|---:|---:|---:|
| Net profit on $10,000 | +$7,654 | +$3,713 | +$4,184 | +$4,688 |
| Worst drawdown | 8.9% | 21.3% | 18.2% | 15.2% |

- **The 15% account stop fired in 192 of 200 runs.** Sizing by risk puts more ounces on tight stops, so each dollar of slippage costs more R. No run lost money; Asian Narrow was below 0 in 10 of 200 runs, the others never.
- Not acted on: the owner chose 0.5% before this was known. At 0.25% every drawdown halves (median about 9%).

## 25. Watchdog (owner request, 6 Nov 2026)

`Watchdog.js` checks the EAs every 15 minutes from Google's side and writes the MT5 Watchdog tab. The owner first asked for no notifications, then (same day) for the account stop to reach them: every ALERT goes to their Telegram once (`watchdogAlert_`, keyed so a persisting condition is not resent), with the words "nothing restarts until we decide together". The 07:30 timer sends a daily MT5 report instead of the gold morning map (`mt5DailyReportText_`), after each broker trading day. It only reads, and never copies a START row (it holds the account number). ALERT: a KILL_SWITCH row, a position without a stop, equity 15% below its peak. WARN: an EA silent over 25 minutes while gold trades, ERROR or WARN rows, equity 10% below its peak, stop orders slipping over $0.60 on average (last 20 fills), a retired strategy entering, an EA started without 0.5% risk or the account stop. Apps Script cannot and does not touch MT5: the EAs protect themselves.

## 26. Trading the news, and the news as a bias: tested, not built (owner request, 6 Nov 2026)

The owner argued that news gives faster momentum and could set the day's bias. `research/news_lab.js` tested both on M1 bars since 2023 with rules fixed before running.

- **A. Momentum after the big four US releases** (jobs report, CPI, Fed decision, press conference): wait 5 or 15 minutes, trade the way gold moved since the last price before the release, stop at the far side of that move, take-profit 1.5R, out after 60 or 120 minutes; fills drawn as in section 24 with the news multiplier. Picked on 2023-24: 15 minutes, 120 minutes (median -9.6 R, PF 0.76). 2025-26 (to 8 Oct 2026): median -1.1 R, PF 0.97, above 0 in 25% of runs: **FAIL**. With $0.05 fills (`--ideal`, for information) the same rule makes +2.4 R / +7.4 R (PF 1.07 / 1.27): the momentum is there, but the fills at news time cost more than it pays.
- **B. The surprise (actual - forecast) as a bias**, expecting gold to move against a strong jobs or CPI number: right 54% / 76% of the time 60 minutes after the jobs report (2023-24 / 2025-26), 60% / 36% after CPI; by the day's end 46% / 57% and 65% / 57%. 14 to 24 surprises a half: not stable enough to set a bias. The Fed decision has no forecast in the calendar.
- Not tested yet: the spread guard. The news multiplier (x3) is a guess until the demo has fills near releases; the watchdog's slippage figure will show it.

## 27. Fresh bars to 6 Nov 2026, held out (7 Nov 2026)

`mt5/ExportBars.mq5` 1.10 now writes M1, M15 and H1 in one run. The 7 Nov export matched the old files bar for bar except each old file's last bar (exported while it was still forming); the old files are in `data/backup_20261008/`. Bars from 9 Oct 2026 are the fresh, unseen period: `load()` in `research/daytrade.js` drops them unless a study passes `{ fresh: true }` (`FRESH_FROM`), so every earlier result reproduces (`stress_lab.js`: the book of five +$4,943 / $678, unchanged). Before the cut was added, `news_lab.js` and `stress_lab.js` ran once on the new files (news momentum still FAIL); nothing was chosen from that run. Section 26 now quotes the cut data (the old M1 file had run to 29 Oct).

**Tester confirmation of DonchianGold 1.08 and GoldIntraday 1.16 (7 Nov 2026).** Both ran with the old saved inputs (fixed 0.01 lots, all six intraday strategies), so they test the code, not the new sizing. DonchianGold H4 2023.01.01-2026.10.08, 1 minute OHLC: 12667.34, every journal row the same as 1.07's run except the SKIP wording ("at 0.01 lots"), parity 94.3% (the slippage gap of section 20 above). GoldIntraday M15 2023.01.01-2026.10.30: 14032.00, every row the same as 1.15's, parity on the five strategies still trading 95.1% PASS. A run at 0.5% risk with the two strategies off was skipped by the owner; the demo's first trades and the daily review check the sizes instead.
