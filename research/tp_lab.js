/**
 * Take-profit study: does a target at the broker on every strategy change the risk?
 *
 *   node research/tp_lab.js
 *
 * Levels are multiples of each trade's stop distance. Selection rule, fixed before running: per strategy, the
 * level with the best total R / drawdown R on 2023-2024 only; 2025-2026 then judges it. Dollars are at the fixed
 * 0.01 lots (1 ounce), so $ = R x the stop distance. The daily loss limit is not modelled. Research only.
 *
 * Results (30 Oct 2026, 2025-2026 at real costs):
 *   no take-profit                 PF 1.23  +$3,136  drawdown $959  worst day -$428  worst trade -$212
 *   chosen levels, H4 re-enters    PF 1.23  +$4,057  drawdown $1,214  worst day -$523  worst trade -$254
 *   chosen levels, H4 waits        PF 1.28  +$4,698  drawdown $986  worst day -$268  worst trade -$212
 * The six intraday targets barely change anything: most are rarely reached (Dual Thrust and Momentum at 20:00 about
 * 1% of trades, New York 3%). Only the Asian breakout improves clearly. H4 at 1.5R reaches its target about half the
 * time, and 84 of 107 targets were followed by a new trade the same way within two bars, so it needs the wait.
 * The wait rule was added after seeing that on all the data; only its level was chosen on 2023-2024 alone.
 * A target never limits a loss: that is the stop's job. Skipping trades whose stop costs over $150 (40 of 2,690)
 * takes the worst trade to -$127 and the drawdown to $739, which no target does.
 */
const I = require('./intraday.js');
const R = require('./daytrade.js');

const LEVELS = [0, 0.5, 0.75, 1, 1.5, 2, 3, 4];
const H4_CFG = { dir: 'both', N: 20, M: 10, k: 2, ema: 100, maxBars: 60, barMin: 240, flat: false, swapLong: -5.92, swapShort: 3.67,
                 hardK: 4, firstEntryMin: 0, lastEntryMin: 24 * 60, flatMin: Infinity, from: -Infinity, to: Infinity };
const H4_FROM = Date.UTC(2023, 3, 1);     // three months of warm-up, as in research/parity_mt5.js
const DAY = 86400000;
const f = (v, d) => (v === undefined || v === null || !isFinite(v)) ? '-' : v.toFixed(d === undefined ? 2 : d);

function st(tr) {
  const rs = tr.map(t => t.r), gw = rs.filter(r => r > 0).reduce((a, b) => a + b, 0), gl = -rs.filter(r => r <= 0).reduce((a, b) => a + b, 0);
  let c = 0, p = 0, dd = 0, cu = 0, pu = 0, ddu = 0;
  const days = new Map();
  tr.slice().sort((a, b) => a.exitT - b.exitT).forEach(x => {
    c += x.r; p = Math.max(p, c); dd = Math.max(dd, p - c);
    const u = x.r * x.risk; cu += u; pu = Math.max(pu, cu); ddu = Math.max(ddu, pu - cu);
    const d = Math.floor(x.exitT / DAY); days.set(d, (days.get(d) || 0) + u);
  });
  return { n: tr.length, win: tr.length ? rs.filter(r => r > 0).length / tr.length * 100 : 0, hit: tr.length ? tr.filter(t => t.why === 'TARGET').length / tr.length * 100 : 0,
           pf: gl ? gw / gl : Infinity, totalR: c, ddR: dd, usd: cu, ddUsd: ddu, worstDay: Math.min(0, ...days.values()), worstTrade: Math.min(0, ...tr.map(t => t.r * t.risk)) };
}
const half = tr => ({ a: st(tr.filter(t => t.t < I.SPLIT)), b: st(tr.filter(t => t.t >= I.SPLIT)) });

const m15 = R.load('XAUUSD.sml_M15.csv'), h4 = R.toH4(R.load('XAUUSD.sml_H1.csv'));
const P = I.portfolio(m15, { maxStop: 0, retired: true });   // without the $150 cap, as when these levels were chosen (30 Oct); its effect is measured below
const intraday = (id, l) => I.backtest(m15, I.withTarget(P[id], l), I.COSTS.real);
const swing = (l, wait) => R.simulate(h4, Object.assign({}, H4_CFG, { targetR: l || undefined, targetWait: wait })).filter(t => t.t >= H4_FROM);

function grid(name, run) {
  console.log('\n=== ' + name + '\n  level     |  2023-24: n  win  hit    PF  totalR   ddR  score     $    dd |  2025-26: n  win  hit    PF  totalR   ddR     $    dd  wDay');
  let best = null;
  LEVELS.forEach(l => {
    const { a, b } = half(run(l));
    const score = a.ddR ? a.totalR / a.ddR : 0;
    if (l && (!best || score > best.score)) best = { l, score };
    console.log('  ' + (l ? l + 'R' : 'none').padEnd(8) + '  | ' + String(a.n).padStart(10) + f(a.win, 0).padStart(5) + f(a.hit, 0).padStart(5) + f(a.pf).padStart(6) + f(a.totalR, 1).padStart(8) + f(a.ddR, 1).padStart(6) + f(score).padStart(7) + f(a.usd, 0).padStart(6) + f(a.ddUsd, 0).padStart(6) +
                ' | ' + String(b.n).padStart(10) + f(b.win, 0).padStart(5) + f(b.hit, 0).padStart(5) + f(b.pf).padStart(6) + f(b.totalR, 1).padStart(8) + f(b.ddR, 1).padStart(6) + f(b.usd, 0).padStart(6) + f(b.ddUsd, 0).padStart(6) + f(b.worstDay, 0).padStart(6));
  });
  console.log('  chosen on 2023-2024 only: ' + best.l + 'R');
  return best.l;
}

const ids = Object.keys(I.PORTFOLIO), chosen = {};
ids.forEach(id => { chosen[id] = grid(id, l => intraday(id, l)); });
const h4Plain = grid('H4 swing, re-enters after a target', l => swing(l, false));
const h4Wait = grid('H4 swing, waits for a close back inside the channel after a target', l => swing(l, true));

const line = (label, tr) => {
  const { a, b } = half(tr);
  console.log(label.padEnd(44) + '2023-24 PF ' + f(a.pf) + ' $' + f(a.usd, 0).padStart(5) + ' dd $' + f(a.ddUsd, 0).padStart(4) + ' day $' + f(a.worstDay, 0).padStart(4) +
              ' | 2025-26 PF ' + f(b.pf) + ' $' + f(b.usd, 0).padStart(5) + ' dd $' + f(b.ddUsd, 0).padStart(5) + ' day $' + f(b.worstDay, 0).padStart(5) + ' worst trade $' + f(b.worstTrade, 0).padStart(5));
};
const intra = levels => [].concat(...ids.map(id => intraday(id, levels[id] || 0)));
console.log('\n=== Whole portfolio at 0.01 lots');
const base = intra({}).concat(swing(0)), wait = intra(chosen).concat(swing(h4Wait, true));
line('no take-profit', base);
line('chosen levels, H4 ' + h4Plain + 'R, re-enters', intra(chosen).concat(swing(h4Plain, false)));
line('chosen levels, H4 ' + h4Wait + 'R, waits', wait);
[100, 150, 200].forEach(cap => line('  same, skipping stops over $' + cap + ' (' + wait.filter(t => t.risk > cap).length + ' of ' + wait.length + ')', wait.filter(t => t.risk <= cap)));
console.log('\nChosen: ' + JSON.stringify(chosen) + ', H4 ' + h4Wait + 'R with the wait. The EAs\' inputs and research/intraday.js TARGETS must match.');
