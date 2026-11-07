/**
 * Supply and demand zones on gold, intraday: does a rule-based version of the classic zone method earn its
 * keep, alone and next to the six strategies GoldIntraday already trades?
 *
 *   node research/supply_demand.js [--bars XAUUSD.sml_M1.csv]
 *
 * --bars: trade the zones on finer bars (e.g. M1 from mt5/ExportBars.mq5) so the order of prices inside a
 * 15-minute bar is known; zones are still drawn on M15 / H1 candles built from them, over the M15 file's dates.
 *
 * Rules, fixed before testing:
 * - A zone is a "base" of 1-4 quiet candles (body at most half the candle's range; the base no taller than
 *   1 ATR(14) of that timeframe) followed by an explosive candle leaving it (range at least 1.5 x ATR, body at
 *   least 60% of its range, closing beyond the base without trading back past its far side).
 *   Demand: base, then a rally. Zone = base low (far edge) up to the top of the base candles' bodies (near edge).
 *   Supply: base, then a drop. Zone = bottom of the bodies (near edge) up to the base high (far edge).
 * - Trade the FIRST time price comes back: a limit order at the near edge, stop 0.1 ATR beyond the far edge,
 *   target 2R or 3R; entries 01:00-20:00, flat at 23:00 (server time) like the EA's other strategies.
 * - A zone is used up by its first touch, traded or not, and expires after 2 days (M15 zones) or 10 (H1 zones).
 * - Variants: zones from M15 or H1 candles x target 2R or 3R x either side or only the H4 trend's side.
 * Same engine, costs, design/unseen split and pass mark as research/intraday.js. Research only.
 *
 * First run (30 Oct 2026, 2023-01 to 2026-10): no variant passes; all lose in the design half (PF 0.56-0.87),
 * and the best one added to the EA's six strategies cuts 135R to 48R. H1 zones lose even with no costs.
 * M15 zones are undecided: their stops are about $2, so in 38% of their trades the entry bar also touched the
 * stop, which M15 bars cannot order ("same-bar stop" column; the engine assumes the stop came first). With no
 * costs they are about break-even; settling it needs M1 data.
 * Settled on M1 (1.35M bars from mt5/ExportBars.mq5, --bars XAUUSD.sml_M1.csv): unclear same-bar stops fall
 * to ~10%, and every variant still loses in the design half (PF 0.58-0.94; overall 0.84-0.99 with M1 spreads
 * or M15 spreads). Supply and demand zones, as defined here, are not used.
 */
const { load } = require('./daytrade.js');
const { backtest, h4Trend, withTrend, portfolio, stats, threeWeeks, atr, COSTS, SPLIT } = require('./intraday.js');

const DAY = 86400000, M15 = 15 * 60000, HOUR = 3600000;
const dayOf = t => Math.floor(t / DAY);
const mod = t => { const d = new Date(t); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const hm = (h, m) => h * 60 + (m || 0);

/** Candles of `ms` length built from the M15 bars, each with the M15 index it closes on. */
function candles(bars, ms) {
  const out = [];
  bars.forEach((b, i) => {
    const t = Math.floor(b.t / ms) * ms, x = out[out.length - 1];
    if (x && x.t === t) { x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.c = b.c; x.last = i; }
    else out.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, last: i });
  });
  return out;
}

/** Every zone on candles `c`: { side, near, far, buffer, formed (the base bar its leg-out closed on) }. */
function findZones(c) {
  const a = atr(c, 14), zones = [];
  const quiet = k => k.h > k.l && Math.abs(k.c - k.o) <= 0.5 * (k.h - k.l);
  for (let j = 5; j < c.length; j++) {
    const unit = a[j - 1], k = c[j], range = k.h - k.l;
    if (!unit || range < 1.5 * unit || Math.abs(k.c - k.o) < 0.6 * range) continue;
    let base = null;                                       // the longest run of 1-4 quiet candles before it
    for (let n = 1; n <= 4; n++) {
      const run = c.slice(j - n, j);
      if (!run.every(quiet)) break;
      const hi = Math.max(...run.map(x => x.h)), lo = Math.min(...run.map(x => x.l));
      if (hi - lo > unit) break;
      base = { run, hi, lo };
    }
    if (!base) continue;
    const zone = (side, near, far) => zones.push({ side, near, far, buffer: 0.1 * unit, formed: k.last });
    if (k.c > k.o && k.c > base.hi && k.l >= base.lo) {
      const near = Math.max(...base.run.map(x => Math.max(x.o, x.c)));
      if (near > base.lo) zone(1, near, base.lo);
    } else if (k.c < k.o && k.c < base.lo && k.h <= base.hi) {
      const near = Math.min(...base.run.map(x => Math.min(x.o, x.c)));
      if (near < base.hi) zone(-1, near, base.hi);
    }
  }
  return zones;
}

/** The strategy for the engine: each bar, a limit order at every fresh zone's near edge. */
function zoneStrategy(bars, label, ms, maxAgeDays, targetR) {
  // Live from the bar after it formed; expires maxAgeDays x 96 M15 candles later, whatever the base bars are.
  const m15 = candles(bars, M15);
  let j = 0;
  const zones = findZones(candles(bars, ms)).sort((x, y) => x.formed - y.formed).map(z => {
    while (j + 1 < m15.length && m15[j + 1].t <= bars[z.formed].t) j++;
    const end = m15[j + maxAgeDays * 96];
    return Object.assign(z, { from: z.formed + 1, untilT: end ? end.t : Infinity });
  });
  let next = 0, active = [];
  return {
    name: 'Supply/demand zones (' + label + ' candles), first return, ' + targetR + 'R target',
    family: 'supply and demand', group: 'supply and demand ' + label + ' ' + targetR + 'R', zones,
    flatMin: hm(23), maxPerDay: 4,
    onDay(i) { if (i === 0) { next = 0; active = []; } return {}; },
    onClose(i) {
      const k = bars[i], m = mod(k.t);
      // A zone already live is used up when this bar trades into it; one formed now goes live from the next bar.
      active = active.filter(z => !(z.side === 1 ? k.l + k.sp <= z.near : k.h >= z.near) && k.t < z.untilT);
      while (next < zones.length && zones[next].from <= i + 1) active.push(zones[next++]);
      if (m >= hm(20)) return { orders: [] };
      return { orders: active.map(z => ({ side: z.side, level: z.near, stop: z.far - z.side * z.buffer, targetR, until: hm(20), limit: true })) };
    }
  };
}

if (require.main === module) {
  const m15 = load('XAUUSD.sml_M15.csv');
  const barsAt = process.argv.indexOf('--bars'), barFile = barsAt === -1 ? 'XAUUSD.sml_M15.csv' : process.argv[barsAt + 1];
  const bars = barsAt === -1 ? m15 : load(barFile).filter(b => b.t >= m15[0].t && b.t < m15[m15.length - 1].t + M15);
  // --m15-spread: charge each finer bar its M15 bar's spread, so a run differs from the M15 one only in the
  // order of prices inside each 15 minutes (MT5's M15 spread is narrower than its M1 spreads on average).
  if (process.argv.includes('--m15-spread')) {
    const sp = new Map(m15.map(b => [b.t, b.sp]));
    bars.forEach(b => { const s = sp.get(Math.floor(b.t / M15) * M15); if (s !== undefined) b.sp = s; });
  }
  const f = (v, d) => (v === undefined || v === null || !isFinite(v)) ? '-' : v.toFixed(d === undefined ? 2 : d);
  const t0 = bars[0].t, t1 = bars[bars.length - 1].t, weeks = (t1 - t0) / (7 * DAY);
  const trend = h4Trend(bars);
  const base = [['M15', M15, 2], ['H1', HOUR, 10]].flatMap(([label, ms, age]) => [2, 3].map(R => zoneStrategy(bars, label, ms, age, R)));
  const S = base.concat(base.map(s => Object.assign(withTrend(s, trend), { group: s.group })));

  console.log(barFile + ' (OANDA gold), ' + new Date(t0).toISOString().slice(0, 10) + ' to ' + new Date(t1).toISOString().slice(0, 10) +
              '. Design 2023-2024 | unseen 2025-2026. R = P&L / risk; DD% at 0.5% risk a trade.');
  base.filter((s, i) => i % 2 === 0).forEach(s => {
    const z = s.zones;
    console.log('Zones found on ' + s.name.match(/\((\w+) candles/)[1] + ' candles: ' + z.length + ' (' + f(z.length / weeks, 1) + ' a week; ' +
                z.filter(x => x.side === 1).length + ' demand, ' + z.filter(x => x.side === -1).length + ' supply), median zone height $' +
                f(z.map(x => Math.abs(x.near - x.far)).sort((a, b) => a - b)[z.length >> 1]));
  });

  const rows = [];
  ['real', 'stressed'].forEach(cname => {
    console.log('\n=== Costs: ' + cname + (cname === 'real' ? ' (bar spread + $0.05 a side)' : ' (bar spread + 0.01% of price a side)'));
    console.log('strategy'.padEnd(72) + ' trades /wk win%   PF  avgR     t totalR  ddR | design R  PF | unseen R  PF | stop $ same-bar stop | 2023 2024 2025 2026');
    S.forEach(s => {
      const tr = backtest(bars, s, COSTS[cname]);
      const all = stats(tr, weeks), a = stats(tr.filter(t => t.t < SPLIT), 1), b = stats(tr.filter(t => t.t >= SPLIT), 1);
      const risk = tr.map(t => t.risk).sort((x, y) => x - y)[tr.length >> 1];
      const sameBar = tr.filter(t => t.exitT === t.t && t.why === 'STOP').length / tr.length * 100;
      const yr = [2023, 2024, 2025, 2026].map(y => f(tr.filter(t => new Date(t.t).getUTCFullYear() === y).reduce((x, t) => x + t.r, 0), 0).padStart(5));
      console.log(s.name.slice(0, 72).padEnd(72) + String(all.n).padStart(7) + f(all.perWeek, 1).padStart(4) + f(all.win, 0).padStart(5) +
                  f(all.pf).padStart(6) + f(all.avgR, 3).padStart(7) + f(all.t, 1).padStart(6) + f(all.totalR, 0).padStart(7) +
                  f(all.ddR, 0).padStart(5) + ' | ' + f(a.totalR, 0).padStart(8) + f(a.pf).padStart(5) + ' | ' + f(b.totalR, 0).padStart(8) +
                  f(b.pf).padStart(5) + ' | ' + f(risk).padStart(6) + f(sameBar, 0).padStart(13) + '% |' + yr.join(''));
      rows.push({ s, cname, tr, all, a, b });
    });
  });

  console.log('\nPass mark (as research/intraday.js): PF > 1.1 in the design AND the unseen half at real costs, t-stat > 2, PF > 1 at stressed costs.');
  const passed = S.filter(s => {
    const r = rows.find(x => x.s === s && x.cname === 'real'), st = rows.find(x => x.s === s && x.cname === 'stressed');
    return r.a.pf > 1.1 && r.b.pf > 1.1 && r.all.t > 2 && st.all.pf > 1;
  });
  if (!passed.length) console.log('  No variant passes.');
  passed.forEach(s => {
    const w = threeWeeks(rows.find(x => x.s === s && x.cname === 'real').tr, 4000);
    console.log('  PASS  ' + s.name + ' (a random 3 weeks of 2025-2026: ' + f(w.pPositive, 0) + '% positive)');
  });

  // Next to what the EA already trades: the variant with the best DESIGN-half PF, judged on 2025-2026.
  const best = rows.filter(x => x.cname === 'real').sort((x, y) => y.a.pf - x.a.pf)[0];
  const P = portfolio(m15, { retired: true }), port = [].concat(...Object.values(P).map(s => backtest(m15, s, COSTS.real)));
  const daily = tr => { const m = new Map(); tr.forEach(t => m.set(dayOf(t.t), (m.get(dayOf(t.t)) || 0) + t.r)); return m; };
  const dp = daily(port), dz = daily(best.tr), keys = [...new Set([...dp.keys(), ...dz.keys()])];
  const xs = keys.map(k => dp.get(k) || 0), ys = keys.map(k => dz.get(k) || 0);
  const mean = v => v.reduce((a, b) => a + b, 0) / v.length, mx = mean(xs), my = mean(ys);
  const corr = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) /
               Math.sqrt(xs.reduce((a, x) => a + (x - mx) ** 2, 0) * ys.reduce((a, y) => a + (y - my) ** 2, 0));
  console.log('\nBest variant on the design half: ' + best.s.name + ' (design PF ' + f(best.a.pf) + ', unseen PF ' + f(best.b.pf) + ')');
  console.log('Daily-result correlation with the six-strategy portfolio: ' + f(corr));
  [['the six strategies', port], ['the six + this variant', port.concat(best.tr)]].forEach(([label, tr]) => {
    tr = tr.slice().sort((x, y) => x.exitT - y.exitT);
    const all = stats(tr, weeks), a = stats(tr.filter(t => t.t < SPLIT), 1), b = stats(tr.filter(t => t.t >= SPLIT), 1);
    console.log('  ' + label.padEnd(24) + ': ' + all.n + ' trades, PF ' + f(all.pf) + ', ' + f(all.totalR, 0) + 'R, worst drawdown ' + f(all.ddR, 0) +
                'R | design ' + f(a.totalR, 0) + 'R PF ' + f(a.pf) + ' | unseen ' + f(b.totalR, 0) + 'R PF ' + f(b.pf));
  });
}

module.exports = { candles, findZones, zoneStrategy };
