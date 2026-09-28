/**
 * Indicators.gs — pure functions, no I/O, no globals.
 *
 * Every function takes an array and returns an array of the same length,
 * with `null` where there isn't enough history yet. Keeping the lengths
 * aligned means index i always refers to candle i everywhere in the project.
 */

/** Exponential moving average, seeded with an SMA of the first `period` values. */
function ema_(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;

  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** True Range for each candle. First candle has no previous close -> h-l. */
function trueRange_(candles) {
  return candles.map((k, i) => {
    if (i === 0) return k.h - k.l;
    const pc = candles[i - 1].c;
    return Math.max(k.h - k.l, Math.abs(k.h - pc), Math.abs(k.l - pc));
  });
}

/** Average True Range using Wilder smoothing (not a plain SMA). */
function atr_(candles, period) {
  const tr = trueRange_(candles);
  const out = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;

  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;

  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/**
 * Donchian channel EXCLUDING the current bar.
 *
 * upper[i] = highest high of bars [i-period .. i-1]
 * lower[i] = lowest  low  of bars [i-period .. i-1]
 *
 * Excluding bar i is the whole point. If bar i's own high is inside the
 * channel, then "close > upper" is trivially satisfiable by any green bar and
 * the signal means nothing.
 */
function donchian_(candles, period) {
  const upper = new Array(candles.length).fill(null);
  const lower = new Array(candles.length).fill(null);

  for (let i = period; i < candles.length; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let j = i - period; j < i; j++) {
      if (candles[j].h > hi) hi = candles[j].h;
      if (candles[j].l < lo) lo = candles[j].l;
    }
    upper[i] = hi;
    lower[i] = lo;
  }
  return { upper: upper, lower: lower };
}

/** Simple percent change between two prices. */
function pctChange_(from, to) {
  return ((to - from) / from) * 100;
}

/** Max peak-to-trough drop of an equity curve, as a positive percentage. */
function maxDrawdownPct_(equity) {
  let peak = -Infinity, worst = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    const dd = ((peak - v) / peak) * 100;
    if (dd > worst) worst = dd;
  }
  return worst;
}

/** Annualised realised volatility from closes, for the regime brief. */
function realisedVolPct_(candles, lookback) {
  const n = Math.min(lookback, candles.length - 1);
  const rets = [];
  for (let i = candles.length - n; i < candles.length; i++) {
    rets.push(Math.log(candles[i].c / candles[i - 1].c));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varc = rets.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / (rets.length - 1);
  const barsPerYear = (365 * 24 * 60) / CONFIG.MARKET.intervalMinutes;
  return Math.sqrt(varc) * Math.sqrt(barsPerYear) * 100;
}