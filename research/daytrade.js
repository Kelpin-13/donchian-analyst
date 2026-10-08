/**
 * Day-trading research on the broker's own gold data (MT5 export in data/).
 *
 *   node research/daytrade.js
 *
 * Same Donchian rules as Strategy.js (channels exclude the current bar, EMA trend
 * filter, ATR stop checked on the close, decisions on closed bars, fills at the
 * next bar's open), plus what day trading needs:
 *   - shorts: the mirror image (close below the N-bar low while below the EMA,
 *     stop above, exit on a close above the M-bar high)
 *   - session: no entries in the first hour or after 22:00 server time; every
 *     position closed at the 23:00 bar's open, an hour before the rollover, so
 *     no swap is ever paid
 *   - costs as charged: MT5 bars are Bid prices. Buys fill at Ask = Bid + that
 *     bar's spread, sells at Bid; plus extra slippage per side.
 *
 * Results are in R (P&L ÷ the risk taken), which doesn't depend on leverage.
 * This is research only: nothing here trades.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ctx = { Math, Number, Array, Object, JSON, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'Indicator.js'), 'utf8'), ctx);   // ema_, atr_, donchian_

const POINT = 0.001;            // XAUUSD.sml: 3 digits
const SLIP = 0.0001;            // extra slippage per side, fraction of price (0.01%)

/** MT5 "Export Bars" file → candles. Times stay on the server clock (as if UTC). */
function load(file) {
  return fs.readFileSync(path.join(ROOT, 'data', file), 'utf8').trim().split(/\r?\n/).slice(1).map(line => {
    const [d, t, o, h, l, c, tv, , sp] = line.split('\t');
    return { t: Date.parse(d.replace(/\./g, '-') + 'T' + t + 'Z'), o: +o, h: +h, l: +l, c: +c, v: +tv, sp: +sp * POINT };
  });
}

const minuteOfDay = t => { const d = new Date(t); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const dayOf = t => Math.floor(t / 86400000);

/**
 * One run. cfg: { dir: 'long'|'short'|'both', N, M, k, ema, maxBars, barMin,
 * firstEntryMin, lastEntryMin, flatMin, from, to }.
 */
function simulate(bars, cfg, ser) {
  const s = ser || series(bars, cfg);
  const trades = [];
  let pos = null, pending = null;
  for (let i = 1; i < bars.length; i++) {
    const k = bars[i];
    if (k.t >= cfg.to) { if (pos) close(pos, k, 'WINDOW_END'); pos = null; break; }   // count it, don't drop it
    if (k.t < cfg.from) continue;
    // Forced session exit: anything still open at the flat time (or carried into a new day) closes at this open.
    if (pos && cfg.flat !== false && (minuteOfDay(k.t) >= cfg.flatMin || dayOf(k.t) !== dayOf(pos.t))) {
      close(pos, k, 'SESSION'); pos = null; pending = null;
    }
    // Holding overnight: one swap per server-midnight rollover (MT5 "Swap rates": Mon-Fri x1, no triple day).
    if (pos && cfg.flat === false && dayOf(k.t) !== dayOf(bars[i - 1].t)) {
      const rate = pos.side === 1 ? cfg.swapLong : cfg.swapShort;          // % per year, of price
      pos.swap += bars[i - 1].c * rate / 100 / 360;                         // per unit
    }
    if (pending) {                              // fill yesterday's-close decisions at this open
      if (pending.type === 'EXIT' && pos) { close(pos, k, pending.why); pos = null; }
      else if (pending.type !== 'EXIT' && !pos) pos = open(pending, k);
      pending = null;
    }
    if (pos) pos.bars++;
    const up = s.entry.upper[i], lo = s.entry.lower[i], xu = s.exit.upper[i], xl = s.exit.lower[i];
    const e = s.ema[i], a = s.atr[i];
    if (up === null || lo === null || xu === null || xl === null || e === null || a === null) continue;
    const closeMin = minuteOfDay(k.t) + cfg.barMin;
    if (!pos) {
      const inSession = closeMin >= cfg.firstEntryMin && closeMin <= cfg.lastEntryMin;
      if (!inSession) continue;
      if (cfg.dir !== 'short' && k.c > up && k.c > e) pending = { type: 'LONG', stopDist: cfg.k * a };
      else if (cfg.dir !== 'long' && k.c < lo && k.c < e) pending = { type: 'SHORT', stopDist: cfg.k * a };
    } else if (pos.side === 1) {
      if (k.c <= pos.stop) pending = { type: 'EXIT', why: 'STOP' };
      else if (k.c < xl) pending = { type: 'EXIT', why: 'CHANNEL' };
      else if (pos.bars >= cfg.maxBars) pending = { type: 'EXIT', why: 'TIME' };
    } else {
      if (k.c >= pos.stop) pending = { type: 'EXIT', why: 'STOP' };
      else if (k.c > xu) pending = { type: 'EXIT', why: 'CHANNEL' };
      else if (pos.bars >= cfg.maxBars) pending = { type: 'EXIT', why: 'TIME' };
    }
  }
  return trades;

  function open(sig, k) {
    const side = sig.type === 'LONG' ? 1 : -1;
    // Buy at Ask (Bid + spread), sell at Bid; slippage against us either way.
    const fill = side === 1 ? (k.o + k.sp) * (1 + SLIP) : k.o * (1 - SLIP);
    return { side, t: k.t, entry: fill, stop: fill - side * sig.stopDist, risk: sig.stopDist, bars: 0, spreadIn: k.sp, swap: 0 };
  }
  function close(p, k, why) {
    const fill = p.side === 1 ? k.o * (1 - SLIP) : (k.o + k.sp) * (1 + SLIP);
    const pnl = (fill - p.entry) * p.side + p.swap;     // per unit, swap included
    trades.push({ t: p.t, exitT: k.t, side: p.side, r: pnl / p.risk, why, bars: p.bars,
                  costR: ((p.side === 1 ? p.spreadIn : k.sp) + p.entry * SLIP * 2) / p.risk });
  }
}

function series(bars, cfg) {
  return {
    ema: ctx.ema_(bars.map(b => b.c), cfg.ema),
    atr: ctx.atr_(bars, 14),
    entry: ctx.donchian_(bars, cfg.N),
    exit: ctx.donchian_(bars, cfg.M)
  };
}

function stats(trades, weeks) {
  const n = trades.length;
  if (!n) return { n: 0 };
  const wins = trades.filter(t => t.r > 0), losses = trades.filter(t => t.r <= 0);
  const gw = wins.reduce((a, t) => a + t.r, 0), gl = -losses.reduce((a, t) => a + t.r, 0);
  let cum = 0, peak = 0, dd = 0;
  trades.forEach(t => { cum += t.r; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); });
  return { n, perWeek: n / weeks, win: wins.length / n * 100, pf: gl ? gw / gl : Infinity, avgR: cum / n,
           totalR: cum, ddR: dd, costR: trades.reduce((a, t) => a + t.costR, 0) / n,
           longs: trades.filter(t => t.side === 1).length };
}

/** Walk-forward on R: tune N and k on 12 months, trade the next 4, step 4. */
function walkForward(bars, base, grid) {
  const M = 30.44 * 86400000;
  const first = bars[0].t + 2 * M, last = bars[bars.length - 1].t;      // 2 months of warm-up
  const folds = [];
  const cache = {};
  const ser = c => cache[c.N + '|' + c.M] || (cache[c.N + '|' + c.M] = series(bars, c));
  for (let trainStart = first; trainStart + 16 * M <= last; trainStart += 4 * M) {
    const trainEnd = trainStart + 12 * M, testEnd = trainEnd + 4 * M;
    let best = null;
    grid.forEach(g => {
      const c = Object.assign({}, base, g, { from: trainStart, to: trainEnd });
      const st = stats(simulate(bars, c, ser(c)), 52);
      if (st.n < 30) return;
      const score = st.totalR / Math.max(st.ddR, 1);
      if (!best || score > best.score) best = { g, st, score };
    });
    const test = (g) => stats(simulate(bars, Object.assign({}, base, g, { from: trainEnd, to: testEnd }),
                                       ser(Object.assign({}, base, g))), 17.4);
    const fixed = test({});
    const chosen = best ? test(best.g) : fixed;
    folds.push({ test: new Date(trainEnd).toISOString().slice(0, 10) + ' → ' + new Date(testEnd).toISOString().slice(0, 10),
                 chosen: best ? 'N' + best.g.N + ' k' + best.g.k : 'default',
                 trainR: best ? best.st.totalR / 52 : null, fixedR: fixed.totalR || 0, chosenR: chosen.totalR || 0,
                 fixedN: fixed.n || 0, chosenN: chosen.n || 0 });
  }
  const sum = (a, f) => a.reduce((x, y) => x + f(y), 0);
  const isRate = sum(folds.filter(f => f.trainR !== null), f => f.trainR) / Math.max(1, folds.filter(f => f.trainR !== null).length);
  const oosRate = sum(folds, f => f.chosenR / 17.4) / Math.max(1, folds.length);
  return { folds, fixedR: sum(folds, f => f.fixedR), chosenR: sum(folds, f => f.chosenR),
           fixedTrades: sum(folds, f => f.fixedN), wfe: isRate ? oosRate / isRate * 100 : null,
           positiveFolds: folds.filter(f => f.fixedR > 0).length };
}

/* ------------------------------------------------------------------ */
if (require.main === module) {
  const f2 = (v, d) => (v === undefined || v === null || !isFinite(v)) ? '—' : v.toFixed(d === undefined ? 2 : d);
  const sets = [
    { name: 'M15', file: 'XAUUSD.sml_M15.csv', barMin: 15 },
    { name: 'H1',  file: 'XAUUSD.sml_H1.csv',  barMin: 60 }
  ];
  const years = [[2023, 'Y2023'], [2024, 'Y2024'], [2025, 'Y2025'], [2026, '2026 (to Oct)']];
  sets.push({ name: 'H4 (hold overnight, pays swap: your proven 4h rules)', file: 'XAUUSD.sml_H1.csv', barMin: 240, h4: true });
  sets.forEach(S => {
    const bars = S.h4 ? toH4(load(S.file)) : load(S.file);
    const weeks = (bars[bars.length - 1].t - bars[0].t) / (7 * 86400000);
    console.log('\n=== ' + S.name + ': ' + bars.length + ' bars, ' + new Date(bars[0].t).toISOString().slice(0, 10) + ' → ' +
                new Date(bars[bars.length - 1].t).toISOString().slice(0, 10) + ', median spread $' +
                f2(bars.map(b => b.sp).sort((a, b) => a - b)[bars.length >> 1], 3));
    const base = S.h4
      ? { N: 20, M: 10, k: 2, ema: 100, maxBars: 60, barMin: 240, flat: false, swapLong: -5.92, swapShort: 3.67,
          firstEntryMin: 0, lastEntryMin: 24 * 60, flatMin: Infinity, from: -Infinity, to: Infinity }
      : { N: 20, M: 10, k: 2, ema: 100, maxBars: 60, barMin: S.barMin,
          firstEntryMin: 2 * 60, lastEntryMin: 22 * 60, flatMin: 23 * 60, from: -Infinity, to: Infinity };
    console.log(S.h4 ? 'Rules: your default 20/10 breakout, EMA100, 2×ATR stop, held overnight, swap long -5.92%/yr, short +3.67%/yr'
                     : 'Rules: your default 20/10 breakout, EMA100, 2×ATR stop, flat by 23:00 server time');
    console.log('dir    trades  /week  win%   PF    avgR   totalR  maxDD(R)  cost/trade(R) | ' + years.map(y => y[1].padStart(8)).join(' '));
    ['long', 'short', 'both'].forEach(dir => {
      const cfg = Object.assign({}, base, { dir });
      const all = simulate(bars, cfg);
      const st = stats(all, weeks);
      const yr = years.map(([y]) => { const r = all.filter(t => new Date(t.t).getUTCFullYear() === y).reduce((a, t) => a + t.r, 0); return f2(r, 1).padStart(8); });
      console.log(dir.padEnd(6) + String(st.n).padStart(7) + f2(st.perWeek, 1).padStart(7) + f2(st.win, 0).padStart(6) +
                  f2(st.pf).padStart(6) + f2(st.avgR, 3).padStart(8) + f2(st.totalR, 1).padStart(9) + f2(st.ddR, 1).padStart(10) +
                  f2(st.costR, 3).padStart(15) + ' | ' + yr.join(' '));
    });
    console.log('Walk-forward (tune breakout N ∈ {10,20,40,55} and stop k ∈ {1.5,2,3} on 12 months, trade the next 4):');
    const grid = [];
    [10, 20, 40, 55].forEach(N => [1.5, 2, 3].forEach(k => grid.push({ N, M: Math.max(5, Math.round(N / 2)), k })));
    ['long', 'short', 'both'].forEach(dir => {
      const wf = walkForward(bars, Object.assign({}, base, { dir }), grid);
      console.log('  ' + dir.padEnd(6) + 'unseen R, default settings ' + f2(wf.fixedR, 1).padStart(6) + ' (' + wf.fixedTrades + ' trades, ' +
                  wf.positiveFolds + '/' + wf.folds.length + ' folds positive) | re-tuned each fold ' + f2(wf.chosenR, 1).padStart(6) +
                  ' | WFE ' + f2(wf.wfe, 0) + '%');
    });
  });
}

module.exports = { load, simulate, series, stats, walkForward, toH4 };

/** H1 → H4 on the server clock (00, 04, 08 … server time), keeping the bar's lowest spread. */
function toH4(h1) {
  const out = [];
  h1.forEach(b => {
    const bucket = Math.floor(b.t / (4 * 3600000)) * 4 * 3600000;
    const last = out[out.length - 1];
    if (last && last.t === bucket) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v; }
    else out.push({ t: bucket, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, sp: b.sp });
  });
  return out;
}
