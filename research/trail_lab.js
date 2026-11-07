/**
 * Trailing-stop study: does moving the stop behind the price help the EAs as they trade now
 * (fixed 0.01 lots, take-profit from the fill, no stop over $150)?
 *
 *   node research/trail_lab.js
 *
 * Fixed before running (5 Nov 2026):
 *   - the same seven choices for the six intraday strategies together, and separately for H4: none; move the
 *     stop to the fill once the trade is 0.5R or 1R up; or trail it 0.5R or 1R behind the best price once the
 *     trade is 0.5R or 1R up. Every take-profit stays where it is.
 *   - intraday: one choice for all six (not one per strategy), moved at each M15 bar's close.
 *     H4: the strategy stop moves (checked on 4-hour closes), or the broker's stop moves (fires inside a bar).
 *   - pick: the best profit / worst drop in dollars on 2023-2024 only, and it must beat "none" there.
 *   - pass: on 2025-2026, seen once, a better profit / worst drop than "none" and at least 90% of its profit.
 * Dollars are at 0.01 lots (1 ounce): $ = R x the stop distance. Real costs. Research only.
 *
 * Results (5 Nov 2026, profit / worst drop):
 *   intraday   every choice below "none" on 2023-24 (and on 2025-26): no trailing stop for the six
 *   H4         broker stop, trail 0.5R from +1R (tied with 1R behind on 2023-24: 2.413 vs 2.411)
 *              2023-24 +$261 / $163 -> +$362 / $150;  2025-26 +$2,153 / $367 -> +$2,263 / $263   PASS
 *   all seven  2025-26 +$4,552 / $739 -> +$4,662 / $607; worst trade unchanged ($127)
 * Built into DonchianGold 1.07 (InpTrailAtR 1.0, InpTrailDistR 0.5). See docs/DESIGN.md section 20.
 */
const I = require('./intraday.js');
const R = require('./daytrade.js');

const H4_CFG = { dir: 'both', N: 20, M: 10, k: 2, ema: 100, maxBars: 60, barMin: 240, flat: false, swapLong: -5.92, swapShort: 3.67,
                 hardK: 4, targetR: 1.5, targetWait: true, maxStop: I.MAX_STOP,
                 firstEntryMin: 0, lastEntryMin: 24 * 60, flatMin: Infinity, from: -Infinity, to: Infinity };
const H4_FROM = Date.UTC(2023, 3, 1);     // three months of warm-up, as in research/parity_mt5.js
const DAY = 86400000;
const CHOICES = [
  { name: 'none' },
  { name: 'to the fill at +0.5R', at: 0.5, lock: true },
  { name: 'to the fill at +1R', at: 1, lock: true },
  { name: 'trail 0.5R from +0.5R', at: 0.5, dist: 0.5 },
  { name: 'trail 1R from +0.5R', at: 0.5, dist: 1 },
  { name: 'trail 0.5R from +1R', at: 1, dist: 0.5 },
  { name: 'trail 1R from +1R', at: 1, dist: 1 }
];
const trailOf = c => c.at === undefined ? undefined : { at: c.at, dist: c.dist, lock: !!c.lock };

function st(tr) {
  let cu = 0, pu = 0, dd = 0, gw = 0, gl = 0;
  const days = new Map();
  tr.slice().sort((a, b) => a.exitT - b.exitT).forEach(x => {
    const u = x.r * x.risk; cu += u; pu = Math.max(pu, cu); dd = Math.max(dd, pu - cu);
    if (u > 0) gw += u; else gl -= u;
    const d = Math.floor(x.exitT / DAY); days.set(d, (days.get(d) || 0) + u);
  });
  const share = why => tr.length ? tr.filter(t => t.why === why).length / tr.length * 100 : 0;
  return { n: tr.length, win: tr.length ? tr.filter(t => t.r > 0).length / tr.length * 100 : 0, pf: gl ? gw / gl : Infinity,
           usd: cu, dd, ratio: dd ? cu / dd : 0, worstDay: Math.min(0, ...days.values()), target: share('TARGET'), trail: share('TRAIL') };
}
const f = (v, d) => (v === undefined || v === null || !isFinite(v)) ? '-' : v.toFixed(d === undefined ? 2 : d);
const row = s => String(s.n).padStart(5) + f(s.win, 0).padStart(5) + f(s.pf).padStart(6) + f(s.usd, 0).padStart(7) + f(s.dd, 0).padStart(6) +
                 f(s.ratio).padStart(6) + f(s.worstDay, 0).padStart(6) + f(s.target, 0).padStart(5) + f(s.trail, 0).padStart(5);
const HEAD = '      n  win    PF      $    dd ratio  wDay  tp%  tr%';

function study(name, run) {
  console.log('\n=== ' + name + '\n  choice                   |  2023-24' + HEAD + ' |  2025-26' + HEAD);
  const res = CHOICES.map(c => { const tr = run(c); return { c, a: st(tr.filter(t => t.t < I.SPLIT)), b: st(tr.filter(t => t.t >= I.SPLIT)), tr }; });
  res.forEach(x => console.log('  ' + x.c.name.padEnd(24) + ' |         ' + row(x.a) + ' |         ' + row(x.b)));
  const base = res[0];
  const pick = res.slice(1).filter(x => x.a.ratio > base.a.ratio).sort((x, y) => y.a.ratio - x.a.ratio)[0];
  if (!pick) { console.log('  picked on 2023-2024: nothing beats "none" there, so no trailing stop'); return { base, pick: null }; }
  const pass = pick.b.ratio > base.b.ratio && pick.b.usd >= 0.9 * base.b.usd;
  console.log('  picked on 2023-2024: ' + pick.c.name + ' | 2025-2026: profit/drop ' + f(pick.b.ratio) + ' vs ' + f(base.b.ratio) +
              ', profit $' + f(pick.b.usd, 0) + ' vs $' + f(base.b.usd, 0) + ' -> ' + (pass ? 'PASS' : 'FAIL'));
  return { base, pick, pass };
}

const m15 = R.load('XAUUSD.sml_M15.csv'), h4 = R.toH4(R.load('XAUUSD.sml_H1.csv'));
const P = I.portfolio(m15, { retired: true });   // all six, as on 5 Nov
const intraday = c => [].concat(...Object.keys(P).map(id =>
  I.backtest(m15, Object.assign({}, P[id], { trail: trailOf(c) }), I.COSTS.real).map(t => Object.assign(t, { strat: id }))));
const swing = broker => c => R.simulate(h4, Object.assign({}, H4_CFG, { trail: c.at === undefined ? undefined : Object.assign(trailOf(c), { broker }) }))
  .filter(t => t.t >= H4_FROM).map(t => Object.assign(t, { strat: 'H4' }));

const A = study('Six intraday strategies (one choice for all)', intraday);
const B = study('H4 Donchian, the strategy stop trails (4-hour closes)', swing(false));
const C = study('H4 Donchian, the broker stop trails (inside the bar)', swing(true));
// H4's one choice: of the two kinds' picks, the better profit / worst drop on 2023-2024.
const H = [B, C].filter(x => x.pick).sort((x, y) => y.pick.a.ratio - x.pick.a.ratio)[0];
if (H) console.log('\nH4 choice (better 2023-2024 profit/drop of the two picks): ' + (H === C ? 'broker stop, ' : 'strategy stop, ') + H.pick.c.name +
                   ' -> ' + (H.pass ? 'PASS' : 'FAIL') + ' on 2025-2026');

// The whole book at real costs: the intraday choice (none if nothing passed) plus H4's.
const book = (a, h) => a.tr.concat(h.tr);
const now = book(A.base, B.base), next = book(A.pick && A.pass ? A.pick : A.base, H && H.pass ? H.pick : B.base);
console.log('\n=== All seven strategies, 0.01 lots      n  win    PF      $    dd ratio  wDay  tp%  tr%');
[['now', now], ['with the choices above', next]].forEach(([n, tr]) => {
  console.log('  ' + n.padEnd(24) + ' 2023-24 ' + row(st(tr.filter(t => t.t < I.SPLIT))));
  console.log('  ' + ''.padEnd(24) + ' 2025-26 ' + row(st(tr.filter(t => t.t >= I.SPLIT))));
});
const worst = tr => Math.min(...tr.filter(t => t.t >= I.SPLIT).map(t => t.r * t.risk));
console.log('  worst trade 2025-26: now $' + f(worst(now), 0) + ', with the choices $' + f(worst(next), 0));

// Per strategy, for the intraday pick (information only: the choice is one rule for all six).
if (A.pick) {
  console.log('\n=== Per strategy, "none" vs "' + A.pick.c.name + '" (2025-2026)');
  Object.keys(P).forEach(id => {
    const b = st(A.base.tr.filter(t => t.strat === id && t.t >= I.SPLIT)), p = st(A.pick.tr.filter(t => t.strat === id && t.t >= I.SPLIT));
    console.log('  ' + id.padEnd(13) + ' $' + f(b.usd, 0).padStart(6) + ' dd ' + f(b.dd, 0).padStart(5) + '  ->  $' + f(p.usd, 0).padStart(6) + ' dd ' + f(p.dd, 0).padStart(5));
  });
}
