/**
 * Runs the EAs' own MQL5 functions in Node, so the tests can drive the real code through timelines the Strategy
 * Tester can't stage: a live weekend, a reopening before its first tick. Not a compiler: it knows the C-like
 * subset of mt5/*.mq5, and an argument passed by reference needs a patch or a fake.
 */
const fs = require('fs');
const path = require('path');

const TYPE = '(?:double|int|long|ulong|uint|bool|string|datetime|ENUM_ORDER_TYPE)';

/** Every top-level function in a source file: name -> { params, body }. */
function functionsOf(src) {
  const out = {}, lines = src.split(/\r?\n/);
  lines.forEach((l, i) => {
    const m = /^(?:\w+\s+)+(\w+)\((.*)\)\s*(\{.*\})?\s*$/.exec(l);
    if (!m || /^(input|return|#)/.test(l)) return;
    if (m[3]) { out[m[1]] = { params: m[2], body: m[3] }; return; }
    if (!/^\s*\{/.test(lines[i + 1] || '')) return;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) { body.push(lines[j]); if (/^ {2}\}\s*$/.test(lines[j])) break; }
    out[m[1]] = { params: m[2], body: body.join('\n') };
  });
  return out;
}

function toJs(name, fn) {
  const args = fn.params.split(',').map(p => p.replace(/\[\]/g, '').trim().split(/[\s&]+/).pop()).filter(Boolean);
  const body = fn.body
    .replace(/\/\/.*$/gm, '')
    .replace(/\bMqlRates (\w+)\[\];/g, 'let $1 = [];')
    .replace(/\bMql\w+ (\w+);/g, 'let $1 = {};')
    .replace(/\(long\)\(/g, 'Math.trunc(')
    .replace(/\((?:datetime|double|ulong|uint|int|long|string|ENUM_\w+)\)/g, '')
    .replace(new RegExp('(^\\s*|[;{(]\\s*)(?:const\\s+)?' + TYPE + '\\s+(?=[A-Za-z_])', 'gm'), '$1let ');
  return 'function ' + name + '(' + args.join(', ') + ') ' + body;
}

/**
 * Loads an EA's functions, inputs and plain globals. Names in `env` win over the source (they are the fakes);
 * `lift` limits which functions come from the source; `patches` are [from, to] edits for by-reference calls.
 * Returns the functions, plus get(name) / set(name, value) for the globals and inputs.
 */
function loadEa(file, { env, lift, patches = [] }) {
  let src = fs.readFileSync(path.isAbsolute(file) ? file : path.join(__dirname, '..', 'mt5', file), 'utf8').replace(/\r\n/g, '\n');
  patches.forEach(([from, to]) => {
    if (!src.includes(from)) throw new Error('mql.js patch no longer matches ' + file + ': ' + from);
    src = src.split(from).join(to);
  });
  const fns = functionsOf(src);
  const names = Object.keys(fns).filter(n => !(n in env) && (!lift || lift.includes(n)));
  if (lift) lift.filter(n => !fns[n]).forEach(n => { throw new Error(file + ' has no function ' + n); });
  const declared = new Set(Object.keys(env));
  const decls = [];
  const globalLine = new RegExp('^(?:const\\s+|input\\s+)?(?:' + TYPE + '|ENUM_TIMEFRAMES)\\s+(\\w+)(\\[\\w*\\])?\\s*(?:=\\s*(.+?))?;');
  src.split(/\r?\n/).forEach(l => {
    const m = globalLine.exec(l);
    if (!m || declared.has(m[1])) return;
    declared.add(m[1]);
    const init = m[2] ? (m[3] ? m[3].replace(/^\{/, '[').replace(/\}$/, ']') : '[]') : (m[3] || 'undefined');
    decls.push('let ' + m[1] + ' = ' + init + ';');
  });
  const code = names.map(n => toJs(n, fns[n])).join('\n');
  // A constant the fakes don't define is its own name: comparisons still work.
  const constants = new Set((code + decls.join('\n')).match(/\b[A-Z][A-Z0-9_]{3,}\b/g) || []);
  const consts = [...constants].filter(c => !declared.has(c)).map(c => 'const ' + c + ' = "' + c + '";');
  const vars = [...declared].filter(n => !(n in env));
  const body = 'const { ' + Object.keys(env).join(', ') + ' } = env;\n' + consts.join('\n') + '\n' + decls.join('\n') + '\n' + code + '\n' +
    'return { ' + names.join(', ') + (names.length ? ', ' : '') + 'get: n => ({ ' + vars.map(v => v + ': () => ' + v).join(', ') + ' })[n](), ' +
    'set: (n, x) => ({ ' + vars.map(v => v + ': y => { ' + v + ' = y; }').join(', ') + ' })[n](x) };';
  return new Function('env', body)(env);
}

const RETCODES = { TRADE_RETCODE_DONE: 10009, TRADE_RETCODE_PLACED: 10008, TRADE_RETCODE_MARKET_CLOSED: 10018, TRADE_RETCODE_REQUOTE: 10004,
  TRADE_RETCODE_PRICE_CHANGED: 10020, TRADE_RETCODE_PRICE_OFF: 10021, TRADE_RETCODE_TIMEOUT: 10012, TRADE_RETCODE_CONNECTION: 10031,
  TRADE_RETCODE_TOO_MANY_REQUESTS: 10024, TRADE_RETCODE_REJECT: 10006 };

const pad = n => String(n).padStart(2, '0');
function stamp(t, secs) {
  const d = new Date(t * 1000);
  return d.getUTCFullYear() + '.' + pad(d.getUTCMonth() + 1) + '.' + pad(d.getUTCDate()) + ' ' + pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()) + (secs ? ':' + pad(d.getUTCSeconds()) : '');
}

/**
 * A small fake of the terminal and the broker, for one symbol. `open(t)` says whether the market takes orders at
 * server time t. `clock` is the real server time and `now` what TimeCurrent() returns: live it stands still with
 * the last quote, in the tester a timer event moves it too. Every order that reaches the broker lands in `sends`,
 * every journal row in `rows`.
 */
function fakeBroker({ magic, open }) {
  const b = { now: 0, clock: 0, quote: null, bars: [], m1: [], open, sends: [], rows: [], position: null, deals: [], gv: new Map(), equity: 10000, rc: 0, price: 0, order: 0, ticketNo: 1, refuseWith: null };
  b.tick = (t, bid, ask = bid + 0.3) => {
    b.now = b.clock = t;
    b.quote = { ms: t * 1000, bid, ask };
    if (b.m1[b.m1.length - 1] !== t - t % 60) b.m1.push(t - t % 60);    // the M1 bars that have had a quote
  };
  const reply = rc => { b.rc = rc; return rc === RETCODES.TRADE_RETCODE_DONE || rc === RETCODES.TRADE_RETCODE_PLACED; };
  const send = (kind, extra) => {
    const s = Object.assign({ kind, at: b.clock, quoteMs: b.quote ? b.quote.ms : 0 }, extra);
    b.sends.push(s);
    const rc = b.refuseWith || (b.open(b.clock) ? RETCODES.TRADE_RETCODE_DONE : RETCODES.TRADE_RETCODE_MARKET_CLOSED);
    s.rc = rc;
    return rc;
  };
  const market = (dir, lots, sl, tp) => {
    if (!reply(send(dir === 1 ? 'buy' : 'sell', { lots, sl, tp }))) return false;
    b.price = dir === 1 ? b.quote.ask : b.quote.bid;
    b.order = b.ticketNo++;
    b.position = { ticket: b.order, dir, lots, sl, tp, price: b.price, time: b.now, magic };
    return true;
  };
  b.closeAt = (price, reason) => {
    const p = b.position;
    b.deals.push({ ticket: p.ticket, price, time: b.now, reason });
    b.price = price;
    b.position = null;
  };
  b.trade = {
    SetExpertMagicNumber() {}, SetDeviationInPoints() {}, SetTypeFillingBySymbol() {}, LogLevel() {},
    Buy: (lots, s, p, sl, tp) => market(1, lots, sl, tp),
    Sell: (lots, s, p, sl, tp) => market(-1, lots, sl, tp),
    BuyStop: (lots, level, s, sl, tp) => reply(send('buy stop', { lots, level, sl, tp })),
    SellStop: (lots, level, s, sl, tp) => reply(send('sell stop', { lots, level, sl, tp })),
    OrderDelete: t => reply(send('cancel', { ticket: t })),
    PositionClose: () => {
      if (!reply(send('close'))) return false;
      b.closeAt(b.position.dir === 1 ? b.quote.bid : b.quote.ask, 'DEAL_REASON_EXPERT');
      return true;
    },
    ResultRetcode: () => b.rc,
    ResultRetcodeDescription: () => (b.rc === RETCODES.TRADE_RETCODE_MARKET_CLOSED ? 'market closed' : 'retcode ' + b.rc),
    ResultPrice: () => b.price,
    ResultOrder: () => b.order
  };
  b.env = Object.assign({}, RETCODES, {
    trade: b.trade, _Symbol: 'XAUUSD.sml', _Digits: 3, _Point: 0.001, DBL_MAX: Number.MAX_VALUE,
    TIME_DATE: 1, TIME_MINUTES: 2, TIME_SECONDS: 4,
    Math, Alert() {}, ExpertRemove() {}, EventSetTimer() {}, Print() {}, ArraySetAsSeries() {},
    GlobalVariablesFlush: () => { b.onDisk = new Map(b.gv); },    // what a crash would leave behind
    TimeLocal: () => b.clock,
    ArraySize: a => a.length,
    Journal: (...a) => { const [ev, detail] = a.slice(-2); b.rows.push({ t: b.now, ev, detail, who: a.length > 2 ? a[0] : null }); },
    TimeCurrent: () => b.now,
    TimeToString: (t, mode) => stamp(t, (mode & 4) !== 0),
    DoubleToString: (x, d) => (+x).toFixed(d),
    IntegerToString: x => String(x),
    EnumToString: x => String(x),
    StringFind: (s, x) => s.indexOf(x),
    NormalizeDouble: (x, d) => +(+x).toFixed(d),
    MathMax: Math.max, MathMin: Math.min, MathAbs: Math.abs, MathRound: Math.round, MathFloor: Math.floor,
    MQLInfoInteger: k => (k === 'MQL_TESTER' && b.live ? 0 : 1),   // set b.live to leave the tester's path
    TerminalInfoInteger: k => (k === 'TERMINAL_CONNECTED' && b.offline ? 0 : 1),
    SeriesInfoInteger: () => b.synced !== false,
    AccountInfoInteger: k => (k === 'ACCOUNT_TRADE_MODE' ? 'ACCOUNT_TRADE_MODE_DEMO' : 0),
    AccountInfoDouble: k => (k === 'ACCOUNT_MARGIN_FREE' ? 1e9 : b.equity),
    GlobalVariableCheck: k => b.gv.has(k),
    GlobalVariableGet: k => b.gv.get(k),
    GlobalVariableSet: (k, v) => { b.gv.set(k, v); return 0; },
    GlobalVariableDel: k => b.gv.delete(k),
    SymbolInfoTick: (s, q) => { if (!b.quote) return false; q.time_msc = b.quote.ms; q.bid = b.quote.bid; q.ask = b.quote.ask; return true; },
    SymbolInfoDouble: (s, k) => (k === 'SYMBOL_ASK' ? (b.quote ? b.quote.ask : 0) : k === 'SYMBOL_BID' ? (b.quote ? b.quote.bid : 0) :
      ({ SYMBOL_TRADE_TICK_SIZE: 0.001, SYMBOL_TRADE_TICK_VALUE: 0.1, SYMBOL_TRADE_CONTRACT_SIZE: 100, SYMBOL_VOLUME_STEP: 0.001, SYMBOL_VOLUME_MAX: 100, SYMBOL_VOLUME_MIN: 0.001 })[k]),
    SymbolInfoInteger: () => 0,
    OrderCalcMargin: () => false,
    PositionsTotal: () => (b.position ? 1 : 0),
    PositionGetTicket: () => (b.position ? b.position.ticket : 0),
    PositionSelectByTicket: () => !!b.position,
    PositionGetString: () => 'XAUUSD.sml',
    PositionGetInteger: k => (k === 'POSITION_MAGIC' ? b.position.magic : k === 'POSITION_TYPE' ? (b.position.dir === 1 ? 'POSITION_TYPE_BUY' : 'POSITION_TYPE_SELL') :
      k === 'POSITION_IDENTIFIER' ? b.position.ticket : k === 'POSITION_TIME' ? b.position.time : 0),
    PositionGetDouble: k => (k === 'POSITION_PRICE_OPEN' ? b.position.price : k === 'POSITION_SL' ? b.position.sl : k === 'POSITION_TP' ? b.position.tp : 0),
    PositionPnl: () => 0,
    HistorySelectByPosition: id => { b.dealsOf = b.deals.filter(d => d.ticket === id); return true; },
    HistoryDealsTotal: () => b.dealsOf.length,
    HistoryDealGetTicket: i => i + 1,
    HistoryDealGetInteger: (d, k) => (k === 'DEAL_ENTRY' ? 'DEAL_ENTRY_OUT' : k === 'DEAL_REASON' ? b.dealsOf[d - 1].reason : k === 'DEAL_TIME' ? b.dealsOf[d - 1].time : 0),
    HistoryDealGetDouble: (d) => b.dealsOf[d - 1].price,
    iTime: (s, tf, shift) => { const r = b.bars[b.bars.length - 1 - shift]; return r ? r.time : 0; },
    iBarShift: () => 0,
    CopyRates: (s, tf, start, count, r) => {
      r.length = 0;
      if (tf === 'PERIOD_M1') {                                       // by date: start and count are the first and last times
        for (let i = b.m1.length - 1; i >= 0 && b.m1[i] >= start; i--) if (b.m1[i] <= count) r.unshift({ time: b.m1[i] });
        return r.length;
      }
      const end = b.bars.length - start, from = Math.max(0, end - count);
      for (let i = from; i < end; i++) r.push(b.bars[i]);
      return r.length;
    }
  });
  return b;
}

/** DonchianGold's real code on a fake broker. */
function loadDonchianGold(broker, file = 'DonchianGold.mq5') {
  return loadEa(file, {
    env: broker.env,
    patches: [
      ['bool has = FindPosition(ticket, side, openPrice);', 'const fp = FindPosition(); ticket = fp.ticket; side = fp.side; openPrice = fp.openPrice; const has = fp.has;'],
      ['bool FindPosition(ulong &ticket, int &side, double &openPrice)', 'bool FindPosition()'],
      ['   int found = 0;\n', '   int found = 0; ulong ticket = 0; int side = 0; double openPrice = 0;\n'],
      ['   return found > 0;', '   return { has: found > 0, ticket: ticket, side: side, openPrice: openPrice };'],
      ['Channel(r, n, InpBreakout, hi, lo);', '[hi, lo] = Channel(r, n, InpBreakout);'],
      ['Channel(r, n, InpExit, xhi, xlo);', '[xhi, xlo] = Channel(r, n, InpExit);'],
      ['void Channel(const MqlRates &r[], const int n, const int period, double &hi, double &lo)', 'void Channel(const MqlRates &r[], const int n, const int period)'],
      ['   hi = -DBL_MAX; lo = DBL_MAX;\n', '   double hi = -DBL_MAX, lo = DBL_MAX;\n'],
      ['lo = MathMin(lo, r[j].low); }\n', 'lo = MathMin(lo, r[j].low); }\n   return [hi, lo];\n']
    ]
  });
}

module.exports = { functionsOf, loadEa, fakeBroker, loadDonchianGold, stamp, RETCODES };
