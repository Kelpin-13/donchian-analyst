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
// What each strategy does, and what 18 years of the broker's gold data says: MT5 Strategy Tester runs of the
// EAs over 2008-2014, 2015-2022 and 2023-Oct 2026 (research/journal_stats.js). eras = total R per era;
// trades / perWeek / avgR = all 18 years. Must describe what the EAs actually do.
// {HH:MM} and {HH:MM-HH:MM} are broker times; the Strategies tab shows them in the owner's clock.
const MT5_ERAS = ['2008–14 (crash, rally, bear market)', '2015–22 (quiet years)', '2023–26 (boom)'];
const MT5_STRATEGIES = [
  { id: 'H4', ea: 'DonchianGold', chart: 'H4', name: 'H4 swing breakout', risk: 1, perWeek: 0.78, avgR: 0.185,
    trades: 765, eras: [55.1, 43.4, 42.9],
    how: '20-bar breakout on 4-hour bars, with the trend; holds for days',
    glance: 'Any time; checks every 4 hours', direction: 'Buy or sell, with the trend',
    idea: 'Gold trends. A close at a new 20-bar high or low on the 4-hour chart often starts a move that lasts for days.',
    when: 'Whenever the market is open: it decides each time a 4-hour bar closes, and holds trades overnight.',
    entry: 'BUY when a 4-hour bar closes above the highest high of the 20 bars before it and above its 100-bar average (EMA 100). ' +
           'SELL when it closes below the lowest low of those 20 bars and below the average. The order goes in at the next bar\'s open.',
    stop: '2 × ATR(14) from the entry, judged on each bar\'s close, plus a safety stop at the broker 4 × ATR away in case of a sudden crash.',
    exit: 'The stop; a close back through the 10-bar channel (the trend has ended); or after 60 bars (about 10 trading days).',
    note: 'It holds overnight, so it pays (or earns) the broker\'s daily swap.' },
  { id: 'NY_ORB', ea: 'GoldIntraday', chart: 'M15', name: 'New York opening range', risk: 0.125, perWeek: 3.25, avgR: 0.044,
    trades: 3186, eras: [118.1, -38.2, 60.8],
    how: 'Breakout of the first half hour of New York trading, with the H4 trend',
    glance: '{17:00-20:00}', direction: 'The H4 trend\'s side only',
    idea: 'The first half hour of New York stock trading often sets gold\'s direction for the rest of the session.',
    when: 'Measures the range {16:30-17:00}; enters {17:00-20:00}; closed by {23:00}.',
    entry: 'In an uptrend a buy-stop order waits at the high of {16:30-17:00}; in a downtrend a sell-stop order waits at its low. One trade a day.',
    stop: 'The other side of that half-hour range.',
    exit: 'The stop, or closed at {23:00}.',
    note: 'Strong when gold moves hard (2008-14, 2023-26) but lost through the quiet years 2015-22, so it trades at half risk.' },
  { id: 'ASIAN_NARROW', ea: 'GoldIntraday', chart: 'M15', name: 'Asian range breakout', risk: 0.25, perWeek: 1.83, avgR: 0.040,
    trades: 1797, eras: [16.1, 36.8, 19.8],
    how: 'Breakout of a quiet Asian session (01:00-09:00 server time)',
    glance: '{09:00-15:00}, quiet nights only', direction: 'Whichever side breaks first',
    idea: 'When the Asian session is unusually quiet, the European open often breaks out of it hard (Toby Crabel\'s narrow-range rule).',
    when: 'Measures the range {01:00-09:00}; enters {09:00-15:00}, only after a quiet night; closed by {23:00}.',
    entry: 'Only if that night\'s range is narrow (under 0.35 × the daily ATR): a buy-stop waits at its high and a sell-stop at its low. ' +
           'The first one hit wins and the other is cancelled.',
    stop: 'The other side of the Asian range.',
    exit: 'The stop, or closed at {23:00}.',
    note: 'About one night in two counts as quiet, so it trades a couple of times a week.' },
  { id: 'DUAL_THRUST', ea: 'GoldIntraday', chart: 'M15', name: 'Dual Thrust', risk: 0.25, perWeek: 1.86, avgR: 0.051,
    trades: 1823, eras: [64.9, 13.8, 14.2],
    how: "Breakout of the day's open +/- half the 4-day range; flips on its stop",
    glance: '{01:00-20:00}', direction: 'Both; flips when stopped',
    idea: 'A classic day-trading system (Michael Chalek): a move of half the recent daily range away from the open is a real breakout.',
    when: 'From the open at {01:00} until {20:00}; closed by {23:00}.',
    entry: 'Range = the larger of (highest high − lowest close) and (highest close − lowest low) over the last 4 days. ' +
           'A buy-stop waits at today\'s open + ½ range and a sell-stop at the open − ½ range.',
    stop: 'The opposite trigger. When it is hit, the trade turns around into the other direction (stop-and-reverse), up to 3 trades a day.',
    exit: 'The stop-and-reverse, or closed at {23:00}.',
    note: 'Its stop is wide, so its trades are small; on very wild days even the broker\'s smallest size (0.001 lots) would risk too much, and it sits out.' },
  { id: 'R_BREAKER', ea: 'GoldIntraday', chart: 'M15', name: 'R-Breaker', risk: 0.25, perWeek: 0.92, avgR: 0.059,
    trades: 907, eras: [39.0, 0.7, 13.5],
    how: "Breakouts and reversals at levels from yesterday's prices, with the H4 trend",
    glance: 'Every 15 min until {20:00}', direction: 'Buy or sell, with the H4 trend',
    idea: 'Pivot levels from yesterday\'s high, low and close (Richard Saidenberg): follow strong breakouts, and catch moves that fail at the day\'s extremes.',
    when: 'Checks every 15 minutes until {20:00}; closed by {23:00}.',
    entry: 'From yesterday\'s prices it sets six levels around a pivot. BUY when the price closes above the top level, or when it fell below the lower ' +
           '"setup" level and climbs back over the "reversal" level. SELL is the mirror image. Up to 2 trades a day.',
    stop: '0.5 × the daily ATR from the entry.',
    exit: 'The stop; a reversal signal against it; or closed at {23:00}.',
    note: 'Best in lively markets; about break-even through the quiet years 2015-22.' },
  { id: 'MOM_16', ea: 'GoldIntraday', chart: 'M15', name: 'Momentum at 16:00', risk: 0.125, perWeek: 2.70, avgR: 0.027,
    trades: 2651, eras: [47.3, -17.2, 41.9],
    how: "Joins the day's direction at 16:00 server time, with the H4 trend",
    glance: '{16:00}', direction: 'Buy or sell, with the H4 trend',
    idea: 'Intraday momentum (Gao, Han, Li & Zhou, 2018): the way gold has moved since the day\'s open tends to carry on into the US afternoon.',
    when: 'One decision at {16:00}; closed by {23:00}.',
    entry: 'At {16:00}: if gold is above the day\'s opening price it BUYS, if below it SELLS, but only when that agrees with the H4 trend.',
    stop: '0.5 × the daily ATR from the entry.',
    exit: 'The stop, or closed at {23:00}.',
    note: 'Strong when gold trends (2008-14, 2023-26) but lost through the quiet years 2015-22, so it trades at half risk.' },
  { id: 'MOM_20', ea: 'GoldIntraday', chart: 'M15', name: 'Momentum at 20:00', risk: 0.25, perWeek: 2.90, avgR: 0.015,
    trades: 2842, eras: [18.5, 5.1, 18.2],
    how: "Joins the day's direction at 20:00 server time, with the H4 trend",
    glance: '{20:00}', direction: 'Buy or sell, with the H4 trend',
    idea: 'The same intraday momentum idea, later in the day: the day\'s direction so far tends to carry on into the close.',
    when: 'One decision at {20:00}; closed by {23:00}.',
    entry: 'At {20:00}: if gold is above the day\'s opening price it BUYS, if below it SELLS, but only when that agrees with the H4 trend.',
    stop: '0.5 × the daily ATR from the entry.',
    exit: 'The stop, or closed at {23:00}.',
    note: 'Small but positive in every era tested.' }
];
const MT5_RULES = [
  'Demo account only: both EAs refuse to run on a real-money account.',
  'Gold only (XAUUSD.sml): both EAs refuse any other chart.',
  'Every order has its stop loss at the broker from the moment it opens.',
  'One position per strategy at a time. No adding to losing trades, no martingale, no doubling up.',
  'Risk per trade: 0.25% of the account for each intraday strategy (half that, 0.125%, for New York opening range and Momentum at 16:00), 1% for the H4 swing breakout.',
  'Every intraday trade is closed by {23:00}, before the daily rollover, so intraday trades pay no overnight swap.',
  'No new intraday trades after the account falls 2% in one day.',
  'Emergency stop for both EAs: in MT5 press F3 → Add → name DG_KILL, value 1. They close everything and stop trading.',
  'Nobody touches the trades: no manual entries, exits or changes. The EAs follow these rules exactly.'
];
const MT5_STRATEGIES_SHEET = 'MT5 Strategies';
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
    const got = mt5AppendLines_(ea, body);
    // A full rebuild (~100 sheet calls) only when a trade opened or closed; anything else just refreshes the
    // live cells, so the EA's reply comes back well inside its 8-second wait.
    if (got.trades || !ss_().getSheetByName(MT5_SUMMARY) || !ss_().getSheetByName(MT5_TRADES)) mt5Rebuild_();
    else mt5WriteLiveCells_();
    return 'stored ' + got.n;
  } finally {
    lock.releaseLock();
  }
}

/** The latest heartbeat of each EA: when, equity, open positions. */
function mt5SaveStatus_(ea, body) {
  const all = mt5Status_();
  all[ea] = { seen: Date.now(), equity: Number(body.equity) || null, balance: Number(body.balance) || null,
              open: Number(body.open) || 0, floating: Number(body.floating) || 0,
              offset: isFinite(Number(body.offset)) && body.offset !== undefined ? Number(body.offset) : null };   // broker clock - UTC, s
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
  if (!lines.length) return { n: 0, trades: false };
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
  return { n: rows.length, trades: rows.some(r => /^(ENTRY_|EXIT_|KILL_SWITCH$)/.test(r[4])) };
}

/* ------------------------------------------------------------------ */
/** Menu: rebuild the two result sheets from MT5 Log. */
function mt5RebuildNow() {
  mt5Rebuild_(true);
  try { ss_().setActiveSheet(ss_().getSheetByName(MT5_SUMMARY)); } catch (e) {}
}

function mt5Rebuild_(force) {
  const log = mt5ReadLog_();
  const built = mt5BuildTrades_(log);
  mt5WriteTrades_(built.trades, built.open);
  mt5WriteSummary_(log, built.trades, built.open);
  mt5WriteStrategies_(force);
  mt5FormatLog_();
  mt5OrderTabs_();
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
// The look shared by the three tabs: one font, roomy rows, a dark header, light stripes.
const MT5_STYLE = { font: 'Arial', size: 11, head: '#111827', headText: '#ffffff', sub: '#e5e7eb', stripe: '#f3f4f6',
                    open: '#fef3c7', green: '#047857', red: '#b91c1c', grey: '#6b7280', ink: '#111827' };
const MT5_COLOUR = v => (v === '' || v === null || v === 0 ? MT5_STYLE.ink : v > 0 ? MT5_STYLE.green : MT5_STYLE.red);

/** Header row: dark, white, bold, centred, wrapped, tall enough for two lines. */
function mt5Header_(s, row, width, height) {
  s.getRange(row, 1, 1, width).setFontWeight('bold').setBackground(MT5_STYLE.head).setFontColor(MT5_STYLE.headText)
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  s.setRowHeight(row, height || 36);
}

function mt5WriteTrades_(trades, open) {
  const s = sheet_(MT5_TRADES, MT5_TRADE_HEADERS);
  s.clear();
  const W = MT5_TRADE_HEADERS.length;
  const rows = [MT5_TRADE_HEADERS];
  open.slice().reverse().forEach(t => rows.push([t.opened, 'still open', mt5Name_(t.strat), t.side === 1 ? 'BUY' : 'SELL', t.lots, t.entry,
                                                 t.stop, '', '', '', '', t.slip === null ? '' : t.slip, t.why]));
  trades.slice().reverse().forEach(t => rows.push([t.opened, t.closed, mt5Name_(t.strat), t.side === 1 ? 'BUY' : 'SELL', t.lots, t.entry,
                                                   t.stop, t.exit, t.reason, t.r === null ? '' : t.r, t.pnl === null ? '' : t.pnl,
                                                   t.slip === null ? '' : t.slip, t.why]));
  if (rows.length === 1) rows.push(['No trades yet', '', '', '', '', '', '', '', '', '', '', '', '']);
  const n = rows.length - 1;
  s.getRange(1, 1, rows.length, W).setValues(rows)
    .setFontFamily(MT5_STYLE.font).setFontSize(MT5_STYLE.size).setFontColor(MT5_STYLE.ink).setVerticalAlignment('middle');
  mt5Header_(s, 1, W, 38);
  s.setFrozenRows(1);
  s.setRowHeights(2, n, 30);

  // Each column aligned to what it holds: words left, numbers right, short labels centred.
  const align = ['center', 'center', 'left', 'center', 'center', 'right', 'right', 'right', 'left', 'center', 'right', 'center', 'left'];
  s.getRange(2, 1, n, W).setHorizontalAlignments(rows.slice(1).map(() => align))
    .setBackgrounds(rows.slice(1).map((r, i) => new Array(W).fill(i < open.length ? MT5_STYLE.open : i % 2 ? MT5_STYLE.stripe : '#ffffff')));
  s.getRange(2, 1, n, 2).setNumberFormat('ddd d mmm, hh:mm');
  s.getRange(2, 5, n, 1).setNumberFormat('0.000');
  s.getRange(2, 6, n, 3).setNumberFormat('#,##0.00');
  s.getRange(2, 10, n, 1).setNumberFormat('+0.00" R";-0.00" R";0.00" R"');
  s.getRange(2, 11, n, 1).setNumberFormat('+$#,##0.00;-$#,##0.00;$0.00');
  s.getRange(2, 12, n, 1).setNumberFormat('$0.00');
  s.getRange(2, 4, n, 1).setFontWeight('bold').setFontColors(rows.slice(1).map(r => [r[3] === 'BUY' ? MT5_STYLE.green : r[3] === 'SELL' ? MT5_STYLE.red : MT5_STYLE.ink]));
  s.getRange(2, 10, n, 2).setFontWeight('bold').setFontColors(rows.slice(1).map(r => { const c = MT5_COLOUR(r[10] !== '' ? r[10] : r[9]); return [c, c]; }));
  s.getRange(2, 2, n, 1).setFontColors(rows.slice(1).map(r => [r[1] === 'still open' ? '#92400e' : MT5_STYLE.ink]));
  s.getRange(2, 13, n, 1).setFontColor(MT5_STYLE.grey);
  [165, 165, 210, 90, 75, 100, 100, 100, 230, 105, 115, 100, 420].forEach((w, i) => s.setColumnWidth(i + 1, w));
}

/* ------------------------------------------------------------------ */
// Fixed rows of the Summary, so a heartbeat can refresh them without a rebuild.
const MT5_ROW = { equity: 5, open: 11, eaFirst: 14 };
const MT5_SUMMARY_WIDTHS = [230, 120, 340, 85, 100, 110, 120, 110, 140];   // A..I

function mt5WriteSummary_(log, trades, open) {
  const ss = ss_();
  let s = ss.getSheetByName(MT5_SUMMARY);
  if (!s) s = ss.insertSheet(MT5_SUMMARY);
  s.clear();
  try { s.getCharts().forEach(c => s.removeChart(c)); } catch (e) {}
  const W = 9;

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
  const money = '$#,##0.00', signed = '+$#,##0.00;-$#,##0.00;$0.00', rFmt = '+0.00" R";-0.00" R";0.00" R"', dateFmt = 'd mmm, hh:mm';

  s.setHiddenGridlines(true);
  s.getRange(1, 1, 80, W).setFontFamily(MT5_STYLE.font).setFontSize(MT5_STYLE.size).setFontColor(MT5_STYLE.ink).setVerticalAlignment('middle');
  const section = (row, text) => {
    s.getRange(row, 1, 1, W).setValues([['  ' + text, '', '', '', '', '', '', '', '']]).setFontWeight('bold').setFontSize(12)
      .setBackground(MT5_STYLE.head).setFontColor(MT5_STYLE.headText);
    s.setRowHeight(row, 34);
  };
  const gap = row => s.setRowHeight(row, 14);

  // Title
  s.getRange(1, 1).setValue('Gold EAs on the OANDA demo account').setFontSize(20).setFontWeight('bold');
  s.setRowHeight(1, 46);
  s.getRange(2, 1).setFontColor(MT5_STYLE.grey).setFontSize(10);                // its text: mt5WriteLiveCells_
  s.setRowHeight(2, 24);
  gap(3);

  // Account
  section(4, 'ACCOUNT');
  s.getRange(5, 1, 7, 3).setValues([
    ['Equity now', '', 'the whole demo account, both EAs, open trades included'],
    ['Started with', startEq, ''],
    ['Profit / loss', total, (total >= 0 ? '+' : '') + (total / startEq * 100).toFixed(2) + '% of the starting balance (closed trades)'],
    ['Closed trades', trades.length, won + ' won, ' + (trades.length - won) + ' lost' +
      (trades.length ? ' (' + Math.round(won / trades.length * 100) + '% winners)' : '')],
    ['Profit factor', gl ? Math.round(gw / gl * 100) / 100 : (gw ? 'no losses yet' : '-'), 'money won ÷ money lost; above 1 means profitable'],
    ['Worst drawdown', dd, 'biggest fall from a high point (backtest worst: about 9%)'],
    ['Open right now', '', '']
  ]);
  s.setRowHeights(5, 7, 32);
  s.getRange(5, 1, 7, 1).setFontWeight('bold').setFontColor('#374151');
  s.getRange(5, 2, 7, 1).setFontWeight('bold').setFontSize(13).setHorizontalAlignment('right');
  s.getRange(5, 2, 2, 1).setNumberFormat(money);
  s.getRange(7, 2).setNumberFormat(signed).setFontColor(MT5_COLOUR(total));
  s.getRange(10, 2).setNumberFormat('0.0%');
  s.getRange(5, 3, 7, 1).setFontColor(MT5_STYLE.grey).setFontSize(10).setFontStyle('italic');
  s.getRange(5, 1, 7, 3).setBackgrounds([0, 1, 2, 3, 4, 5, 6].map(i => new Array(3).fill(i % 2 ? MT5_STYLE.stripe : '#ffffff')));
  gap(12);

  // Is it running?
  section(13, 'IS IT RUNNING?');
  Object.keys(MT5_EAS).forEach((ea, i) => {
    const row = MT5_ROW.eaFirst + i;
    s.getRange(row, 1).setValue(MT5_EAS[ea].label).setFontWeight('bold').setFontColor('#374151');
    s.getRange(row, 3).setFormula('=IF(B' + row + '="","not connected yet",IF(NOW()-B' + row + '>' + MT5_SILENT_DAYS +
      ',"⚠️  no contact for "&TEXT(NOW()-B' + row + ',"[h]:mm")&" hours (laptop off, asleep or MT5 closed?)","✅  running"))');
  });
  s.setRowHeights(MT5_ROW.eaFirst, 2, 32);
  s.getRange(MT5_ROW.eaFirst, 2, 2, 1).setNumberFormat(dateFmt).setHorizontalAlignment('right');
  s.getRange(MT5_ROW.eaFirst, 3, 2, 1).setFontWeight('bold');
  gap(16);

  // By strategy
  section(17, 'BY STRATEGY');
  const t0 = 18;
  const rows = [['Strategy', 'Trades', 'What it does', 'Win rate', 'Result', 'Average per trade', 'Backtest average', 'Profit / loss', 'Trades expected by now']];
  MT5_STRATEGIES.forEach(st => {
    const ts = trades.filter(t => t.strat === st.id);
    const w = ts.filter(t => (t.pnl !== null ? t.pnl : t.r || 0) > 0).length;
    const r = ts.reduce((a, t) => a + (t.r || 0), 0), p = ts.reduce((a, t) => a + (t.pnl || 0), 0);
    rows.push([st.name + (st.risk === 1 ? '  (1% risk)' : st.risk < 0.25 ? '  (half risk)' : ''), ts.length, st.how, ts.length ? w / ts.length : '', Math.round(r * 100) / 100,
               ts.length ? Math.round(r / ts.length * 1000) / 1000 : '', st.avgR, Math.round(p * 100) / 100, Math.round(st.perWeek * weeks * 10) / 10]);
  });
  const allR = trades.reduce((a, t) => a + (t.r || 0), 0);
  rows.push(['All strategies', trades.length, '', trades.length ? won / trades.length : '', Math.round(allR * 100) / 100,
             trades.length ? Math.round(allR / trades.length * 1000) / 1000 : '', '', Math.round(total * 100) / 100,
             Math.round(MT5_STRATEGIES.reduce((a, st) => a + st.perWeek, 0) * weeks * 10) / 10]);
  const nb = rows.length - 1;
  s.getRange(t0, 1, rows.length, W).setValues(rows);
  s.getRange(t0, 1, 1, W).setFontWeight('bold').setBackground(MT5_STYLE.sub).setHorizontalAlignment('center').setWrap(true);
  s.setRowHeight(t0, 40);
  s.setRowHeights(t0 + 1, nb, 42);
  s.getRange(t0 + 1, 1, nb, W).setBackgrounds(rows.slice(1).map((r, i) => new Array(W).fill(i === nb - 1 ? MT5_STYLE.sub : i % 2 ? MT5_STYLE.stripe : '#ffffff')))
    .setHorizontalAlignments(rows.slice(1).map(() => ['left', 'center', 'left', 'center', 'center', 'center', 'center', 'right', 'center']));
  s.getRange(t0 + 1, 1, nb, 1).setFontWeight('bold');
  s.getRange(t0 + 1, 3, nb, 1).setWrap(true).setFontSize(10).setFontColor(MT5_STYLE.grey);
  s.getRange(t0 + 1, 4, nb, 1).setNumberFormat('0%');
  s.getRange(t0 + 1, 5, nb, 1).setNumberFormat(rFmt).setFontWeight('bold').setFontColors(rows.slice(1).map(r => [MT5_COLOUR(r[4])]));
  s.getRange(t0 + 1, 6, nb, 2).setNumberFormat('+0.000" R";-0.000" R";0.000" R"');
  s.getRange(t0 + 1, 8, nb, 1).setNumberFormat(signed).setFontWeight('bold').setFontColors(rows.slice(1).map(r => [MT5_COLOUR(r[7])]));
  s.getRange(t0 + nb, 1, 1, W).setFontWeight('bold');
  const b0 = t0 + rows.length + 1;
  gap(b0 - 1);

  // Balance chart (its data in hidden columns K:L)
  section(b0, 'BALANCE AFTER EACH CLOSED TRADE');
  s.getRange(1, 11, curve.length, 2).setValues(curve);
  s.getRange(2, 11, curve.length - 1, 1).setNumberFormat('d mmm hh:mm');
  try {
    s.insertChart(s.newChart().asLineChart().addRange(s.getRange(1, 11, curve.length, 2))
      .setPosition(b0 + 1, 1, 8, 8).setNumHeaders(1)
      .setOption('legend', { position: 'none' }).setOption('colors', ['#2563eb'])
      .setOption('vAxis', { format: '$#,##0' }).setOption('width', 1080).setOption('height', 300).build());
  } catch (e) {}
  s.hideColumns(11, 2);
  s.setRowHeights(b0 + 1, 11, 28);
  const l0 = b0 + 13;
  gap(l0 - 1);

  // Last 10 trades
  section(l0, 'LAST 10 TRADES   ·   every trade: the MT5 Trades tab');
  const last = [['Strategy', 'Direction', 'Exit reason', 'Result', 'Profit / loss', 'Closed']];
  trades.slice().sort((a, b) => b.closed - a.closed).slice(0, 10)
    .forEach(t => last.push([mt5Name_(t.strat), t.side === 1 ? 'BUY' : 'SELL', t.reason, t.r === null ? '' : t.r, t.pnl === null ? '' : t.pnl, t.closed]));
  if (last.length === 1) last.push(['No closed trades yet', '', '', '', '', '']);
  const nl = last.length - 1;
  s.getRange(l0 + 1, 1, last.length, 6).setValues(last);
  s.getRange(l0 + 1, 1, 1, 6).setFontWeight('bold').setBackground(MT5_STYLE.sub).setHorizontalAlignment('center');
  s.setRowHeight(l0 + 1, 32);
  s.setRowHeights(l0 + 2, nl, 30);
  s.getRange(l0 + 2, 1, nl, 6).setBackgrounds(last.slice(1).map((r, i) => new Array(6).fill(i % 2 ? MT5_STYLE.stripe : '#ffffff')))
    .setHorizontalAlignments(last.slice(1).map(() => ['left', 'center', 'left', 'center', 'right', 'center']));
  s.getRange(l0 + 2, 2, nl, 1).setFontWeight('bold').setFontColors(last.slice(1).map(r => [r[1] === 'BUY' ? MT5_STYLE.green : r[1] === 'SELL' ? MT5_STYLE.red : MT5_STYLE.ink]));
  s.getRange(l0 + 2, 4, nl, 1).setNumberFormat(rFmt);
  s.getRange(l0 + 2, 5, nl, 1).setNumberFormat(signed);
  s.getRange(l0 + 2, 4, nl, 2).setFontWeight('bold').setFontColors(last.slice(1).map(r => { const c = MT5_COLOUR(r[4] !== '' ? r[4] : r[3]); return [c, c]; }));
  s.getRange(l0 + 2, 6, nl, 1).setNumberFormat(dateFmt);
  const h0 = l0 + last.length + 2;
  gap(h0 - 1);

  // How to read this
  section(h0, 'HOW TO READ THIS');
  const notes = [
    'R = the result in units of the risk taken. +1 R means the trade made what it risked; -1 R means its stop loss was hit.',
    'Intraday trades risk 0.25% of the account (about $25), New York opening range and Momentum at 16:00 half that; H4 trades risk 1% (about $100).',
    '"Backtest average" is what 18 years of the broker\'s gold data (2008-2026) says each strategy earns per trade on average.',
    'A few weeks of trades swing far around that average: this period shows the EAs run by the rules; the backtest is the evidence of profit.',
    'Slippage (MT5 Trades tab) = how much worse than the planned level a stop order filled, in dollars per ounce.',
    'Times are your clock. "Server time" in MT5 Log is the broker\'s clock (5 hours behind yours until 1 Nov, then 6).'
  ];
  s.getRange(h0 + 1, 1, notes.length, 1).setValues(notes.map(x => ['•  ' + x])).setFontColor('#374151').setFontSize(10);
  s.setRowHeights(h0 + 1, notes.length, 26);

  MT5_SUMMARY_WIDTHS.forEach((w, i) => s.setColumnWidth(i + 1, w));
  s.setFrozenRows(2);
  mt5WriteLiveCells_(s);
}

/** The cells a heartbeat refreshes: equity, open positions, last contact per EA. */
function mt5WriteLiveCells_(sheet) {
  const s = sheet || ss_().getSheetByName(MT5_SUMMARY);
  if (!s) return;
  s.getRange(2, 1).setValue('Updated ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'EEE d MMM, HH:mm') +
    '  ·  sent by the two Expert Advisors on your laptop; nothing here is typed by hand');
  const st = mt5Status_();
  const eas = Object.keys(MT5_EAS);
  const latest = eas.map(ea => st[ea]).filter(x => x && x.equity).sort((a, b) => b.seen - a.seen)[0];
  if (latest) s.getRange(MT5_ROW.equity, 2).setValue(latest.equity).setNumberFormat('$#,##0.00');
  const openN = eas.reduce((a, ea) => a + ((st[ea] && st[ea].open) || 0), 0);
  const floating = eas.reduce((a, ea) => a + ((st[ea] && st[ea].floating) || 0), 0);
  s.getRange(MT5_ROW.open, 2, 1, 2).setValues([[openN + (openN === 1 ? ' position' : ' positions'),
    openN ? 'floating ' + (floating >= 0 ? '+$' : '-$') + Math.abs(floating).toFixed(2) + ' right now' : 'none']]);
  eas.forEach((ea, i) => s.getRange(MT5_ROW.eaFirst + i, 2).setValue(st[ea] ? new Date(st[ea].seen) : ''));
}

/** MT5 Log: the raw record, readable too. */
function mt5FormatLog_() {
  const s = ss_().getSheetByName(MT5_LOG);
  if (!s) return;
  const n = Math.max(1, s.getLastRow());
  s.getRange(1, 1, n, MT5_LOG_HEADERS.length).setFontFamily(MT5_STYLE.font).setFontSize(10).setVerticalAlignment('middle');
  mt5Header_(s, 1, MT5_LOG_HEADERS.length, 32);
  s.setFrozenRows(1);
  if (n > 1) {
    s.getRange(2, 1, n - 1, 1).setNumberFormat('ddd d mmm, hh:mm:ss');
    s.getRange(2, 6, n - 1, 1).setNumberFormat('$#,##0.00');
    s.getRange(2, 8, n - 1, 1).setFontColor('#9ca3af');
  }
  [170, 150, 110, 130, 130, 100, 760, 280].forEach((w, i) => s.setColumnWidth(i + 1, w));
}

/** Tabs in reading order, coloured: Summary, Trades, Log. Moves a tab only when it is out of place. */
function mt5OrderTabs_() {
  const ss = ss_();
  [[MT5_SUMMARY, '#16a34a'], [MT5_STRATEGIES_SHEET, '#7c3aed'], [MT5_TRADES, '#2563eb'], [MT5_LOG, '#9ca3af']].forEach(([name, colour], i) => {
    const s = ss.getSheetByName(name);
    if (!s) return;
    try {
      s.setTabColor(colour);
      if (s.getIndex() !== i + 1) { ss.setActiveSheet(s); ss.moveActiveSheet(i + 1); }
    } catch (e) {}
  });
}

/* ------------------------------------------------------------------ */
/** Minutes to add to the broker's clock to get the owner's: the EAs report the broker offset, the script knows its zone. */
function mt5ClockShift_() {
  const st = mt5Status_();
  const off = Object.keys(st).map(k => st[k].offset).filter(x => x !== null && x !== undefined && isFinite(x))[0];
  const brokerH = (off !== undefined ? off : 10800) / 3600;                // UTC+3 until 1 Nov, then UTC+2
  const z = /([+-])(\d\d):?(\d\d)$/.exec(Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'Z'));
  const ownH = z ? (z[1] === '-' ? -1 : 1) * (Number(z[2]) + Number(z[3]) / 60) : 8;
  return Math.round((ownH - brokerH) * 60);
}

/** "{17:00-20:00}" (broker time) → "22:00–01:00 (broker 17:00–20:00)", or just "22:00–01:00". */
function mt5Times_(text, shift, withBroker) {
  const hhmm = m => { m = ((m % 1440) + 1440) % 1440; return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); };
  const min = x => Number(x.slice(0, 2)) * 60 + Number(x.slice(3, 5));
  return String(text).replace(/\{(\d\d:\d\d)(?:-(\d\d:\d\d))?\}/g, (all, a, b) => {
    const mine = hhmm(min(a) + shift) + (b ? '–' + hhmm(min(b) + shift) : '');
    return withBroker ? mine + ' (broker ' + a + (b ? '–' + b : '') + ')' : mine;
  });
}

/**
 * MT5 Strategies: every strategy the EAs trade, in plain English, with its backtest record. Rewritten only
 * when asked or when the clocks change (it shows times in the owner's clock).
 */
function mt5WriteStrategies_(force) {
  const shift = mt5ClockShift_(), stamp = 'v2|' + shift;
  const props = PropertiesService.getScriptProperties(), ss = ss_();
  let s = ss.getSheetByName(MT5_STRATEGIES_SHEET);
  if (s && !force && props.getProperty('MT5_STRAT_DONE') === stamp) return;
  if (!s) s = ss.insertSheet(MT5_STRATEGIES_SHEET);
  const W = 8, T = (x, b) => mt5Times_(x, shift, b);
  try { s.getRange(1, 1, s.getMaxRows(), W).breakApart(); } catch (e) {}
  s.clear();
  s.setHiddenGridlines(true);
  s.getRange(1, 1, 200, W).setFontFamily(MT5_STYLE.font).setFontSize(MT5_STYLE.size).setFontColor(MT5_STYLE.ink).setVerticalAlignment('middle');
  const section = (row, text) => {
    s.getRange(row, 1, 1, W).setValues([['  ' + text, '', '', '', '', '', '', '']]).setFontWeight('bold').setFontSize(12)
      .setBackground(MT5_STYLE.head).setFontColor(MT5_STYLE.headText);
    s.setRowHeight(row, 34);
  };
  const height = text => 12 + 20 * Math.max(1, Math.ceil(String(text).length / 125));
  const hours = Math.abs(shift) / 60;

  s.getRange(1, 1).setValue('The strategies trading right now').setFontSize(20).setFontWeight('bold');
  s.setRowHeight(1, 46);
  s.getRange(2, 1).setValue(MT5_STRATEGIES.length + ' strategies in 2 Expert Advisors on the OANDA demo account  ·  times are your clock; ' +
    'the broker\'s clock is ' + hours + ' hours ' + (shift >= 0 ? 'behind' : 'ahead of') + ' yours').setFontColor(MT5_STYLE.grey).setFontSize(10);
  s.setRowHeight(2, 24);
  s.setRowHeight(3, 14);

  // At a glance
  section(4, 'AT A GLANCE');
  const glance = [['Strategy', 'Expert Advisor', 'When (your time)', 'Direction', 'Risk', 'Trades a week', '18-year result', 'Eras it made money']];
  MT5_STRATEGIES.forEach(st => glance.push([st.name, st.ea + '  ·  ' + st.chart, T(st.glance, false), st.direction, st.risk + '%',
                                            st.perWeek, Math.round(st.eras.reduce((a, b) => a + b, 0)),
                                            st.eras.filter(r => r > 0).length + ' of ' + st.eras.length]));
  const ng = glance.length - 1;
  s.getRange(5, 1, glance.length, W).setValues(glance);
  s.getRange(5, 1, 1, W).setFontWeight('bold').setBackground(MT5_STYLE.sub).setHorizontalAlignment('center').setWrap(true);
  s.setRowHeight(5, 36);
  s.setRowHeights(6, ng, 34);
  s.getRange(6, 1, ng, W).setWrap(true)
    .setBackgrounds(glance.slice(1).map((r, i) => new Array(W).fill(i % 2 ? MT5_STYLE.stripe : '#ffffff')))
    .setHorizontalAlignments(glance.slice(1).map(() => ['left', 'left', 'left', 'left', 'center', 'center', 'center', 'center']));
  s.getRange(6, 1, ng, 1).setFontWeight('bold');
  s.getRange(6, 6, ng, 1).setNumberFormat('0.0');
  s.getRange(6, 7, ng, 1).setNumberFormat('+0" R";-0" R";0" R"').setFontWeight('bold')
    .setFontColors(glance.slice(1).map(r => [MT5_COLOUR(r[6])]));
  let r = 6 + ng;
  s.setRowHeight(r++, 14);

  // The rules every trade follows
  section(r++, 'RULES EVERY TRADE FOLLOWS');
  MT5_RULES.forEach((rule, i) => {
    s.getRange(r, 1, 1, W).merge().setValue('•  ' + T(rule, true)).setWrap(true)
      .setBackground(i % 2 ? MT5_STYLE.stripe : '#ffffff');
    s.setRowHeight(r++, Math.max(30, height(rule)));
  });
  s.setRowHeight(r++, 14);

  // One card per strategy
  const signedR = v => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v) + ' R';
  MT5_STRATEGIES.forEach((st, i) => {
    section(r++, (i + 1) + '   ' + st.name.toUpperCase());
    const lines = [
      ['Expert Advisor', st.ea + ' on the XAUUSD.sml ' + st.chart + ' chart'],
      ['The idea', st.idea],
      ['When it trades', T(st.when, true)],
      ['Direction', st.direction],
      ['How it enters', T(st.entry, true)],
      ['Stop loss', st.stop],
      ['How it exits', T(st.exit, true)],
      ['Risk per trade', st.risk + '% of the account (about $' + Math.round(st.risk * 100) + ' on $10,000)'],
      ['Backtest, 18 years', st.trades + ' trades from 2008 to 2026 (' + st.perWeek + ' a week)  ·  ' +
                             signedR(Math.round(st.eras.reduce((a, b) => a + b, 0))) + ' in total  ·  ' +
                             (st.avgR >= 0 ? '+' : '−') + Math.abs(st.avgR) + ' R per trade on average'],
      ['By era', MT5_ERAS.map((e, j) => e + ':  ' + signedR(Math.round(st.eras[j]))).join('      ')],
      ['Good to know', st.note]
    ];
    lines.forEach(([label, text], j) => {
      s.getRange(r, 1).setValue(label).setFontWeight('bold').setFontColor('#374151').setVerticalAlignment('top');
      s.getRange(r, 2, 1, W - 1).merge().setValue(text).setWrap(true).setVerticalAlignment('top');
      s.getRange(r, 1, 1, W).setBackground(j % 2 ? MT5_STYLE.stripe : '#ffffff');
      s.setRowHeight(r++, Math.max(30, height(text)));
    });
    s.setRowHeight(r++, 18);
  });

  [210, 170, 215, 230, 80, 110, 100, 120].forEach((w, i) => s.setColumnWidth(i + 1, w));
  s.setFrozenRows(2);
  props.setProperty('MT5_STRAT_DONE', stamp);
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
