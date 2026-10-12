/**
 * Mt5.gs — results from the two MT5 Expert Advisors on the OANDA demo, gathered in this spreadsheet.
 *
 * Each EA (mt5/DonchianGold.mq5, mt5/GoldIntraday.mq5, via mt5/SheetSync.mqh) POSTs the new lines of
 * its journal to this web app about every half minute, plus a heartbeat every 10 minutes. doPost
 * (Webhook.gs) hands them to handleMt5_(). Lines land once each in MT5 Log; from that log this file
 * rebuilds MT5 Trades (one row per trade) and MT5 Summary (the page to read).
 *
 * Apps Script still places no orders: this only records what the EAs did.
 * Security: the EAs send MT5_KEY (Script Properties) in the body; anything else is rejected.
 * Menu: Trading Agent → MT5 gold EAs → Connect MT5 shows the link and the key to paste into both EAs.
 */

const MT5_LOG = 'MT5 Log', MT5_TRADES = 'MT5 Trades', MT5_SUMMARY = 'MT5 Summary';
const MT5_LOG_HEADERS = ['Time (your clock)', 'Server time', 'EA', 'Strategy', 'Event', 'Equity', 'Detail', 'Id'];
const MT5_TRADE_HEADERS = ['Opened', 'Closed', 'Strategy', 'Direction', 'Lots', 'Entry', 'Stop', 'Exit', 'Exit reason',
                           'Result (R)', 'P&L ($)', 'Slippage ($)', 'Why it entered'];
const MT5_EAS = {
  DonchianGold: { label: 'H4 swing EA (DonchianGold)', strategyColumn: false },
  GoldIntraday: { label: 'Intraday EA (GoldIntraday)', strategyColumn: true }
};
// What each strategy does, and what 3.75 years of the broker's data says to expect (research/).
const MT5_STRATEGIES = [
  { id: 'H4', ea: 'DonchianGold', name: 'H4 swing breakout', risk: 1, perWeek: 0.74, avgR: 0.29,
    how: '20-bar breakout on 4-hour bars, with the trend; holds for days' },
  { id: 'NY_ORB', ea: 'GoldIntraday', name: 'New York opening range', risk: 0.25, perWeek: 3.3, avgR: 0.062,
    how: 'Breakout of the first half hour of New York trading, with the H4 trend' },
  { id: 'ASIAN_NARROW', ea: 'GoldIntraday', name: 'Asian range breakout', risk: 0.25, perWeek: 1.7, avgR: 0.047,
    how: 'Breakout of a quiet Asian session (01:00-09:00 server time)' },
  { id: 'DUAL_THRUST', ea: 'GoldIntraday', name: 'Dual Thrust', risk: 0.25, perWeek: 1.6, avgR: 0.039,
    how: "Breakout of the day's open +/- half the 4-day range; flips on its stop" },
  { id: 'R_BREAKER', ea: 'GoldIntraday', name: 'R-Breaker', risk: 0.25, perWeek: 0.5, avgR: 0.136,
    how: "Breakouts and reversals at levels from yesterday's prices, with the H4 trend" },
  { id: 'MOM_16', ea: 'GoldIntraday', name: 'Momentum at 16:00', risk: 0.25, perWeek: 2.8, avgR: 0.073,
    how: "Joins the day's direction at 16:00 server time, with the H4 trend" },
  { id: 'MOM_20', ea: 'GoldIntraday', name: 'Momentum at 20:00', risk: 0.25, perWeek: 2.9, avgR: 0.025,
    how: "Joins the day's direction at 20:00 server time, with the H4 trend" }
];
const MT5_EXIT_WORDS = {
  EXIT_STOP: 'Stop loss', EXIT_CHANNEL: 'Trend ended (10-bar channel)', EXIT_TIME: 'Time limit (60 bars)',
  EXIT_HARDSTOP: 'Broker safety stop', EXIT_SESSION: 'Day end (closed at 23:00)', EXIT_REVERSE: 'Reversed',
  EXIT_RETRY: 'Exit (after retries)', KILL_SWITCH: 'Kill switch', EXIT_KILL_SWITCH: 'Kill switch',
  EXIT_MANUAL: '⚠️ Closed by hand', EXIT_EXTERNAL: '⚠️ Closed outside the EA', EXIT_STOPOUT: '⚠️ Margin stop-out'
};
const MT5_CONTRACT = 100;            // XAUUSD.sml: 1 lot = 100 oz (used only when an old row has no profit)
const MT5_SILENT_DAYS = 1 / 24;      // the Summary flags an EA silent for an hour (heartbeat: 10 minutes)

/* ------------------------------------------------------------------ */
/** doPost route for the EAs. Returns the text the EA reads back: "stored N", "rejected" or "busy". */
function handleMt5_(body) {
  const key = secret_('MT5_KEY', false);
  if (!key || !safeEqual_(body.key, key)) { logLine_('WARN', 'MT5 post rejected: bad or missing key'); return 'rejected'; }
  const ea = String(body.ea || '');
  if (!MT5_EAS[ea]) { logLine_('WARN', 'MT5 post rejected: unknown EA ' + ea.slice(0, 40)); return 'rejected'; }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return 'busy';
  try {
    mt5SaveStatus_(ea, body);
    const added = mt5AppendLines_(ea, body);
    if (added || !ss_().getSheetByName(MT5_SUMMARY)) mt5Rebuild_();
    else mt5WriteLiveCells_();
    return 'stored ' + added;
  } finally {
    lock.releaseLock();
  }
}

/** The latest heartbeat of each EA: when, equity, open positions. */
function mt5SaveStatus_(ea, body) {
  const all = mt5Status_();
  all[ea] = { seen: Date.now(), equity: Number(body.equity) || null, balance: Number(body.balance) || null,
              open: Number(body.open) || 0, floating: Number(body.floating) || 0 };
  PropertiesService.getScriptProperties().setProperty('MT5_STATUS', JSON.stringify(all));
}
function mt5Status_() {
  try { return JSON.parse(secret_('MT5_STATUS', false) || '{}'); } catch (e) { return {}; }
}

/**
 * New journal lines → MT5 Log, each once. A line's id is EA + its line number in the journal + its time,
 * so a resend after an EA restart changes nothing.
 */
function mt5AppendLines_(ea, body) {
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) return 0;
  const s = sheet_(MT5_LOG, MT5_LOG_HEADERS);
  const last = s.getLastRow();
  const have = new Set(last >= 2 ? s.getRange(2, 8, last - 1, 1).getValues().map(r => String(r[0])) : []);
  const from = Number(body.from) || 1, offsetMs = (Number(body.offset) || 0) * 1000;
  const withStrategy = MT5_EAS[ea].strategyColumn;
  const rows = [];
  lines.forEach((line, i) => {
    line = String(line || '').trim();
    if (!line || /^server_time,/.test(line)) return;                    // the header
    const p = line.split(',');
    const server = p[0], serverMs = Date.parse(server.replace(/\./g, '-').replace(' ', 'T') + 'Z');
    if (!isFinite(serverMs) || serverMs < Date.UTC(2020, 0, 1)) return;   // the tester's 1970 init check
    const id = ea + ':' + (from + i) + ':' + server;
    if (have.has(id)) return;
    have.add(id);
    const f = withStrategy ? { strat: p[1], ev: p[2], eq: p[3], rest: p.slice(4) } : { strat: 'H4', ev: p[1], eq: p[2], rest: p.slice(3) };
    rows.push([new Date(serverMs - offsetMs), server, ea, f.strat, f.ev, Number(f.eq), f.rest.join(','), id]);
  });
  if (rows.length) s.getRange(last + 1, 1, rows.length, MT5_LOG_HEADERS.length).setValues(rows);
  return rows.length;
}

/* ------------------------------------------------------------------ */
/** Menu: rebuild the two result sheets from MT5 Log. */
function mt5RebuildNow() {
  mt5Rebuild_();
  try { ss_().setActiveSheet(ss_().getSheetByName(MT5_SUMMARY)); } catch (e) {}
}

function mt5Rebuild_() {
  const log = mt5ReadLog_();
  const built = mt5BuildTrades_(log);
  mt5WriteTrades_(built.trades, built.open);
  mt5WriteSummary_(log, built.trades, built.open);
}

function mt5ReadLog_() {
  const s = ss_().getSheetByName(MT5_LOG);
  if (!s || s.getLastRow() < 2) return [];
  return s.getRange(2, 1, s.getLastRow() - 1, MT5_LOG_HEADERS.length).getValues()
    .map(r => ({ time: new Date(r[0]), ea: String(r[2]), strat: String(r[3]), ev: String(r[4]), eq: Number(r[5]), detail: String(r[6]) }))
    .sort((a, b) => a.time - b.time);
}

function mt5Num_(re, s) { const m = re.exec(s || ''); return m ? Number(m[1]) : null; }

/** Pair each strategy's entries with its exits. */
function mt5BuildTrades_(log) {
  const open = {}, level = {}, trades = [];
  log.forEach(r => {
    const k = r.ea + '|' + r.strat;
    if (r.ev === 'ORDER') {                                   // a resting stop order: its level, for slippage
      const m = /^(buy|sell) stop at ([\d.]+)/.exec(r.detail);
      if (m) level[k + '|' + (m[1] === 'buy' ? 1 : -1)] = Number(m[2]);
      return;
    }
    if (r.ev === 'ENTRY_LONG' || r.ev === 'ENTRY_SHORT') {
      const side = r.ev === 'ENTRY_LONG' ? 1 : -1;
      const entry = mt5Num_(/lots at ([\d.]+)/, r.detail);
      const viaStop = /^stop order filled/.test(r.detail), lvl = level[k + '|' + side];
      let why = r.strat === 'H4' ? (side === 1 ? 'New 20-bar high in an uptrend' : 'New 20-bar low in a downtrend')
                                 : r.detail.split(':')[0];
      if (viaStop) why = (side === 1 ? 'Broke above ' : 'Broke below ') + (lvl || '?') + ' (stop order)';
      open[k] = { opened: r.time, closed: null, ea: r.ea, strat: r.strat, side, entry,
                  lots: mt5Num_(/([\d.]+) lots/, r.detail), stop: mt5Num_(/stop ([\d.]+)/, r.detail),
                  slip: viaStop && lvl && entry ? Math.round((entry - lvl) * side * 100) / 100 : null, why };
      return;
    }
    if (!/^EXIT_|^KILL_SWITCH$/.test(r.ev) || !open[k]) return;
    const t = open[k];
    delete open[k];
    t.closed = r.time;
    t.exit = mt5Num_(/closed (?:ticket \d+ )?at ([\d.]+)/, r.detail);
    t.reason = MT5_EXIT_WORDS[r.ev] || r.ev;
    const risk = t.entry && t.stop ? Math.abs(t.entry - t.stop) : 0;
    t.r = risk && t.exit ? Math.round((t.exit - t.entry) * t.side / risk * 100) / 100 : null;
    const profit = mt5Num_(/profit (-?[\d.]+)/, r.detail);
    t.pnl = profit !== null ? profit
          : (t.exit && t.lots ? Math.round((t.exit - t.entry) * t.side * t.lots * MT5_CONTRACT * 100) / 100 : null);
    trades.push(t);
  });
  return { trades, open: Object.keys(open).map(k => open[k]) };
}

function mt5Name_(id) { const s = MT5_STRATEGIES.filter(x => x.id === id)[0]; return s ? s.name : id; }

/* ------------------------------------------------------------------ */
function mt5WriteTrades_(trades, open) {
  const s = sheet_(MT5_TRADES, MT5_TRADE_HEADERS);
  s.clear();
  const rows = [MT5_TRADE_HEADERS];
  open.slice().reverse().forEach(t => rows.push([t.opened, 'open', mt5Name_(t.strat), t.side === 1 ? 'BUY' : 'SELL', t.lots, t.entry,
                                                 t.stop, '', 'still open', '', '', t.slip === null ? '' : t.slip, t.why]));
  trades.slice().reverse().forEach(t => rows.push([t.opened, t.closed, mt5Name_(t.strat), t.side === 1 ? 'BUY' : 'SELL', t.lots, t.entry,
                                                   t.stop, t.exit, t.reason, t.r === null ? '' : t.r, t.pnl === null ? '' : t.pnl,
                                                   t.slip === null ? '' : t.slip, t.why]));
  s.getRange(1, 1, rows.length, MT5_TRADE_HEADERS.length).setValues(rows);
  s.setFrozenRows(1);
  s.getRange(1, 1, 1, MT5_TRADE_HEADERS.length).setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');
  if (rows.length > 1) {
    const n = rows.length - 1;
    s.getRange(2, 1, n, 2).setNumberFormat('ddd d mmm hh:mm');
    s.getRange(2, 6, n, 3).setNumberFormat('0.00');
    s.getRange(2, 10, n, 1).setNumberFormat('+0.00"R";-0.00"R";0.00"R"');
    s.getRange(2, 11, n, 1).setNumberFormat('+$#,##0.00;-$#,##0.00;$0.00');
    s.getRange(2, 1, n, MT5_TRADE_HEADERS.length).setFontColor('#111827').setBackground('#ffffff');
    s.getRange(2, 10, n, 2).setFontColors(rows.slice(1).map(r => {
      const v = r[10] !== '' ? r[10] : r[9];
      const c = v === '' ? '#6b7280' : v > 0 ? '#047857' : v < 0 ? '#b91c1c' : '#374151';
      return [c, c];
    }));
    if (open.length) s.getRange(2, 1, open.length, MT5_TRADE_HEADERS.length).setBackground('#fef9c3');
  }
  [150, 150, 190, 75, 60, 85, 85, 85, 200, 85, 95, 95, 320].forEach((w, i) => s.setColumnWidth(i + 1, w));
}

/* ------------------------------------------------------------------ */
// Fixed rows of the Summary, so a heartbeat can refresh them without a rebuild.
const MT5_ROW = { equity: 5, open: 11, eaFirst: 14 };

function mt5WriteSummary_(log, trades, open) {
  const ss = ss_();
  let s = ss.getSheetByName(MT5_SUMMARY);
  if (!s) {
    s = ss.insertSheet(MT5_SUMMARY);
    try { ss.setActiveSheet(s); ss.moveActiveSheet(1); } catch (e) {}         // first tab: the page to read
  }
  s.clear();
  try { s.getCharts().forEach(c => s.removeChart(c)); } catch (e) {}

  const status = mt5Status_();
  const startEq = (log.filter(r => r.eq > 0)[0] || {}).eq || 10000;
  const pnls = trades.map(t => t.pnl || 0);
  const total = pnls.reduce((a, b) => a + b, 0);
  const won = trades.filter(t => (t.pnl !== null ? t.pnl : t.r || 0) > 0).length;
  const gw = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0), gl = -pnls.filter(p => p < 0).reduce((a, b) => a + b, 0);
  let bal = startEq, peak = startEq, dd = 0;
  const curve = [['Closed', 'Balance'], [log.length ? log[0].time : new Date(), startEq]];
  trades.slice().sort((a, b) => a.closed - b.closed).forEach(t => {
    bal += t.pnl || 0; peak = Math.max(peak, bal); dd = Math.max(dd, (peak - bal) / peak);
    curve.push([t.closed, Math.round(bal * 100) / 100]);
  });
  const firstStart = (log.filter(r => r.ev === 'START')[0] || log[0] || { time: new Date() }).time;
  const weeks = Math.max(0, (Date.now() - firstStart.getTime()) / (7 * 86400000));

  const fmtMoney = '$#,##0.00', fmtSigned = '+$#,##0.00;-$#,##0.00;$0.00';
  const header = (row, text) => s.getRange(row, 1, 1, 9).setValues([[text, '', '', '', '', '', '', '', '']])
    .setFontWeight('bold').setBackground('#1f2937').setFontColor('#ffffff');

  s.getRange(1, 1).setValue('Gold EAs on the OANDA demo account').setFontSize(16).setFontWeight('bold');
  s.getRange(2, 1).setValue('Updated ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'EEE d MMM HH:mm') +
    '. Everything here is sent by the two Expert Advisors on your laptop; nothing is typed by hand.').setFontColor('#6b7280');

  header(4, 'ACCOUNT');
  s.getRange(5, 1, 7, 3).setValues([
    ['Equity now', '', 'the whole demo account, both EAs, including open trades'],
    ['Started with', startEq, ''],
    ['Profit / loss (closed trades)', total, (total >= 0 ? '+' : '') + (total / startEq * 100).toFixed(2) + '% of the starting balance'],
    ['Closed trades', trades.length, won + ' won, ' + (trades.length - won) + ' lost' +
      (trades.length ? ' (' + Math.round(won / trades.length * 100) + '% winners)' : '')],
    ['Profit factor', gl ? Math.round(gw / gl * 100) / 100 : (gw ? 'no losses yet' : '-'), 'money won ÷ money lost: above 1 means profitable'],
    ['Worst drawdown', dd, 'the biggest fall from a high point, closed trades (backtest worst: about 9% intraday)'],
    ['Open right now', '', '']
  ]);
  s.getRange(5, 1, 7, 1).setFontWeight('bold');
  s.getRange(5, 2, 3, 1).setNumberFormat(fmtMoney);
  s.getRange(7, 2).setNumberFormat(fmtSigned).setFontColor(total >= 0 ? '#047857' : '#b91c1c');
  s.getRange(10, 2).setNumberFormat('0.0%');
  s.getRange(5, 3, 7, 1).setFontColor('#6b7280');

  header(13, 'IS IT RUNNING?');
  Object.keys(MT5_EAS).forEach((ea, i) => {
    const row = MT5_ROW.eaFirst + i;
    s.getRange(row, 1).setValue(MT5_EAS[ea].label).setFontWeight('bold');
    s.getRange(row, 3).setFormula('=IF(B' + row + '="","not connected yet",IF(NOW()-B' + row + '>' + MT5_SILENT_DAYS +
      ',"⚠️ no contact for "&TEXT(NOW()-B' + row + ',"[h]:mm")&" (laptop off, asleep or MT5 closed?)","✅ running"))');
  });
  s.getRange(MT5_ROW.eaFirst, 2, 2, 1).setNumberFormat('ddd d mmm hh:mm');

  header(17, 'BY STRATEGY');
  const t0 = 18;
  const rows = [['Strategy', 'Trades', 'What it does', 'Win %', 'Result (R)', 'Avg R / trade', 'Backtest avg R', 'P&L ($)', 'Expected trades by now']];
  MT5_STRATEGIES.forEach(st => {
    const ts = trades.filter(t => t.strat === st.id);
    const w = ts.filter(t => (t.pnl !== null ? t.pnl : t.r || 0) > 0).length;
    const r = ts.reduce((a, t) => a + (t.r || 0), 0), p = ts.reduce((a, t) => a + (t.pnl || 0), 0);
    rows.push([st.name + (st.risk === 1 ? ' (1% risk)' : ''), ts.length, st.how, ts.length ? w / ts.length : '', Math.round(r * 100) / 100,
               ts.length ? Math.round(r / ts.length * 1000) / 1000 : '', st.avgR, Math.round(p * 100) / 100, Math.round(st.perWeek * weeks * 10) / 10]);
  });
  const allR = trades.reduce((a, t) => a + (t.r || 0), 0);
  rows.push(['All strategies', trades.length, '', trades.length ? won / trades.length : '', Math.round(allR * 100) / 100,
             trades.length ? Math.round(allR / trades.length * 1000) / 1000 : '', '', Math.round(total * 100) / 100,
             Math.round(MT5_STRATEGIES.reduce((a, st) => a + st.perWeek, 0) * weeks * 10) / 10]);
  s.getRange(t0, 1, rows.length, 9).setValues(rows);
  s.getRange(t0, 1, 1, 9).setFontWeight('bold').setBackground('#e5e7eb');
  s.getRange(t0 + rows.length - 1, 1, 1, 9).setFontWeight('bold').setBackground('#f3f4f6');
  s.getRange(t0 + 1, 4, rows.length - 1, 1).setNumberFormat('0%');
  s.getRange(t0 + 1, 5, rows.length - 1, 1).setNumberFormat('+0.00"R";-0.00"R";0.00"R"');
  s.getRange(t0 + 1, 6, rows.length - 1, 2).setNumberFormat('+0.000"R";-0.000"R";0.000"R"');
  s.getRange(t0 + 1, 8, rows.length - 1, 1).setNumberFormat(fmtSigned);
  s.getRange(t0 + 1, 3, rows.length - 1, 1).setFontColor('#6b7280');
  s.getRange(t0 + 1, 5, rows.length - 1, 1).setFontColors(rows.slice(1).map(r => [r[4] > 0 ? '#047857' : r[4] < 0 ? '#b91c1c' : '#374151']));
  s.getRange(t0 + 1, 8, rows.length - 1, 1).setFontColors(rows.slice(1).map(r => [r[7] > 0 ? '#047857' : r[7] < 0 ? '#b91c1c' : '#374151']));

  const l0 = t0 + rows.length + 1;
  header(l0, 'LAST 10 TRADES   (all trades: the MT5 Trades tab)');
  const last = [['Closed', 'Strategy', 'Exit reason', 'Direction', 'Result (R)', 'P&L ($)']];
  trades.slice().sort((a, b) => b.closed - a.closed).slice(0, 10)
    .forEach(t => last.push([t.closed, mt5Name_(t.strat), t.reason, t.side === 1 ? 'BUY' : 'SELL', t.r === null ? '' : t.r, t.pnl === null ? '' : t.pnl]));
  if (last.length === 1) last.push(['No closed trades yet', '', '', '', '', '']);
  s.getRange(l0 + 1, 1, last.length, 6).setValues(last);
  s.getRange(l0 + 1, 1, 1, 6).setFontWeight('bold').setBackground('#e5e7eb');
  s.getRange(l0 + 2, 1, last.length - 1, 1).setNumberFormat('ddd d mmm hh:mm');
  s.getRange(l0 + 2, 5, last.length - 1, 1).setNumberFormat('+0.00"R";-0.00"R";0.00"R"');
  s.getRange(l0 + 2, 6, last.length - 1, 1).setNumberFormat(fmtSigned);
  s.getRange(l0 + 2, 5, last.length - 1, 2).setFontColors(last.slice(1).map(r => {
    const c = r[5] === '' ? '#374151' : r[5] > 0 ? '#047857' : r[5] < 0 ? '#b91c1c' : '#374151';
    return [c, c];
  }));

  const h0 = l0 + last.length + 2;
  header(h0, 'HOW TO READ THIS');
  const notes = [
    'R = the result in units of the risk taken. +1R means the trade made what it risked; -1R means its stop loss was hit.',
    'Each intraday trade risks 0.25% of the account; each H4 trade risks 1%. So +1R is about +$25 intraday, +$100 on H4.',
    '"Backtest avg R" is what 3.75 years of the broker\'s gold data says each strategy earns per trade on average.',
    'A few weeks of trades swing far around that average. This period shows that the EAs run by the rules; the backtest is the evidence of profit.',
    'Slippage (MT5 Trades tab) = how much worse than the planned level a stop order filled, in dollars per ounce.',
    'Times are your clock. "Server time" in MT5 Log is the broker\'s clock (5 hours behind yours until 1 Nov, then 6).'
  ];
  s.getRange(h0 + 1, 1, notes.length, 1).setValues(notes.map(n => [n]));
  s.getRange(h0 + 1, 1, notes.length, 1).setFontColor('#374151');

  // The balance curve, from columns K:L (kept out of the way).
  s.getRange(1, 11, curve.length, 2).setValues(curve);
  s.getRange(2, 11, curve.length - 1, 1).setNumberFormat('d mmm hh:mm');
  try {
    s.insertChart(s.newChart().asLineChart().addRange(s.getRange(1, 11, curve.length, 2))
      .setPosition(4, 5, 10, 0).setNumHeaders(1)
      .setOption('title', 'Balance after each closed trade').setOption('legend', { position: 'none' })
      .setOption('width', 520).setOption('height', 250).build());
  } catch (e) {}
  s.hideColumns(11, 2);

  [235, 110, 360, 95, 95, 105, 110, 105, 150].forEach((w, i) => s.setColumnWidth(i + 1, w));
  s.setFrozenRows(2);
  mt5WriteLiveCells_(s);
}

/** The cells a heartbeat refreshes: equity, open positions, last contact per EA. */
function mt5WriteLiveCells_(sheet) {
  const s = sheet || ss_().getSheetByName(MT5_SUMMARY);
  if (!s) return;
  const st = mt5Status_();
  const eas = Object.keys(MT5_EAS);
  const latest = eas.map(ea => st[ea]).filter(x => x && x.equity).sort((a, b) => b.seen - a.seen)[0];
  if (latest) s.getRange(MT5_ROW.equity, 2).setValue(latest.equity).setNumberFormat('$#,##0.00');
  const openN = eas.reduce((a, ea) => a + ((st[ea] && st[ea].open) || 0), 0);
  const floating = eas.reduce((a, ea) => a + ((st[ea] && st[ea].floating) || 0), 0);
  s.getRange(MT5_ROW.open, 2, 1, 2).setValues([[openN + (openN === 1 ? ' position' : ' positions'),
    openN ? 'floating ' + (floating >= 0 ? '+$' : '-$') + Math.abs(floating).toFixed(2) : 'none']]);
  eas.forEach((ea, i) => s.getRange(MT5_ROW.eaFirst + i, 2).setValue(st[ea] ? new Date(st[ea].seen) : ''));
}

/* ------------------------------------------------------------------ */
/**
 * Menu: the link and the key to paste into both EAs' inputs. Creates the key the first time.
 * The key is shown only in this dialog, never logged.
 */
function mt5Connect() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('MT5_KEY');
  if (!key) {
    key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 40);
    props.setProperty('MT5_KEY', key);
  }
  let hook = webAppUrl_('WEBHOOK_URL');
  if (!hook.url || !/\/exec$/.test(hook.url)) {
    // Ask for the link here, so the owner never needs the Apps Script settings page.
    try {
      const ui = SpreadsheetApp.getUi();
      const r = ui.prompt('Connect MT5: your web app link', 'Paste the web app link that ends in /exec:', ui.ButtonSet.OK_CANCEL);
      if (r.getSelectedButton() === ui.Button.OK) {
        props.setProperty('WEBHOOK_URL', r.getResponseText().trim());
        hook = webAppUrl_('WEBHOOK_URL');
      }
    } catch (e) {}
  }
  const url = hook.url && /\/exec$/.test(hook.url) ? hook.url : '';
  const msg = (url
    ? '1. Sheet URL (both EAs, input "Sheet URL"):\n' + url
    : '1. First publish the web app: Deploy → New deployment → Web app → Execute as: Me, Who has access: Anyone → Deploy. ' +
      'Copy the link ending in /exec into Script Properties as WEBHOOK_URL, then open this again.') +
    '\n\n2. Sheet key (both EAs, input "Sheet key"):\n' + key +
    '\n\n3. In MT5: Tools → Options → Expert Advisors → tick "Allow WebRequest for listed URL" and add\n' +
    'https://script.google.com\nhttps://script.googleusercontent.com';
  try { SpreadsheetApp.getUi().alert('Connect MT5 to this sheet', msg, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { Logger.log('Open this from the spreadsheet menu: Trading Agent → MT5 gold EAs → Connect MT5.'); }
}
