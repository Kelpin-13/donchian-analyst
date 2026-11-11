/**
 * Spread guard: no new entry when the entry bar's spread is over K x the median spread of the 20 bars before it
 * (research queue item 1, 10 Nov 2026).
 *
 *   node research/spread_guard_lab.js [runs]
 *
 * Question: does skipping entries made while the broker's spread is unusually wide improve the book at realistic fills?
 * Fixed before running:
 *   - guard    entry bar spread (its bar value in the MT5 export) > K x median spread of the previous 20 bars -> no entry.
 *              Intraday strategies: M15 bars. H4: the H1 bar at the H4 open (the H4 bar keeps the lowest spread, so it
 *              would almost never fire). A market entry that is blocked is dropped; a resting stop order stays and may
 *              trigger on a later bar; a stop-and-reverse is a new entry and is blocked too. Exits are never blocked.
 *              Engine option cost.entryGuard (intraday.js) / cfg.entryGuard (daytrade.js), default off: old results unchanged.
 *   - choices  none, K = 2, K = 3. ONE K for every strategy, picked on 2023-2024 (best book median profit/drawdown there,
 *              and it must beat "none" there); if neither beats "none" on 2023-24 the guard is dropped and reported FAIL.
 *   - book     the five strategies still trading (I.portfolio default) + H4 with the trail (as realism_lab.js), 0.5% risk
 *              ($50 a 1 R, not compounded), from 2023-04-03; data to 2026-10-08 (fresh bars not loaded).
 *   - fills    realism_lab.js model (live demo draws, x3 within 30 min of US news, 2% late +$3), 100 runs, the SAME seeds for
 *              every choice. Reported: worst 5%, median and best 5% over the runs.
 *   - measure  per run and period: profit / drawdown, in dollars (R x 50), drawdown = largest peak-to-trough on the trades
 *              in exit order. The "worst 5%" is the 5th percentile over the runs of that ratio.
 * Pass (judged once on 2025-2026, for the picked K, on the whole book): worst-5% profit/drawdown better than "none" AND
 *   median profit at least 90% of "none"'s median profit. Per-strategy results are shown with the same test, for information
 *   (a strategy is called out if the guard fails there), but the book decides.
 * A pass is not built: it goes to the owner under "Needs the owner".
 *
 * Results (10 Nov 2026, one run, 100 runs of random fills, same seeds for every choice; profit $ / drawdown $ at $50 a 1 R):
 *   guard fires on  K=2: 2.99% of M15 bars, 1.11% of H1 bars; K=3: 0.75% / 0.29%. About 4 of 1,400 book trades are skipped.
 *   Book 2023-24    median profit/dd: none 0.77, K=2 0.82, K=3 0.84 (worst 5%: 0.43, 0.51, 0.51). Picked K = 3.
 *   Book 2025-26    none: worst-5% 2.38, median 2.75, median profit $2,742
 *                   K = 3: worst-5% 2.45, median 2.77, median profit $2,772 (101%)  -> PASS (K = 2 for information: 2.51 / 2.82)
 *   Per strategy 2025-26 (same test): DUAL_THRUST, MOM_16, H4 pass; ASIAN_NARROW and R_BREAKER fail it (worst-5% ratio
 *   -0.27 vs -0.31 and 1.90 vs 1.91; differences of 0.01-0.04).
 *   Reading: the book passes the written rule, but the gain is small (worst-5% 2.38 -> 2.45, profit +1%) because the guard
 *   skips only about 0.3% of trades; it is inside the run-to-run noise of the fill draws. Not built.
 */
const I = require('./intraday.js');
const R = require('./daytrade.js');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const RUNS = Number(process.argv[2]) || 100;
const MIN = 60000, FROM = Date.UTC(2023, 3, 3), RISK_USD = 50;
const LIVE = [0.03, 0.03, 0.58, 0.16, 0.02, 0.378, 0.085, 1.085, 0.422, 0.11];
const NEWS_X = 3, NEWS_WIN = 30 * MIN, LATE_P = 0.02, LATE_USD = 3, WIN = 20;
const H4_CFG = { dir: 'both', N: 20, M: 10, k: 2, ema: 100, maxBars: 60, barMin: 240, flat: false, swapLong: -5.92, swapShort: 3.67,
                 hardK: 4, targetR: 1.5, targetWait: true, maxStop: I.MAX_STOP, trail: { at: 1, dist: 0.5, broker: true },
                 firstEntryMin: 0, lastEntryMin: 24 * 60, flatMin: Infinity, from: -Infinity, to: Infinity };

const cal = loadReleases(findCalendar(), null), news = cal.times;
const nearNews = t => { const i = firstFrom(news, t - NEWS_WIN); return i < news.length && news[i] <= t + NEWS_WIN; };
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const m15 = R.load('XAUUSD.sml_M15.csv'), h1 = R.load('XAUUSD.sml_H1.csv'), h4 = R.toH4(h1);
const P = I.portfolio(m15);
const IDS = Object.keys(P).concat(['H4']);

/** Set of bar times whose spread is over K x the median of the WIN bars before. */
function guardSet(bars, K) {
  const set = new Set();
  for (let i = WIN; i < bars.length; i++) {
    const prev = bars.slice(i - WIN, i).map(b => b.sp).sort((a, b) => a - b);
    const med = (prev[WIN / 2 - 1] + prev[WIN / 2]) / 2;
    if (med > 0 && bars[i].sp > K * med) set.add(bars[i].t);
  }
  return set;
}
const CHOICES = [{ name: 'none', K: 0 }, { name: 'K = 2', K: 2 }, { name: 'K = 3', K: 3 }];
CHOICES.forEach(c => { if (c.K) { c.g15 = guardSet(m15, c.K); c.g1 = guardSet(h1, c.K); } });

function book(c, slipFn) {
  const tr = [];
  const cost = { slip: I.COSTS.real.slip, slipFn };
  if (c.K) cost.entryGuard = t => c.g15.has(t);
  Object.keys(P).forEach(id => I.backtest(m15, P[id], cost).forEach(t => tr.push({ id, t: t.t, x: t.exitT, r: t.r })));
  const cfg = Object.assign({}, H4_CFG, { slipFn });
  if (c.K) cfg.entryGuard = t => c.g1.has(t);
  R.simulate(h4, cfg).forEach(t => tr.push({ id: 'H4', t: t.t, x: t.exitT, r: t.r }));
  return tr.filter(t => t.t >= FROM).sort((a, b) => a.x - b.x);
}
function score(tr) {
  let cu = 0, pk = 0, dd = 0;
  tr.forEach(t => { cu += t.r * RISK_USD; pk = Math.max(pk, cu); dd = Math.max(dd, pk - cu); });
  return { usd: cu, dd, ratio: dd > 0 ? cu / dd : (cu > 0 ? 99 : 0), n: tr.length };
}
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const f = (v, d) => v.toFixed(d === undefined ? 0 : d);

// results[choice][period][scope] = array over runs of score()
const PERIODS = { 'a': t => t.t < I.SPLIT, 'b': t => t.t >= I.SPLIT };
const res = CHOICES.map(() => ({ a: {}, b: {} }));
const blocked = CHOICES.map(() => 0);
for (let k = 0; k < RUNS; k++) {
  CHOICES.forEach((c, ci) => {
    const rand = rng(1000 + k);
    const slipFn = t => { let x = LIVE[Math.floor(rand() * LIVE.length)]; if (nearNews(t)) x *= NEWS_X; if (rand() < LATE_P) x += LATE_USD; return x; };
    const tr = book(c, slipFn);
    ['a', 'b'].forEach(p => {
      const sub = tr.filter(PERIODS[p]);
      ['BOOK'].concat(IDS).forEach(id => {
        const s = score(id === 'BOOK' ? sub : sub.filter(t => t.id === id));
        (res[ci][p][id] = res[ci][p][id] || []).push(s);
      });
    });
    if (k === 0) blocked[ci] = tr.length;
  });
}
const sum = (ci, p, id) => {
  const a = res[ci][p][id];
  const ratios = a.map(s => s.ratio), usd = a.map(s => s.usd), dd = a.map(s => s.dd);
  return { r5: pct(ratios, 5), r50: pct(ratios, 50), r95: pct(ratios, 95), u5: pct(usd, 5), u50: pct(usd, 50), u95: pct(usd, 95), d50: pct(dd, 50), d95: pct(dd, 95) };
};
const line = (s) => f(s.u5).padStart(7) + f(s.u50).padStart(7) + f(s.u95).padStart(7) + ' |' + f(s.d50).padStart(5) + f(s.d95).padStart(5) + ' |' +
                    f(s.r5, 2).padStart(6) + f(s.r50, 2).padStart(6) + f(s.r95, 2).padStart(6);
const HEAD = '  profit $ worst5% med best5% | dd med worst5% | profit/dd worst5% med best5%';

console.log('Spread guard, book: ' + IDS.join(', ') + '; $' + RISK_USD + ' a 1 R, ' + RUNS + ' runs with random fills (same seeds for every choice).');
console.log('Guard fires on ' + CHOICES.slice(1).map(c => 'K=' + c.K + ': ' + (c.g15.size / m15.length * 100).toFixed(2) + '% of M15 bars, ' + (c.g1.size / h1.length * 100).toFixed(2) + '% of H1 bars').join('; '));
console.log('Trades in run 1 (book): ' + CHOICES.map((c, i) => c.name + ' ' + blocked[i]).join(', '));
['a', 'b'].forEach(p => {
  console.log('\n=== Book, ' + (p === 'a' ? '2023-24' : '2025-26'));
  console.log('  choice  ' + HEAD);
  CHOICES.forEach((c, ci) => console.log('  ' + c.name.padEnd(7) + ' ' + line(sum(ci, p, 'BOOK'))));
});
// Pick on 2023-24: best median profit/drawdown, must beat none.
const a0 = sum(0, 'a', 'BOOK');
const cand = CHOICES.map((c, ci) => ({ c, ci, s: sum(ci, 'a', 'BOOK') })).filter(x => x.ci > 0 && x.s.r50 > a0.r50).sort((x, y) => y.s.r50 - x.s.r50);
let verdict;
if (!cand.length) {
  verdict = 'FAIL (neither K beats "none" on 2023-24, so the guard is dropped)';
  console.log('\nPicked on 2023-24: nothing beats "none" (median profit/dd ' + f(a0.r50, 2) + ').');
} else {
  const pk = cand[0], b0 = sum(0, 'b', 'BOOK'), b1 = sum(pk.ci, 'b', 'BOOK');
  const pass = b1.r5 > b0.r5 && b1.u50 >= 0.9 * b0.u50;
  verdict = (pass ? 'PASS' : 'FAIL');
  console.log('\nPicked on 2023-24: ' + pk.c.name + ' (median profit/dd ' + f(pk.s.r50, 2) + ' vs ' + f(a0.r50, 2) + ' for none).');
  console.log('2025-26, seen once: worst-5% profit/dd ' + f(b1.r5, 2) + ' vs ' + f(b0.r5, 2) + ' (needs better); median profit $' + f(b1.u50) + ' vs $' + f(b0.u50) +
              ' = ' + f(b1.u50 / b0.u50 * 100) + '% (needs >= 90%) -> ' + verdict);
  console.log('\nPer strategy, 2025-26, picked ' + pk.c.name + ' vs none (information; the book decides)');
  console.log('  strategy     none: worst5% med profit$ | guard: worst5% med profit$ | test');
  IDS.forEach(id => {
    const n = sum(0, 'b', id), g = sum(pk.ci, 'b', id);
    const ok = g.r5 > n.r5 && g.u50 >= 0.9 * n.u50;
    console.log('  ' + id.padEnd(12) + f(n.r5, 2).padStart(10) + f(n.r50, 2).padStart(6) + f(n.u50).padStart(8) + ' |' + f(g.r5, 2).padStart(9) + f(g.r50, 2).padStart(6) + f(g.u50).padStart(8) + ' | ' + (ok ? 'pass' : 'fail'));
  });
}
console.log('\nVERDICT: ' + verdict);
