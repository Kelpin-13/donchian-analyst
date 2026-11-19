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
 * The 07:30 Telegram report (Watchdog.gs, gold demo) ends with a stocks section from this tab: equity vs the same money
 * in SPY, open trades, and any rule reminder (owner, 19 Nov 2026: "run both stocks and gold"). Kept in Script
 * Property PAPER_REPORT by runPaper, which runs after the Stocks tab at about 06:30.
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
    const m = res.summary, actions = [];
    rows.forEach(r => { const o = res.rows[r.row]; if (o && o.warn.length) actions.push(r.ticker + ': ' + o.warn.join('; ')); });
    PropertiesService.getScriptProperties().setProperty('PAPER_REPORT', JSON.stringify({
      at: Date.now(), capital: m.capital, equity: m.equity, spy: m.spy,
      open: rows.filter(r => res.rows[r.row] && res.rows[r.row].status === 'OPEN').length,
      trades: rows.length, actions: actions.slice(0, 8) }));
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
        const hint = paperExitHint_(series[r.ticker], r.entryDate);
        if (hint) o.warn.push(hint);
      }
    } else if (!closed) o.warn.push('no price for ' + r.ticker);
    out[r.row] = o;
  });
  const openValue = Object.values(out).reduce((a, o) => a + (o.value || 0), 0), equity = cash + openValue;
  let spy = null;
  if (firstDay !== null) { const a = closeOn('SPY', firstDay), b = lastClose('SPY'); if (a && b) spy = capital * b / a; }
  return { rows: out, summary: { capital, equity, cash, openValue, openRisk, closedPnl, openPnl, spy, overdrawn: cash < -1e-9 } };
}

/**
 * The gap rule's exits (research/gap_lab.js) for an open trade: day 3 after the entry day = sell half at that close and
 * move the stop to the entry price; a close below the 10-day average = sell the rest at the next open.
 */
function paperExitHint_(bars, entryDay) {
  if (!bars || !bars.length || entryDay === null) return '';
  const day = b => Math.floor(b.t / 86400000) * 86400000, n = bars.length;
  const after = bars.filter(b => day(b) > entryDay).length;
  const hints = [];
  if (after === 3) hints.push('rule: day 3, sell half at today\'s close and move the stop to the entry price');
  if (after >= 1 && n >= 10) {
    let s = 0; for (let i = n - 10; i < n; i++) s += bars[i].c;
    if (bars[n - 1].c < s / 10) hints.push('rule: closed below the 10-day average, sell the rest at the next open');
  }
  return hints.join('; ');
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

/** The stocks section of the 07:30 report (HTML), or '' when the Paper tab has not run in the last 4 days. Pure. */
function paperReportText_(st, now) {
  if (!st || !st.at || now - st.at > 4 * 86400000) return '';
  const esc = x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const usd = v => '$' + Math.round(v).toLocaleString('en-US');
  if (!st.trades) return '<b>Stocks (paper)</b>\nNo trades yet: waiting for the first gap signal.';
  const pct = (st.equity / st.capital - 1) * 100;
  const lines = ['<b>Stocks (paper)</b>',
    'Equity ' + usd(st.equity) + ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(1) + '%)' +
      (st.spy ? ', same money in SPY ' + usd(st.spy) + ' (' + (st.spy >= st.capital ? '+' : '') + ((st.spy / st.capital - 1) * 100).toFixed(1) + '%)' : ''),
    'Open trades: ' + st.open];
  (st.actions || []).forEach(a => lines.push('! ' + esc(a)));
  return lines.join('\n');
}
