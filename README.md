# Donchian Analyst

A personal quant research project on gold (XAUUSD): rules-based strategies, tested on 18 years of
broker data, traded automatically by MetaTrader 5 Expert Advisors **on a demo account**, with every
trade logged to a Google Sheet.

> **Not financial advice. Research and demo trading only.**
> Nothing here is a recommendation to buy or sell anything. Backtests are not live results, and past
> results do not predict future ones. Both Expert Advisors refuse to run on a real-money account
> (`ACCOUNT_TRADE_MODE_DEMO` check). If you change that, the risk is entirely yours.

## What's inside

| Folder / file | What it is |
|---|---|
| `mt5/DonchianGold.mq5` | Expert Advisor: H4 swing breakout (Donchian 20/10 with a 100-bar EMA trend filter), long and short, 1% risk a trade |
| `mt5/GoldIntraday.mq5` | Expert Advisor: six intraday strategies on M15 (New York opening range, Asian narrow-range breakout, Dual Thrust, R-Breaker, momentum at 16:00 and 20:00 broker time), 0.125–0.25% risk a trade, flat by the end of the day |
| `mt5/SheetSync.mqh` | Sends each EA's journal to the Google Sheet (Apps Script web app, shared key) |
| `mt5/ExportCalendar.mq5` | Script: exports MT5's economic calendar for the news research |
| `*.js`, `*.html` | Google Apps Script: the Sheet's results book (`Mt5.js`) plus the original research system (backtester, paper trading, lab, Claude-powered analyst) |
| `research/` | Node / Python studies on MT5 exports: strategy research, EA parity checks, 18-year Strategy Tester analysis, news windows, trade-filter model |
| `tests/` | Offline test suite for the Apps Script code: `node tests/run.js` |
| `docs/DESIGN.md` | Why the system works the way it does, with the exact rules |
| `docs/OPERATIONS.md` | Sheets, triggers, Script Properties, menu and deployment |

## How it was tested

- Each strategy was designed on one period and checked on years it had never seen, then run in the
  MT5 Strategy Tester over 2008–2014, 2015–2022 and 2023–2026.
- Each EA is checked trade by trade against its research version (`research/parity_*.js`).
- The tester fills stop orders at exactly their price, so its results are optimistic; the live demo
  journal records real fills to measure the difference.
- Ideas that did not hold up across all periods (a news filter, a machine-learning trade filter, most
  mean-reversion variants) were tested and dropped; the scripts and their results are kept in `research/`.

## Running it yourself

- Apps Script: push with [clasp](https://github.com/google/clasp); setup and properties are in
  `docs/OPERATIONS.md`. Keys (Anthropic, Twelve Data, Telegram, the MT5 shared key) belong in
  **Script Properties**, never in code.
- MT5: copy `mt5/` into `MQL5/Experts/DonchianAnalyst/`, compile in MetaEditor, and attach to a
  **demo** account's XAUUSD chart (H4 for DonchianGold, M15 for GoldIntraday).
- Research scripts need your own MT5 exports in `data/` (not included).

## Licence

No licence is granted: you may read the code here, but all other rights are reserved.
