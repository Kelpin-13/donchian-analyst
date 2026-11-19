/**
 * Stocks.gs: a daily watchlist of liquid US stocks and ETFs in the Stocks tab (owner, 19 Nov 2026: "i wish to do
 * multiple stock monitoring, the most important part is liquidity ... use the Sheet").
 *
 * Monitoring only: it reads Yahoo Finance daily prices (owner approved Yahoo, 19 Nov 2026) and shows, per ticker, how
 * liquid it is (average dollar volume), how much it moves (ATR as % of price) and its trend (200-day average, 3- and
 * 12-month return, distance from the 52-week high). It gives no buy or sell signal: a rule goes in only after it has
 * passed a backtest in research/.
 *
 * The list: tickers in column A of a tab named "Stock List" (header in row 1), if that tab exists; otherwise
 * STOCKS.defaults. Runs once a day after the US close (its timer installs itself from the morning timer, like the
 * watchdog, so a clasp push is enough), and from the menu: Stocks: refresh now.
 */
const STOCKS = {
  sheet: 'Stocks', listSheet: 'Stock List', hour: 6, minute: 30,     // script time zone; the US close is 05:00 in UTC+8 winter
  defaults: [
    'SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLI', 'SMH', 'TLT', 'GLD',
    'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'AMD', 'NFLX', 'ORCL', 'CRM', 'ADBE', 'QCOM', 'MU',
    'INTC', 'PLTR', 'UBER', 'COIN', 'JPM', 'BAC', 'WFC', 'GS', 'V', 'MA', 'PYPL', 'XOM', 'CVX', 'UNH', 'LLY', 'JNJ', 'PFE',
    'MRK', 'ABBV', 'KO', 'PEP', 'WMT', 'COST', 'HD', 'NKE', 'SBUX', 'DIS', 'BA', 'CAT', 'GE', 'F', 'T', 'VZ', 'BABA'
  ],
  headers: ['Ticker', 'Price', 'Day %', '$ volume 20d ($M)', 'Liquidity rank', 'ATR 14d % of price', 'Moves rank',
            'vs 200-day %', 'Trend', '3-month %', '12-month %', 'From 52w high %', 'Last day']
};

/** Timer and menu: rebuild the Stocks tab. */
function runStocks() {
  try {
    const list = stocksList_();
    const rows = [], missing = [];
    for (let i = 0; i < list.length; i += 20) {
      const part = list.slice(i, i + 20);
      const res = UrlFetchApp.fetchAll(part.map(t => ({
        url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(t) + '?range=2y&interval=1d',
        muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0 (sheet)' }
      })));
      res.forEach((r, k) => {
        let row = null;
        try { if (r.getResponseCode() === 200) row = stocksRow_(part[k], stocksBars_(JSON.parse(r.getContentText()))); } catch (e) { row = null; }
        if (row) rows.push(row); else missing.push(part[k]);
      });
    }
    stocksWrite_(stocksRank_(rows), missing);
  } catch (e) {
    logLine_('ERROR', 'Stocks: ' + e.message);
  }
  if (ss_().getSheetByName(PAPER.sheet)) runPaper();   // Paper.gs: the paper portfolio, once the tab exists
}
function stocksNow() {
  runStocks();
  try { SpreadsheetApp.getUi().alert('Stocks', 'The Stocks tab is up to date.', SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
}

/** Installs the daily timer once. Called by runMorningMap (a timer, so it runs the newest code). */
function stocksEnsure_() {
  if (ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'runStocks')) return false;
  ScriptApp.newTrigger('runStocks').timeBased().atHour(STOCKS.hour).nearMinute(STOCKS.minute).everyDays(1)
    .inTimezone(Session.getScriptTimeZone()).create();
  logLine_('INFO', 'Stocks: daily timer installed');
  return true;
}

function stocksList_() {
  const s = ss_().getSheetByName(STOCKS.listSheet);
  if (!s || s.getLastRow() < 2) return STOCKS.defaults.slice();
  const seen = {};
  return s.getRange(2, 1, s.getLastRow() - 1, 1).getValues().map(r => String(r[0]).trim().toUpperCase())
    .filter(t => /^[A-Z0-9.\-^=]{1,12}$/.test(t) && !seen[t] && (seen[t] = true));
}

/** Yahoo chart JSON -> [{t, h, l, c, v}] (split-adjusted, oldest first). */
function stocksBars_(j) {
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) return [];
  const q = r.indicators.quote[0];
  return r.timestamp.map((ts, i) => ({ t: ts * 1000, h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }))
    .filter(b => b.c != null && b.h != null && b.l != null);
}

/** One ticker's row (before ranking), or null with too little history. Pure: tested in tests/run.js. */
function stocksRow_(ticker, bars) {
  const n = bars.length;
  if (n < 30) return null;
  const last = bars[n - 1], c = last.c;
  const avg = (from, f) => { let s = 0, k = 0; for (let i = Math.max(0, from); i < n; i++) { s += f(bars[i], i); k++; } return k ? s / k : null; };
  const dollarVol = avg(n - 20, b => b.c * b.v) / 1e6;
  const atr = avg(n - 14, (b, i) => i ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l);
  const sma200 = n >= 200 ? avg(n - 200, b => b.c) : null;
  const ret = d => n > d ? (c / bars[n - 1 - d].c - 1) * 100 : null;
  let hi = -Infinity; for (let i = Math.max(0, n - 252); i < n; i++) hi = Math.max(hi, bars[i].h);
  const vs200 = sma200 ? (c / sma200 - 1) * 100 : null;
  return {
    ticker, price: c, day: (c / bars[n - 2].c - 1) * 100, dollarVol, atrPct: atr / c * 100, vs200,
    trend: vs200 === null ? '' : vs200 > 0 ? 'Up' : 'Down', r3: ret(63), r12: ret(252), fromHigh: (c / hi - 1) * 100,
    lastDay: Utilities.formatDate(new Date(last.t), 'America/New_York', 'yyyy-MM-dd')
  };
}

/** Rank by liquidity (1 = most dollar volume) and by moves (1 = biggest ATR %); sorted by liquidity. */
function stocksRank_(rows) {
  rows.slice().sort((a, b) => b.atrPct - a.atrPct).forEach((r, i) => { r.movesRank = i + 1; });
  return rows.sort((a, b) => b.dollarVol - a.dollarVol).map((r, i) => Object.assign(r, { liqRank: i + 1 }));
}

function stocksWrite_(rows, missing) {
  const s = ss_().getSheetByName(STOCKS.sheet) || ss_().insertSheet(STOCKS.sheet);
  s.clear();
  const r1 = x => x === null ? '' : Math.round(x * 10) / 10, r2 = x => x === null ? '' : Math.round(x * 100) / 100;
  const data = rows.map(r => [r.ticker, r2(r.price), r1(r.day), Math.round(r.dollarVol), r.liqRank, r1(r.atrPct), r.movesRank,
                              r1(r.vs200), r.trend, r1(r.r3), r1(r.r12), r1(r.fromHigh), r.lastDay]);
  s.getRange(1, 1, 1, STOCKS.headers.length).setValues([STOCKS.headers]).setFontWeight('bold');
  if (data.length) s.getRange(2, 1, data.length, STOCKS.headers.length).setValues(data);
  const note = 'Updated ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') +
               '. Yahoo daily prices. Monitoring only, no buy/sell signals. Liquidity = average daily dollar volume; ' +
               'moves = ATR as % of price (how far it travels in a day, both ways). Edit the list in a "' + STOCKS.listSheet +
               '" tab (tickers in column A).' + (missing.length ? ' No data: ' + missing.join(', ') + '.' : '');
  s.getRange(data.length + 3, 1).setValue(note);
  s.setFrozenRows(1);
}
