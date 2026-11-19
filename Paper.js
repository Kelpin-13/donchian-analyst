/**
 * Paper.gs: a paper (pretend-money) stock portfolio in the Paper tab (owner, 19 Nov 2026: "paper first, US ETFs",
 * "use the Sheet"). The owner types each trade; the script fills in prices, profit, risk and a SPY comparison.
 *
 * Owner fills columns A-H, one row per trade, longs only:
 *   Ticker | Entry date | Entry price | Shares | Stop | Exit date | Exit price | Note
 * The script writes columns I-P every morning (after the Stocks tab) and from the menu (Paper: update now):
 *   Last price | Value | P&L $ | P&L % | R | Risk at entry % | Status | Warning
 * and a summary to the right: equity, cash, open risk, closed and open P&L, and what the same money in SPY from the
 * first entry would be worth. Status: OPEN or CLOSED. Warnings: no stop, risk over 1% of the account at entry, the
 * last close under the stop (the stop would have been hit: close it at the stop), more money in use than the account.
 * It places no orders anywhere.
 */
const PAPER = {
  sheet: 'Paper', capital: 10000, maxRiskPct: 1,
  inHeaders: ['Ticker', 'Entry date', 'Entry price', 'Shares', 'Stop', 'Exit date', 'Exit price', 'Note'],
  outHeaders: ['Last price', 'Value', 'P&L $', 'P&L %', 'R', 'Risk at entry %', 'Status', 'Warning']
};

function paperNow() {
  runPaper();
  try { SpreadsheetApp.getUi().alert('Paper', 'The Paper tab is up to date.', SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
}

function runPaper() {
  try {
    const s = paperSheet_(), last = s.getLastRow();
    const rows = last < 2 ? [] : s.getRange(2, 1, last - 1, PAPER.inHeaders.length).getValues()
      .map((r, i) => ({ row: i + 2, ticker: String(r[0]).trim().toUpperCase(), entryDate: paperDate_(r[1]), entry: +r[2], shares: +r[3],
                        stop: r[4] === '' ? null : +r[4], exitDate: paperDate_(r[5]), exit: r[6] === '' ? null : +r[6] }))
      .filter(r => r.ticker);
    const tickers = Array.from(new Set(rows.map(r => r.ticker).concat(['SPY'])));
    const series = {};
    UrlFetchApp.fetchAll(tickers.map(t => ({
      url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(t) + '?range=5y&interval=1d',
      muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0 (sheet)' }
    }))).forEach((r, k) => { try { if (r.getResponseCode() === 200) series[tickers[k]] = stocksBars_(JSON.parse(r.getContentText())); } catch (e) {} });
    const res = paperCalc_(rows, series, PAPER.capital);
    paperWrite_(s, rows, res);
  } catch (e) {
    logLine_('ERROR', 'Paper: ' + e.message);
  }
}

function paperDate_(v) {
  if (v instanceof Date) return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate());
  const m = String(v).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}

function paperSheet_() {
  let s = ss_().getSheetByName(PAPER.sheet);
  if (!s) {
    s = ss_().insertSheet(PAPER.sheet);
    s.getRange(1, 1, 1, PAPER.inHeaders.length + PAPER.outHeaders.length).setValues([PAPER.inHeaders.concat(PAPER.outHeaders)]).setFontWeight('bold');
    s.getRange(1, 1, 1, PAPER.inHeaders.length).setBackground('#fff2cc');
    s.setFrozenRows(1);
    s.getRange(2, 8).setValue('Example: type a ticker in A2, dates as 2026-11-20, prices in dollars. Yellow columns are yours.');
  }
  return s;
}

/** Pure: tested in tests/run.js. series: ticker -> [{t (ms, any hour), c}] oldest first. */
function paperCalc_(rows, series, capital) {
  const lastClose = t => { const s = series[t]; return s && s.length ? s[s.length - 1].c : null; };
  const closeOn = (t, day) => {      // the last close on or before a UTC day
    const s = series[t]; if (!s) return null;
    let c = null; for (const b of s) { if (Math.floor(b.t / 86400000) * 86400000 <= day) c = b.c; else break; }
    return c;
  };
  let cash = capital, closedPnl = 0, openPnl = 0, openRisk = 0, firstDay = null;
  const sorted = rows.slice().sort((a, b) => (a.entryDate || 0) - (b.entryDate || 0));
  const out = {};
  sorted.forEach(r => {
    const o = { warn: [] };
    if (!(r.entry > 0) || !(r.shares > 0)) { o.warn.push('entry price and shares needed'); out[r.row] = o; return; }
    if (r.entryDate !== null && (firstDay === null || r.entryDate < firstDay)) firstDay = r.entryDate;
    const closed = r.exit !== null && r.exit > 0, px = closed ? r.exit : lastClose(r.ticker);
    o.status = closed ? 'CLOSED' : 'OPEN';
    o.last = closed ? null : px;
    o.riskPct = r.stop !== null && r.stop < r.entry ? (r.entry - r.stop) * r.shares / capital * 100 : null;
    if (r.stop === null) o.warn.push('no stop');
    else if (r.stop >= r.entry) o.warn.push('stop not below entry');
    if (o.riskPct !== null && o.riskPct > PAPER.maxRiskPct) o.warn.push('risk over ' + PAPER.maxRiskPct + '% of the account');
    cash -= r.entry * r.shares;
    if (px !== null) {
      o.pnl = (px - r.entry) * r.shares;
      o.pnlPct = (px / r.entry - 1) * 100;
      o.r = r.stop !== null && r.stop < r.entry ? (px - r.entry) / (r.entry - r.stop) : null;
      if (closed) { cash += r.exit * r.shares; closedPnl += o.pnl; }
      else {
        o.value = px * r.shares; openPnl += o.pnl;
        if (r.stop !== null && r.stop < r.entry) openRisk += Math.max(0, (px - r.stop) * r.shares);
        if (r.stop !== null && px <= r.stop) o.warn.push('closed under the stop: exit at the stop');
      }
    } else if (!closed) o.warn.push('no price for ' + r.ticker);
    out[r.row] = o;
  });
  const openValue = Object.values(out).reduce((a, o) => a + (o.value || 0), 0), equity = cash + openValue;
  let spy = null;
  if (firstDay !== null) { const a = closeOn('SPY', firstDay), b = lastClose('SPY'); if (a && b) spy = capital * b / a; }
  return { rows: out, summary: { capital, equity, cash, openValue, openRisk, closedPnl, openPnl, spy, overdrawn: cash < -1e-9 } };
}

function paperWrite_(s, rows, res) {
  const r2 = x => x === null || x === undefined || !isFinite(x) ? '' : Math.round(x * 100) / 100;
  rows.forEach(r => {
    const o = res.rows[r.row] || { warn: [] };
    s.getRange(r.row, PAPER.inHeaders.length + 1, 1, PAPER.outHeaders.length)
      .setValues([[r2(o.last), r2(o.value), r2(o.pnl), r2(o.pnlPct), r2(o.r), r2(o.riskPct), o.status || '', o.warn.join('; ')]]);
  });
  const m = res.summary, col = PAPER.inHeaders.length + PAPER.outHeaders.length + 2;
  const lines = [
    ['Paper account', ''], ['Starting money', m.capital], ['Equity now', r2(m.equity)], ['Cash', r2(m.cash)],
    ['In stocks', r2(m.openValue)], ['Open P&L', r2(m.openPnl)], ['Closed P&L', r2(m.closedPnl)],
    ['Return', m.capital ? r2((m.equity / m.capital - 1) * 100) + '%' : ''],
    ['Open risk (to stops)', r2(m.openRisk)],
    ['Same money in SPY since the first entry', m.spy === null ? '' : r2(m.spy)],
    ['Warning', m.overdrawn ? 'more money in use than the account' : ''],
    ['Updated', Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm')]
  ];
  s.getRange(1, col, lines.length, 2).setValues(lines);
  s.getRange(1, col).setFontWeight('bold');
}
