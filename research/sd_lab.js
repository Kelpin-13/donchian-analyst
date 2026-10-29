/**
 * Supply-and-demand lab: the rule-based zone methods found in public sources, tested on gold intraday with
 * the research engine (research/intraday.js) on 1-minute bars, so the order of prices inside a bar is known.
 *
 *   node research/sd_lab.js                 design half only (2023-2024): pick candidates here
 *   node research/sd_lab.js --reveal 3,17   also the unseen half (2025-2026) and stressed costs for those rows
 *   node research/sd_lab.js --round2        round 2 (below), same options
 *
 * Zone families (each from a public description, rules fixed before testing):
 * - Classic base zones (Sam Seiden style, as research/supply_demand.js): 1-4 quiet candles, then an explosive
 *   leg away. Strict = leg >= 1.5 ATR(14), body >= 60%; relaxed = leg >= 1.0 ATR, body >= 50%.
 * - Order blocks (smart-money concepts; LuxAlgo / openalgo "Smart Money Radar" / joshyattridge smc): a swing
 *   high or low is a pivot with 3 candles each side; a close through the last swing is a break of structure,
 *   and the last opposite-coloured candle in the 50 before it is the block (its high to its low).
 * - Fair value gaps (fmzquant "Dynamic FVG intraday"): candle 3's low above candle 1's high with candle 2
 *   closing above it (bullish), or the mirror image; the gap between them is the zone.
 * Entries (from the same sources and dukascopy / fxnx write-ups), on the first return to a zone only:
 * - limit:   a limit order at the zone's near edge, stop beyond the far edge (0.1 ATR beyond for base zones and
 *            order blocks, at the edge for gaps, as the source does).
 * - confirm: the 15-minute candle that touches the zone must close back out of it in the zone's direction
 *            (a rejection candle); buy or sell at the next open, stop beyond the far edge.
 * - shift:   after the touch, wait up to 8 fifteen-minute candles for a close beyond the highest high (demand)
 *            or lowest low (supply) of the 3 candles before it, a small change of character; enter at the next
 *            open, stop 0.1 ATR(M15) beyond the extreme made since the touch. A close through the far edge first
 *            kills the zone.
 * All: 2R target, entries 01:00-20:00 server time, flat at 23:00 like the EA, at most 3 trades a day; each
 * family alone and with the H4 trend filter (only the side of the H4 EMA-100 trend).
 *
 * Protocol, fixed before the first run: candidates are chosen on the design half only. A candidate passes only
 * if, at real costs, PF > 1.1 in both halves, t > 2, every calendar year is positive and total R is at least
 * twice the worst drawdown; and PF > 1 at stressed costs. The unseen half is looked at once, for the finalists.
 * Research only.
 *
 * Results (30 Oct 2026, M1 2023-01-03 to 2026-10-29): NOTHING PASSES. Round 1 (48 versions, design half):
 * fair value gaps lose heavily (M15 limit -1,120R: stops of a few dollars are eaten by the spread), classic
 * zones on H1 lose, on H4 about break-even; the only t > 2 was #19, order blocks H4, limit + H4 trend (108
 * trades, PF 1.58, +27R, both years positive) - about what the best of 48 tries gives by luck. Its neighbours
 * (pivot 2-5, target 1.5-3R, buffer 0-0.5 ATR, age 10-40 days) mostly stayed positive (PF 1.0-1.58) and
 * without the trend filter it fell to PF 1.10. Revealed once: 2025-2026 95 trades, PF 0.99, -1R -> FAIL.
 * Round 2 (7 versions, below): none reaches t > 2 in the design half, so none was revealed. The morning map
 * (Morning.js) shows H4 order blocks as a map and says they are not signals.
 */
const { load } = require('./daytrade.js');
const { backtest, h4Trend, withTrend, stats, atr, COSTS, SPLIT } = require('./intraday.js');
const { candles } = require('./supply_demand.js');

const DAY = 86400000, M15 = 15 * 60000, H1 = 3600000, H4 = 4 * H1;
const mod = t => { const d = new Date(t); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const hm = (h, m) => h * 60 + (m || 0);

/* ---------------- zone finders: [{ side, near, far, unit, formed }] on candles c ---------------- */
// formed = the M1 index the pattern's last candle closes on; the zone goes live on the next M1 bar.

function classicZones(c, legK, bodyK) {
  const a = atr(c, 14), zones = [];
  const quiet = k => k.h > k.l && Math.abs(k.c - k.o) <= 0.5 * (k.h - k.l);
  for (let j = 5; j < c.length; j++) {
    const unit = a[j - 1], k = c[j], range = k.h - k.l;
    if (!unit || range < legK * unit || Math.abs(k.c - k.o) < bodyK * range) continue;
    let base = null;
    for (let n = 1; n <= 4; n++) {
      const run = c.slice(j - n, j);
      if (!run.every(quiet)) break;
      const hi = Math.max(...run.map(x => x.h)), lo = Math.min(...run.map(x => x.l));
      if (hi - lo > unit) break;
      base = { run, hi, lo };
    }
    if (!base) continue;
    if (k.c > k.o && k.c > base.hi && k.l >= base.lo) {
      const near = Math.max(...base.run.map(x => Math.max(x.o, x.c)));
      if (near > base.lo) zones.push({ side: 1, near, far: base.lo, unit, formed: k.last });
    } else if (k.c < k.o && k.c < base.lo && k.h <= base.hi) {
      const near = Math.min(...base.run.map(x => Math.min(x.o, x.c)));
      if (near < base.hi) zones.push({ side: -1, near, far: base.hi, unit, formed: k.last });
    }
  }
  return zones;
}

function orderBlocks(c, pivot, lookback) {
  const a = atr(c, 14), zones = [];
  let sh = null, sl = null;                                   // the last swing high / low not yet broken
  for (let j = 2 * pivot; j < c.length; j++) {
    const p = j - pivot;                                      // a pivot is confirmed `pivot` candles later
    let isHigh = true, isLow = true;
    for (let q = p - pivot; q <= j; q++) {
      if (q === p) continue;
      if (c[q].h >= c[p].h) isHigh = false;
      if (c[q].l <= c[p].l) isLow = false;
    }
    if (isHigh) sh = { level: c[p].h, at: p };
    if (isLow) sl = { level: c[p].l, at: p };
    const k = c[j], unit = a[j - 1];
    if (!unit) continue;
    if (sh && k.c > sh.level) {
      for (let q = j - 1; q >= Math.max(0, j - lookback); q--) {
        if (c[q].c < c[q].o) { zones.push({ side: 1, near: c[q].h, far: c[q].l, unit, formed: k.last }); break; }
      }
      sh = null;
    }
    if (sl && k.c < sl.level) {
      for (let q = j - 1; q >= Math.max(0, j - lookback); q--) {
        if (c[q].c > c[q].o) { zones.push({ side: -1, near: c[q].l, far: c[q].h, unit, formed: k.last }); break; }
      }
      sl = null;
    }
  }
  return zones;
}

function fairValueGaps(c, minK) {
  const a = atr(c, 14), zones = [];
  for (let j = 2; j < c.length; j++) {
    const unit = a[j - 1];
    if (!unit) continue;
    const k = c[j], m = c[j - 1], f = c[j - 2];
    if (k.l > f.h && m.c > f.h && k.l - f.h >= minK * unit) zones.push({ side: 1, near: k.l, far: f.h, unit, formed: k.last });
    if (k.h < f.l && m.c < f.l && f.l - k.h >= minK * unit) zones.push({ side: -1, near: k.h, far: f.l, unit, formed: k.last });
  }
  return zones;
}

/* ---------------- one strategy for the engine ---------------- */
// o: { name, entry: 'limit' | 'confirm' | 'shift', targetR, maxAgeDays, buffer (x the zone's ATR), from, until }
function zoneLab(bars, m15, m15Of, m15Atr, zones, o) {
  const Z = zones.slice().sort((x, y) => x.formed - y.formed)
    .map(z => Object.assign({}, z, { from: z.formed + 1, untilT: bars[z.formed].t + o.maxAgeDays * DAY, buf: o.buffer * z.unit }));
  const first = o.from === undefined ? hm(1) : o.from, last = o.until === undefined ? hm(20) : o.until;
  let next = 0, active = [], watch = [];
  return {
    name: o.name, flatMin: hm(23), maxPerDay: 3,
    onDay(i) { if (i === 0) { next = 0; active = []; watch = []; } return {}; },
    onClose(i) {
      const k = bars[i], m = mod(k.t), inWindow = m >= first && m < last;
      const touched = z => (z.side === 1 ? k.l + k.sp <= z.near : k.h >= z.near);
      if (o.entry === 'limit') {
        active = active.filter(z => !touched(z) && k.t < z.untilT);
        while (next < Z.length && Z[next].from <= i + 1) active.push(Z[next++]);
        if (!inWindow) return { orders: [] };
        return { orders: active.map(z => ({ side: z.side, level: z.near, stop: z.far - z.side * z.buf, targetR: o.targetR, until: last, limit: true })) };
      }
      // confirm / shift: a touch moves the zone to the watch list; decisions on 15-minute closes
      const J = m15Of[i];
      active = active.filter(z => {
        if (k.t >= z.untilT) return false;
        if (!touched(z)) return true;
        watch.push({ z, touchJ: J, ext: z.side === 1 ? k.l : k.h });
        return false;
      });
      while (next < Z.length && Z[next].from <= i + 1) active.push(Z[next++]);
      if (m15[J].last !== i) return null;
      const cd = m15[J];
      let enter = null;
      watch = watch.filter(w => {
        const z = w.z, s = z.side, dead = z.far - s * z.buf;
        w.ext = s === 1 ? Math.min(w.ext, cd.l) : Math.max(w.ext, cd.h);
        if (o.entry === 'confirm') {
          const ok = (s === 1 ? cd.c > z.near && cd.c > cd.o && cd.l > dead : cd.c < z.near && cd.c < cd.o && cd.h < dead);
          if (ok && inWindow && !enter) enter = { side: s, stop: dead, targetR: o.targetR };
          return false;                                        // first touch only
        }
        if (s === 1 ? cd.c < dead : cd.c > dead) return false;   // closed through the far edge: zone dead
        if (J > w.touchJ && J >= 3) {
          const prev = m15.slice(J - 3, J), lvl = s === 1 ? Math.max(...prev.map(x => x.h)) : Math.min(...prev.map(x => x.l));
          if (s === 1 ? cd.c > lvl : cd.c < lvl) {
            if (inWindow && !enter) enter = { side: s, stop: w.ext - s * 0.1 * (m15Atr[J] || 0), targetR: o.targetR };
            return false;
          }
        }
        return J - w.touchJ < 8;
      });
      return enter ? { enter } : null;
    }
  };
}

/* ---------------- the grid ---------------- */
function grid(bars) {
  const c15 = candles(bars, M15), c1 = candles(bars, H1), c4 = candles(bars, H4);
  const m15Of = new Int32Array(bars.length);
  c15.forEach((x, j) => { for (let i = j ? c15[j - 1].last + 1 : 0; i <= x.last; i++) m15Of[i] = j; });
  const m15Atr = atr(c15, 14), trend = h4Trend(bars);
  const families = [
    ['Base zones H4 strict', classicZones(c4, 1.5, 0.6), 20, 0.1],
    ['Base zones H4 relaxed', classicZones(c4, 1.0, 0.5), 20, 0.1],
    ['Base zones H1 relaxed', classicZones(c1, 1.0, 0.5), 10, 0.1],
    ['Order blocks H4', orderBlocks(c4, 3, 50), 20, 0.1],
    ['Order blocks H1', orderBlocks(c1, 3, 50), 10, 0.1],
    ['Fair value gaps H1', fairValueGaps(c1, 0), 5, 0],
    ['Fair value gaps H1 >= 0.3 ATR', fairValueGaps(c1, 0.3), 5, 0],
    ['Fair value gaps M15', fairValueGaps(c15, 0), 2, 0]
  ];
  const S = [];
  families.forEach(([fam, zones, age, buffer]) => ['limit', 'confirm', 'shift'].forEach(entry => {
    const s = zoneLab(bars, c15, m15Of, m15Atr, zones, { name: fam + ', ' + entry, entry, targetR: 2, maxAgeDays: age, buffer });
    s.zoneCount = zones.length;
    S.push(s, Object.assign(withTrend(s, trend), { zoneCount: zones.length }));
  }));
  return { S, families, ctx: { c15, m15Of, m15Atr, trend } };
}

/*
 * Round 2, fixed after round 1 and before running it. Round 1's only design-half t > 2 (order blocks H4, limit,
 * + H4 trend: 108 trades, PF 1.58, +27R) failed its single look at 2025-2026 (95 trades, PF 0.99, -1R). Ideas from
 * the same sources not yet tried, with the same protocol:
 * - session: that strategy, entries only 09:00-20:00 server (London and New York; fxnx's "golden hours").
 * - displacement: only order blocks whose move to the break left a fair value gap (trendspider / LuxAlgo:
 *   an order block with an imbalance is the stronger one).
 * - structure trend: direction from the 4-hour swing structure (the side of the last break of structure) instead
 *   of the EMA, for 4-hour and 1-hour order blocks (LuxAlgo: swing structure for bias, internal for entries).
 * - liquidity sweep (fxnx: gold runs the stops beyond obvious swings before the real move): a 15-minute candle
 *   that trades through the last confirmed 4-hour swing low and closes back above it is a buy at the next open,
 *   stop 0.1 ATR(M15) under its low, 2R (mirror for swing highs); each swing once; alone, with the EMA trend and
 *   with the structure trend.
 */

/** The 4-hour swing structure per M1 bar: +1 after a close above the last swing high, -1 after one below the last swing low. */
function structureTrend(bars, c, pivot) {
  const out = new Int8Array(bars.length);
  let sh = null, sl = null, dir = 0, from = 0;
  for (let j = 0; j < c.length; j++) {
    for (let i = from; i <= c[j].last; i++) out[i] = dir;        // bars inside candle j know only the closed ones
    from = c[j].last + 1;
    const p = j - pivot;
    if (p - pivot >= 0) {
      let isHigh = true, isLow = true;
      for (let q = p - pivot; q <= j; q++) {
        if (q === p) continue;
        if (c[q].h >= c[p].h) isHigh = false;
        if (c[q].l <= c[p].l) isLow = false;
      }
      if (isHigh) sh = c[p].h;
      if (isLow) sl = c[p].l;
    }
    if (sh !== null && c[j].c > sh) { dir = 1; sh = null; }
    if (sl !== null && c[j].c < sl) { dir = -1; sl = null; }
  }
  return out;
}

/** Order blocks whose move to the break of structure left a fair value gap. */
function displacedBlocks(c, pivot, lookback) {
  const zones = orderBlocks(c, pivot, lookback), at = new Map(c.map((k, j) => [k.last, j]));
  return zones.filter(z => {
    const j = at.get(z.formed);
    for (let m = j; m >= Math.max(2, j - lookback); m--) {
      if (z.side === 1 ? c[m].l > c[m - 2].h : c[m].h < c[m - 2].l) return true;
      if (z.side === 1 ? (c[m].c < c[m].o && c[m].h === z.near) : (c[m].c > c[m].o && c[m].l === z.near)) break;   // back at the block
    }
    return false;
  });
}

/** Liquidity sweep of the last confirmed 4-hour swing, traded on 15-minute closes. */
function sweepStrategy(bars, c4, m15, m15Of, m15Atr, pivot, name) {
  const swings = [];                                              // { side: 1 = swing low (buy its sweep), level, live (M1 index) }
  for (let j = 2 * pivot; j < c4.length; j++) {
    const p = j - pivot;
    let isHigh = true, isLow = true;
    for (let q = p - pivot; q <= j; q++) {
      if (q === p) continue;
      if (c4[q].h >= c4[p].h) isHigh = false;
      if (c4[q].l <= c4[p].l) isLow = false;
    }
    if (isLow) swings.push({ side: 1, level: c4[p].l, live: c4[j].last + 1 });
    if (isHigh) swings.push({ side: -1, level: c4[p].h, live: c4[j].last + 1 });
  }
  let next = 0, low = null, high = null;
  return {
    name, flatMin: hm(23), maxPerDay: 3,
    onDay(i) { if (i === 0) { next = 0; low = null; high = null; } return {}; },
    onClose(i) {
      while (next < swings.length && swings[next].live <= i + 1) { const s = swings[next++]; if (s.side === 1) low = s; else high = s; }
      const J = m15Of[i];
      if (m15[J].last !== i) return null;
      const cd = m15[J], m = mod(bars[i].t), unit = m15Atr[J] || 0;
      if (m < hm(1) || m >= hm(20)) return null;
      if (low && cd.l < low.level) {
        const ok = cd.c > low.level; low = null;
        if (ok) return { enter: { side: 1, stop: cd.l - 0.1 * unit, targetR: 2 } };
      }
      if (high && cd.h > high.level) {
        const ok = cd.c < high.level; high = null;
        if (ok) return { enter: { side: -1, stop: cd.h + 0.1 * unit, targetR: 2 } };
      }
      return null;
    }
  };
}

function grid2(bars) {
  const c15 = candles(bars, M15), c1 = candles(bars, H1), c4 = candles(bars, H4);
  const m15Of = new Int32Array(bars.length);
  c15.forEach((x, j) => { for (let i = j ? c15[j - 1].last + 1 : 0; i <= x.last; i++) m15Of[i] = j; });
  const m15Atr = atr(c15, 14), ema = h4Trend(bars), structure = structureTrend(bars, c4, 3);
  const lab = (zones, o) => zoneLab(bars, c15, m15Of, m15Atr, zones, Object.assign({ entry: 'limit', targetR: 2, buffer: 0.1 }, o));
  const ob4 = orderBlocks(c4, 3, 50), ob1 = orderBlocks(c1, 3, 50);
  const named = (s, name) => Object.assign(s, { name });
  const sweep = sweepStrategy(bars, c4, c15, m15Of, m15Atr, 3, 'Liquidity sweep of H4 swings');
  return [
    named(withTrend(lab(ob4, { maxAgeDays: 20, from: hm(9) }), ema), 'Order blocks H4, limit + H4 trend, 09:00-20:00 only'),
    named(withTrend(lab(displacedBlocks(c4, 3, 50), { maxAgeDays: 20 }), ema), 'Order blocks H4 with displacement, limit + H4 trend'),
    named(withTrend(lab(ob4, { maxAgeDays: 20 }), structure), 'Order blocks H4, limit + H4 structure'),
    named(withTrend(lab(ob1, { maxAgeDays: 10 }), structure), 'Order blocks H1, limit + H4 structure'),
    sweep,
    named(withTrend(sweep, ema), 'Liquidity sweep of H4 swings + H4 trend'),
    named(withTrend(sweep, structure), 'Liquidity sweep of H4 swings + H4 structure')
  ];
}

module.exports = { classicZones, orderBlocks, fairValueGaps, zoneLab, grid, structureTrend, displacedBlocks, sweepStrategy, grid2 };

if (require.main === module) {
  const bars = load('XAUUSD.sml_M1.csv');
  const at = process.argv.indexOf('--reveal');
  const reveal = at === -1 ? [] : process.argv[at + 1].split(',').map(Number);
  const f = (v, d) => (v === undefined || v === null || !isFinite(v)) ? '-' : v.toFixed(d === undefined ? 2 : d);
  const year = y => t => new Date(t.t).getUTCFullYear() === y;
  const { S, families } = process.argv.includes('--round2') ? { S: grid2(bars), families: [] } : grid(bars);
  console.log('Gold M1 ' + new Date(bars[0].t).toISOString().slice(0, 10) + ' to ' + new Date(bars[bars.length - 1].t).toISOString().slice(0, 10) +
              '. Design half 2023-2024 shown; the unseen half 2025-2026 only for --reveal rows. Real costs.');
  families.forEach(([fam, zones]) => console.log('  ' + fam.padEnd(30) + zones.length + ' zones'));
  console.log('\n #  strategy'.padEnd(58) + ' design: trades win%   PF  avgR     t totalR  ddR | 2023  2024');
  S.forEach((s, n) => {
    const tr = backtest(bars, s, COSTS.real), a = stats(tr.filter(t => t.t < SPLIT), 1);
    const yr = [2023, 2024].map(y => f(tr.filter(year(y)).reduce((x, t) => x + t.r, 0), 0).padStart(6)).join('');
    console.log(String(n).padStart(2) + '  ' + s.name.slice(0, 54).padEnd(54) + String(a.n).padStart(8) + f(a.win, 0).padStart(5) + f(a.pf).padStart(6) +
                f(a.avgR, 3).padStart(7) + f(a.t, 1).padStart(6) + f(a.totalR, 0).padStart(7) + f(a.ddR, 0).padStart(5) + ' |' + yr);
    if (reveal.includes(n)) {
      const b = stats(tr.filter(t => t.t >= SPLIT), 1), all = stats(tr, 1), st = stats(backtest(bars, s, COSTS.stressed), 1);
      const yrs = [2023, 2024, 2025, 2026].map(y => tr.filter(year(y)).reduce((x, t) => x + t.r, 0));
      const pass = a.pf > 1.1 && b.pf > 1.1 && all.t > 2 && yrs.every(r => r > 0) && all.totalR >= 2 * all.ddR && st.pf > 1;
      console.log('      unseen: ' + b.n + ' trades, PF ' + f(b.pf) + ', ' + f(b.totalR, 0) + 'R | all: PF ' + f(all.pf) + ', t ' + f(all.t, 1) +
                  ', ' + f(all.totalR, 0) + 'R, worst drawdown ' + f(all.ddR, 0) + 'R | years ' + yrs.map(r => f(r, 0)).join(' / ') +
                  ' | stressed PF ' + f(st.pf) + ' -> ' + (pass ? 'PASS' : 'fail'));
    }
  });
}
