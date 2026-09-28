/**
 * Data.gs — market data adapters.
 *
 * Every provider normalises to the SAME shape so the strategy never knows
 * or cares where candles came from:
 *   { t: <ms epoch, candle OPEN time>, o, h, l, c, v }
 * sorted oldest -> newest, with the still-forming candle REMOVED.
 *
 * That last part matters more than anything else in this file. If you leave
 * the live candle in, your backtest sees prices that hadn't happened yet and
 * your results become fiction.
 */

function fetchCandles_() {
  const p = CONFIG.MARKET.provider;
  if (p === 'coinbase') return fetchCoinbase_();
  if (p === 'kraken') return fetchKraken_();
  if (p === 'bybit')  return fetchBybit_();
  throw new Error('Unknown provider: ' + p);
}

function httpJson_(url) {
  const res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'Accept': 'application/json' }
  });
  const code = res.getResponseCode();
  if (code !== 200) {
    throw new Error('HTTP ' + code + ' from ' + url + ' :: ' +
                    res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText());
}

/** Kraken public OHLC. No API key, no geo-block, max 720 candles. */
function fetchKraken_() {
  const url = 'https://api.kraken.com/0/public/OHLC'
            + '?pair=' + encodeURIComponent(CONFIG.MARKET.symbol)
            + '&interval=' + CONFIG.MARKET.intervalMinutes;

  const j = httpJson_(url);
  if (j.error && j.error.length) throw new Error('Kraken: ' + j.error.join('; '));

  // Kraken renames pairs (XBTUSD -> XXBTZUSD), so grab the first non-'last' key.
  const key = Object.keys(j.result).filter(k => k !== 'last')[0];
  const rows = j.result[key];

  // Row: [time(sec), open, high, low, close, vwap, volume, count]
  const candles = rows.map(r => ({
    t: Number(r[0]) * 1000,
    o: Number(r[1]),
    h: Number(r[2]),
    l: Number(r[3]),
    c: Number(r[4]),
    v: Number(r[6])
  }));

  return trimToClosed_(candles);
}

/** Bybit v5 spot kline. Newest-first, so we reverse. */
function fetchBybit_() {
  const url = 'https://api.bybit.com/v5/market/kline'
            + '?category=spot'
            + '&symbol=' + encodeURIComponent(CONFIG.MARKET.symbol)
            + '&interval=' + CONFIG.MARKET.intervalMinutes
            + '&limit=' + Math.min(CONFIG.MARKET.candlesToFetch, 1000);

  const j = httpJson_(url);
  if (j.retCode !== 0) throw new Error('Bybit: ' + j.retMsg);

  // Row: [startMs, open, high, low, close, volume, turnover]
  const candles = j.result.list.map(r => ({
    t: Number(r[0]),
    o: Number(r[1]),
    h: Number(r[2]),
    l: Number(r[3]),
    c: Number(r[4]),
    v: Number(r[5])
  })).reverse();

  return trimToClosed_(candles);
}

/**
 * Sort ascending, drop the candle that is still forming, and cap length.
 * A candle is closed once (openTime + interval) is in the past.
 */
function trimToClosed_(candles) {
  const intervalMs = CONFIG.MARKET.intervalMinutes * 60 * 1000;
  const now = Date.now();

  const closed = candles
    .filter(k => Number.isFinite(k.c) && k.c > 0)
    .filter(k => (k.t + intervalMs) <= now)
    .sort((a, b) => a.t - b.t);

  const want = CONFIG.MARKET.candlesToFetch;
  const out = closed.length > want ? closed.slice(closed.length - want) : closed;

  const need = CONFIG.STRATEGY.trendEmaPeriod + CONFIG.STRATEGY.breakoutLookback + 5;
  if (out.length < need) {
    throw new Error('Only ' + out.length + ' closed candles, need ' + need +
                    '. Lower trendEmaPeriod or use a smaller interval.');
  }
  return out;
}

/** Run this by hand first. If it fails, nothing else will work. */
function testFeed() {
  const c = fetchCandles_();
  const last = c[c.length - 1];
  Logger.log('%s candles. Last closed: %s  O:%s H:%s L:%s C:%s',
    c.length,
    Utilities.formatDate(new Date(last.t), CONFIG.TZ, 'yyyy-MM-dd HH:mm'),
    last.o, last.h, last.l, last.c);
}

/* ======================================================================
 * COINBASE — recommended provider.
 *
 * Coinbase's public candles endpoint has no 4-hour granularity (it offers
 * 1m, 5m, 15m, 1h, 6h, 1d) and returns at most 300 candles per request.
 * So: fetch 1h candles in pages, then aggregate into 4h buckets aligned to
 * 00:00, 04:00, 08:00 ... UTC — the same boundaries TradingView uses for
 * COINBASE:BTCUSD on the 4h chart.
 * ====================================================================== */

const COINBASE_GRANS = [60, 300, 900, 3600, 21600, 86400]; // seconds

/** Largest Coinbase granularity that divides the target interval evenly. */
function coinbaseBaseGran_(intervalMinutes) {
  const target = intervalMinutes * 60;
  let best = null;
  COINBASE_GRANS.forEach(g => { if (target % g === 0) best = g; });
  if (!best) throw new Error('No Coinbase granularity divides ' + intervalMinutes + 'm');
  return best;
}

/**
 * Fetch raw Coinbase candles between two timestamps, paging 300 at a time.
 * Returns ascending {t,o,h,l,c,v}. Row order from Coinbase is
 * [time, LOW, HIGH, open, close, volume] — low before high, easy to get wrong.
 */
function fetchCoinbaseRange_(product, granSec, startMs, endMs) {
  const pageMs = 300 * granSec * 1000;
  const out = {};
  let cursor = startMs;
  let calls = 0;

  while (cursor < endMs) {
    const pageEnd = Math.min(cursor + pageMs, endMs);
    const url = 'https://api.exchange.coinbase.com/products/' +
      encodeURIComponent(product) + '/candles' +
      '?granularity=' + granSec +
      '&start=' + new Date(cursor).toISOString() +
      '&end=' + new Date(pageEnd).toISOString();

    const rows = httpJson_(url);
    if (!Array.isArray(rows)) throw new Error('Coinbase: ' + JSON.stringify(rows).slice(0, 200));

    rows.forEach(r => {
      const t = Number(r[0]) * 1000;
      out[t] = { t: t, l: Number(r[1]), h: Number(r[2]), o: Number(r[3]), c: Number(r[4]), v: Number(r[5]) };
    });

    cursor = pageEnd;
    calls++;
    if (calls % 5 === 0) Utilities.sleep(250);   // stay polite to the public API
  }

  return Object.keys(out).map(k => out[k]).sort((a, b) => a.t - b.t);
}

/**
 * Merge small candles into bigger ones, bucketed on UTC boundaries.
 * A bucket only counts as complete once its end time has passed.
 */
function aggregateCandles_(small, intervalMinutes) {
  const size = intervalMinutes * 60 * 1000;
  const buckets = {};
  const order = [];

  small.forEach(k => {
    const b = Math.floor(k.t / size) * size;
    if (!buckets[b]) {
      buckets[b] = { t: b, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, n: 1, last: k.t };
      order.push(b);
    } else {
      const x = buckets[b];
      if (k.h > x.h) x.h = k.h;
      if (k.l < x.l) x.l = k.l;
      if (k.t > x.last) { x.c = k.c; x.last = k.t; }
      x.v += k.v;
      x.n++;
    }
  });

  return order.sort((a, b) => a - b).map(b => {
    const x = buckets[b];
    return { t: x.t, o: x.o, h: x.h, l: x.l, c: x.c, v: x.v };
  });
}

/** Live feed: enough recent history for the indicators, aggregated to the interval. */
function fetchCoinbase_() {
  const iv = CONFIG.MARKET.intervalMinutes;
  const gran = coinbaseBaseGran_(iv);
  const endMs = Date.now();
  const size = iv * 60 * 1000;
  // Align the start to a bucket boundary, otherwise the oldest 4h bar is
  // built from only part of its hours and has the wrong open/high/low.
  const startMs = Math.floor((endMs - (CONFIG.MARKET.candlesToFetch + 2) * size) / size) * size;

  const raw = fetchCoinbaseRange_(CONFIG.MARKET.symbol, gran, startMs, endMs);
  const candles = (gran === iv * 60) ? raw : aggregateCandles_(raw, iv);
  return trimToClosed_(candles);
}

/* ======================================================================
 * LIVE PRICE — used by the paper broker to fill orders at the real price
 * right now, rather than a stale candle close.
 * ====================================================================== */
function fetchTickerPrice_() {
  const p = CONFIG.MARKET.provider;
  const sym = encodeURIComponent(CONFIG.MARKET.symbol);

  if (p === 'coinbase') {
    const j = httpJson_('https://api.exchange.coinbase.com/products/' + sym + '/ticker');
    return Number(j.price);
  }
  if (p === 'kraken') {
    const j = httpJson_('https://api.kraken.com/0/public/Ticker?pair=' + sym);
    const key = Object.keys(j.result)[0];
    return Number(j.result[key].c[0]);
  }
  if (p === 'bybit') {
    const j = httpJson_('https://api.bybit.com/v5/market/tickers?category=spot&symbol=' + sym);
    return Number(j.result.list[0].lastPrice);
  }
  throw new Error('Unknown provider: ' + p);
}

function testTicker() {
  Logger.log('%s %s last price: %s', CONFIG.MARKET.provider, CONFIG.MARKET.symbol, fetchTickerPrice_());
}