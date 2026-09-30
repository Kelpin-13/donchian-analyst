# Operations reference

What exists at runtime, who writes it, and when. Check here before renaming a sheet,
column, property or trigger — other code (and the web panel) reads them by name.

## Scheduled jobs (installed by `setup()`, times in Asia/Kuala_Lumpur)

| Handler | When | Does |
|---|---|---|
| `runMonitor` | every 15 min | new closed 4h candle → signal → paper fill, AI gate verdict (shadow), agent note, alert; equity snapshot |
| `runDailyBrief` | 08:00 | regime brief (Regime sheet + alert) |
| `runGrader` | 11:00 | grades notes ≥12 bars old; reconciles Crosscheck |
| `runAutoBacktest` | Sunday 09:00 | all backtest stages → BT_Log row + alert; then Claude lab proposals |
| `runLab` | 02:00 | runs QUEUED experiments within a 4.5-min budget |
| `runChallenger` | every 15 min | challenger paper account: acts once per closed `CHALLENGER.intervalMinutes` candle (skips without fetching otherwise) |
| `processTelegramQueue` | one-off, ~1s after a Telegram message | answers queued questions |

`setup()` deletes **all** triggers first, then installs these. Re-run it after adding a job.

## Sheets

Sheets marked *overwritten* are replaced on every run; everything else is append-only.

| Sheet | Written by | Notes |
|---|---|---|
| Signals | monitor, grader | cols A–L fixed at signal time; M–S filled by grader (`SIGNAL_HEADERS`) |
| PaperTrades | `paperOnSignal_` | one row per fill |
| Equity | `paperSnapshot_` | one row per closed bar |
| Regime | daily brief | |
| Journal | agent Q&A, lab promote/revert | |
| Log | `logLine_` | levels INFO / WARN / ERROR / SIGNAL; trimmed to 2,000 rows |
| Trace | agent loop | every tool call |
| Gate | monitor (AI gate, shadow) | one row per verdict; `FinalR` filled when the trade closes (`GATE_HEADERS`) |
| Ch_Trades, Ch_Equity | `runChallenger` | challenger's fills and per-bar equity; same columns as PaperTrades / Equity |
| Crosscheck | webhook + monitor | status PENDING / MATCH / TV_ONLY / APPS_SCRIPT_ONLY |
| History | `buildHistory`, `updateHistory`, `importTradingViewCsv` | `t_ms, time_utc, open, high, low, close, volume` |
| BT_Summary, BT_Trades, BT_Equity, BT_Sweep, BT_WalkForward, BT_MonteCarlo, BT_Compare, BT_LiveVsBacktest | backtest stages | *overwritten* each run |
| BT_Log | `runAutoBacktest` | one row per weekly run (`BT_LOG_HEADERS`) |
| Lab_Queue | seed, Claude, owner | Status: QUEUED / PROPOSED / RUNNING / DONE / ERROR |
| Lab_Log | `runLab`, promote | one row per experiment (`LAB_LOG_HEADERS`) |
| Debug, TV_Import, TV_Trades | owner-triggered tools | |

The panel reads columns **by header name**, so renaming a header breaks the panel. Adding
columns at the end is safe.

## Script Properties

| Key | Kind | Set by |
|---|---|---|
| `ANTHROPIC_API_KEY` | secret | owner |
| `DASHBOARD_KEY` | secret | owner |
| `TV_WEBHOOK_SECRET` | secret, optional | owner |
| `TELEGRAM_BOT_TOKEN` | secret, optional | owner |
| `DASHBOARD_URL` | web app link ending `/dev` (daily panel) — used by Show dashboard URL and Check installation | owner |
| `WEBHOOK_URL` | web app link ending `/exec`, optional (TradingView/Telegram) | owner |
| `BOT_STATE` | JSON: position, entry, stop, barsInTrade, lastBarProcessed | monitor |
| `PAPER_STATE` | JSON: cash, units, fees, peak, startedAt, lastSnapshotBar… | paper broker |
| `LAST_MONITOR_RUN` | ms timestamp | monitor |
| `CH_STATE`, `CH_PAPER_STATE` | challenger position state and paper book (same shapes as `BOT_STATE` / `PAPER_STATE`) | challenger |
| `CH_START` | JSON: start time, BTC price and live paper equity when the challenger began | challenger |
| `LIVE_STRATEGY` | JSON overrides layered over `CONFIG.STRATEGY` | lab promote / revert |
| `LAB_TRIED` | count of experiments run | lab |
| `LAB_HOLDOUT_USES` | count of holdout tests | lab promote |
| `TG_QUEUE` | pending Telegram questions | Telegram handler |

Names must match exactly (capitals, underscores). A mistyped name like `claude-api-key`
fails silently as "missing" — this has happened.

## Menu (Trading Agent)

Check installation · Test data feed · Test live price · Dump indicators ·
**Backtesting**: build/import/update history, quick, detailed, sweep, walk-forward, Monte
Carlo, TV compare, live decay, full automatic run ·
**Lab**: add starters, run now, ask Claude, promote (holdout), show live, revert ·
**Live**: check now, daily brief, grade, ask the agent, paper account, AI gate report, challenger vs current, dashboard URL ·
**TradingView**: test webhook · Show scorecard · **Reset**: position state, paper account, challenger.

`checkInstall()` / `installChecks_(skipApi)` detect stale files by looking for a function
that exists only in the current version of each file. When adding a file or a
version-defining function, add a check there.

## Deployment facts

- Code reaches Apps Script via `clasp push` from this folder (master copy).
- Triggers and menu run the latest **saved/pushed** code immediately.
- Panel for daily use: the `/dev` test-deployment URL + `?k=DASHBOARD_KEY` (owner login only).
- Links come from the `DASHBOARD_URL` / `WEBHOOK_URL` Script Properties, not
  `ScriptApp.getService().getUrl()` — that returned a deployment ID that no longer existed
  ("Sorry, unable to open the file at present").
- `/exec` (Web app deployment) is only needed for webhooks; update it via Manage
  deployments → edit → New version, never a new deployment (URL would change).
- A broken push breaks the live monitor too. Run Check installation after every push.

## When something fails

1. Log sheet (or panel → System tab) for the ERROR line.
2. Apps Script → Executions for the stack trace.
3. Check installation for missing files, properties or triggers.
4. `git diff` / `git log` to see what changed since it last worked.
