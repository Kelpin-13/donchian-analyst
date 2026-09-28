/**
 * Webhook.gs — the single entry point for everything that POSTs to this project.
 *
 * One Apps Script web app has one URL and one doPost(). This file routes:
 *   TradingView alerts  ->  handleTradingView_()
 *   Telegram updates    ->  handleTelegram_()  (in Agent.gs)
 *
 * ---------------------------------------------------------------------------
 * THE CROSS-CHECK IDEA
 *
 * TradingView runs donchian_analyst.pine on its own servers, on its own data
 * feed, in its own language. This project runs the same rules in JavaScript.
 * Two independent implementations of one strategy. When both fire on the same
 * bar, you have strong evidence both are right. When only one fires, one of
 * them has a bug or they're looking at different data — and you'd never have
 * known without the second engine.
 *
 * TradingView is the WITNESS here, not the decision-maker. The paper account
 * and the journal are driven by runMonitor(). A TradingView alert never places
 * a paper order on its own. That keeps a compromised or misconfigured alert
 * from doing anything except writing one row to a sheet.
 * ---------------------------------------------------------------------------
 *
 * SECURITY: doPost cannot read HTTP headers, so the only way to know a POST
 * came from your TradingView alert is a shared secret inside the JSON body.
 * Set TV_WEBHOOK_SECRET in Script Properties to a long random string, and put
 * the same string in the Pine script's "Webhook secret" input.
 */

const CROSSCHECK_HEADERS = ['Key', 'Type', 'BarTime (UTC)', 'TV received', 'TV price',
                            'Apps Script fired', 'Apps Script price', 'Status', 'Note'];

function doPost(e) {
  let body = null;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '');
  } catch (err) {
    logLine_('WARN', 'doPost: non-JSON body ignored (' + String(e && e.postData && e.postData.contents).slice(0, 80) + ')');
    return ContentService.createTextOutput('ignored');
  }

  try {
    if (body && body.source === 'tradingview') handleTradingView_(body);
    else if (body && body.update_id !== undefined) handleTelegram_(body);
    else logLine_('WARN', 'doPost: unrecognised payload');
  } catch (err) {
    logLine_('ERROR', 'doPost: ' + err.message);
  }
  // Always answer fast and plainly. Details go to the Log sheet, not the caller.
  return ContentService.createTextOutput('ok');
}

/** Length-independent comparison so the secret check doesn't leak timing. */
function safeEqual_(a, b) {
  a = String(a || ''); b = String(b || '');
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function handleTradingView_(body) {
  if (!CONFIG.TRADINGVIEW.enabled) { logLine_('WARN', 'TradingView alert received but TRADINGVIEW.enabled is false'); return; }

  const secret = secret_('TV_WEBHOOK_SECRET', false);
  if (!secret || !safeEqual_(body.secret, secret)) {
    logLine_('WARN', 'TradingView alert rejected: bad or missing secret');
    return;
  }

  const type = String(body.type || '');
  const barTime = Number(body.bar_time);
  const price = Number(body.price);
  if (!/^(ENTRY_LONG|EXIT_STOP|EXIT_CHANNEL|EXIT_TIME)$/.test(type) || !isFinite(barTime)) {
    logLine_('WARN', 'TradingView alert rejected: bad fields ' + JSON.stringify(body).slice(0, 200));
    return;
  }

  let note = '';
  if (body.symbol && body.symbol !== CONFIG.TRADINGVIEW.tickerId) {
    note = 'Symbol mismatch: TradingView sent ' + body.symbol + ', config expects ' + CONFIG.TRADINGVIEW.tickerId;
  }
  const ivTv = String(body.interval || '');
  if (ivTv && ivTv !== String(CONFIG.MARKET.intervalMinutes)) {
    note += (note ? '; ' : '') + 'Interval mismatch: TradingView ' + ivTv + ', config ' + CONFIG.MARKET.intervalMinutes;
  }

  recordCrosscheck_('TV', type, barTime, price, note);
}

/**
 * Upsert one row per (signal type, bar). Either engine can arrive first.
 * Status becomes MATCH as soon as both have reported.
 */
function recordCrosscheck_(source, type, barTime, price, note) {
  if (!CONFIG.TRADINGVIEW.enabled) return;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) { logLine_('WARN', 'recordCrosscheck_: lock busy'); return; }
  try {
    const s = sheet_('Crosscheck', CROSSCHECK_HEADERS);
    const key = type + '|' + barTime;
    const last = s.getLastRow();
    const from = Math.max(2, last - 300);
    const keys = last >= 2 ? s.getRange(from, 1, last - from + 1, 1).getValues().map(r => String(r[0])) : [];
    const idx = keys.indexOf(key);

    if (idx === -1) {
      const row = [key, type, utc_(barTime), '', '', '', '', 'PENDING', note || ''];
      if (source === 'TV') { row[3] = new Date(); row[4] = price; }
      else { row[5] = new Date(); row[6] = price; }
      s.appendRow(row);
      return;
    }

    const r = from + idx;
    const cur = s.getRange(r, 1, 1, CROSSCHECK_HEADERS.length).getValues()[0];
    if (source === 'TV') {
      if (cur[3]) return;                        // duplicate TradingView delivery
      cur[3] = new Date(); cur[4] = price;
    } else {
      if (cur[5]) return;
      cur[5] = new Date(); cur[6] = price;
    }
    if (cur[3] && cur[5]) {
      const tv = Number(cur[4]), gas = Number(cur[6]);
      const diffPct = tv && gas ? Math.abs(tv - gas) / gas * 100 : 0;
      cur[7] = 'MATCH';
      if (diffPct > 0.2) cur[8] = (cur[8] ? cur[8] + '; ' : '') + 'Close prices differ by ' + round_(diffPct) + '% — different data feeds?';
    }
    if (note) cur[8] = (cur[8] ? cur[8] + '; ' : '') + note;
    s.getRange(r, 1, 1, CROSSCHECK_HEADERS.length).setValues([cur]);
  } finally {
    lock.releaseLock();
  }
}

/**
 * After the grace period, anything still PENDING means only one engine fired.
 * That's a discrepancy worth investigating, so it gets flagged and alerted.
 */
function reconcileCrosscheck_() {
  if (!CONFIG.TRADINGVIEW.enabled) return 0;
  const s = ss_().getSheetByName('Crosscheck');
  if (!s || s.getLastRow() < 2) return 0;

  const grace = CONFIG.TRADINGVIEW.crosscheckGraceBars * CONFIG.MARKET.intervalMinutes * 60 * 1000;
  const ivMs = CONFIG.MARKET.intervalMinutes * 60 * 1000;
  const v = s.getRange(2, 1, s.getLastRow() - 1, CROSSCHECK_HEADERS.length).getValues();
  let flagged = 0;

  v.forEach((row, i) => {
    if (row[7] !== 'PENDING') return;
    const barTime = Number(String(row[0]).split('|')[1]);
    if (Date.now() < barTime + ivMs + grace) return;   // still inside the grace window
    const status = row[3] ? 'TV_ONLY' : 'APPS_SCRIPT_ONLY';
    s.getRange(i + 2, 8).setValue(status);
    flagged++;
    sendAlert_('⚠️ Engine disagreement: ' + row[1] + ' on bar ' + row[2] + ' fired in ' +
      (row[3] ? 'TradingView' : 'Apps Script') + ' only.\n\nCheck the Crosscheck sheet. Usual causes: ' +
      'different exchange/symbol, a missed alert, or indicator warm-up differences.');
  });

  if (flagged) logLine_('WARN', 'Crosscheck: ' + flagged + ' discrepancy row(s) flagged');
  return flagged;
}

/**
 * Simulate a TradingView alert from the editor, without TradingView.
 * Proves the whole path works before you pay for anything.
 */
function testTradingViewWebhook() {
  const fake = {
    postData: { contents: JSON.stringify({
      secret: secret_('TV_WEBHOOK_SECRET', true),
      source: 'tradingview',
      symbol: CONFIG.TRADINGVIEW.tickerId,
      interval: String(CONFIG.MARKET.intervalMinutes),
      type: 'ENTRY_LONG',
      bar_time: Math.floor(Date.now() / 14400000) * 14400000 - 14400000,
      price: 12345.6
    }) }
  };
  const was = CONFIG.TRADINGVIEW.enabled;
  CONFIG.TRADINGVIEW.enabled = true;
  try { doPost(fake); } finally { CONFIG.TRADINGVIEW.enabled = was; }
  Logger.log('Sent a fake alert. Open the Crosscheck sheet — you should see a PENDING row with a TV price of 12345.6.');
}