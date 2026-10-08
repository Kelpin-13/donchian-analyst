/**
 * Test harness: loads every project .js file into one sandbox (like Apps Script's
 * shared global scope) with in-memory fakes for SpreadsheetApp, PropertiesService,
 * LockService, Utilities and UrlFetchApp. UrlFetchApp answers Coinbase, Twelve Data and OANDA
 * requests from synthetic price data, so the real data adapters run too.
 * No network, no Google account. Not uploaded to Apps Script (.claspignore).
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const H = 3600 * 1000;
/** The only keys the fake services accept, like a real account's keys. */
const VALID_KEYS = { OANDA_API_KEY: 'k', TWELVEDATA_API_KEY: 'td' };

/** Deterministic random numbers, so every run sees the same prices. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

/**
 * Hourly candles with alternating trend / chop regimes. `weekdaysOnly` drops
 * Friday 21:00 – Sunday 22:00 UTC, like gold and forex.
 */
function makeHourly(seed, startMs, hours, startPrice, vol, weekdaysOnly) {
  const r = rng(seed), out = [];
  let p = startPrice, drift = 0;
  for (let i = 0; i < hours; i++) {
    if (i % 240 === 0) drift = (r() - 0.45) * vol * 0.6;               // new regime every 10 days
    const t = startMs + i * H, d = new Date(t), day = d.getUTCDay(), hr = d.getUTCHours();
    const o = p;
    p = Math.max(0.01, p * (1 + drift + (r() - 0.5) * vol));
    if (weekdaysOnly && (day === 6 || (day === 5 && hr >= 21) || (day === 0 && hr < 22))) continue;
    const hi = Math.max(o, p) * (1 + r() * vol * 0.5), lo = Math.min(o, p) * (1 - r() * vol * 0.5);
    out.push({ t, o, h: hi, l: lo, c: p, v: 100 + r() * 900 });
  }
  return out;
}

/** The markets the fake exchanges serve: hourly candles per symbol. */
function makeMarkets(startMs, hours) {
  return {
    'BTC-USD': makeHourly(1, startMs, hours, 60000, 0.006),
    'ETH-USD': makeHourly(2, startMs, hours, 3000, 0.008),
    'SOL-USD': makeHourly(3, startMs, hours, 150, 0.011),
    'XRP-USD': makeHourly(4, startMs, hours, 0.6, 0.010),
    'LINK-USD': makeHourly(5, startMs, hours, 15, 0.010),
    'AVAX-USD': makeHourly(6, startMs, hours, 30, 0.011),
    'XAU_USD': makeHourly(7, startMs, hours, 2400, 0.002, true),     // OANDA's symbol
    'XAU/USD': makeHourly(8, startMs, hours, 2600, 0.002, true),     // Twelve Data's symbols
    'EUR/USD': makeHourly(9, startMs, hours, 1.08, 0.0008, true),
    'GBP/USD': makeHourly(10, startMs, hours, 1.27, 0.001, true),
    'USD/JPY': makeHourly(11, startMs, hours, 150, 0.001, true),
    'AUD/USD': makeHourly(12, startMs, hours, 0.66, 0.0012, true)
  };
}

/** Merge hourly candles (up to `now`) into bars of `size` ms; the newest may still be forming. */
function aggregate(hourly, size, now) {
  const agg = {};
  hourly.filter(k => k.t < now).forEach(k => {
    const b = Math.floor(k.t / size) * size;
    const x = agg[b] || (agg[b] = { t: b, o: k.o, h: k.h, l: k.l, c: k.c, v: 0 });
    x.h = Math.max(x.h, k.h); x.l = Math.min(x.l, k.l); x.c = k.c; x.v += k.v;
  });
  return Object.values(agg).sort((a, b) => a.t - b.t).map(x => Object.assign(x, { complete: x.t + size <= now }));
}

function fakeSheets() {
  const sheets = {};
  const mk = () => {
    const rows = [];
    const cell = (r, c) => { rows[r - 1] = rows[r - 1] || []; return rows[r - 1]; };
    return {
      rows,
      getLastRow: () => rows.length,
      getLastColumn: () => rows.reduce((m, r) => Math.max(m, r ? r.length : 0), 0),
      appendRow: r => rows.push(r.slice()),
      clear: () => { rows.length = 0; },
      deleteRows: (from, n) => rows.splice(from - 1, n),
      setFrozenRows: () => {},
      getCharts: () => [], removeChart: () => {}, clearConditionalFormatRules: () => {},
      getRange: (r, c, n = 1, w = 1) => {
        const rng = {                                   // like Apps Script, setters return the range for chaining
          getValue: () => (rows[r - 1] || [])[c - 1],
          getValues: () => rows.slice(r - 1, r - 1 + n).map(x => { const a = (x || []).slice(c - 1, c - 1 + w); while (a.length < w) a.push(''); return a; }),
          setValue: v => { cell(r, c)[c - 1] = v; return rng; },
          setValues: vs => { vs.forEach((v, j) => v.forEach((x, k) => { cell(r + j, c)[c - 1 + k] = x; })); return rng; },
          setFontWeight: () => rng, setBackground: () => rng, setNumberFormat: () => rng, setBorder: () => rng
        };
        return rng;
      }
    };
  };
  return { sheets, ss: { getSheetByName: n => sheets[n] || null, insertSheet: n => (sheets[n] = mk()) } };
}

/**
 * A fresh Apps Script world. opts: { markets, props, dir }.
 * Returns { ctx, run(code), sheets, props, setNow(ms), calls }.
 */
function world(opts) {
  const o = opts || {};
  const markets = o.markets;
  const { sheets, ss } = fakeSheets();
  const props = Object.assign({ ANTHROPIC_API_KEY: 'test' }, o.props || {});
  const calls = [], callTimes = [], cacheStore = {};
  let now = 0;

  class FakeDate extends Date {
    constructor(...a) { a.length ? super(...a) : super(now); }
    static now() { return now; }
  }
  const reply = (code, body) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(body) });

  function fetch(url, params) {
    calls.push(url);
    callTimes.push(now);
    const u = new URL(url);
    let m;
    if ((m = u.pathname.match(/^\/products\/([^/]+)\/candles$/))) {             // Coinbase candles
      const rows = markets[decodeURIComponent(m[1])];
      if (!rows) return reply(404, { message: 'NotFound' });
      const g = Number(u.searchParams.get('granularity')) * 1000;
      if (g !== H) return reply(400, { message: 'test feed serves 1h only' });
      const s = Date.parse(u.searchParams.get('start')), e = Date.parse(u.searchParams.get('end'));
      const out = rows.filter(k => k.t >= s && k.t <= e && k.t < now)
        .map(k => [k.t / 1000, k.l, k.h, k.o, k.c, k.v]).reverse().slice(0, 300);
      return reply(200, out);
    }
    if ((m = u.pathname.match(/^\/products\/([^/]+)\/ticker$/))) {               // Coinbase ticker
      const rows = (markets[decodeURIComponent(m[1])] || []).filter(k => k.t < now);
      return reply(200, { price: String(rows[rows.length - 1].c) });
    }
    if ((m = u.pathname.match(/^\/v3\/instruments\/([^/]+)\/candles$/))) {       // OANDA candles
      const auth = (params.headers || {}).Authorization || '';
      if (auth !== 'Bearer ' + VALID_KEYS.OANDA_API_KEY) return reply(401, { errorMessage: 'Insufficient authorization' });
      const hourly = markets[decodeURIComponent(m[1])];
      const gran = u.searchParams.get('granularity');
      const size = { S5: 0, H1: H, H4: 4 * H }[gran];
      let bars;
      if (size === 0) {
        const last = hourly.filter(k => k.t < now).pop();
        bars = [{ t: last.t, o: last.c, h: last.c, l: last.c, c: last.c, complete: false }];
      } else {
        bars = aggregate(hourly, size, now);
        const count = Number(u.searchParams.get('count') || 500), from = u.searchParams.get('from');
        bars = from ? bars.filter(x => x.t >= Number(from) * 1000).slice(0, count) : bars.slice(-count);
      }
      return reply(200, { instrument: m[1], granularity: gran, candles: bars.map(x => ({
        time: (x.t / 1000).toFixed(9), complete: x.complete, volume: Math.round(x.v || 1),
        mid: { o: String(x.o), h: String(x.h), l: String(x.l), c: String(x.c) } })) });
    }
    if (u.hostname === 'api.twelvedata.com') {                                     // Twelve Data
      // Like the real API, errors come back as HTTP 200 with status "error".
      if (((params && params.headers) || {}).Authorization !== 'apikey ' + VALID_KEYS.TWELVEDATA_API_KEY) {
        return reply(200, { code: 401, message: '**apikey** parameter is incorrect or not specified.', status: 'error' });
      }
      const sym = u.searchParams.get('symbol'), hourly = markets[sym];
      if (!hourly) return reply(200, { code: 404, message: 'symbol not found: ' + sym, status: 'error' });
      if (u.pathname === '/price') return reply(200, { price: String(hourly.filter(k => k.t < now).pop().c) });
      if (u.pathname === '/time_series') {
        const size = { '1h': H, '4h': 4 * H }[u.searchParams.get('interval')];
        if (!size) return reply(200, { code: 400, message: 'bad interval', status: 'error' });
        const n = Math.min(5000, Number(u.searchParams.get('outputsize') || 30));
        const fmt = t => new Date(t).toISOString().slice(0, 19).replace('T', ' ');
        return reply(200, { meta: { symbol: sym }, status: 'ok', values: aggregate(hourly, size, now).slice(-n)
          .map(x => ({ datetime: fmt(x.t), open: String(x.o), high: String(x.h), low: String(x.l), close: String(x.c) })) });
      }
    }
    if (u.hostname === 'api.anthropic.com') return reply(500, { error: 'Claude is not called in tests' });
    return reply(404, { message: 'unexpected URL in test: ' + url });
  }

  const ctx = {
    console, Math, JSON, Number, String, Object, Array, isFinite, isNaN, URL, Date: FakeDate,
    Logger: { log: () => {} },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss, getUi: () => { throw new Error('no UI in tests'); } },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null),
      getProperties: () => Object.assign({}, props),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: k => { delete props[k]; }
    }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    CacheService: { getScriptCache: () => ({                                   // honours expiry against fake time
      get: k => (cacheStore[k] && cacheStore[k].exp > now ? cacheStore[k].v : null),
      put: (k, v, sec) => { cacheStore[k] = { v: String(v), exp: now + (sec || 600) * 1000 }; }
    }) },
    Utilities: { formatDate: d => new Date(d).toISOString(), sleep: () => {} },
    MailApp: { sendEmail: () => {} },
    UrlFetchApp: { fetch }
  };
  vm.createContext(ctx);
  const dir = o.dir || ROOT;
  fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()
    .forEach(f => vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), ctx, { filename: f }));
  const run = code => vm.runInContext(code, ctx);
  // Claude-backed steps are replaced: tests check plumbing, not model output.
  run(`agentPreTradeNote_ = function () { return { setup: 'test', invalidation: '', watch: '', confidence: 'n/a' }; };
       if (CONFIG.GATE) CONFIG.GATE.mode = 'off';`);
  return { ctx, run, sheets, props, calls, callTimes, setNow: t => { now = t; }, get now() { return now; } };
}

module.exports = { world, makeMarkets, makeHourly, H, VALID_KEYS };
