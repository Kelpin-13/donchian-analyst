/**
 * Stocks.gs: a daily watchlist of liquid US stocks and ETFs in the Stocks tab (owner, 19 Nov 2026: "i wish to do
 * multiple stock monitoring, the most important part is liquidity ... use the Sheet").
 *
 * It reads Yahoo Finance daily prices (owner approved Yahoo, 19 Nov 2026) and shows, per ticker, how liquid it is
 * (average dollar volume), how much it moves (ATR as % of price) and its trend (200-day average, 3- and 12-month
 * return, distance from the 52-week high). One signal column, for the PAPER portfolio only: the gap rule that passed
 * research/gap_lab.js (19 Nov 2026, also on a second stock list): the stock opened at least 6% above yesterday's close,
 * closed at or above its open, its low is within 2 ATR of the close, $50M a day traded, and SPY closed above its
 * 200-day average the day before. Buy at that close, stop at the day's low, 0.5% of the paper account at risk.
 * Exits (the Paper tab reminds): half at the close of the 3rd day, then the stop to the entry price, the rest at the
 * next open after a close below the 10-day average.
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
    'MRK', 'ABBV', 'KO', 'PEP', 'WMT', 'COST', 'HD', 'NKE', 'SBUX', 'DIS', 'BA', 'CAT', 'GE', 'F', 'T', 'VZ', 'BABA',
    // research/gap_lab.js list B (the replication list)
    'ABT', 'ACN', 'AIG', 'AMGN', 'AXP', 'BKNG', 'BLK', 'BMY', 'C', 'CHTR', 'CL', 'CMCSA', 'COF', 'COP', 'CSCO', 'CVS', 'DE', 'DHR',
    'DUK', 'EMR', 'FDX', 'GD', 'GILD', 'GM', 'HON', 'IBM', 'ISRG', 'LIN', 'LMT', 'LOW', 'MCD', 'MDLZ', 'MDT', 'MET', 'MMM', 'MO',
    'MS', 'NEE', 'NOW', 'PG', 'PM', 'RTX', 'SCHW', 'SO', 'SPG', 'TGT', 'TMO', 'TXN', 'UNP', 'UPS', 'USB'
  ],
  headers: ['Ticker', 'Price', 'Day %', '$ volume 20d ($M)', 'Liquidity rank', 'ATR 14d % of price', 'Moves rank',
            'vs 200-day %', 'Trend', '3-month %', '12-month %', 'From 52w high %', 'Last day', 'Gap signal (paper)'],
  gapPct: 6, gapMaxAtr: 2, minDollarVolM: 50, riskPct: 0.5
};

/** Timer and menu: rebuild the Stocks tab. */
function runStocks() {
  try {
    const list = stocksList_();
    if (list.indexOf('SPY') < 0) list.push('SPY');          // the gap signal's market filter needs SPY
    const rows = [], missing = [];
    let spyBars = null;
    for (let i = 0; i < list.length; i += 20) {
      const part = list.slice(i, i + 20);
      const res = UrlFetchApp.fetchAll(part.map(t => ({
        url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(t) + '?range=2y&interval=1d',
        muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0 (sheet)' }
      })));
      res.forEach((r, k) => {
        let row = null;
        try {
          if (r.getResponseCode() === 200) {
            const bars = stocksBars_(JSON.parse(r.getContentText()));
            if (part[k] === 'SPY') spyBars = bars;
            row = stocksRow_(part[k], bars);
          }
        } catch (e) { row = null; }
        if (row) rows.push(row); else missing.push(part[k]);
      });
    }
    const marketOk = stocksMarketOk_(spyBars), capital = typeof PAPER !== 'undefined' ? PAPER.capital : 10000;
    rows.forEach(r => { r.signal = stocksGapSignal_(r, marketOk, capital); });
    stocksWrite_(stocksRank_(rows), missing, marketOk);
    const text = stocksAlertText_(rows);
    if (text) {                                    // tell the owner on Telegram (the chat the MT5 report uses)
      try { const chat = telegramChatId_(); if (chat) telegramCall_('sendMessage', { chat_id: String(chat), text }); }
      catch (e) { logLine_('ERROR', 'Stocks: Telegram: ' + e.message); }
    }
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
  return r.timestamp.map((ts, i) => ({ t: ts * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }))
    .filter(b => b.c != null && b.h != null && b.l != null && b.o != null);
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
  const trAt = i => Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c));
  let atrPrev = 0; for (let i = n - 15; i < n - 1; i++) atrPrev += trAt(i); atrPrev /= 14;   // ATR(14) to yesterday
  let dvPrev = 0; for (let i = n - 21; i < n - 1; i++) dvPrev += bars[i].c * bars[i].v; dvPrev /= 20e6;   // $M, to yesterday
  return {
    open: last.o, low: last.l, gapPct: (last.o / bars[n - 2].c - 1) * 100, atrPrev, dvPrev,
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

/** SPY closed above its 200-day average the day before the last bar (the gap rule's market filter). */
function stocksMarketOk_(bars) {
  if (!bars || bars.length < 202) return false;
  const n = bars.length; let s = 0;
  for (let i = n - 201; i < n - 1; i++) s += bars[i].c;
  return bars[n - 2].c > s / 200;
}

/** The gap rule on a row's last day: '' or the paper trade to place. Pure: tested in tests/run.js. */
function stocksGapSignal_(r, marketOk, capital) {
  const g = STOCKS;
  if (!marketOk || r.ticker === 'SPY' || !(r.gapPct >= g.gapPct) || !(r.price >= r.open) || !(r.dvPrev >= g.minDollarVolM)) return '';
  const risk = r.price - r.low;
  if (!(risk > 0) || risk > g.gapMaxAtr * r.atrPrev) return '';
  const shares = Math.floor(Math.min(capital * g.riskPct / 100 / risk, capital * 0.2 / r.price));
  if (shares < 1) return '';
  return 'GAP BUY ' + shares + ' sh at ' + (Math.round(r.price * 100) / 100) + ', stop ' + (Math.round(r.low * 100) / 100) +
         ' (gap ' + (Math.round(r.gapPct * 10) / 10) + '%)';
}

/** The Telegram text for the day's gap signals, or '' when there are none. Pure: tested in tests/run.js. */
function stocksAlertText_(rows) {
  const s = rows.filter(r => r.signal);
  if (!s.length) return '';
  return 'Stocks, paper only: ' + s.length + ' gap signal' + (s.length > 1 ? 's' : '') + ' (' + s[0].lastDay + ' US close)\n' +
         s.map(r => r.ticker + ': ' + r.signal).join('\n') +
         '\nCopy into the Paper tab at that close price. Exits: half at the close of day 3, the rest after a close below the 10-day average.';
}

function stocksWrite_(rows, missing, marketOk) {
  const s = ss_().getSheetByName(STOCKS.sheet) || ss_().insertSheet(STOCKS.sheet);
  s.clear();
  const r1 = x => x === null ? '' : Math.round(x * 10) / 10, r2 = x => x === null ? '' : Math.round(x * 100) / 100;
  const data = rows.map(r => [r.ticker, r2(r.price), r1(r.day), Math.round(r.dollarVol), r.liqRank, r1(r.atrPct), r.movesRank,
                              r1(r.vs200), r.trend, r1(r.r3), r1(r.r12), r1(r.fromHigh), r.lastDay, r.signal || '']);
  s.getRange(1, 1, 1, STOCKS.headers.length).setValues([STOCKS.headers]).setFontWeight('bold');
  if (data.length) s.getRange(2, 1, data.length, STOCKS.headers.length).setValues(data);
  const note = 'Updated ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') +
               '. Yahoo daily prices. Gap signal = the rule that passed research/gap_lab.js, for the PAPER tab only (market filter ' +
               (marketOk ? 'on: SPY above its 200-day' : 'OFF: SPY below its 200-day, no signals') + '). Liquidity = average daily dollar volume; ' +
               'moves = ATR as % of price (how far it travels in a day, both ways). Edit the list in a "' + STOCKS.listSheet +
               '" tab (tickers in column A).' + (missing.length ? ' No data: ' + missing.join(', ') + '.' : '');
  s.getRange(data.length + 3, 1).setValue(note);
  s.setFrozenRows(1);
}
