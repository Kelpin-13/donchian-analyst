/**
 * Stress test of all seven strategies as the EAs trade now (fixed 0.01 lots = 1 oz, so $ = price distance,
 * take-profits from the fill, no stop over $150): worst drawdowns, worse fills, wider spreads, volatile days.
 *
 *   node research/stress_lab.js            prints the tables, writes data/reports/stress.json (git-ignored)
 *
 * Scenarios (every non-limit fill: entries, stop losses, market exits; take-profits are limit orders):
 *   base           the research's own costs: bar spread + $0.05 a side (intraday), + 0.01% a side (H4)
 *   slip +$0.25    that much extra a side. Live demo stop-order entries, 12 Oct - 5 Nov 2026: 10 fills,
 *                  mean $0.29, median $0.13, worst $1.09, so $0.25 is roughly what the demo already gives
 *   slip +$0.50    twice the live mean
 *   slip +$1.00    the worst live fill on every trade
 *   pressure       spread x2 and +$0.50 a side together, what a news spike looks like
 * Drawdowns are on closed trades in dollars (the H4 trade's open loss can add a little; the Strategy Tester's
 * equity column shows it). "MC 95%/99%": 5,000 reshuffles of the daily P&L (days drawn with replacement),
 * the drawdown that 5% / 1% of them exceed: what a different order of the same days could have done.
 * Volatile day: the day's high-low range is over 1.5x the median of the previous 60 days' ranges.
 * Window: 2023-04-03 (after the H4 warm-up) to the end of data/. Research only: nothing here trades.
 */
const fs = require('fs');
const path = require('path');
const I = require('./intraday.js');
const R = require('./daytrade.js');

const DAY = 86400000, FROM = Date.UTC(2023, 3, 3), ACCOUNT = 10000;
const H4_CFG = { dir: 'both', N: 20, M: 10, k: 2, ema: 100, maxBars: 60, barMin: 240, flat: false, swapLong: -5.92, swapShort: 3.67,
                 hardK: 4, targetR: 1.5, targetWait: true, maxStop: I.MAX_STOP,
                 firstEntryMin: 0, lastEntryMin: 24 * 60, flatMin: Infinity, from: -Infinity, to: Infinity };
const H4_TRAIL = { at: 1, dist: 0.5, broker: true };      // DonchianGold 1.07, not installed yet
const SCENARIOS = [
  { id: 'base', name: 'base costs', slip: 0, spread: 1 },
  { id: 's25', name: 'slip +$0.25', slip: 0.25, spread: 1 },
  { id: 's50', name: 'slip +$0.50', slip: 0.5, spread: 1 },
  { id: 's100', name: 'slip +$1.00', slip: 1, spread: 1 },
  { id: 'press', name: 'spread x2, +$0.50', slip: 0.5, spread: 2 }
];

const m15 = R.load('XAUUSD.sml_M15.csv'), h1 = R.load('XAUUSD.sml_H1.csv');
const P = I.portfolio(m15, { retired: process.argv.includes('--all') });   // --all: the seven of 6 Nov (DESIGN section 22)
const IDS = Object.keys(P).concat(['H4']);
const widen = (bars, x) => x === 1 ? bars : bars.map(b => Object.assign({}, b, { sp: b.sp * x }));

function tradesOf(sc, h4trail) {
  const m = widen(m15, sc.spread), h4 = R.toH4(widen(h1, sc.spread));
  const out = [];
  Object.keys(P).forEach(id => I.backtest(m, P[id], { slip: I.COSTS.real.slip + sc.slip })
    .forEach(t => out.push({ strat: id, t: t.t, exitT: t.exitT, usd: t.r * t.risk, why: t.why })));
  R.simulate(h4, Object.assign({}, H4_CFG, { slipUsd: sc.slip }, h4trail ? { trail: H4_TRAIL } : {}))
    .forEach(t => out.push({ strat: 'H4', t: t.t, exitT: t.exitT, usd: t.r * t.risk, why: t.why }));
  return out.filter(t => t.t >= FROM).sort((a, b) => a.exitT - b.exitT);
}

/* -------- volatile days: range over 1.5x the median of the previous 60 days -------- */
const dayRange = new Map();
m15.forEach(b => { const d = Math.floor(b.t / DAY), x = dayRange.get(d); if (!x) dayRange.set(d, { h: b.h, l: b.l }); else { x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); } });
const dayKeys = [...dayRange.keys()].sort((a, b) => a - b);
const volatile = new Set();
dayKeys.forEach((d, i) => {
  if (i < 60) return;
  const prev = dayKeys.slice(i - 60, i).map(k => dayRange.get(k).h - dayRange.get(k).l).sort((a, b) => a - b);
  const r = dayRange.get(d); if (r.h - r.l > 1.5 * prev[30]) volatile.add(d);
});

/* -------- statistics -------- */
const iso = t => new Date(t).toISOString().slice(0, 10);
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function stats(tr) {
  let cu = 0, pk = 0, pkT = FROM, dd = 0, ddPk = FROM, ddPkUsd = 0, ddLow = FROM, gw = 0, gl = 0, w = 0, streak = 0, worstStreak = 0, streakUsd = 0, worstStreakUsd = 0;
  const days = new Map(), months = new Map(), curve = [];
  tr.forEach(x => {
    cu += x.usd;
    if (cu > pk) { pk = cu; pkT = x.exitT; }
    if (pk - cu > dd) { dd = pk - cu; ddPk = pkT; ddPkUsd = pk; ddLow = x.exitT; }
    if (x.usd > 0) { w++; gw += x.usd; streak = 0; streakUsd = 0; } else { gl -= x.usd; streak++; streakUsd += x.usd; worstStreak = Math.max(worstStreak, streak); worstStreakUsd = Math.min(worstStreakUsd, streakUsd); }
    const d = Math.floor(x.exitT / DAY); days.set(d, (days.get(d) || 0) + x.usd);
    const mo = iso(x.exitT).slice(0, 7); months.set(mo, (months.get(mo) || 0) + x.usd);
    curve.push([x.exitT, cu]);
  });
  // recovery: the first close back at the old peak after the trough
  let recov = null;
  { let c = 0; for (const x of tr) { c += x.usd; if (x.exitT > ddLow && c >= ddPkUsd) { recov = x.exitT; break; } } }
  // Monte Carlo on daily P&L (days with a closed trade), drawn with replacement
  const dv = [...days.values()], rand = rng(20261106), mc = [];
  for (let k = 0; k < 5000; k++) { let c = 0, p = 0, m = 0; for (let j = 0; j < dv.length; j++) { c += dv[Math.floor(rand() * dv.length)]; p = Math.max(p, c); m = Math.max(m, p - c); } mc.push(m); }
  mc.sort((a, b) => a - b);
  const volUsd = tr.filter(x => volatile.has(Math.floor(x.exitT / DAY))).reduce((a, x) => a + x.usd, 0);
  const volN = tr.filter(x => volatile.has(Math.floor(x.exitT / DAY))).length;
  return { n: tr.length, win: tr.length ? w / tr.length * 100 : 0, pf: gl ? gw / gl : Infinity, usd: cu, dd, ddPct: dd / ACCOUNT * 100,
           ddFrom: iso(ddPk), ddTo: iso(ddLow), recovered: recov ? iso(recov) : 'not yet', ddDays: Math.round(((recov || tr[tr.length - 1].exitT) - ddPk) / DAY),
           mc95: mc[Math.floor(mc.length * 0.95)], mc99: mc[Math.floor(mc.length * 0.99)],
           worstDay: Math.min(0, ...days.values()), worstMonth: Math.min(0, ...months.values()), worstStreak, worstStreakUsd,
           ratio: dd ? cu / dd : 0, volUsd, volN, months, curve };
}

const f = (v, d) => (v === undefined || v === null || !isFinite(v)) ? '-' : v.toFixed(d === undefined ? 0 : d);
const all = {};
SCENARIOS.forEach(sc => { all[sc.id] = tradesOf(sc, false); });
const trailBase = tradesOf(SCENARIOS[0], true), trailPress = tradesOf(SCENARIOS[4], true);

console.log('Window ' + iso(FROM) + ' to ' + iso(all.base[all.base.length - 1].exitT) + ', fixed 0.01 lots, $' + ACCOUNT + ' account. ' + volatile.size + ' volatile days of ' + dayKeys.length + '.');
console.log('\n=== Worst drawdown per strategy, base costs');
console.log('  strategy        trades win%   PF    net$   maxDD$  dd%  peak -> trough            recovered   days  MC95$  MC99$ wDay$ wMonth$ lossRun');
const rows = [];
IDS.concat(['ALL']).forEach(id => {
  const tr = id === 'ALL' ? all.base : all.base.filter(t => t.strat === id), s = stats(tr);
  const stress = SCENARIOS.map(sc => stats(id === 'ALL' ? all[sc.id] : all[sc.id].filter(t => t.strat === id)));
  rows.push({ id, s, stress });
  console.log('  ' + id.padEnd(15) + String(s.n).padStart(6) + f(s.win).padStart(5) + f(s.pf, 2).padStart(6) + f(s.usd).padStart(8) + f(s.dd).padStart(9) + f(s.ddPct, 1).padStart(5) +
              '  ' + s.ddFrom + ' -> ' + s.ddTo + '  ' + s.recovered.padEnd(10) + String(s.ddDays).padStart(5) + f(s.mc95).padStart(7) + f(s.mc99).padStart(7) +
              f(s.worstDay).padStart(6) + f(s.worstMonth).padStart(8) + ('  ' + s.worstStreak + ' ($' + f(s.worstStreakUsd) + ')'));
});

console.log('\n=== Net profit $ / worst drawdown $ under worse fills');
console.log('  strategy        ' + SCENARIOS.map(sc => sc.name.padStart(19)).join(''));
rows.forEach(r => console.log('  ' + r.id.padEnd(15) + r.stress.map(s => (f(s.usd) + ' / ' + f(s.dd)).padStart(19)).join('')));
const tb = stats(trailBase.filter(t => t.strat === 'H4')), tp = stats(trailPress.filter(t => t.strat === 'H4'));
const ab = stats(trailBase), ap = stats(trailPress);
console.log('  H4 with trail   ' + (f(tb.usd) + ' / ' + f(tb.dd)).padStart(19) + ' (base)   ' + (f(tp.usd) + ' / ' + f(tp.dd)) + ' (pressure)   1.07, not installed');
console.log('  ALL with trail  ' + (f(ab.usd) + ' / ' + f(ab.dd)).padStart(19) + ' (base)   ' + (f(ap.usd) + ' / ' + f(ap.dd)) + ' (pressure)');

console.log('\n=== Volatile days (' + volatile.size + ') vs the rest, base costs: net $ (trades)');
rows.forEach(r => console.log('  ' + r.id.padEnd(15) + ('volatile ' + f(r.s.volUsd) + ' (' + r.s.volN + ')').padEnd(24) + 'other ' + f(r.s.usd - r.s.volUsd) + ' (' + (r.s.n - r.s.volN) + ')'));

console.log('\n=== Net $ per year, base costs');
const years = [...new Set(all.base.map(t => iso(t.exitT).slice(0, 4)))];
console.log('  strategy       ' + years.map(y => y.padStart(8)).join(''));
rows.forEach(r => console.log('  ' + r.id.padEnd(15) + years.map(y => f([...r.s.months].filter(([m]) => m.startsWith(y)).reduce((a, [, v]) => a + v, 0)).padStart(8)).join('')));
const losingMonths = [...rows[rows.length - 1].s.months.values()].filter(v => v < 0).length;
console.log('  whole book: ' + losingMonths + ' losing months of ' + rows[rows.length - 1].s.months.size);

console.log('\n=== The 8 worst days for the whole book, base costs');
const byDay = new Map(); all.base.forEach(t => { const d = Math.floor(t.exitT / DAY); const x = byDay.get(d) || { usd: 0, s: {} }; x.usd += t.usd; x.s[t.strat] = (x.s[t.strat] || 0) + t.usd; byDay.set(d, x); });
[...byDay].sort((a, b) => a[1].usd - b[1].usd).slice(0, 8).forEach(([d, x]) => {
  const r = dayRange.get(d);
  console.log('  ' + iso(d * DAY) + '  $' + f(x.usd).padStart(5) + '  gold range $' + (r ? f(r.h - r.l) : '-').padStart(4) + (volatile.has(d) ? ' volatile' : '         ') + '  ' +
              Object.entries(x.s).filter(([, v]) => v < 0).map(([k, v]) => k + ' ' + f(v)).join(', '));
});

/* -------- data for the chart and the Sheet -------- */
const weekly = tr => { const out = []; let c = 0, i = 0; const end = tr[tr.length - 1].exitT; for (let w = FROM; w <= end + 7 * DAY; w += 7 * DAY) { while (i < tr.length && tr[i].exitT < w) c += tr[i++].usd; out.push([iso(w), +c.toFixed(2)]); } return out; };
const monthsGold = []; h1.filter(b => b.t >= FROM).forEach(b => { const m = iso(b.t).slice(0, 7), x = monthsGold[monthsGold.length - 1];
  if (!x || x.m !== m) monthsGold.push({ m, o: b.o, h: b.h, l: b.l, c: b.c }); else { x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.c = b.c; } });
const out = {
  made: new Date().toISOString(), from: iso(FROM), to: iso(all.base[all.base.length - 1].exitT), account: ACCOUNT, volatileDays: volatile.size, days: dayKeys.length,
  scenarios: SCENARIOS.map(s => s.name),
  table: rows.map(r => ({ id: r.id, n: r.s.n, win: +r.s.win.toFixed(1), pf: +r.s.pf.toFixed(2), net: +r.s.usd.toFixed(2), dd: +r.s.dd.toFixed(2), ddPct: +r.s.ddPct.toFixed(2),
    ddFrom: r.s.ddFrom, ddTo: r.s.ddTo, recovered: r.s.recovered, ddDays: r.s.ddDays, mc95: +r.s.mc95.toFixed(2), mc99: +r.s.mc99.toFixed(2),
    worstDay: +r.s.worstDay.toFixed(2), worstMonth: +r.s.worstMonth.toFixed(2), lossRun: r.s.worstStreak, lossRunUsd: +r.s.worstStreakUsd.toFixed(2),
    volNet: +r.s.volUsd.toFixed(2), volN: r.s.volN, stress: r.stress.map(s => ({ net: +s.usd.toFixed(2), dd: +s.dd.toFixed(2) })) })),
  curves: Object.assign({}, ...SCENARIOS.map(sc => ({ ['ALL ' + sc.name]: weekly(all[sc.id]) }))),
  perStrategy: Object.assign({}, ...IDS.map(id => ({ [id]: weekly(all.base.filter(t => t.strat === id)) }))),
  gold: monthsGold.map(x => [x.m, +x.o.toFixed(2), +x.h.toFixed(2), +x.l.toFixed(2), +x.c.toFixed(2)])
};
const dir = path.join(__dirname, '..', 'data', 'reports');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'stress.json'), JSON.stringify(out));
console.log('\nWrote data/reports/stress.json');
