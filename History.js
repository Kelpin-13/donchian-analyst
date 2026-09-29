/**
 * History.gs — long price history for serious backtesting.
 *
 * The live feed only needs ~400 bars. A backtest you'd believe needs years.
 * Two ways to fill the History sheet:
 *
 *   buildHistory()          Free. Pages through Coinbase's public API.
 *                           ~3 years of 4h bars in about 30 seconds.
 *
 *   importTradingViewCsv()  Needs a paid TradingView plan (chart export).
 *                           Guarantees your backtest runs on EXACTLY the bars
 *                           TradingView's Strategy Tester sees.
 *
 * Every backtest function reads from the History sheet via loadHistory_(),
 * so you fetch once and run as many experiments as you like.
 */

const HISTORY_HEADERS = ['t_ms', 'time_utc', 'open', 'high', 'low', 'close', 'volume'];

/** Fetch years of history from Coinbase and store it. Coinbase provider only. */
function buildHistory() {
  if (CONFIG.MARKET.provider !== 'coinbase') {
    throw new Error('buildHistory() needs MARKET.provider = "coinbase". ' +
      'Kraken only serves 720 bars. For other exchanges, use importTradingViewCsv().');
  }

  const iv = CONFIG.MARKET.intervalMinutes;
  const gran = coinbaseBaseGran_(iv);
  const endMs = Date.now();
  const size = iv * 60 * 1000;
  const startMs = Math.floor((endMs - CONFIG.BACKTEST.historyDays * 86400 * 1000) / size) * size;

  const t0 = Date.now();
  const raw = fetchCoinbaseRange_(CONFIG.MARKET.symbol, gran, startMs, endMs);
  let candles = (gran === iv * 60) ? raw : aggregateCandles_(raw, iv);

  // Drop the still-forming bar, same rule as live.
  const ivMs = iv * 60 * 1000;
  candles = candles.filter(k => k.t + ivMs <= Date.now());

  writeHistory_(candles);
  checkHistoryGaps_(candles);

  Logger.log('Stored %s %sm bars (%s to %s) in %ss.',
    candles.length, iv,
    new Date(candles[0].t).toISOString().slice(0, 10),
    new Date(candles[candles.length - 1].t).toISOString().slice(0, 10),
    ((Date.now() - t0) / 1000).toFixed(1));
}

/**
 * Append only the bars closed since the last stored one. Run weekly by
 * runAutoBacktest(), or from the menu. Builds the full history if the sheet
 * is empty. Returns { added, lastUtc }.
 */
function updateHistory() {
  const s = ss_().getSheetByName(CONFIG.BACKTEST.historySheet);
  if (!s || s.getLastRow() < 3) {
    buildHistory();
    const all = loadHistory_();
    return { added: all.length, lastUtc: utc_(all[all.length - 1].t) };
  }

  const iv = CONFIG.MARKET.intervalMinutes;
  const ivMs = iv * 60 * 1000;
  const lastT = Number(s.getRange(s.getLastRow(), 1).getValue());

  let fresh;
  if (CONFIG.MARKET.provider === 'coinbase') {
    const gran = coinbaseBaseGran_(iv);
    const raw = fetchCoinbaseRange_(CONFIG.MARKET.symbol, gran, lastT + ivMs, Date.now());
    fresh = (gran === iv * 60) ? raw : aggregateCandles_(raw, iv);
  } else {
    fresh = fetchCandles_();   // other providers: the live feed's recent bars
  }
  fresh = fresh.filter(k => k.t > lastT && k.t + ivMs <= Date.now());

  if (fresh.length) {
    const rows = fresh.map(k => [
      k.t, new Date(k.t).toISOString().slice(0, 16).replace('T', ' '), k.o, k.h, k.l, k.c, k.v
    ]);
    s.getRange(s.getLastRow() + 1, 1, rows.length, HISTORY_HEADERS.length).setValues(rows);
    // Check the seam between the old last bar and the new ones.
    checkHistoryGaps_([{ t: lastT }].concat(fresh));
  }

  const endT = fresh.length ? fresh[fresh.length - 1].t : lastT;
  Logger.log('History: added %s new bar(s), last bar now %s UTC.', fresh.length, utc_(endT));
  return { added: fresh.length, lastUtc: utc_(endT) };
}

/**
 * Import a TradingView chart export.
 *
 * 1. On TradingView, set the chart timezone to UTC (bottom-right clock).
 * 2. Scroll left until you have all the history you want loaded.
 * 3. Chart menu -> Download chart data -> ISO time -> Download.
 * 4. In this spreadsheet: File -> Import -> Upload -> "Insert new sheet(s)".
 *    Rename that sheet to TV_Import.
 * 5. Run this function.
 */
function importTradingViewCsv() {
  const s = ss_().getSheetByName('TV_Import');
  if (!s) throw new Error('No sheet named TV_Import. See the steps in the comment above.');

  const values = s.getDataRange().getValues();
  const head = values[0].map(h => String(h).toLowerCase().trim());
  const col = name => head.indexOf(name);

  const ci = { t: col('time'), o: col('open'), h: col('high'), l: col('low'), c: col('close') };
  const vi = head.findIndex(h => h === 'volume' || h.indexOf('vol') === 0);
  Object.keys(ci).forEach(k => {
    if (ci[k] === -1) throw new Error('TV_Import is missing a "' + k + '" column. Headers: ' + head.join(', '));
  });

  const candles = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const t = parseTvTime_(row[ci.t]);
    const c = Number(row[ci.c]);
    if (!t || !isFinite(c)) continue;
    candles.push({
      t: t, o: Number(row[ci.o]), h: Number(row[ci.h]), l: Number(row[ci.l]), c: c,
      v: vi === -1 ? 0 : Number(row[vi]) || 0
    });
  }
  candles.sort((a, b) => a.t - b.t);

  // TradingView includes the forming bar if you export mid-candle. Drop it.
  const ivMs = CONFIG.MARKET.intervalMinutes * 60 * 1000;
  const closed = candles.filter(k => k.t + ivMs <= Date.now());

  writeHistory_(closed);
  checkHistoryGaps_(closed);
  Logger.log('Imported %s bars from TradingView (%s to %s).', closed.length,
    new Date(closed[0].t).toISOString().slice(0, 16),
    new Date(closed[closed.length - 1].t).toISOString().slice(0, 16));
}

/** TradingView exports either UNIX seconds or ISO strings. Handle both. */
function parseTvTime_(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) { const n = Number(s); return n > 1e12 ? n : n * 1000; }
  const ms = Date.parse(s);
  return isNaN(ms) ? null : ms;
}

function writeHistory_(candles) {
  const s = sheet_(CONFIG.BACKTEST.historySheet, null);
  s.clear();
  const rows = [HISTORY_HEADERS].concat(candles.map(k => [
    k.t, new Date(k.t).toISOString().slice(0, 16).replace('T', ' '), k.o, k.h, k.l, k.c, k.v
  ]));
  s.getRange(1, 1, rows.length, HISTORY_HEADERS.length).setValues(rows);
  s.getRange(1, 1, 1, HISTORY_HEADERS.length).setFontWeight('bold');
  s.setFrozenRows(1);
}

/**
 * Read the History sheet. Falls back to the live feed if it's empty, so every
 * backtest function still runs before you've built history — just on less data.
 */
function loadHistory_() {
  const s = ss_().getSheetByName(CONFIG.BACKTEST.historySheet);
  if (!s || s.getLastRow() < 3) {
    Logger.log('History sheet empty — falling back to the live feed (%s bars). ' +
               'Run buildHistory() for a real backtest.', CONFIG.MARKET.candlesToFetch);
    return fetchCandles_();
  }
  const v = s.getRange(2, 1, s.getLastRow() - 1, HISTORY_HEADERS.length).getValues();
  return v.map(r => ({ t: Number(r[0]), o: Number(r[2]), h: Number(r[3]), l: Number(r[4]),
                       c: Number(r[5]), v: Number(r[6]) }))
          .filter(k => isFinite(k.c) && k.c > 0);
}

/**
 * Missing bars silently break lookback indicators — a "20-bar high" across a
 * gap spans more time than you think. Report them so you know.
 */
function checkHistoryGaps_(candles) {
  const ivMs = CONFIG.MARKET.intervalMinutes * 60 * 1000;
  const gaps = [];
  for (let i = 1; i < candles.length; i++) {
    const missing = Math.round((candles[i].t - candles[i - 1].t) / ivMs) - 1;
    if (missing > 0) gaps.push(new Date(candles[i - 1].t).toISOString().slice(0, 16) + ' (+' + missing + ')');
  }
  if (gaps.length) {
    logLine_('WARN', gaps.length + ' gap(s) in history: ' + gaps.slice(0, 10).join('; '));
    Logger.log('WARNING: %s gap(s) in history. First few: %s', gaps.length, gaps.slice(0, 5).join('; '));
  } else {
    Logger.log('No gaps. Every bar is present.');
  }
  return gaps;
}