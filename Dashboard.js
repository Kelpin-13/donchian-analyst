/**
 * Dashboard.gs — your live "trading screen", served as a web app.
 *
 * This is the answer to "do I need a virtual machine to watch it trade?"
 * No. The monitor already runs 24/7 on Google's servers via triggers. This
 * page is just a window into it that you can open on your phone or laptop.
 *
 * Deploy -> New deployment -> Web app. Then open:
 *   https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec?k=<DASHBOARD_KEY>
 *
 * The same deployment also receives TradingView webhooks (doPost), which
 * needs "Who has access: Anyone". That makes doGet public too, which is why
 * the page refuses to render without the DASHBOARD_KEY.
 */

function doGet(e) {
  const k = e && e.parameter && e.parameter.k;
  const expected = secret_('DASHBOARD_KEY', false);
  if (!expected || !safeEqual_(k, expected)) {
    return HtmlService.createHtmlOutput(
      '<p style="font-family:system-ui,sans-serif;padding:24px;max-width:36em;line-height:1.5">' +
      'This dashboard is locked. Add <code>?k=</code> followed by your DASHBOARD_KEY to the end of the URL. ' +
      'Set the key in Apps Script under Project Settings, Script Properties.</p>')
      .setTitle('Dashboard locked');
  }
  const t = HtmlService.createTemplateFromFile('DashboardPage');
  t.k = k;
  t.refresh = CONFIG.DASHBOARD.refreshSeconds;
  return t.evaluate()
    .setTitle('Donchian Analyst — ' + CONFIG.MARKET.symbol)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Candles change every 4 hours; the page refreshes every minute. Cache them. */
function cachedCandles_() {
  const cache = CacheService.getScriptCache();
  const key = 'dash_candles_' + CONFIG.MARKET.provider + CONFIG.MARKET.symbol + CONFIG.MARKET.intervalMinutes;
  const hit = cache.get(key);
  if (hit) return JSON.parse(hit);
  const c = fetchCandles_().slice(-260);
  try { cache.put(key, JSON.stringify(c), 600); } catch (err) { /* too big to cache: fine */ }
  return c;
}

function lastRows_(name, n) {
  const s = ss_().getSheetByName(name);
  if (!s || s.getLastRow() < 2) return [];
  const count = Math.min(n, s.getLastRow() - 1);
  return s.getRange(s.getLastRow() - count + 1, 1, count, s.getLastColumn()).getValues();
}

/**
 * Called from the page every refresh. Returns everything the Live tab shows.
 * `marketId` picks a challenger market (e.g. 'XAUUSD') instead of the live strategy.
 */
function getDashboardData(k, marketId) {
  const expected = secret_('DASHBOARD_KEY', false);
  if (!expected || !safeEqual_(k, expected)) throw new Error('Locked');
  if (marketId && marketId !== 'LIVE') return marketDashboardData_(marketId);

  const candles = cachedCandles_();
  const series = computeSeries_(candles);
  const i = candles.length - 1;
  const last = candles[i];
  const ivMs = CONFIG.MARKET.intervalMinutes * 60 * 1000;

  let price = last.c, priceSource = 'last close';
  try { price = fetchTickerPrice_(); priceSource = 'live'; } catch (err) {}

  const st = getState_();
  const paper = paperStatus_(price);
  const upper = series.entry.upper[i], lower = series.exit.lower[i], ema = series.ema[i];

  // Chart: the last 120 closed bars with the channel and EMA
  const from = Math.max(0, candles.length - 120);
  const chart = { labels: [], close: [], upper: [], lower: [], ema: [] };
  for (let j = from; j < candles.length; j++) {
    chart.labels.push(Utilities.formatDate(new Date(candles[j].t), CONFIG.TZ, 'dd MMM HH:mm'));
    chart.close.push(round_(candles[j].c));
    chart.upper.push(round_(series.entry.upper[j]));
    chart.lower.push(round_(series.exit.lower[j]));
    chart.ema.push(round_(series.ema[j]));
  }

  const eqRows = lastRows_('Equity', 400);
  const signals = lastRows_(CONFIG.SHEETS.signals, 8).reverse().map(r => ({
    time: r[1] ? Utilities.formatDate(new Date(r[1]), CONFIG.TZ, 'dd MMM HH:mm') : '',
    type: r[2], price: round_(Number(r[3])), setup: String(r[8] || '').slice(0, 280),
    confidence: r[11], verdict: r[16] || '', lesson: String(r[17] || '')
  }));
  const briefRow = lastRows_(CONFIG.SHEETS.regime, 1)[0];
  const errRow = lastRows_(CONFIG.SHEETS.log, 50).reverse().find(r => r[1] === 'ERROR');

  let cross = null;
  if (CONFIG.TRADINGVIEW.enabled) {
    const cr = lastRows_('Crosscheck', 200);
    cross = {
      match: cr.filter(r => r[7] === 'MATCH').length,
      pending: cr.filter(r => r[7] === 'PENDING').length,
      disagree: cr.filter(r => r[7] === 'TV_ONLY' || r[7] === 'APPS_SCRIPT_ONLY').length
    };
  }

  return {
    symbol: CONFIG.MARKET.symbol,
    provider: CONFIG.MARKET.provider,
    interval: CONFIG.MARKET.intervalMinutes,
    serverNow: Date.now(),
    price: round_(price),
    priceSource: priceSource,
    lastBarTime: last.t,
    nextCloseAt: last.t + 2 * ivMs,
    upper: round_(upper), lower: round_(lower), ema: round_(ema), atr: round_(series.atr[i]),
    breakoutLookback: CONFIG.STRATEGY.breakoutLookback,
    exitLookback: CONFIG.STRATEGY.exitLookback,
    emaPeriod: CONFIG.STRATEGY.trendEmaPeriod,
    position: st.position,
    entry: round_(st.entryPrice), stop: round_(st.stop), barsInTrade: st.barsInTrade,
    maxBars: CONFIG.STRATEGY.maxBarsInTrade,
    paper: {
      equity: round_(paper.equity), start: paper.startingEquity, returnPct: round_(paper.returnPct),
      cash: round_(paper.cash), openPnl: round_(paper.openPnl), fees: round_(paper.feesPaid),
      trades: paper.trades, winRate: paper.winRate === null ? null : round_(paper.winRate),
      drawdownPct: round_(paper.drawdownPct), enabled: CONFIG.PAPER.enabled
    },
    chart: chart,
    equity: eqRows.map(r => ({ t: Utilities.formatDate(new Date(r[1]), CONFIG.TZ, 'dd MMM'), v: Number(r[5]) })),
    signals: signals,
    brief: briefRow ? { date: Utilities.formatDate(new Date(briefRow[0]), CONFIG.TZ, 'dd MMM'),
                        regime: briefRow[1], summary: briefRow[7], risk: briefRow[9] } : null,
    cross: cross,
    lastError: errRow ? { time: Utilities.formatDate(new Date(errRow[0]), CONFIG.TZ, 'dd MMM HH:mm'),
                          msg: String(errRow[2]).slice(0, 160) } : null,
    lastRun: Number(PropertiesService.getScriptProperties().getProperty('LAST_MONITOR_RUN') || 0),
    market: 'LIVE', role: 'live', closed: false, markets: dashboardMarkets_()
  };
}

/** The market switcher: the live strategy first, then every enabled challenger market. */
function dashboardMarkets_() {
  const C = CONFIG.CHALLENGER;
  return [{ id: 'LIVE', label: CONFIG.MARKET.symbol, role: 'live' }].concat(
    (C && C.enabled ? C.markets || [] : []).filter(m => m.enabled).map(m => ({ id: m.id, label: m.symbol, role: 'paper' })));
}

/**
 * Same shape as getDashboardData(), for one challenger market (paper only).
 * Twelve Data's free plan allows 800 requests a day and the page refreshes every
 * minute, so candles are cached until the next bar can have closed and the price
 * for 5 minutes. That keeps the panel to ~300 requests a day even left open.
 */
function marketDashboardData_(id) {
  const C = CONFIG.CHALLENGER;
  const m = (C && C.enabled ? C.markets || [] : []).filter(x => x.id === id && x.enabled)[0];
  if (!m) throw new Error('Unknown or disabled market: ' + id);
  if (!chHasKey_(m)) throw new Error(id + ' needs ' + CH_PROVIDER_KEYS[m.provider] + ' in Script Properties');

  const P = challengerParams_();
  const ivMs = C.intervalMinutes * 60 * 1000;
  const cache = CacheService.getScriptCache();
  const ckey = 'dash_mk_' + m.id + '_' + C.intervalMinutes;
  let candles = null;
  try { const hit = cache.get(ckey); if (hit) candles = JSON.parse(hit); } catch (e) {}
  if (!candles || Date.now() >= candles[candles.length - 1].t + 2 * ivMs) {
    candles = chCandles_(m, C.intervalMinutes, Math.min(C.candlesToFetch, 260), P);
    const ttl = Math.round((candles[candles.length - 1].t + 2 * ivMs - Date.now()) / 1000) + 60;
    try { cache.put(ckey, JSON.stringify(candles), Math.max(60, Math.min(21600, ttl))); } catch (e) { /* too big: fine */ }
  }
  const series = computeSeries_(candles, P);
  const i = candles.length - 1, last = candles[i];

  let price = last.c, priceSource = 'last close';
  const pkey = 'dash_px_' + m.id;
  try {
    const hit = cache.get(pkey);
    if (hit) { price = Number(hit); priceSource = 'live'; }
    else { price = chPrice_(m); priceSource = 'live'; cache.put(pkey, String(price), 300); }
  } catch (e) { price = last.c; priceSource = 'last close'; }

  const st = chGet_('CH_STATE_' + m.id) || freshState_();
  const book = paperStatus_(price, chBook_(m));
  const from = Math.max(0, candles.length - 120);
  const chart = { labels: [], close: [], upper: [], lower: [], ema: [] };
  for (let j = from; j < candles.length; j++) {
    chart.labels.push(Utilities.formatDate(new Date(candles[j].t), CONFIG.TZ, 'dd MMM HH:mm'));
    chart.close.push(round_(candles[j].c));
    chart.upper.push(round_(series.entry.upper[j]));
    chart.lower.push(round_(series.exit.lower[j]));
    chart.ema.push(round_(series.ema[j]));
  }
  const fills = lastRows_(CH_TRADES_SHEET, 300).filter(r => r[0] === m.id).slice(-8).reverse().map(r => ({
    time: r[4] ? Utilities.formatDate(new Date(r[4]), CONFIG.TZ, 'dd MMM HH:mm') : '',
    type: String(r[3]), price: round_(Number(r[5])), setup: '', confidence: '', verdict: '', lesson: ''
  }));
  const errRow = lastRows_(CONFIG.SHEETS.log, 50).reverse().find(r => r[1] === 'ERROR');

  return {
    symbol: m.symbol, provider: m.provider, interval: C.intervalMinutes, serverNow: Date.now(),
    price: round_(price), priceSource: priceSource, lastBarTime: last.t, nextCloseAt: last.t + 2 * ivMs,
    // Gold & FX close at the weekend: no new bar for longer than one interval means closed.
    closed: Date.now() > last.t + 2 * ivMs + 20 * 60 * 1000,
    upper: round_(series.entry.upper[i]), lower: round_(series.exit.lower[i]), ema: round_(series.ema[i]),
    atr: round_(series.atr[i]),
    breakoutLookback: P.breakoutLookback, exitLookback: P.exitLookback, emaPeriod: P.trendEmaPeriod,
    position: st.position, entry: round_(st.entryPrice), stop: round_(st.stop), barsInTrade: st.barsInTrade,
    maxBars: P.maxBarsInTrade,
    paper: {
      equity: round_(book.equity), start: book.startingEquity, returnPct: round_(book.returnPct),
      cash: round_(book.cash), openPnl: round_(book.openPnl), fees: round_(book.feesPaid),
      trades: book.trades, winRate: book.winRate === null ? null : round_(book.winRate),
      drawdownPct: round_(book.drawdownPct), enabled: CONFIG.PAPER.enabled
    },
    chart: chart, equity: [], signals: fills, brief: null, cross: null,
    lastError: errRow ? { time: Utilities.formatDate(new Date(errRow[0]), CONFIG.TZ, 'dd MMM HH:mm'),
                          msg: String(errRow[2]).slice(0, 160) } : null,
    lastRun: Number(PropertiesService.getScriptProperties().getProperty('LAST_MONITOR_RUN') || 0),
    market: m.id, role: 'paper', markets: dashboardMarkets_()
  };
}

/** Show the full dashboard URL so you don't have to assemble it by hand. */
function showDashboardUrl() {
  const panel = webAppUrl_('DASHBOARD_URL');
  const hook = webAppUrl_('WEBHOOK_URL');
  const msg = panel.error
    ? panel.error
    : 'Dashboard (keep this private):\n' + panel.url + '?k=' + secret_('DASHBOARD_KEY', true) +
      '\n\nWebhook URL for TradingView and Telegram:\n' +
      (hook.url || 'not set. Only needed for webhooks: add WEBHOOK_URL (the /exec link) to Script Properties.');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Web app links', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
}

/**
 * Web app links come from Script Properties, not ScriptApp.getService().getUrl(),
 * which can return a deployment ID that no longer exists ("unable to open the file").
 * Copy the link from Deploy → Manage deployments (/exec) or Test deployments (/dev).
 * Returns { url } or { error }.
 */
function webAppUrl_(prop) {
  const raw = secret_(prop, false).trim().split('?')[0].replace(/\/+$/, '');
  if (!raw) {
    return { error: prop + ' is not set. In the Apps Script editor: Deploy → Test deployments → copy the Web app URL ' +
      '(ends in /dev), then Project Settings → Script Properties → add ' + prop + ' with that link.' };
  }
  if (!/^https:\/\/script\.google\.com\/(a\/macros\/[^/]+|macros)\/s\/[\w-]+\/(dev|exec)$/.test(raw)) {
    return { error: prop + ' doesn\'t look like a web app link (it should end in /dev or /exec): ' + raw };
  }
  return { url: raw };
}

/* =====================================================================
 * CONTROL PANEL — one read-only endpoint per tab.
 *
 * Every function checks the dashboard key itself: the page is public by
 * URL, so the key is the lock on the data, not just on the page.
 * Anything that CHANGES state (promote, reset, run) stays in the sheet
 * menu, where your Google login protects it.
 *
 * google.script.run can't return Date objects, so every cell goes
 * through cell_() before it leaves the server.
 * ===================================================================== */

function requireKey_(k) {
  const expected = secret_('DASHBOARD_KEY', false);
  if (!expected || !safeEqual_(k, expected)) throw new Error('Locked');
}

function cell_(v) {
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : Utilities.formatDate(v, CONFIG.TZ, 'dd MMM yyyy HH:mm');
  if (typeof v === 'number') {
    if (!isFinite(v)) return '';
    return Math.abs(v) < 10 && v !== Math.round(v) ? Math.round(v * 1e6) / 1e6 : Math.round(v * 100) / 100;
  }
  return v === null || v === undefined ? '' : String(v);
}

/** Header row plus the newest n data rows, newest first. */
function readTable_(name, n) {
  const s = ss_().getSheetByName(name);
  if (!s || s.getLastRow() < 1 || s.getLastColumn() < 1) return { headers: [], rows: [] };
  const cols = s.getLastColumn();
  const headers = s.getRange(1, 1, 1, cols).getValues()[0].map(h => String(h));
  const count = Math.min(n, Math.max(0, s.getLastRow() - 1));
  const rows = count ? s.getRange(s.getLastRow() - count + 1, 1, count, cols).getValues().map(r => r.map(cell_)) : [];
  return { headers: headers, rows: rows.reverse() };
}

function shortDate_(v) {
  const d = v instanceof Date ? v : new Date(v);
  return isNaN(d.getTime()) ? '' : Utilities.formatDate(d, CONFIG.TZ, 'dd MMM');
}

/* ---------- Paper tab ---------- */
function getPaperData(k) {
  requireKey_(k);
  let price = null;
  try { price = fetchTickerPrice_(); } catch (e) {}
  const s = paperStatus_(price);
  const a = getPaper_();
  return {
    enabled: CONFIG.PAPER.enabled,
    price: round_(price),
    equity: round_(s.equity), start: s.startingEquity, returnPct: round_(s.returnPct),
    cash: round_(s.cash), units: s.units, openPnl: round_(s.openPnl), entryFill: round_(s.entryFill),
    fees: round_(s.feesPaid), realized: round_(s.realizedPnl), trades: s.trades,
    winRate: s.winRate === null ? null : round_(s.winRate), drawdownPct: round_(s.drawdownPct),
    startedAt: a.startedAt ? Utilities.formatDate(new Date(a.startedAt), CONFIG.TZ, 'dd MMM yyyy') : '',
    feePct: CONFIG.PAPER.feePct, slippagePct: CONFIG.PAPER.slippagePct,
    curve: lastRows_('Equity', 400).map(r => ({ t: shortDate_(r[1]), v: Number(r[5]) })),
    fills: readTable_('PaperTrades', 40),
    challenger: challengerCompare_(price)
  };
}

/* ---------- Backtests tab ---------- */
function getBacktestData(k) {
  requireKey_(k);
  const out = { log: readTable_('BT_Log', 60), curve: null };
  const s = ss_().getSheetByName('BT_Equity');
  if (s && s.getLastRow() > 2) {
    const v = s.getRange(2, 1, s.getLastRow() - 1, 4).getValues();
    const step = Math.max(1, Math.ceil(v.length / 300));
    const c = { labels: [], strat: [], hold: [], dd: [] };
    for (let i = 0; i < v.length; i += step) {
      c.labels.push(v[i][0] instanceof Date ? Utilities.formatDate(v[i][0], 'UTC', 'MMM yyyy') : String(v[i][0]).slice(0, 7));
      c.strat.push(Number(v[i][1])); c.hold.push(Number(v[i][2])); c.dd.push(Number(v[i][3]));
    }
    out.curve = c;
  }
  return out;
}

/* ---------- Lab tab ---------- */
function getLabData(k) {
  requireKey_(k);
  const p = PropertiesService.getScriptProperties();
  return {
    live: p.getProperty('LIVE_STRATEGY') || '',
    tried: Number(p.getProperty('LAB_TRIED') || 0),
    holdoutUses: Number(p.getProperty('LAB_HOLDOUT_USES') || 0),
    strategy: CONFIG.STRATEGY,
    runHour: CONFIG.LAB ? CONFIG.LAB.runHour : null,
    queue: readTable_('Lab_Queue', 200),
    log: readTable_('Lab_Log', 40)
  };
}

/* ---------- System tab ---------- */
function getSystemData(k) {
  requireKey_(k);
  let triggers = [];
  try { triggers = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction()); } catch (e) {}
  return {
    provider: CONFIG.MARKET.provider, symbol: CONFIG.MARKET.symbol, interval: CONFIG.MARKET.intervalMinutes,
    model: CONFIG.ANALYST.model, agent: !!(CONFIG.AGENT && CONFIG.AGENT.enabled),
    tvEnabled: CONFIG.TRADINGVIEW.enabled, challengerOn: !!(CONFIG.CHALLENGER && CONFIG.CHALLENGER.enabled), emailOn: !!CONFIG.ALERTS.email, telegramOn: !!CONFIG.ALERTS.telegramChatId,
    triggers: triggers,
    lastRun: Number(PropertiesService.getScriptProperties().getProperty('LAST_MONITOR_RUN') || 0),
    serverNow: Date.now(),
    log: readTable_(CONFIG.SHEETS.log, 40),
    cross: CONFIG.TRADINGVIEW.enabled ? readTable_('Crosscheck', 20) : null
  };
}

/** Installation check from the panel. Skips the paid Claude call. */
function runPanelChecks(k) {
  requireKey_(k);
  return installChecks_(true);
}