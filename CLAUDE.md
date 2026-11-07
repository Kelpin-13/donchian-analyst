# Donchian Analyst — project briefing

Personal quant research project: a rules-based market monitor, backtester and paper-trading
system in Google Apps Script, with a Claude-powered analyst. Focus: gold (XAUUSD) day trading.
**It never trades real money.** Automated orders are allowed only on an MT5 **demo** account
(owner decision, 9 Oct 2026), and the code must refuse to trade on any live account.

## Read before changing things

- `docs/DESIGN.md` — why each part works the way it does, with the exact rules and numbers.
  Read the relevant section before touching the strategy, backtester, lab, agent or panel.
- `docs/OPERATIONS.md` — sheets, triggers, Script Properties, menu and deployment facts.
  Check it before renaming anything; other code and the panel read these by name.
- If a change makes either file wrong, update it in the same change.

## How the code gets to Apps Script

- This folder is the master copy. Files are `.js` here, `.gs` in Apps Script (clasp converts).
- Before handing over a change: run `node tests/run.js --against HEAD` (offline, ~45 s). It must say
  ALL PASSED; `--against` proves the live strategy still matches the last commit.
- After editing: the owner runs `clasp push`, then checks **Trading Agent → Check installation**
  in the sheet, then commits to GitHub. Never run `clasp push` yourself unless asked.
- `clasp push` uploads every `.js`/`.html`/`appsscript.json`. `.claspignore` keeps
  `README.md`, `CLAUDE.md`, `docs/`, `tests/` and `donchian_analyst.pine` out of Apps Script.
  `tests/` must stay in `.claspignore`: clasp uploads `.js` in subfolders, and test files would
  share Apps Script's global scope.
- All files share ONE global scope. Function names must be unique across every file,
  or one silently overrides another. Check for duplicates after any change.
- Functions ending in `_` are private: they can't be run from the menu or called from
  the web page. Menu items need a public wrapper.

## Architecture (one line per file)

| File | Role |
|---|---|
| `Config.js` | All settings. Promoted lab settings are layered on top from Script Property `LIVE_STRATEGY` |
| `Data.js` | Exchange adapters (Coinbase default; 1h candles aggregated to 4h on UTC boundaries), live price |
| `Indicator.js` | EMA, Wilder ATR, Donchian channels. Pure functions, arrays aligned to candle index |
| `Strategy.js` | `decideAtBar_()` — THE strategy. Used by live, backtest and lab alike. Optional filters via `entryBlockedBy_()` |
| `History.js` | Long history in the History sheet; `updateHistory()` adds new bars only |
| `Backtest.js` | `simulate_()` engine (next-open fills, fees, slippage, risk sizing), metrics, sweep, walk-forward, Monte Carlo |
| `AutoBacktest.js` | Weekly run of every stage, verdict rules, one permanent row per run in BT_Log |
| `Lab.js` | Research lab: queued experiments, locked holdout year, promote/revert with human approval |
| `Challenger.js` | Multi-market paper challenger: same `decideAtBar_()` on every enabled market in `CONFIG.CHALLENGER.markets` (gold & FX via Twelve Data; crypto via Coinbase, off), one book each with its own costs, side by side with live. Never touches the live position |
| `PaperBroker.js` | Paper account: fills at the live price with fees and slippage |
| `AiGate.js` | Shadow-only three-field verdict (action, conviction, risk_flag) logged to the Gate sheet and graded against real trades. Never changes a trade |
| `Analyst.js` / `Agent.js` | One-shot Claude calls / tool-calling agent loop with READ-ONLY tools |
| `Journal.js` | Signals sheet and the self-grading loop |
| `Webhook.js` | `doPost` router (TradingView cross-check, Telegram) |
| `Dashboard.js` / `DashboardPage.html` | Read-only web control panel, 5 tabs |
| `Main.js` | Triggers (`setup`), monitor loop, menu, `checkInstall` |
| `donchian_analyst.pine` | Same strategy in Pine v6 for TradingView — not uploaded to Apps Script |
| `mt5/DonchianGold.mq5` | MT5 Expert Advisor: gold H4, long + short, fixed 0.01 lots a trade (`InpFixedLots`; 0 = the old percent sizing), a take-profit at the broker (`InpTpR`, set again from the real fill, then waits for a close back inside the channel), no entry whose stop would cost over $150 (`InpMaxStopUsd`, same as `maxStop` in `research/parity_mt5.js`), a broker stop that trails 0.5R behind the best price from +1R (`InpTrailAtR`/`InpTrailDistR`, same as `trail` in `research/parity_mt5.js`; 0 = off), **demo only**. Mirrors `research/daytrade.js` (H4 hold-overnight, both). Compile with MetaEditor; install under `MQL5/Experts/DonchianAnalyst/` |
| `Mt5.js` | Receives both EAs' journals (doPost route `source: 'mt5'`, key `MT5_KEY`) and rebuilds MT5 Summary / MT5 Trades from MT5 Log |
| `Watchdog.js` | Every 15 minutes (`runWatchdog`, installs itself from the morning map's timer): checks both EAs from Google's side and writes the MT5 Watchdog tab. Reads only. ALERTs (account stop fired, position without a stop, 15% down) go to the owner's Telegram once each; it also builds the daily MT5 report the 07:30 timer sends (owner, 6 Nov 2026) |
| `Morning.js` | The 07:30 Telegram timer: since 6 Nov 2026 it sends the daily MT5 report (`MORNING.send`); the gold morning map, on the menu (trigger `runMorningMap`, menu Morning map: connect / send now / stop): 4-hour order blocks (same rule as `research/sd_lab.js`, a test checks), trend, the EAs' levels from MT5 Log, EA heartbeat warning, Google Charts picture. Zones are labelled a map, not signals. Chat ID in Script Property `TELEGRAM_CHAT_ID` (`telegramChatId_()`), never in code |
| `mt5/AccountGuard.mqh` | Included by both EAs: the 15% account stop (`DrawdownStop()`, peak equity in global variable `DG_PEAK`, sets `DG_KILL`). Install it next to the EAs |
| `mt5/SheetSync.mqh` | Included by both EAs: sends new journal lines + a heartbeat to the web app from OnTimer (never in the tester or a bar's first minute) |
| `mt5/GoldIntraday.mq5` | MT5 Expert Advisor: six intraday gold strategies on M15 (NY ORB and momentum at 20:00 retired 6 Nov 2026, off by default; `RETIRED` in `research/intraday.js`), flat by 23:00, fixed 0.01 lots a trade (`InpFixedLots`; 0 = the old percent sizing), a take-profit at the broker per strategy (`InpTp*`, same values as `TARGETS` in `research/intraday.js`, a test checks; set again from the real fill), no trade whose stop would cost over $150 (`InpMaxStopUsd`, same as `MAX_STOP`), **demo only**, magic 20261013 + 1..6. Mirrors the portfolio in `research/intraday.js` |
| `research/` | Node research on the broker's MT5 exports in `data/` (git-ignored): `daytrade.js` (day-trading vs H4 study), `intraday.js` (intraday strategy study + the EA's portfolio), `parity_mt5.js` / `parity_intraday.js` (each EA vs its research, trade by trade), `journal_stats.js` (a Strategy Tester run per strategy and year), `news_windows.js` (tester trades vs US news releases; `calendar.js` reads the exported calendar), `trade_features.js` + `trade_filter.py` (trade-filter study: LightGBM on what the EA knew at entry, walk-forward over the tester eras; Python 3 with `lightgbm` + `pandas`), `supply_demand.js` (supply/demand zone study on M15 or M1 bars; uses the engine's limit orders), `sd_lab.js` (69 supply/demand versions from public sources on M1 bars: base zones, order blocks, fair value gaps, three entry types; design-half selection, unseen half revealed once; none passed), `tp_lab.js` (take-profit levels per strategy, chosen on 2023-2024 only), `trail_lab.js` (trailing stops: seven choices, picked on 2023-2024 only; H4 got one, the intraday six none), `pyramid_lab.js` (adding to winning H4 trades within a $150 loss budget; its engine matches `daytrade.js` with adding off; failed on 2025-2026, not built), `stress_lab.js` (all seven under worse fills, wider spreads and volatile days: worst drawdowns, Monte Carlo, per year; writes `data/reports/stress.json`) + `stress_chart.js` (balance, drawdown and gold candles into `data/reports/stress_chart.html`), `realism_lab.js` (the book run 200 times, each with its own random fills drawn from the live demo's slippage, tripled near US news), `news_lab.js` (momentum after the big four US releases, and the jobs/CPI surprise as a bias; both failed) |
| `tests/` | Offline tests: `run.js` (the suite), `harness.js` (fake Apps Script), `mql.js` (runs the EAs' own MQL5 functions in Node against a fake broker; it stops with an error when a patch no longer matches the EA source) |
| `mt5/ExportBars.mq5` | MT5 script, places no orders: writes gold M1, M15 and H1 bars since 2023 to `MQL5/Files/XAUUSD.sml_M1.csv`, `_M15.csv` and `_H1.csv` in MT5's Bars-export format (copy them to `data/`). Install under `MQL5/Scripts/DonchianAnalyst/` |
| `mt5/ExportCalendar.mq5` | MT5 script, places no orders: writes the economic calendar since 2007 to `MQL5/Files/calendar_events.csv` (copy it to `data/`) for `research/news_windows.js`. Install under `MQL5/Scripts/DonchianAnalyst/` |

## Rules that must not be broken

1. **Demo only, never real money.** Automated order placement is allowed only on a demo account:
   the MT5 Expert Advisor must check `ACCOUNT_TRADE_MODE == ACCOUNT_TRADE_MODE_DEMO` at start-up and
   before every order, and stop trading if it isn't. Never add live-account credentials, live order
   endpoints, or anything that can move real money. Apps Script itself still places no orders.
   Every automated order carries a stop loss; no averaging down, no martingale, no manual override
   of the rules (the owner's aim: no reckless or greedy decisions).
2. **Secrets live in Script Properties** (`ANTHROPIC_API_KEY`, `DASHBOARD_KEY`, `TV_WEBHOOK_SECRET`,
   `TELEGRAM_BOT_TOKEN`). Never put a key or token in a code file.
3. **One strategy.** Live, backtest and lab all call `decideAtBar_()`. Never create a separate copy
   of the rules for one of them.
4. **No look-ahead.** Only closed candles. Channels exclude the current bar. Backtest fills at the
   NEXT bar's open by default.
5. **New strategy options default to OFF**, so the live strategy doesn't change until the lab
   promotes something. After a change, confirm a backtest with defaults gives identical trades.
6. **Pine parity.** Any change to the rules in `Strategy.js` needs the same change in
   `donchian_analyst.pine`, or the TradingView cross-check will flag disagreements. Say so.
   **EA parity:** `mt5/DonchianGold.mq5` and `research/daytrade.js` are the same gold rules in two
   languages. Change both together, then re-run the Strategy Tester and `node research/parity_mt5.js`
   (must report PASS) before the EA trades again. The same holds for `mt5/GoldIntraday.mq5` and the
   portfolio in `research/intraday.js`, checked with `node research/parity_intraday.js`.
7. **The lab never promotes by itself.** Promotion needs the holdout test and the owner's yes.
   Don't loosen lab thresholds to make an experiment pass.
8. **The agent's tools stay read-only.** The tool list is the security boundary.
9. **Apps Script limits:** 6 minutes per run, 90 minutes of trigger runtime per day. Heavy jobs
   need a time budget and must log what they skipped.
10. **The web panel is read-only.** Every server endpoint calls `requireKey_()`. Anything that
    changes state belongs in the sheet menu. `google.script.run` can't return Date objects — convert them.

## Owner preferences

Plain language, concrete steps, direct feedback. If a requested change would weaken one of the
rules above (e.g. auto-promoting, raising risk to improve backtest numbers), say so plainly and
suggest the safe version instead of silently doing it.
