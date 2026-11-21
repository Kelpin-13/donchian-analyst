/**
 * Alpaca.gs: trades the gap rule (research/gap_lab.js, Stocks.gs) on an Alpaca PAPER account with real US share prices
 * (owner, 20 Nov 2026: "route B", after the OANDA CFD retest failed). Paper only: the paper server's address is fixed
 * below, and it refuses keys that are not paper keys (paper key IDs start with "PK", live ones with "AK").
 *
 * Setup (owner): an Alpaca account, paper keys, then Script Properties ALPACA_KEY_ID and ALPACA_SECRET (never in code or
 * chat), then menu "Alpaca paper: switch on". Off by default; "switch off" stops new orders (open positions and their
 * stops stay at Alpaca).
 *
 * A 5-minute timer acts in three windows, read from Alpaca's market clock (holidays and early closes included):
 *   entry    11-22 minutes before the close: the day-3 half sale, then the day's buys, both as market-on-close
 *            orders (Alpaca's cut-off is 10 minutes before the close). Signal as Stocks.gs, decided on the day so far
 *            (Yahoo's current daily bar): gap of 6%+ at the open, price at or above the open, low within 2 ATR, $50M
 *            traded, a year of history, SPY above its 200-day the day before. Biggest gap first, at most 10 positions,
 *            0.5% of equity at risk to the day's low, at most 20% of equity in one stock, whole shares.
 *   evening  after the close: a stop-loss (GTC stop order) for every position at the entry day's final low, or at the
 *            entry price after the day-3 half; a close under the 10-day average marks the rest for the next open.
 *   open     3-30 minutes before the open: those are sold with market-on-open orders.
 * Known difference from the backtest: it decides about 15 minutes before the close (the test knew the close), and its
 * stop is the final low of the day. Every order goes to the Alpaca tab and to Telegram.
 * Also (owner, 21 Nov 2026): a self-test on the menu (places a 1-share SPY limit buy at half the price, reads it back,
 * cancels it), each closed trade's result in R kept in ALPACA_CLOSED, and a weekly scorecard on Telegram (Saturday
 * 09:00): the paper account against SPY since ALPACA_START, closed trades against the backtest's expectation.
 * Core (owner, 21 Nov 2026: "yes switch to spare money in SPY"; research/gap_lab.js --core added about 1% a year on both
 * lists): in the entry window the account is topped up to hold SPY with everything not in gap trades (1% kept as
 * cash), with a market-on-close SPY order when the difference is over 0.5% of equity. SPY is held in any market (the
 * market filter only gates gap buys), so the paper account takes SPY's drops. SPY has no stop.
 */
const ALPACA = {
  base: 'https://paper-api.alpaca.markets',      // the paper server; never the live one
  sheet: 'Alpaca', riskPct: 0.5, maxWeight: 0.2, maxPos: 10,
  entryMin: [11, 22], openMin: [3, 30], eveningHours: [16, 19],
  // the backtest's test half, lists A + B (2017 - Nov 2026, 179 trades): what the paper record is judged against
  expect: { avgR: 0.32, sdR: 1.73, win: 0.45, perMonth: 1.5 },
  core: { on: true, symbol: 'SPY', cashPct: 1, minTradePct: 0.5 }
};

/* ---------------- timer, menu ---------------- */
function alpacaOn_() { return PropertiesService.getScriptProperties().getProperty('ALPACA_ON') === 'true'; }
function alpacaEnsure_() {
  const has = ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'runAlpaca');
  if (!alpacaOn_()) { ScriptApp.getProjectTriggers().filter(t => ['runAlpaca', 'alpacaWeekly'].indexOf(t.getHandlerFunction()) >= 0).forEach(t => ScriptApp.deleteTrigger(t)); return false; }
  try { alpacaStart_(); } catch (e) { logLine_('WARN', 'Alpaca start point: ' + e.message); }
  const weekly = ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'alpacaWeekly');
  if (!weekly) ScriptApp.newTrigger('alpacaWeekly').timeBased().onWeekDay(ScriptApp.WeekDay.SATURDAY).atHour(9).create();
  if (has.length) return !weekly;
  ScriptApp.newTrigger('runAlpaca').timeBased().everyMinutes(5).create();
  logLine_('INFO', 'Alpaca: 5-minute timer installed');
  return true;
}
/** The scorecard's starting point (equity and SPY), set once. */
function alpacaStart_() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('ALPACA_START')) return;
  const a = alpacaApi_('get', '/v2/account'), spy = alpacaYahoo_(['SPY']).SPY;
  props.setProperty('ALPACA_START', JSON.stringify({ day: Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd'), equity: +a.equity, spy: spy ? spy[spy.length - 1].c : null }));
}
function alpacaSwitchOn() {
  let msg;
  try {
    alpacaKeys_();
    const a = alpacaApi_('get', '/v2/account');
    PropertiesService.getScriptProperties().setProperty('ALPACA_ON', 'true');
    alpacaEnsure_();
    alpacaLog_([['ON', '', '', '', 'paper account equity $' + Math.round(+a.equity)]]);
    msg = 'Alpaca paper trading is on. Paper equity $' + Math.round(+a.equity) + '. It acts near the US close and open; every order goes to the Alpaca tab and Telegram.';
  } catch (e) { msg = 'Not switched on: ' + e.message; }
  try { SpreadsheetApp.getUi().alert('Alpaca paper', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
}
function alpacaSwitchOff() {
  PropertiesService.getScriptProperties().setProperty('ALPACA_ON', 'false');
  alpacaEnsure_();
  alpacaLog_([['OFF', '', '', '', 'no new orders; open positions and their stops stay at Alpaca']]);
  try { SpreadsheetApp.getUi().alert('Alpaca paper', 'Switched off. Open positions and their stop orders stay at Alpaca.', SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
}
function alpacaStatus() {
  let msg;
  try {
    const a = alpacaApi_('get', '/v2/account'), p = alpacaApi_('get', '/v2/positions');
    msg = 'Paper equity $' + Math.round(+a.equity) + ', cash $' + Math.round(+a.cash) + ', ' + p.length + ' position(s)' +
          (p.length ? ': ' + p.map(x => x.symbol + ' ' + x.qty + ' (' + (+x.unrealized_pl >= 0 ? '+' : '') + Math.round(+x.unrealized_pl) + ')').join(', ') : '') +
          '. Trading is ' + (alpacaOn_() ? 'on.' : 'off.');
  } catch (e) { msg = e.message; }
  try { SpreadsheetApp.getUi().alert('Alpaca paper', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
}

/** Timer, every 5 minutes. Cheap outside the three windows (no network call). */
function runAlpaca() {
  if (!alpacaOn_()) return;
  const hour = +Utilities.formatDate(new Date(), 'America/New_York', 'H');
  if (!(hour === 9 || hour === 15 || hour === 12 ||   // 12: entries on early-close days (13:00)
        (hour >= ALPACA.eveningHours[0] && hour <= ALPACA.eveningHours[1]))) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const st = alpacaState_(), clock = alpacaApi_('get', '/v2/clock');
    const phase = alpacaPhase_(clock, hour, st);
    if (phase === 'entry') alpacaEntry_(st, clock);
    else if (phase === 'open') alpacaOpen_(st, clock);
    else if (phase === 'evening') alpacaEvening_(st, clock);
    alpacaSave_(st);
  } catch (e) {
    logLine_('ERROR', 'Alpaca: ' + e.message);
    alpacaLog_([['ERROR', '', '', '', e.message.slice(0, 200)]]);
  } finally { lock.releaseLock(); }
}

/* ---------------- pure decisions (tested in tests/run.js) ---------------- */
/** Which window the clock is in: 'entry', 'open', 'evening' or ''. Each runs once a New York day. */
function alpacaPhase_(clock, nyHour, st) {
  const now = Date.parse(clock.timestamp), day = String(clock.timestamp).slice(0, 10);
  if (clock.is_open) {
    const m = (Date.parse(clock.next_close) - now) / 60000;
    return m >= ALPACA.entryMin[0] && m <= ALPACA.entryMin[1] && st.entryDay !== day ? 'entry' : '';
  }
  const mo = (Date.parse(clock.next_open) - now) / 60000;
  if (mo >= ALPACA.openMin[0] && mo <= ALPACA.openMin[1] && st.openDay !== day) return 'open';
  if (nyHour >= ALPACA.eveningHours[0] && nyHour <= ALPACA.eveningHours[1] && st.eveningDay !== day) return 'evening';
  return '';
}
/** The day's buys: rows from stocksRow_ on bars that end with today's bar so far. */
function alpacaEntryPlan_(rows, marketOk, equity, cash, held) {
  if (!marketOk) return [];
  const g = STOCKS, out = [];
  let n = held.length;
  rows.filter(r => r.ticker !== 'SPY' && held.indexOf(r.ticker) < 0 && r.gapPct >= g.gapPct && r.price >= r.open &&
                   r.dvPrev >= g.minDollarVolM && r.hist >= 253 && r.price - r.low > 0 && r.price - r.low <= g.gapMaxAtr * r.atrPrev)
    .sort((a, b) => b.gapPct - a.gapPct)
    .forEach(r => {
      if (n >= ALPACA.maxPos) return;
      const risk = r.price - r.low;
      const qty = Math.floor(Math.min(equity * ALPACA.riskPct / 100 / risk, equity * ALPACA.maxWeight / r.price, cash / r.price));
      if (qty < 1) return;
      cash -= qty * r.price; n++;
      out.push({ symbol: r.ticker, qty, price: r.price, stop: r.low, gap: r.gapPct });
    });
  return out;
}
/** The core order in SPY shares (+ buy, - sell, 0 = leave): hold SPY with all but the cash buffer and the gap trades. */
function alpacaCoreDelta_(equity, gapValue, spyQty, spyPrice) {
  const C = ALPACA.core, want = Math.max(0, Math.floor((equity * (1 - C.cashPct / 100) - gapValue) / spyPrice));
  const d = want - spyQty;
  return Math.abs(d) * spyPrice >= equity * C.minTradePct / 100 ? d : 0;
}
/** Trading days after the entry day, counted on a bar series (Yahoo stamps each day at the 09:30 New York open). */
function alpacaDaysSince_(bars, entryDay) {
  return bars.filter(b => new Date(b.t).toISOString().slice(0, 10) > entryDay).length;
}
/** After the close, for one held position: its stop and whether to sell the rest at the next open. */
function alpacaEveningPlan_(p, entry, bars, today) {
  const n = bars.length, last = bars[n - 1];
  let stop = p.stop;
  if (p.entryDay === today) stop = last.l;                       // the entry day's final low
  if (p.half) stop = Math.max(stop, entry);                      // after the day-3 half: the entry price
  let exitNext = false;
  if (alpacaDaysSince_(bars, p.entryDay) >= 1 && n >= 10) {
    let s = 0; for (let i = n - 10; i < n; i++) s += bars[i].c;
    exitNext = last.c < s / 10;
  }
  if (stop >= last.c) exitNext = true;                         // the stop is already crossed: out at the next open, as the test
  return { stop: Math.round(stop * 100) / 100, exitNext };
}

/* ---------------- the three windows ---------------- */
function alpacaEntry_(st, clock) {
  const today = String(clock.timestamp).slice(0, 10), log = [];
  st.entryDay = today;
  const list = stocksList_(); if (list.indexOf('SPY') < 0) list.push('SPY');
  const bars = alpacaYahoo_(list), spy = bars.SPY;
  if (!spy || new Date(spy[spy.length - 1].t).toISOString().slice(0, 10) !== today) { log.push(['SKIP', '', '', '', 'no Yahoo bar for today yet']); alpacaLog_(log); return; }
  const acct = alpacaApi_('get', '/v2/account'), positions = alpacaApi_('get', '/v2/positions');
  const C = ALPACA.core, held = positions.map(p => p.symbol).filter(x => x !== C.symbol);   // the core is not a gap position
  const spyPos = positions.find(x => x.symbol === C.symbol), spyQty = spyPos ? +spyPos.qty : 0, spyPrice = spy[spy.length - 1].c;
  let halfValue = 0;
  // day 3: sell half at the close; the remaining shares keep their stop until the evening run moves it to the entry
  Object.keys(st.pos).forEach(sym => {
    const p = st.pos[sym], pos = positions.find(x => x.symbol === sym);
    if (!pos || p.half || alpacaDaysSince_(spy, p.entryDay) !== 3) return;
    const qty = +pos.qty, half = Math.floor(qty / 2);
    p.half = true;
    if (half < 1) { log.push(['DAY 3', sym, qty, '', 'one share: kept, stop moves to the entry tonight']); return; }
    alpacaCancel_(p.stopId);
    alpacaApi_('post', '/v2/orders', { symbol: sym, qty: String(half), side: 'sell', type: 'market', time_in_force: 'cls' });
    halfValue += half * (+pos.current_price);
    p.stopId = alpacaStop_(sym, qty - half, p.stop);
    log.push(['SELL HALF (close)', sym, half, '', 'day 3; stop ' + p.stop + ' on the other ' + (qty - half)]);
  });
  const rows = [];
  list.forEach(t => { const b = bars[t]; if (!b) return; const r = stocksRow_(t, b); if (r) rows.push(r); });
  const plan = alpacaEntryPlan_(rows, stocksMarketOk_(spy), +acct.equity, +acct.cash + (C.on ? spyQty * spyPrice : 0), held);
  if (C.on) {                                       // the core: SPY with everything not in gap trades, settled at the close
    const gapValue = positions.filter(x => x.symbol !== C.symbol).reduce((a, x) => a + (+x.market_value), 0) - halfValue +
                     plan.reduce((a, o) => a + o.qty * o.price, 0);
    const d = alpacaCoreDelta_(+acct.equity, gapValue, spyQty, spyPrice);
    if (d) {
      alpacaApi_('post', '/v2/orders', { symbol: C.symbol, qty: String(Math.abs(d)), side: d > 0 ? 'buy' : 'sell', type: 'market', time_in_force: 'cls' });
      log.push([d > 0 ? 'CORE BUY (close)' : 'CORE SELL (close)', C.symbol, Math.abs(d), spyPrice, d > 0 ? 'spare money into SPY' : 'SPY sold to pay for gap buys']);
    }
  }
  plan.forEach(o => {
    const res = alpacaApi_('post', '/v2/orders', { symbol: o.symbol, qty: String(o.qty), side: 'buy', type: 'market', time_in_force: 'cls' });
    st.pos[o.symbol] = { entryDay: today, stop: o.stop, half: false, stopId: null, buyId: res.id, exitNext: false };
    log.push(['BUY (close)', o.symbol, o.qty, o.price, 'gap ' + o.gap.toFixed(1) + '%, stop ' + o.stop.toFixed(2) + ' (moves to the final low tonight)']);
  });
  if (!stocksMarketOk_(spy)) log.push(['NO BUYS', '', '', '', 'SPY was under its 200-day yesterday']);
  alpacaLog_(log); alpacaTell_(log);
}

function alpacaEvening_(st, clock) {
  const today = String(clock.timestamp).slice(0, 10), log = [];
  st.eveningDay = today;
  const syms = Object.keys(st.pos), bars = alpacaYahoo_(syms.concat(['SPY'])), spy = bars.SPY;
  if (!spy || new Date(spy[spy.length - 1].t).toISOString().slice(0, 10) !== today) return;   // no session today
  const positions = alpacaApi_('get', '/v2/positions');
  syms.forEach(sym => {
    const p = st.pos[sym], pos = positions.find(x => x.symbol === sym), b = bars[sym];
    if (!pos) {
      let note = p.entryDay === today ? 'the close order did not fill' : 'sold (stop or exit order)';
      if (p.entryDay !== today && p.risk0) {
        try {
          const t = alpacaTradeResult_(alpacaApi_('get', '/v2/account/activities/FILL?after=' + p.entryDay + 'T00:00:00Z&direction=asc&page_size=100'), sym, p, today);
          if (t) { alpacaClosedAdd_(t); note += ': ' + (t.pnl >= 0 ? '+$' : '-$') + Math.abs(t.pnl).toFixed(2) + ', ' + (t.r >= 0 ? '+' : '') + t.r.toFixed(2) + ' R'; }
        } catch (e) { note += ' (result not read: ' + e.message.slice(0, 80) + ')'; }
      }
      log.push([p.entryDay === today ? 'NOT FILLED' : 'CLOSED', sym, '', '', note]);
      delete st.pos[sym]; return;
    }
    if (!b) { log.push(['WARN', sym, pos.qty, '', 'no Yahoo prices: stop left as it is']); return; }
    const e = alpacaEveningPlan_(p, +pos.avg_entry_price, b, today);
    if (p.entryDay === today && !p.risk0) { p.qty0 = +pos.qty; p.entry = +pos.avg_entry_price; p.risk0 = Math.max(0.01, p.entry - e.stop); }
    if (e.stop < b[b.length - 1].c && (e.stop !== p.stop || !p.stopId || p.stopQty !== +pos.qty)) {
      alpacaCancel_(p.stopId);
      p.stop = e.stop; p.stopId = alpacaStop_(sym, +pos.qty, e.stop); p.stopQty = +pos.qty;
      log.push(['STOP', sym, pos.qty, e.stop, p.half ? 'at the entry price after day 3' : 'the entry day\'s low']);
    }
    if (e.exitNext && !p.exitNext) { p.exitNext = true; log.push(['EXIT TOMORROW', sym, pos.qty, b[b.length - 1].c, 'closed under the 10-day average: sell at the open']); }
  });
  alpacaLog_(log); alpacaTell_(log);
}

function alpacaOpen_(st, clock) {
  const log = [];
  st.openDay = String(clock.timestamp).slice(0, 10);
  const positions = alpacaApi_('get', '/v2/positions');
  Object.keys(st.pos).forEach(sym => {
    const p = st.pos[sym], pos = positions.find(x => x.symbol === sym);
    if (!p.exitNext || !pos) return;
    alpacaCancel_(p.stopId); p.stopId = null;
    alpacaApi_('post', '/v2/orders', { symbol: sym, qty: String(pos.qty), side: 'sell', type: 'market', time_in_force: 'opg' });
    log.push(['SELL (open)', sym, pos.qty, '', 'under the 10-day average']);
  });
  alpacaLog_(log); alpacaTell_(log);
}

/* ---------------- plumbing ---------------- */
function alpacaKeys_() {
  const id = secret_('ALPACA_KEY_ID', true), key = secret_('ALPACA_SECRET', true);
  if (!/^PK/.test(id)) throw new Error('ALPACA_KEY_ID is not a paper key (paper key IDs start with PK): refused');
  return { id, key };
}
/** Alpaca paper API call. Errors carry Alpaca's message, never the keys. */
function alpacaApi_(method, path, body) {
  const k = alpacaKeys_();
  const opt = { method, muteHttpExceptions: true, headers: { 'APCA-API-KEY-ID': k.id, 'APCA-API-SECRET-KEY': k.key } };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  const res = UrlFetchApp.fetch(ALPACA.base + path, opt), code = res.getResponseCode();
  let j = null; try { j = JSON.parse(res.getContentText() || 'null'); } catch (e) {}
  if (code >= 300) throw new Error('Alpaca ' + method.toUpperCase() + ' ' + path.split('?')[0] + ': ' + String((j && j.message) || 'HTTP ' + code).slice(0, 200));
  return j;
}
function alpacaStop_(sym, qty, stop) {
  if (!(qty >= 1)) return null;
  return alpacaApi_('post', '/v2/orders', { symbol: sym, qty: String(qty), side: 'sell', type: 'stop', stop_price: String(stop), time_in_force: 'gtc' }).id;
}
function alpacaCancel_(id) { if (id) { try { alpacaApi_('delete', '/v2/orders/' + id); } catch (e) { /* already filled or cancelled */ } } }
function alpacaYahoo_(tickers) {
  const out = {};
  for (let i = 0; i < tickers.length; i += 20) {
    const part = tickers.slice(i, i + 20);
    UrlFetchApp.fetchAll(part.map(t => ({ url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(t) + '?range=2y&interval=1d',
      muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0 (sheet)' } })))
      .forEach((r, k) => { try { if (r.getResponseCode() === 200) out[part[k]] = stocksBars_(JSON.parse(r.getContentText())); } catch (e) {} });
  }
  return out;
}
function alpacaState_() {
  let s = null; try { s = JSON.parse(PropertiesService.getScriptProperties().getProperty('ALPACA_STATE') || 'null'); } catch (e) {}
  return s && s.pos ? s : { pos: {} };
}
function alpacaSave_(st) { PropertiesService.getScriptProperties().setProperty('ALPACA_STATE', JSON.stringify(st)); }
function alpacaLog_(rows) {
  if (!rows.length) return;
  const ss = ss_(); let s = ss.getSheetByName(ALPACA.sheet);
  if (!s) { s = ss.insertSheet(ALPACA.sheet); s.getRange(1, 1, 1, 6).setValues([['Time', 'Action', 'Symbol', 'Shares', 'Price / stop', 'Note']]).setFontWeight('bold'); s.setFrozenRows(1); }
  const t = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  s.getRange(s.getLastRow() + 1, 1, rows.length, 6).setValues(rows.map(r => [t].concat(r.slice(0, 5))));
}
function alpacaTell_(rows) {
  if (!rows.length) return;
  try {
    const chat = telegramChatId_();
    if (chat) telegramCall_('sendMessage', { chat_id: String(chat), text: 'Alpaca PAPER:\n' + rows.map(r => r.filter(x => x !== '').join(' · ')).join('\n') });
  } catch (e) { logLine_('ERROR', 'Alpaca: Telegram: ' + e.message); }
}

/* ---------------- trade record and scorecard (pure parts tested in tests/run.js) ---------------- */
/** One closed trade from Alpaca's fill activities: P&L in $ and in R (risk = entry - first stop, on the first size). */
function alpacaTradeResult_(fills, sym, p, today) {
  const f = (fills || []).filter(x => x.symbol === sym && String(x.transaction_time).slice(0, 10) >= p.entryDay);
  if (!f.length) return null;
  let pnl = 0; f.forEach(x => { pnl += (x.side === 'sell' ? 1 : -1) * (+x.qty) * (+x.price); });
  return { sym, entryDay: p.entryDay, exitDay: today, pnl: Math.round(pnl * 100) / 100, r: pnl / (p.qty0 * p.risk0) };
}
function alpacaClosed_() { try { return JSON.parse(PropertiesService.getScriptProperties().getProperty('ALPACA_CLOSED') || '[]'); } catch (e) { return []; } }
function alpacaClosedAdd_(t) { const a = alpacaClosed_(); a.push(t); PropertiesService.getScriptProperties().setProperty('ALPACA_CLOSED', JSON.stringify(a.slice(-400))); }

/** The weekly scorecard text. o: {start:{day,equity,spy}, equity, spy, open, marketOk, closed:[{r,pnl}], weeks}. */
function alpacaScorecardText_(o) {
  const E = ALPACA.expect, pct = v => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%';
  const acc = o.equity / o.start.equity - 1, spy = o.start.spy && o.spy ? o.spy / o.start.spy - 1 : null;
  const L = ['Alpaca PAPER weekly scorecard (since ' + o.start.day + ')',
    'Account ' + pct(acc) + (spy === null ? '' : ' | SPY ' + pct(spy)) + ' | open positions ' + o.open,
    'Market light: ' + (o.marketOk ? 'GREEN (SPY above its 200-day): buys allowed' : 'RED (SPY under its 200-day): no buys')];
  const n = o.closed.length, months = o.weeks / 4.35;
  L.push('Closed trades: ' + n + ' (the backtest averaged ' + (E.perMonth * months).toFixed(1) + ' in this time, fewer when the light is red)');
  if (n) {
    const avg = o.closed.reduce((a, t) => a + t.r, 0) / n, win = o.closed.filter(t => t.r > 0).length / n;
    L.push('Average ' + (avg >= 0 ? '+' : '') + avg.toFixed(2) + ' R, win rate ' + Math.round(win * 100) + '% (backtest +' + E.avgR.toFixed(2) + ' R, ' + Math.round(E.win * 100) + '%)');
    if (n >= 5) {
      const band = 2 * E.sdR / Math.sqrt(n), lo = E.avgR - band, hi = E.avgR + band;
      L.push(avg < lo ? 'BELOW the backtest range (' + lo.toFixed(2) + ' to ' + hi.toFixed(2) + ' R): worth a review' : 'Inside the backtest range (' + lo.toFixed(2) + ' to ' + hi.toFixed(2) + ' R) for ' + n + ' trades');
    } else L.push('Too few trades to judge (5 needed for a range, 10-20 for a verdict).');
  }
  return L.join('\n');
}

/** Weekly timer (Saturday 09:00): the scorecard to Telegram. */
function alpacaWeekly() {
  if (!alpacaOn_()) return;
  try {
    alpacaStart_();
    const start = JSON.parse(PropertiesService.getScriptProperties().getProperty('ALPACA_START'));
    const a = alpacaApi_('get', '/v2/account'), pos = alpacaApi_('get', '/v2/positions'), spy = alpacaYahoo_(['SPY']).SPY;
    const text = alpacaScorecardText_({ start, equity: +a.equity, spy: spy ? spy[spy.length - 1].c : null, open: pos.length,
      marketOk: spy ? spy[spy.length - 1].c > spy.slice(-200).reduce((x, b) => x + b.c, 0) / 200 : false,
      closed: alpacaClosed_(), weeks: Math.max(0, (Date.now() - Date.parse(start.day)) / (7 * 86400000)) });
    const chat = telegramChatId_();
    if (chat) telegramCall_('sendMessage', { chat_id: String(chat), text }, { weekly: true });
    alpacaLog_([['SCORECARD', '', '', '', text.split('\n')[1]]]);
  } catch (e) { logLine_('ERROR', 'Alpaca weekly: ' + e.message); }
}

/** Menu: proves the order path works without trading: a 1-share SPY limit buy at half the price, read back, cancelled. */
function alpacaSelfTest() {
  const out = [];
  let ok = true;
  const step = (name, fn) => { if (!ok) return null; try { const v = fn(); out.push('OK   ' + name); return v; } catch (e) { ok = false; out.push('FAIL ' + name + ': ' + e.message); return null; } };
  step('paper keys', () => alpacaKeys_());
  const acct = step('account', () => alpacaApi_('get', '/v2/account'));
  step('market clock', () => alpacaApi_('get', '/v2/clock'));
  const spy = step('Yahoo prices', () => { const b = alpacaYahoo_(['SPY', 'AAPL']); if (!b.SPY || b.SPY.length < 253 || !b.AAPL) throw new Error('too little history'); return b.SPY; });
  const order = step('place a test order (1 SPY, limit at half the price)', () => alpacaApi_('post', '/v2/orders',
    { symbol: 'SPY', qty: '1', side: 'buy', type: 'limit', limit_price: (Math.round(spy[spy.length - 1].c * 50) / 100).toFixed(2), time_in_force: 'day' }));
  step('read it back', () => { const o = alpacaApi_('get', '/v2/orders/' + order.id); if (o.symbol !== 'SPY') throw new Error('wrong order'); return o; });
  step('cancel it', () => { alpacaApi_('delete', '/v2/orders/' + order.id); const o = alpacaApi_('get', '/v2/orders/' + order.id);
    if (['canceled', 'pending_cancel'].indexOf(o.status) < 0) throw new Error('status ' + o.status); return o; });
  if (order && !ok) alpacaCancel_(order.id);
  const msg = (ok ? 'SELF-TEST PASSED' : 'SELF-TEST FAILED') + (acct ? ' (paper equity $' + Math.round(+acct.equity) + ')' : '') + '\n' + out.join('\n');
  alpacaLog_([['SELF-TEST', 'SPY', 1, '', (ok ? 'passed' : 'FAILED: ' + out[out.length - 1]).slice(0, 200)]]);
  try { SpreadsheetApp.getUi().alert('Alpaca paper', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return msg;
}
