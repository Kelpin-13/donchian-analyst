/**
 * A daily loss limit: no new entries for the rest of the server day once the day's closed trades have lost L x 1R
 * (owner, 14 Nov 2026: "do what you need to do"; the one idea worth borrowing from the day-trader-skill repository).
 * Rules fixed before the first run.
 *
 *   node research/daily_limit_lab.js [runs]
 *
 * Book: the four intraday strategies still trading + H4 with the trail (as research/realism_lab.js), every trade 1R,
 * 2023-04-03 to 2026-10-08, the realism_lab.js fills (live demo draws, x3 near US news, 2% late +$3), 100 runs, the
 * same seeds for every choice.
 *   limit     once the sum of R of the trades CLOSED so far in a server day is at or below -L, every trade that would be
 *             entered later that day is dropped (positions already open run on as planned). L = 1, 1.5, 2; or none.
 *             Applied to the list of trades: a dropped trade is simply removed, which leaves the others as they were
 *             (the strategies do not depend on each other; a strategy's second trade of a day after its own dropped
 *             first one is rare and is dropped too, as it would be entered later the same day).
 *   measure   total R / worst peak-to-trough drawdown in R, trades in exit order, per half.
 *   pick/pass pick L on 2023-2024 by median ratio (it must beat "none" there, else FAIL at once); pass if on 2025-2026
 *             its median ratio beats "none" AND its median total R is at least 90% of "none"'s. A pass is not built: it
 *             goes to the owner first. The fresh month is not used.
 * Results (14 Nov 2026, one run, 100 runs of random fills; median total R, R / worst drawdown; 2023-24 | 2025-26):
 *   none 28.1, 0.77 | 55.5, 2.73;  -1 R 17.5, 0.51 | 51.6, 2.82;  -1.5 R 24.3, 0.68 | 53.9, 2.70;  -2 R 24.5, 0.66 | 52.8, 2.61.
 *   No limit beats "none" on 2023-2024: FAIL. A losing trade here says nothing about the next one the same day, so
 *   the limit drops winners and losers alike and the drawdown barely moves (it builds over weeks, not inside a day).
 * Research only: nothing here trades.
 */
const I = require('./intraday.js');
const R = require('./daytrade.js');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const RUNS = Number(process.argv[2]) || 100;
const DAY = 86400000, MIN = 60000, FROM = Date.UTC(2023, 3, 3), SPLIT = I.SPLIT;
const LIVE = [0.03, 0.03, 0.58, 0.16, 0.02, 0.378, 0.085, 1.085, 0.422, 0.11], NEWS_X = 3, NEWS_WIN = 30 * MIN, LATE_P = 0.02, LATE_USD = 3;
const H4_CFG = { dir: 'both', N: 20, M: 10, k: 2, ema: 100, maxBars: 60, barMin: 240, flat: false, swapLong: -5.92, swapShort: 3.67,
                 hardK: 4, targetR: 1.5, targetWait: true, maxStop: I.MAX_STOP, trail: { at: 1, dist: 0.5, broker: true },
                 firstEntryMin: 0, lastEntryMin: 24 * 60, flatMin: Infinity, from: -Infinity, to: Infinity };
const news = loadReleases(findCalendar(), null).times;
const nearNews = t => { const i = firstFrom(news, t - NEWS_WIN); return i < news.length && news[i] <= t + NEWS_WIN; };
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const f = (v, d) => isFinite(v) ? v.toFixed(d === undefined ? 1 : d) : 'inf';

const m15 = R.load('XAUUSD.sml_M15.csv'), h4 = R.toH4(R.load('XAUUSD.sml_H1.csv'));
const P = I.portfolio(m15);
function book(slipFn) {
  const tr = [];
  Object.keys(P).forEach(id => I.backtest(m15, P[id], { slip: I.COSTS.real.slip, slipFn }).forEach(t => tr.push({ t: t.t, x: t.exitT, r: t.r })));
  R.simulate(h4, Object.assign({}, H4_CFG, { slipFn })).forEach(t => tr.push({ t: t.t, x: t.exitT, r: t.r }));
  return tr.filter(t => t.t >= FROM && t.t < R.FRESH_FROM);
}
/** Drop every trade entered after its server day's closed trades reached -L. */
function limit(tr, L) {
  if (!L) return tr;
  const byEntry = tr.slice().sort((a, b) => a.t - b.t), kept = [];
  byEntry.forEach(t => {
    const d = Math.floor(t.t / DAY);
    let lost = 0;
    kept.forEach(k => { if (k.x <= t.t && Math.floor(k.x / DAY) === d) lost += k.r; });
    if (lost > -L) kept.push(t);
  });
  return kept;
}
function score(tr) {
  const s = part => { let eq = 0, pk = 0, dd = 0; part.slice().sort((a, b) => a.x - b.x).forEach(t => { eq += t.r; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }); return { r: eq, dd, q: dd ? eq / dd : Infinity, n: part.length }; };
  return { a: s(tr.filter(t => t.t < SPLIT)), b: s(tr.filter(t => t.t >= SPLIT)) };
}
const CH = [0, 1, 1.5, 2], res = CH.map(() => []);
for (let k = 0; k < RUNS; k++) {
  const rand = rng(6200 + k);
  const tr = book(t => LIVE[Math.floor(rand() * LIVE.length)] * (nearNews(t) ? NEWS_X : 1) + (rand() < LATE_P ? LATE_USD : 0));
  CH.forEach((L, i) => res[i].push(score(limit(tr, L))));
}
const med = (i, h, key) => pct(res[i].map(x => x[h][key]), 50);
console.log('Daily loss limit on the book, ' + RUNS + ' runs of random fills, medians');
console.log('  limit  | 2023-24: trades     R  worst DD  R/DD | 2025-26: trades     R  worst DD  R/DD');
CH.forEach((L, i) => console.log('  ' + (L ? '-' + L + ' R' : 'none').padEnd(6) + ' |' + String(med(i, 'a', 'n')).padStart(15) + f(med(i, 'a', 'r')).padStart(7) + f(med(i, 'a', 'dd')).padStart(9) + f(med(i, 'a', 'q'), 2).padStart(7) +
                                  ' |' + String(med(i, 'b', 'n')).padStart(15) + f(med(i, 'b', 'r')).padStart(7) + f(med(i, 'b', 'dd')).padStart(9) + f(med(i, 'b', 'q'), 2).padStart(7)));
let pick = 1; for (let i = 2; i < CH.length; i++) if (med(i, 'a', 'q') > med(pick, 'a', 'q')) pick = i;
if (!(med(pick, 'a', 'q') > med(0, 'a', 'q'))) console.log('  no limit beats "none" on 2023-2024 -> FAIL');
else {
  const pass = med(pick, 'b', 'q') > med(0, 'b', 'q') && med(pick, 'b', 'r') >= 0.9 * med(0, 'b', 'r');
  console.log('  picked on 2023-2024: -' + CH[pick] + ' R -> 2025-2026 ratio ' + f(med(pick, 'b', 'q'), 2) + ' vs ' + f(med(0, 'b', 'q'), 2) + ', R ' + f(med(pick, 'b', 'r')) + ' vs ' + f(med(0, 'b', 'r')) + ' -> ' + (pass ? 'PASS (goes to the owner; not built)' : 'FAIL'));
}
