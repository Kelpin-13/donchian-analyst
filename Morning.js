/**
 * Morning.gs — the 07:30 Telegram timer. Since 6 Nov 2026 (owner) it sends the daily MT5 report (Watchdog.gs); the gold
 * morning map below is kept for the menu's "send now" and for MORNING.send = 'map'.
 *
 * It sends: gold's 4-hour supply and demand zones (order blocks) nearest the price, the 4-hour trend, the levels
 * the MT5 EAs trade today (their latest lines in MT5 Log), whether the EAs are alive, and a picture of the 4-hour
 * chart with the zones drawn in (Google's Charts service; the text still goes if the picture fails).
 *
 * The zones are a map, not signals: entering at them failed our tests (research/sd_lab.js, 2023-2026 gold). The
 * order-block rule here is orderBlocks() in research/sd_lab.js (tests/run.js checks they find the same zones).
 * Prices: Twelve Data's hourly XAU/USD (TWELVEDATA_API_KEY), grouped into the broker's 4-hour bars (broker time =
 * New York + 7 h), so the bars match MT5 and TradingView. It only reads and sends messages.
 * Setup (menu Trading Agent → Morning map): TELEGRAM_BOT_TOKEN in Script Properties, send the bot a message, then
 * Connect Telegram. The chat ID is kept in Script Property TELEGRAM_CHAT_ID, never in code.
 */
// send: what the 07:30 timer sends. 'report' = the daily MT5 report (owner, 6 Nov 2026); 'map' = the gold map as before.
const MORNING = { send: 'report', symbol: 'XAU/USD', hour: 7, minute: 30, hourlyBars: 5000, pivot: 3, lookback: 50, show: 3, chartBars: 120 };
const MORNING_HOUR = 3600000, MORNING_H4 = 4 * 3600000;

/* ---------------- menu and trigger ---------------- */
/**
 * Trigger, every day at 07:30. Sends the daily MT5 report (Watchdog.gs) after each broker trading day, or with
 * MORNING.send = 'map' the gold map while gold trades. Weekends stay silent. The map is still on the menu (send now).
 */
function runMorningMap() {
  try { watchdogEnsure_(); } catch (e) { logLine_('ERROR', 'Watchdog timer: ' + e.message); }   // Watchdog.gs: installs itself once
  const chat = telegramChatId_();
  if (!chat) { logLine_('WARN', 'Morning map: no Telegram chat connected'); return; }
  if (MORNING.send === 'report') {
    try { mt5DailyReportSend_(chat); } catch (e) { logLine_('ERROR', 'MT5 daily report: ' + e.message); }
    return;
  }
  morningMapRun_(chat);
}

/** The gold map, when gold is open. */
function morningMapRun_(chat) {
  try {
    const m = morningBuild_();
    if (!m.open) { logLine_('INFO', 'Morning map: gold is closed, nothing sent'); return; }
    morningSend_(chat, m);
  } catch (e) {
    logLine_('ERROR', 'Morning map: ' + e.message);
  }
}

/** Menu: send the map now, even while gold is closed. */
function morningMapNow() {
  const ui = SpreadsheetApp.getUi(), chat = telegramChatId_();
  if (!chat) { ui.alert('Morning map', 'Connect Telegram first (Trading Agent → Morning map: connect Telegram).', ui.ButtonSet.OK); return; }
  try {
    morningSend_(chat, morningBuild_());
    ui.alert('Morning map', 'Sent. Check Telegram.', ui.ButtonSet.OK);
  } catch (e) {
    ui.alert('Morning map', 'Not sent: ' + e.message, ui.ButtonSet.OK);
  }
}

/** Menu: link the owner's Telegram chat and start the 07:30 timer. */
function telegramConnect() {
  const r = telegramConnect_();
  const ui = SpreadsheetApp.getUi();
  ui.alert(r.ok ? 'Telegram connected' : 'Telegram', r.text, ui.ButtonSet.OK);
}

function telegramConnect_() {
  if (!secret_('TELEGRAM_BOT_TOKEN', false)) {
    return { ok: false, text: 'First create a bot: in Telegram open @BotFather, send /newbot and follow the steps. It gives you a token. ' +
             'In Apps Script open Project Settings → Script properties and add TELEGRAM_BOT_TOKEN with that token. ' +
             'Then send any message to your new bot and run this again.' };
  }
  let updates;
  try {
    updates = telegramCall_('getUpdates', { timeout: '0' });
  } catch (e) {
    return { ok: false, text: e.message + (/webhook/i.test(e.message) ? '\n\nThis bot is linked to the web app (a webhook). Create a separate bot for the morning map.' : '') };
  }
  const msgs = (updates || []).map(u => u.message).filter(x => x && x.chat && x.chat.type === 'private');
  if (!msgs.length) return { ok: false, text: 'No message found. Send any message to your bot in Telegram, then run this again.' };
  const chat = msgs[msgs.length - 1].chat;
  PropertiesService.getScriptProperties().setProperty('TELEGRAM_CHAT_ID', String(chat.id));
  morningMapOn_();
  telegramCall_('sendMessage', { chat_id: String(chat.id), text: 'Connected. The MT5 daily report will arrive here at 07:30, Tuesday to Saturday, and any MT5 alert at once.' });
  logLine_('INFO', 'Telegram connected; morning map timer on');
  return { ok: true, text: 'Connected to the Telegram chat of ' + (chat.first_name || chat.username || 'this account') +
           ' (a confirmation was sent there). If that is not you, run Morning map: stop and remove TELEGRAM_CHAT_ID from Script Properties.\n\n' +
           'The MT5 daily report arrives at 07:30, Tuesday to Saturday; alerts come at once. To see the gold map now: Morning map: send now.' };
}

/** The daily timer (07:30 in the script's time zone). Replaces any earlier one. */
function morningMapOn_() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'runMorningMap').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runMorningMap').timeBased().atHour(MORNING.hour).nearMinute(MORNING.minute).everyDays(1)
    .inTimezone(Session.getScriptTimeZone()).create();
}

/** Menu: stop the morning map (the chat stays connected; Connect Telegram starts it again). */
function morningMapOff() {
  const t = ScriptApp.getProjectTriggers().filter(x => x.getHandlerFunction() === 'runMorningMap');
  t.forEach(x => ScriptApp.deleteTrigger(x));
  logLine_('INFO', 'Morning map timer off');
  try { SpreadsheetApp.getUi().alert('Morning map', t.length ? 'Stopped.' : 'It was not running.', SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
}

/* ---------------- Telegram ---------------- */
/** Telegram Bot API call. Errors carry Telegram's description, never the URL (it holds the token). */
function telegramCall_(method, payload) {
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + secret_('TELEGRAM_BOT_TOKEN', true) + '/' + method,
                                { method: 'post', muteHttpExceptions: true, payload: payload });
  let body = null;
  try { body = JSON.parse(res.getContentText()); } catch (e) {}
  if (!body || !body.ok) throw new Error('Telegram ' + method + ': ' + String((body && body.description) || 'HTTP ' + res.getResponseCode()).slice(0, 200));
  return body.result;
}

function morningSend_(chat, m) {
  telegramCall_('sendMessage', { chat_id: chat, text: morningText_(m), parse_mode: 'HTML', disable_web_page_preview: 'true' });
  try {
    const png = morningChart_(m);
    if (png) telegramCall_('sendPhoto', { chat_id: chat, photo: png, caption: 'Gold, 4-hour bars: supply zones red, demand zones green' });
  } catch (e) {
    logLine_('WARN', 'Morning map picture not sent: ' + e.message);
  }
  logLine_('INFO', 'Morning map sent (' + m.zones.length + ' zones)');
}

/* ---------------- the map ---------------- */
function morningBuild_() {
  const now = Date.now();
  const hourly = twelveCandles_(MORNING.symbol, 60, MORNING.hourlyBars).filter(k => k.t + MORNING_HOUR <= now && morningTrading_(k));
  if (hourly.length < 600) throw new Error('only ' + hourly.length + ' hourly bars from Twelve Data');
  const last = hourly[hourly.length - 1];
  const c4 = morningH4_(hourly).filter(x => x.done);
  const closes = c4.map(x => x.c), e = ema_(closes, 100), n = c4.length;
  const prior = c4.slice(-20);                            // the H4 EA's next decision looks at these 20 bars
  return {
    at: now, price: last.c, open: now - (last.t + MORNING_HOUR) < 2 * MORNING_HOUR,   // a bar in the last two hours
    c4, zones: morningNearest_(morningZones_(c4), last.c),
    ema: e[n - 1], trend: e[n - 1] === null ? 0 : closes[n - 1] > e[n - 1] ? 1 : -1,
    chHigh: Math.max(...prior.map(x => x.h)), chLow: Math.min(...prior.map(x => x.l)),
    ea: morningEa_(now)
  };
}

/** Broker clock for UTC time t: New York + 7 h (UTC+3 during US summer time, UTC+2 otherwise). */
function morningServerMs_(t) {
  const y = new Date(t).getUTCFullYear();
  const sunday = (mon, nth) => { const d = new Date(Date.UTC(y, mon, 1)).getUTCDay(); return Date.UTC(y, mon, 1 + (7 - d) % 7 + 7 * (nth - 1)); };
  const summer = t >= sunday(2, 2) + 7 * MORNING_HOUR && t < sunday(10, 1) + 6 * MORNING_HOUR;   // 02:00 in New York
  return t + (summer ? 3 : 2) * MORNING_HOUR;
}

/**
 * A real trading hour? Twelve Data also sends flat bars while gold is shut (weekends, holidays), which would
 * flatten the average and send the map on Saturdays. Gold trades Monday 01:00 to Friday 24:00 broker time,
 * with a break 00:00-01:00 each day; a bar with no range had no trades.
 */
function morningTrading_(k) {
  const s = new Date(morningServerMs_(k.t)), day = s.getUTCDay();
  return day >= 1 && day <= 5 && s.getUTCHours() >= 1 && k.h > k.l;
}

/** Hourly bars → the broker's 4-hour bars (00:00, 04:00 … broker time); done = all four hours are over. */
function morningH4_(hourly) {
  const out = [];
  hourly.forEach(k => {
    const b = Math.floor(morningServerMs_(k.t) / MORNING_H4) * MORNING_H4, x = out[out.length - 1];
    if (x && x.b === b) { x.h = Math.max(x.h, k.h); x.l = Math.min(x.l, k.l); x.c = k.c; x.lastEnd = k.t + MORNING_HOUR; }
    else out.push({ b, t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, lastEnd: k.t + MORNING_HOUR });
  });
  const lastEnd = hourly.length ? morningServerMs_(hourly[hourly.length - 1].t + MORNING_HOUR) : 0;
  out.forEach(x => { x.done = x.b + MORNING_H4 <= lastEnd; });
  return out;
}

/**
 * Order blocks, as orderBlocks() in research/sd_lab.js: a swing high/low is a pivot with `pivot` candles each side;
 * a close through the last swing is a break of structure, and the last opposite-coloured candle in the `lookback`
 * before it is the block. Demand: near = its high, far = its low; supply: near = its low, far = its high.
 */
function morningOrderBlocks_(c, pivot, lookback) {
  const zones = [];
  let sh = null, sl = null;
  for (let j = 2 * pivot; j < c.length; j++) {
    const p = j - pivot;
    let isHigh = true, isLow = true;
    for (let q = p - pivot; q <= j; q++) {
      if (q === p) continue;
      if (c[q].h >= c[p].h) isHigh = false;
      if (c[q].l <= c[p].l) isLow = false;
    }
    if (isHigh) sh = c[p].h;
    if (isLow) sl = c[p].l;
    if (j < 15) continue;                                  // as the research, which waits for its ATR(14)
    const k = c[j];
    if (sh !== null && k.c > sh) {
      for (let q = j - 1; q >= Math.max(0, j - lookback); q--) {
        if (c[q].c < c[q].o) { zones.push({ side: 1, near: c[q].h, far: c[q].l, at: j }); break; }
      }
      sh = null;
    }
    if (sl !== null && k.c < sl) {
      for (let q = j - 1; q >= Math.max(0, j - lookback); q--) {
        if (c[q].c > c[q].o) { zones.push({ side: -1, near: c[q].l, far: c[q].h, at: j }); break; }
      }
      sl = null;
    }
  }
  return zones;
}

/** Zones still standing (no 4-hour close beyond the far edge), each marked fresh or tested. */
function morningZones_(c4) {
  return morningOrderBlocks_(c4, MORNING.pivot, MORNING.lookback).map(z => {
    let tested = false;
    for (let j = z.at + 1; j < c4.length; j++) {
      const k = c4[j];
      if (z.side === 1 ? k.c < z.far : k.c > z.far) return null;
      if (z.side === 1 ? k.l <= z.near : k.h >= z.near) tested = true;
    }
    return { side: z.side, lo: Math.min(z.near, z.far), hi: Math.max(z.near, z.far), tested, t: c4[z.at].t };
  }).filter(Boolean);
}

/** Up to MORNING.show zones above the price and below it, nearest first, plus any the price is inside. */
function morningNearest_(zones, price) {
  const above = zones.filter(z => z.lo > price).sort((a, b) => a.lo - b.lo).slice(0, MORNING.show);
  const below = zones.filter(z => z.hi < price).sort((a, b) => b.hi - a.hi).slice(0, MORNING.show);
  const inside = zones.filter(z => z.lo <= price && z.hi >= price);
  return above.reverse().concat(inside, below);           // top of the chart first
}

/** What the EAs said last: today's Dual Thrust levels, the H4 EA's position, and when each was last heard from. */
function morningEa_(now) {
  const out = { dt: null, h4: null, seen: {} };
  const st = mt5Status_();
  Object.keys(MT5_EAS).forEach(ea => { out.seen[ea] = st[ea] && st[ea].seen ? now - st[ea].seen : null; });
  const s = ss_().getSheetByName(MT5_LOG);
  if (!s || s.getLastRow() < 2) return out;
  const from = Math.max(2, s.getLastRow() - 400);
  s.getRange(from, 1, s.getLastRow() - from + 1, MT5_LOG_HEADERS.length).getValues().forEach(r => {
    const t = new Date(r[0]).getTime(), ea = String(r[2]), ev = String(r[4]), d = String(r[6]);
    if (now - t > 20 * MORNING_HOUR) return;
    let m;
    if (ea === 'GoldIntraday' && ev === 'DAY' && (m = /Dual Thrust ([\d.]+)-([\d.]+)/.exec(d))) out.dt = { sell: Number(m[1]), buy: Number(m[2]) };
    if (ea === 'DonchianGold' && ev === 'BAR' && (m = /\|\s*(\w+)/.exec(d))) out.h4 = m[1];
  });
  return out;
}

function morningText_(m) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const p = v => Number(v).toFixed(1), shift = mt5ClockShift_();
  const when = Utilities.formatDate(new Date(m.at), Session.getScriptTimeZone(), 'EEE d MMM, HH:mm');
  const lines = ['<b>Gold morning map</b>, ' + esc(when),
    'Price ' + p(m.price) + '. 4-hour trend: ' + (m.trend > 0 ? 'UP' : m.trend < 0 ? 'DOWN' : 'unclear') +
    (m.ema ? ' (' + (m.trend > 0 ? 'above' : 'below') + ' its 100-bar average ' + p(m.ema) + ')' : ''), ''];

  lines.push('<b>4-hour zones</b> (order blocks)');
  const rows = [];
  let marked = false;
  m.zones.forEach(z => {
    if (!marked && z.hi < m.price) { rows.push('--- ' + p(m.price) + ' now ---'); marked = true; }
    const dist = z.lo > m.price ? '+' + p(z.lo - m.price) : z.hi < m.price ? '-' + p(m.price - z.hi) : 'inside';
    rows.push((z.side === 1 ? 'DEMAND ' : 'SUPPLY ') + p(z.lo) + '-' + p(z.hi) + '  ' + dist + '  ' + (z.tested ? 'tested' : 'fresh'));
  });
  if (!marked) rows.push('--- ' + p(m.price) + ' now ---');
  lines.push('<pre>' + esc(rows.join('\n')) + '</pre>');
  lines.push('A map, not signals: trading these zones has not passed our backtests. ' +
             (m.trend ? 'If you watch one, the ' + (m.trend > 0 ? 'demand' : 'supply') + ' side agrees with the trend.' : ''), '');

  lines.push('<b>Today\'s tested levels</b> (the EAs trade these)');
  if (m.ea.dt) lines.push('Dual Thrust: buy stop ' + m.ea.dt.buy.toFixed(2) + ', sell stop ' + m.ea.dt.sell.toFixed(2));
  else lines.push('Dual Thrust: no levels from MT5 today');
  lines.push('H4 swing' + (m.ea.h4 ? ' (now ' + esc(m.ea.h4) + ')' : '') + ': sells on a 4-hour close below about ' + p(m.chLow) +
             (m.trend > 0 ? ' (only if also below ' + p(m.ema) + ')' : '') + ', buys on one above about ' + p(m.chHigh) +
             (m.trend < 0 ? ' (only if also above ' + p(m.ema) + ')' : ''));
  lines.push('Later, your time: Asian breakout ' + mt5Times_('{09:00}', shift) + ' (quiet nights only), Momentum ' + mt5Times_('{16:00}', shift) +
             ', New York open ' + mt5Times_('{17:00}', shift) + ', Momentum ' + mt5Times_('{20:00}', shift) + '; all intraday trades closed ' +
             mt5Times_('{23:00}', shift) + '.', '');

  const silent = Object.keys(MT5_EAS).filter(ea => m.ea.seen[ea] === null || m.ea.seen[ea] > MORNING_HOUR);
  lines.push(silent.length ? '⚠️ MT5 not heard from: ' + silent.map(ea => ea + (m.ea.seen[ea] === null ? ' (never)' : ' (' +
             Math.round(m.ea.seen[ea] / MORNING_HOUR) + ' h)')).join(', ') + '. While MT5 is off nothing trades.' : 'EAs: both running.');
  return lines.join('\n');
}

/** The 4-hour closes with each shown zone's two edges, as a PNG (Google's Charts service). */
function morningChart_(m) {
  if (typeof Charts === 'undefined') return null;
  const bars = m.c4.slice(-MORNING.chartBars), T = Charts.ColumnType.NUMBER;
  const dt = Charts.newDataTable().addColumn(T, 'Bar').addColumn(T, 'Gold');
  m.zones.forEach((z, i) => { dt.addColumn(T, 'Zone ' + i + ' low'); dt.addColumn(T, 'Zone ' + i + ' high'); });
  bars.forEach((b, j) => dt.addRow([j - bars.length + 1, b.c].concat(...m.zones.map(z => [z.lo, z.hi]))));
  const colours = ['#111827'].concat(...m.zones.map(z => z.side === 1 ? ['#1D9E75', '#1D9E75'] : ['#D85A30', '#D85A30']));
  const lows = bars.map(b => b.l).concat(m.zones.map(z => z.lo)), highs = bars.map(b => b.h).concat(m.zones.map(z => z.hi));
  return Charts.newLineChart().setDataTable(dt.build()).setColors(colours).setDimensions(900, 500)
    .setLegendPosition(Charts.Position.NONE).setRange(Math.min(...lows) - 5, Math.max(...highs) + 5)
    .setTitle('Gold 4-hour, last ' + bars.length + ' bars, with supply (red) and demand (green) zones')
    .setXAxisTitle('4-hour bars ago').build().getAs('image/png').setName('gold-morning-map.png');
}
