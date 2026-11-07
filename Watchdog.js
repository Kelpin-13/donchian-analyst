/**
 * Watchdog.gs: checks the two MT5 EAs every 15 minutes from Google's side, whether or not the PC is on, and writes
 * what it finds to the MT5 Watchdog tab.
 *
 * It only reads: the heartbeats (Script Property MT5_STATUS), MT5 Log and the trades built from it. It places,
 * changes and closes nothing; the EAs protect themselves (stops at the broker, daily loss limit, the 15% account stop).
 * Its timer installs itself: watchdogEnsure_() runs from the morning map's timer, so a clasp push is enough.
 *
 * ALERTs also go to the owner's Telegram, once each (owner, 6 Nov 2026: "when the account stop fires, notify me and we
 * decide it together"). The 07:30 timer sends the daily MT5 report (mt5DailyReportSend_) instead of the gold map.
 * Levels: ALERT = act now (an account stop fired, a position without a stop, the account 15% down);
 *         WARN  = look today (an EA silent while gold trades, error rows, fills slipping, an old setting still live);
 *         OK.
 */
const WATCHDOG = {
  sheet: 'MT5 Watchdog', everyMin: 15, silentMin: 25, ddWarnPct: 10, ddStopPct: 15,
  slipWarnUsd: 0.6, slipFills: 20,            // the research's fill model averages $0.29 (research/realism_lab.js)
  keepRows: 300, since: Date.UTC(2026, 10, 6), retired: ['NY_ORB', 'MOM_20'], riskText: 'risk 0.50%', stopText: 'account stop 15%'
};

function runWatchdog() {
  try {
    const props = PropertiesService.getScriptProperties();
    let state = {};
    try { state = JSON.parse(props.getProperty('WATCHDOG_STATE') || '{}'); } catch (e) { state = {}; }
    const log = mt5ReadLog_();
    const res = watchdogCheck_(Date.now(), mt5Status_(), log, mt5BuildTrades_(log), state);
    watchdogAlert_(res, state.alerted || []);                     // sets res.state.alerted
    props.setProperty('WATCHDOG_STATE', JSON.stringify(res.state));
    watchdogWrite_(res);
  } catch (e) {
    logLine_('ERROR', 'Watchdog: ' + e.message);
  }
}

/** Installs the 15-minute timer once. Called by runMorningMap (a timer, so it runs the newest code). */
function watchdogEnsure_() {
  if (ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'runWatchdog')) return false;
  ScriptApp.newTrigger('runWatchdog').timeBased().everyMinutes(WATCHDOG.everyMin).create();
  logLine_('INFO', 'Watchdog: timer installed, every ' + WATCHDOG.everyMin + ' minutes');
  return true;
}

/** Gold trades Monday 01:00 to Friday 23:58 broker time, apart from the daily break 23:58-01:00. */
function watchdogGoldOpen_(serverMs) {
  const d = new Date(serverMs), day = d.getUTCDay(), m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return day >= 1 && day <= 5 && m >= 65 && m <= 23 * 60 + 50;
}

/**
 * The checks, pure so the tests can drive them. status: MT5_STATUS; log: mt5ReadLog_() rows, oldest first;
 * built: mt5BuildTrades_(log); state: what the last run kept ({ peak, seen }). Returns { level, problems, state, ... }.
 */
function watchdogCheck_(now, status, log, built, state) {
  const problems = [], add = (level, text, key) => problems.push({ level, text, key: key || text });
  const st = Object.assign({ peak: 0, seen: 0 }, state || {});
  const eas = Object.keys(MT5_EAS);

  // 1. Heartbeats while gold trades (the EAs send one every 10 minutes).
  const offset = eas.map(e => status[e] && status[e].offset).filter(x => x !== null && x !== undefined)[0];
  const serverNow = now + (offset || 0) * 1000;
  if (offset !== undefined && watchdogGoldOpen_(serverNow)) {
    eas.forEach(e => {
      const s = status[e];
      const mins = s && s.seen ? Math.round((now - s.seen) / 60000) : null;
      if (mins === null) add('WARN', e + ': no heartbeat on record');
      else if (mins > WATCHDOG.silentMin) add('WARN', e + ': silent for ' + mins + ' minutes while gold trades (MT5 closed, PC asleep or no internet; a holiday also looks like this)');
    });
  }

  // 2. Rows since the last check.
  const fresh = log.slice(Math.min(st.seen, log.length));
  st.seen = log.length;
  fresh.filter(r => r.ev === 'KILL_SWITCH').forEach(r => add('ALERT', r.ea + ' kill switch: ' + r.detail.slice(0, 160), 'kill:' + r.ea + ':' + r.time.getTime()));
  const errors = fresh.filter(r => r.ev === 'ERROR');
  if (errors.length) add('WARN', errors.length + ' ERROR row' + (errors.length > 1 ? 's' : '') + ', latest ' + errors[errors.length - 1].strat + ': ' + errors[errors.length - 1].detail.slice(0, 140));
  fresh.filter(r => r.ev === 'WARN').forEach(r => add('WARN', r.ea + ': ' + r.detail.slice(0, 160)));
  fresh.filter(r => /^ENTRY_/.test(r.ev) && WATCHDOG.retired.includes(r.strat) && r.time.getTime() >= WATCHDOG.since)
    .forEach(r => add('WARN', 'retired strategy ' + r.strat + ' still trading: set its input to false on the GoldIntraday chart (F7)'));

  // 3. The settings each EA last started with (never the START row itself: it holds the account number).
  eas.forEach(e => {
    const starts = log.filter(r => r.ea === e && r.ev === 'START');
    const last = starts[starts.length - 1];
    if (!last || last.time.getTime() < WATCHDOG.since) return;
    if (last.detail.indexOf(WATCHDOG.riskText) < 0) add('WARN', e + ' started without 0.5% risk a trade: set its size to 0 and its risk to 0.5 (F7)');
    if (last.detail.indexOf(WATCHDOG.stopText) < 0) add('WARN', e + ' started without the 15% account stop: an old build, or the input is 0');
  });

  // 4. The account against its highest equity.
  const eq = eas.map(e => status[e] && status[e].seen ? status[e] : null).filter(Boolean).sort((a, b) => b.seen - a.seen)[0];
  let ddPct = null;
  if (eq && eq.equity) {
    st.peak = Math.max(st.peak || 0, eq.equity);
    ddPct = (1 - eq.equity / st.peak) * 100;
    if (ddPct >= WATCHDOG.ddStopPct) add('ALERT', 'equity ' + eq.equity.toFixed(2) + ' is ' + ddPct.toFixed(1) + '% below its peak ' + st.peak.toFixed(2) + ': the account stop should have closed everything', 'dd15');
    else if (ddPct >= WATCHDOG.ddWarnPct) add('WARN', 'equity ' + eq.equity.toFixed(2) + ' is ' + ddPct.toFixed(1) + '% below its peak ' + st.peak.toFixed(2) + ' (the account stop is at ' + WATCHDOG.ddStopPct + '%)');
  }

  // 5. Open positions without a stop, and fills slipping more than the research assumes.
  (built.open || []).filter(t => !t.stop).forEach(t => add('ALERT', t.strat + ' position open without a stop in the journal', 'nostop:' + t.strat + ':' + new Date(t.opened).getTime()));
  const slips = (built.trades || []).concat(built.open || []).filter(t => t.slip !== null && t.slip !== undefined).slice(-WATCHDOG.slipFills).map(t => t.slip);
  const slipAvg = slips.length ? slips.reduce((a, b) => a + b, 0) / slips.length : null;
  if (slips.length >= 5 && slipAvg > WATCHDOG.slipWarnUsd)
    add('WARN', 'stop orders slipped $' + slipAvg.toFixed(2) + ' on average over the last ' + slips.length + ' fills; the research assumes $0.29');

  const level = problems.some(p => p.level === 'ALERT') ? 'ALERT' : problems.length ? 'WARN' : 'OK';
  return { level, problems, state: st, ddPct, slipAvg, slipN: slips.length, now };
}

/** The tab: a status line, then one row per change (and one an hour while nothing changes), newest first. */
function watchdogWrite_(res) {
  const s = ss_().getSheetByName(WATCHDOG.sheet) || ss_().insertSheet(WATCHDOG.sheet);
  const text = res.problems.length ? res.problems.map(p => p.level + ': ' + p.text).join('\n') : 'All checks passed';
  const tz = Session.getScriptTimeZone();
  const when = Utilities.formatDate(new Date(res.now), tz, 'yyyy-MM-dd HH:mm');
  const extra = (res.ddPct !== null ? 'drawdown from peak ' + res.ddPct.toFixed(1) + '%' : 'no equity yet') +
                (res.slipAvg !== null ? '  ·  stop-order slippage $' + res.slipAvg.toFixed(2) + ' (' + res.slipN + ' fills)' : '');
  if (s.getLastRow() < 4) {
    s.getRange(1, 1).setValue('Watchdog: checks both EAs every ' + WATCHDOG.everyMin + ' minutes (reads only; changes nothing)').setFontWeight('bold').setFontSize(14);
    s.getRange(4, 1, 1, 4).setValues([['Checked', 'Status', 'What it found', 'Account']]).setFontWeight('bold');
    s.setColumnWidth(1, 140); s.setColumnWidth(2, 80); s.setColumnWidth(3, 620); s.setColumnWidth(4, 360);
    s.setFrozenRows(4);
  }
  s.getRange(2, 1, 1, 4).setValues([['Now: ' + res.level, 'checked ' + when, text, extra]]);
  s.getRange(2, 1).setFontWeight('bold').setFontColor(res.level === 'OK' ? '#16a34a' : res.level === 'WARN' ? '#d97706' : '#dc2626');
  const prev = s.getLastRow() >= 5 ? s.getRange(5, 1, 1, 3).getValues()[0] : null;
  const hourOld = !prev || !(prev[0] instanceof Date) || res.now - prev[0].getTime() >= 3600000;
  if (!prev || prev[1] !== res.level || prev[2] !== text || hourOld) {
    s.insertRowBefore(5);
    s.getRange(5, 1, 1, 4).setValues([[new Date(res.now), res.level, text, extra]]).setWrap(true);
    s.getRange(5, 1).setNumberFormat('yyyy-mm-dd hh:mm');
    if (s.getLastRow() > 4 + WATCHDOG.keepRows) s.deleteRows(5 + WATCHDOG.keepRows, s.getLastRow() - 4 - WATCHDOG.keepRows);
  }
}

/**
 * ALERTs to the owner's Telegram: each one once, when it first appears (a condition that clears and comes back is
 * sent again). Plain text. Without a connected chat it only logs.
 */
function watchdogAlert_(res, before) {
  const alerts = res.problems.filter(p => p.level === 'ALERT');
  res.state.alerted = alerts.map(p => p.key);
  const fresh = alerts.filter(p => before.indexOf(p.key) < 0);
  if (!fresh.length) return 0;
  const chat = telegramChatId_();
  if (!chat) { logLine_('WARN', 'Watchdog: ALERT but no Telegram chat connected: ' + fresh[0].text); return 0; }
  const text = 'MT5 ALERT\n\n' + fresh.map(p => '• ' + p.text).join('\n') +
    '\n\nThe EAs protect themselves: after an account stop both have closed their trades and send nothing new. ' +
    'Nothing restarts until we decide together: open Claude and tell it what this message says. Do not set DG_KILL back to 0 before that.';
  try { telegramCall_('sendMessage', { chat_id: chat, text: text.slice(0, 4000) }); } catch (e) { logLine_('ERROR', 'Watchdog alert: ' + e.message); return 0; }
  logLine_('INFO', 'Watchdog: ALERT sent to Telegram');
  return fresh.length;
}

/**
 * The daily MT5 report (owner, 6 Nov 2026: instead of the morning map), sent by the 07:30 timer. It covers the last
 * 24 hours and goes only after a broker trading day (so Tuesday to Saturday). Returns whether it was sent.
 */
function mt5DailyReportSend_(chat) {
  let state = {};
  try { state = JSON.parse(PropertiesService.getScriptProperties().getProperty('WATCHDOG_STATE') || '{}'); } catch (e) {}
  const text = mt5DailyReportText_(Date.now(), mt5Status_(), mt5ReadLog_(), state);
  if (!text) { logLine_('INFO', 'MT5 daily report: no broker trading day yesterday, nothing sent'); return false; }
  telegramCall_('sendMessage', { chat_id: chat, text: text, parse_mode: 'HTML', disable_web_page_preview: 'true' });
  return true;
}

/** The report's text, or '' when the last broker day was a weekend. Pure, for the tests. */
function mt5DailyReportText_(now, status, log, state) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const money = v => (v < 0 ? '-$' : '+$') + Math.abs(v).toFixed(2);
  const eas = Object.keys(MT5_EAS);
  const offset = eas.map(e => status[e] && status[e].offset).filter(x => x !== null && x !== undefined)[0];
  const yesterday = new Date(now + (offset || 0) * 1000 - 86400000).getUTCDay();   // the broker day the report covers
  if (yesterday === 0 || yesterday === 6) return '';
  const from = now - 86400000;
  const first = log.findIndex(r => r.time.getTime() >= from);
  const check = watchdogCheck_(now, status, log, mt5BuildTrades_(log), { peak: (state && state.peak) || 0, seen: first < 0 ? log.length : first });
  const built = mt5BuildTrades_(log);
  const closed = built.trades.filter(t => t.closed && new Date(t.closed).getTime() >= from);
  const latest = eas.map(e => status[e]).filter(s => s && s.seen).sort((a, b) => b.seen - a.seen)[0];
  const before = log.filter(r => r.time.getTime() < from && r.eq).slice(-1)[0];
  const lines = ['<b>MT5 daily report</b>  ' + esc(Utilities.formatDate(new Date(now), Session.getScriptTimeZone(), 'EEE d MMM')),
                 'Status: <b>' + check.level + '</b>' + (check.level === 'OK' ? ' (all checks passed)' : '')];
  if (latest && latest.equity) {
    lines.push('Equity ' + latest.equity.toFixed(2) + (before ? '  (' + money(latest.equity - before.eq) + ' in 24 h)' : '') +
               (check.ddPct !== null ? '  ·  ' + check.ddPct.toFixed(1) + '% below its peak (stop at ' + WATCHDOG.ddStopPct + '%)' : ''));
  }
  const totR = closed.reduce((a, t) => a + (t.r || 0), 0), totP = closed.reduce((a, t) => a + (t.pnl || 0), 0);
  lines.push('', '<b>Closed in the last 24 h: ' + closed.length + '</b>' + (closed.length ? '  ' + (totR >= 0 ? '+' : '') + totR.toFixed(2) + ' R, ' + money(totP) : ''));
  closed.forEach(t => lines.push('• ' + esc(mt5Name_(t.strat)) + ' ' + (t.side === 1 ? 'buy' : 'sell') + (t.lots ? ' ' + t.lots + ' lots' : '') + ': ' +
                                 (t.r !== null ? (t.r >= 0 ? '+' : '') + t.r.toFixed(2) + ' R' : '?') + (t.pnl !== null ? ', ' + money(t.pnl) : '') + ' (' + esc(t.reason || '') + ')'));
  lines.push('', '<b>Open now: ' + built.open.length + '</b>');
  built.open.forEach(t => lines.push('• ' + esc(mt5Name_(t.strat)) + ' ' + (t.side === 1 ? 'buy' : 'sell') + (t.lots ? ' ' + t.lots + ' lots' : '') + ' at ' + t.entry + ', stop ' + (t.stop || 'none')));
  if (check.slipAvg !== null) lines.push('', 'Stop-order slippage: $' + check.slipAvg.toFixed(2) + ' a fill over the last ' + check.slipN + ' (the research assumes $0.29)');
  if (check.problems.length) { lines.push('', '<b>Watchdog</b>'); check.problems.forEach(p => lines.push('• ' + p.level + ': ' + esc(p.text))); }
  lines.push('', 'Details: the MT5 Watchdog tab, and Claude\'s report in data/reports/daily.');
  return lines.join('\n').slice(0, 4000);
}
