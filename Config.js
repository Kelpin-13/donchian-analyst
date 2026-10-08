/**
 * Config.gs — every tunable knob lives here. Nothing else should hold settings.
 *
 * SECRETS DO NOT GO IN THIS FILE.
 * Put them in Project Settings > Script Properties:
 *   ANTHROPIC_API_KEY   (required if ANALYST.enabled)
 *   TELEGRAM_BOT_TOKEN  (optional)
 *   TV_WEBHOOK_SECRET   (optional — any long random string, see Webhook.gs)
 *   DASHBOARD_KEY       (required for the dashboard — any long random string)
 */

const CONFIG = {

  MARKET: {
    // 'coinbase', 'kraken' or 'bybit'.
    //
    // RULE: use the SAME exchange for the live feed, your TradingView chart,
    // and your backtest history. BTC on Coinbase and BTC on Kraken are close
    // but not identical, and a strategy that triggers on "close above the
    // 20-bar high" will fire on different bars if the bars are different.
    //
    // coinbase — recommended. Free, long history, no geo-block from Google's
    //            servers. TradingView ticker: COINBASE:BTCUSD
    // kraken   — native 4h candles, but only the latest 720 via the API.
    //            TradingView ticker: KRAKEN:XBTUSD
    // bybit    — may be geo-blocked from Google's servers.
    provider: 'coinbase',

    // coinbase: BTC-USD, ETH-USD   kraken: XBTUSD, ETHUSD   bybit: BTCUSDT
    symbol: 'BTC-USD',

    // Candle size in minutes. 240 = 4 hours.
    // Kraken allows: 1, 5, 15, 30, 60, 240, 1440, 10080, 21600
    intervalMinutes: 240,

    // How many candles to pull each run. Must be > trendEmaPeriod + 50.
    candlesToFetch: 400
  },

  STRATEGY: {
    breakoutLookback: 20,   // entry: close above highest high of prior N bars
    exitLookback: 10,       // exit: close below lowest low of prior N bars
    atrPeriod: 14,
    stopAtrMult: 2.0,       // hard stop = entry - (2 x ATR at entry)
    trendEmaPeriod: 100,    // regime filter: only go long above this EMA
    maxBarsInTrade: 60,     // time stop — kills zombie positions
    riskPerTradePct: 1.0,   // % of paper account risked per trade
    accountSizeUSD: 1000,   // PAPER. This bot never touches real money.

    // Optional entry filters — OFF by default. The research lab tests them.
    skipWeekendEntries: false,  // no new entries on Saturday/Sunday (UTC)
    minVolumeRatio: 0,          // e.g. 1.2 = breakout bar volume >= 1.2x the recent average
    minAtrPct: 0,               // e.g. 1.0 = skip entries when ATR < 1% of price
    maxAtrPct: 0                // e.g. 4.0 = skip entries when ATR > 4% of price
  },

  // Research lab (Lab.gs): tests strategy variations, never changes live settings by itself.
  LAB: {
    autoEnabled: true,
    runHour: 2,               // nightly, Kuala Lumpur time
    holdoutDays: 365,         // the most recent year is LOCKED — only used when you promote
    blocks: 6,                // research period split into this many time blocks
    minBlockWinsPct: 67,      // candidate must beat the current strategy in 2/3 of blocks
    minImprovementPct: 10,    // ...and improve the overall score by at least this much
    minTrades: 30,
    proposeWithClaude: true   // weekly: Claude suggests up to 2 experiments for you to approve
  },

  ANALYST: {
    enabled: true,
    model: 'claude-sonnet-5',   // 'claude-haiku-4-5-20251001' is cheaper
    maxTokens: 800,
    dailyBriefHour: 8,          // local hour for the regime brief
    gradeAfterBars: 12          // grade a signal this many bars later
  },

  // AI gate (AiGate.gs): a fast buy/sell/hold + conviction + risk verdict on each
  // rule entry and each in-trade bar. SHADOW ONLY — logged to the Gate sheet and
  // graded against real trade results, never changes a trade. 'off' stops the calls.
  // Costs roughly one API call per 4h bar while in a trade, plus one per entry.
  GATE: {
    mode: 'shadow',             // 'shadow' | 'off'
    model: 'claude-opus-5-5',
    effort: 'low',              // short classification: low effort keeps it fast and cheap
    maxTokens: 4000,
    barsInPrompt: 30,           // recent candles sent with each question
    minConviction: 1.0,         // would allow an entry only if action=buy and conviction >= this (0-2)
    maxRisk: 0.5,               // ...and risk_flag < this (0-1)
    exitRisk: 0.7,              // in a trade: would exit early if action=sell and risk_flag >= this
    minTradesToJudge: 20        // the report refuses to call a winner before this many closed trades
  },

  // Challenger (Challenger.gs): a second PAPER account running the same rules
  // (decideAtBar_) on different candles/settings, side by side with the live
  // strategy. It never touches the live position or paper account. Compare with
  // Live → Challenger vs current, or the dashboard's Paper tab.
  // Changing the name, interval, overrides or market list starts a NEW comparison
  // automatically (the old challenger's state is cleared on its next run).
  CHALLENGER: {
    enabled: true,
    name: '4h rules on gold & FX majors',
    intervalMinutes: 240,
    overrides: {},              // strategy settings that differ from STRATEGY, e.g. {"breakoutLookback": 10}
    candlesToFetch: 400,
    // Each market is its own $1,000 paper book (PAPER.startingEquityUSD); the total is
    // their equal-weighted average. A market joins (enabled: true) only after its 3-year
    // result in MM_Backtest (Live → Challenger: backtest each market) has been reviewed.
    //
    // provider 'twelvedata' needs TWELVEDATA_API_KEY, 'oanda' needs OANDA_API_KEY (Script Properties).
    // feePct / slippagePct are per side, % of price, and replace PAPER/BACKTEST costs for that
    // market. Gold and FX are spread-only on most brokers: these are typical OANDA-style spreads
    // (half the spread + a little slippage per side). Check them against your broker.
    markets: [
      // MM_Backtest 9 Oct 2026 (Jan 2024 - Oct 2026, 4h, untuned rules), PF = profit factor:
      //   XAUUSD PF 2.50, +71% (79 trades, 48% won, worst drop 6%), every year positive -> ON
      //   EURUSD PF 0.96, GBPUSD 0.68, USDJPY 0.98, AUDUSD 0.78: no edge after spread -> off
      { id: 'XAUUSD', provider: 'twelvedata', symbol: 'XAU/USD', enabled: true,  feePct: 0, slippagePct: 0.02 },
      { id: 'EURUSD', provider: 'twelvedata', symbol: 'EUR/USD', enabled: false, feePct: 0, slippagePct: 0.01 },
      { id: 'GBPUSD', provider: 'twelvedata', symbol: 'GBP/USD', enabled: false, feePct: 0, slippagePct: 0.015 },
      { id: 'USDJPY', provider: 'twelvedata', symbol: 'USD/JPY', enabled: false, feePct: 0, slippagePct: 0.01 },
      { id: 'AUDUSD', provider: 'twelvedata', symbol: 'AUD/USD', enabled: false, feePct: 0, slippagePct: 0.015 },
      // Crypto, tested Oct 2026 (all six profitable over 3 years). Off: the focus is gold & FX.
      { id: 'BTC',  provider: 'coinbase', symbol: 'BTC-USD',  enabled: false },
      { id: 'ETH',  provider: 'coinbase', symbol: 'ETH-USD',  enabled: false },
      { id: 'SOL',  provider: 'coinbase', symbol: 'SOL-USD',  enabled: false },
      { id: 'XRP',  provider: 'coinbase', symbol: 'XRP-USD',  enabled: false },
      { id: 'LINK', provider: 'coinbase', symbol: 'LINK-USD', enabled: false },
      { id: 'AVAX', provider: 'coinbase', symbol: 'AVAX-USD', enabled: false }
    ]
  },

  // Twelve Data REST API: gold and forex candles. Free plan: 800 requests/day, 8/minute.
  TWELVEDATA: {
    host: 'https://api.twelvedata.com'
  },

  // OANDA v20 REST API, used for XAU_USD. Practice (demo) accounts use the fxpractice host.
  OANDA: {
    host: 'https://api-fxpractice.oanda.com'
  },

  AGENT: {
    enabled: true,        // false = fall back to the one-shot analyst
    maxTurns: 6,          // hard cap on tool-loop iterations
    maxTokens: 1500,
    webSearch: false,     // Anthropic server-side search; costs extra
    traceSheet: 'Trace'   // every tool call gets logged here
  },

  ALERTS: {
    email: '',            // leave '' to disable email alerts
    telegramChatId: ''    // leave '' to disable Telegram alerts
  },

  // Live paper account. Fills at the real current price, charged real-world
  // fees and slippage. Set these to YOUR exchange's actual taker fee.
  PAPER: {
    enabled: true,
    startingEquityUSD: 1000,
    feePct: 0.10,           // per side, % of notional
    slippagePct: 0.05,      // per side, % of price
    maxExposurePct: 100     // never more than 100% of equity in one position
  },

  BACKTEST: {
    fillAt: 'next_open',    // 'next_open' (honest) or 'close' (optimistic)
    feePct: 0.10,
    slippagePct: 0.05,
    startingEquityUSD: 1000,
    maxExposurePct: 100,
    historySheet: 'History',
    historyDays: 1095,      // how far back buildHistory() fetches (3 years)

    // Parameter sweep grid (runSweep)
    sweepBreakout: [10, 15, 20, 30, 40, 55],
    sweepStopMult: [1.0, 1.5, 2.0, 2.5, 3.0],

    // Walk-forward (runWalkForward): tune on trainBars, test on the next
    // testBars, slide forward by testBars, repeat.
    wfTrainBars: 1500,      // ~250 days of 4h bars
    wfTestBars: 500,        // ~83 days
    wfMinTrades: 5,         // ignore parameter sets that barely traded

    monteCarloRuns: 2000,

    // Weekly automatic backtest (AutoBacktest.gs). Installed by setup().
    autoEnabled: true,
    autoWeekday: 'SUNDAY',          // MONDAY ... SUNDAY
    autoHour: 9,                    // Kuala Lumpur time

    // Decision thresholds the automatic verdict uses. Rules of thumb —
    // change them if you like, but BEFORE you look at results.
    minYearsHistory: 2,
    minTrades: 30,
    minWfePct: 30,
    maxTolerableDrawdownPct: 25
  },

  // Optional. Everything works without TradingView. With it, TradingView's
  // alerts act as an independent second engine that must agree with this one.
  TRADINGVIEW: {
    enabled: false,
    tickerId: 'COINBASE:BTCUSD',   // must match MARKET provider + symbol
    crosscheckGraceBars: 2         // how long to wait for the other engine
  },

  DASHBOARD: {
    refreshSeconds: 60
  },

  SHEETS: {
    signals: 'Signals',
    journal: 'Journal',
    regime:  'Regime',
    log:     'Log'
  },

  TZ: 'Asia/Kuala_Lumpur'
};

/**
 * Promoted lab experiments are stored in Script Properties as LIVE_STRATEGY
 * and layered over CONFIG.STRATEGY here, on every run. Config.gs keeps the
 * original defaults; Trading Agent -> Lab -> Revert removes the layer.
 */
(function applyLiveStrategy_() {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty('LIVE_STRATEGY');
    if (raw) Object.assign(CONFIG.STRATEGY, JSON.parse(raw));
  } catch (e) { /* no properties access in this context: use Config.gs as written */ }
})();

/** Read a secret from Script Properties. Throws loudly if missing. */
function secret_(key, required) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v && required) throw new Error('Missing Script Property: ' + key);
  return v || '';
}

/** Persistent bot state (position, stop, last bar seen). Kept as JSON. */
function getState_() {
  const raw = PropertiesService.getScriptProperties().getProperty('BOT_STATE');
  if (!raw) {
    return {
      position: 'FLAT',      // 'FLAT' | 'LONG'
      entryPrice: null,
      entryTime: null,
      entryAtr: null,
      stop: null,
      barsInTrade: 0,
      lastBarProcessed: 0    // ms timestamp of last closed candle handled
    };
  }
  return JSON.parse(raw);
}

function setState_(state) {
  PropertiesService.getScriptProperties()
    .setProperty('BOT_STATE', JSON.stringify(state));
}

function resetState_() {
  PropertiesService.getScriptProperties().deleteProperty('BOT_STATE');
}