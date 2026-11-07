/**
 * Refining the H4 Donchian breakout (DonchianGold 1.08): entry, stop loss, take-profit and trend filter, one at a time
 * (owner request, 7 Nov 2026: "refine H4 next").
 *
 *   node research/h4_lab.js [runs]
 *
 * Today's rule (research/parity_mt5.js): buy when a 4-hour bar closes above the 20-bar high and above EMA(100) (sell
 * the mirror), at the next bar's open; strategy stop 2 x ATR(14) judged on closes; broker stop 4 ATR; broker stop
 * trails 0.5R behind the best price from +1R; take-profit 1.5R; out on a close back through the 10-bar channel or
 * after 60 bars; no stop over $150.
 *
 * Fixed before the first run. One change at a time, in this order, picked on 2023-04 to 2024-12 only; a change is
 * kept only if it beats what came before there (higher median profit / worst drawdown, in R, and at least 90% of its
 * median profit); otherwise today's setting stays:
 *   1. entry   E0 any close beyond the channel (now) | E1 the close must clear it by 0.25 x ATR |
 *              E2 the close must sit in the bar's outer quarter (a strong close)
 *   2. stop    k 2 x ATR (now) | 1.5 | 2.5
 *   3. target  1.5R (now) | 2.5R | none (the trail and the channel exit only)
 *   4. trend   EMA 100 (now) | EMA 200
 * Fills: research/daytrade.js simulate with every non-limit fill drawing its own slippage as in research/realism_lab.js
 * (live demo fills, x3 within 30 min of US news, 2% late +$3) on top of the spread and 0.01%; 100 runs.
 * Pass (2025-2026, to 8 Oct, seen once): the final rule's median profit / worst drawdown better than today's, at least
 * 90% of its median profit, above 0 in at least 90% of runs. The fresh month: information only. WARNING fixed in
 * advance: 2023-24 holds only about 70 H4 trades, so a "better" choice here is weak evidence; anything kept must also
 * pass the MT5 Strategy Tester on 2015-2022 before it is built.
 * Results (7 Nov 2026, one run, 100 runs of random fills). 2023-04 to 2024-12, median R / drawdown R / ratio: today
 * +16.5 / 7.6 / 2.17 (100 trades); E1 +10.2 / 6.3 / 1.59; E2 +18.9 / 5.2 / 3.71 (kept); then k1.5 +5.1 / 7.5; k2.5
 * +15.1 / 4.2 / 3.51; T2.5 +15.8 / 5.8 / 2.72; no target +13.6 / 5.9 / 2.34; EMA200 +11.5 / 7.2 / 1.59 (none kept).
 * Final E2 (strong close) on 2025-26: +24.8 R / 4.3 R / 5.88 (95 trades) against today's +31.5 R / 5.9 R / 5.37
 * (109 trades): a better ratio but 79% of the profit, under the 90% rule: FAIL. Today's rule stays.
 * Fresh month: 4 trades, +1.6 R, both rules alike.
 * Research only: nothing here trades.
 */
const R = require('./daytrade.js');
const I = require('./intraday.js');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const RUNS = Number(process.argv[2]) || 100;
const MIN = 60000, SPLIT = I.SPLIT, FRESH = R.FRESH_FROM, FROM = Date.UTC(2023, 3, 1);
const LIVE = [0.03, 0.03, 0.58, 0.16, 0.02, 0.378, 0.085, 1.085, 0.422, 0.11], NEWS_X = 3, NEWS_WIN = 30 * MIN, LATE_P = 0.02, LATE_USD = 3;
const TODAY = { dir: 'both', N: 20, M: 10, k: 2, ema: 100, maxBars: 60, barMin: 240, flat: false, swapLong: -5.92, swapShort: 3.67,
                hardK: 4, targetR: 1.5, targetWait: true, maxStop: 150, trail: { at: 1, dist: 0.5, broker: true },
                firstEntryMin: 0, lastEntryMin: 24 * 60, flatMin: Infinity, from: -Infinity, to: Infinity };
const h4 = R.toH4(R.load('XAUUSD.sml_H1.csv', { fresh: true }));
const news = loadReleases(findCalendar(), null).times;
const nearNews = t => { const i = firstFrom(news, t - NEWS_WIN); return i < news.length && news[i] <= t + NEWS_WIN; };
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

function score(tr) {
  let cu = 0, pk = 0, dd = 0;
  tr.slice().sort((a, b) => a.exitT - b.exitT).forEach(t => { cu += t.r; pk = Math.max(pk, cu); dd = Math.max(dd, pk - cu); });
  return { n: tr.length, r: cu, dd, ratio: dd ? cu / dd : cu > 0 ? Infinity : 0 };
}
const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
function evaluate(cfg) {
  const out = { a: [], b: [], f: [] };
  for (let k = 0; k < RUNS; k++) {
    const rand = rng(1300 + k);
    const slipFn = t => LIVE[Math.floor(rand() * LIVE.length)] * (nearNews(t) ? NEWS_X : 1) + (rand() < LATE_P ? LATE_USD : 0);
    const tr = R.simulate(h4, Object.assign({}, cfg, { slipFn })).filter(t => t.t >= FROM);
    out.a.push(score(tr.filter(t => t.t < SPLIT))); out.b.push(score(tr.filter(t => t.t >= SPLIT && t.t < FRESH))); out.f.push(score(tr.filter(t => t.t >= FRESH)));
  }
  const sum = arr => ({ n: arr[0].n, r: med(arr.map(x => x.r)), dd: med(arr.map(x => x.dd)), ratio: med(arr.map(x => x.ratio)), pos: arr.filter(x => x.r > 0).length / arr.length });
  return { cfg, a: sum(out.a), b: sum(out.b), f: sum(out.f) };
}
const name = c => [c.entryBuf ? 'E1' : c.strongClose ? 'E2' : 'E0', 'k' + c.k, c.targetR ? 'T' + c.targetR : 'Tnone', 'EMA' + c.ema].join(' ');
const f = (v, d) => isFinite(v) ? v.toFixed(d === undefined ? 1 : d) : 'inf';
const line = x => '  ' + name(x.cfg).padEnd(22) + '| ' + String(x.a.n).padStart(4) + f(x.a.r).padStart(8) + f(x.a.dd).padStart(7) + f(x.a.ratio, 2).padStart(7);
const better = (x, cur) => x.a.ratio > cur.a.ratio && x.a.r >= 0.9 * cur.a.r;

console.log('H4 Donchian, one change at a time; median over ' + RUNS + ' runs of random fills');
console.log('  choice                | 2023-24: n  med R  med dd  ratio');
let cur = evaluate(TODAY);
console.log(line(cur) + '   today');
[[[{ entryBuf: 0.25 }, { strongClose: 0.75 }], 'entry'], [[{ k: 1.5 }, { k: 2.5 }], 'stop'], [[{ targetR: 2.5 }, { targetR: null }], 'target'], [[{ ema: 200 }], 'trend']]
  .forEach(([alts, step]) => {
    const cands = alts.map(a => evaluate(Object.assign({}, cur.cfg, a)));
    cands.forEach(x => console.log(line(x)));
    const best = cands.filter(x => better(x, cur)).sort((x, y) => y.a.ratio - x.a.ratio)[0];
    console.log('    step ' + step + ': ' + (best ? 'keep ' + name(best.cfg) : 'no change'));
    if (best) cur = best;
  });

const today = evaluate(TODAY), changed = name(cur.cfg) !== name(TODAY);
const row = x => String(x.n).padStart(4) + ' trades, median ' + f(x.r) + ' R, drawdown ' + f(x.dd) + ' R, ratio ' + f(x.ratio, 2) + ', above 0 in ' + (x.pos * 100).toFixed(0) + '% of runs';
console.log('\nFinal rule: ' + name(cur.cfg) + (changed ? '' : ' (= today\'s: nothing beat it on 2023-2024)'));
console.log('  2025-26  today ' + row(today.b) + '\n           final ' + row(cur.b));
const pass = changed && cur.b.ratio > today.b.ratio && cur.b.r >= 0.9 * today.b.r && cur.b.pos >= 0.9;
console.log('  -> ' + (!changed ? 'nothing to judge' : pass ? 'PASS on 2025-26 (still needs the 2015-2022 tester check before it is built)' : 'FAIL'));
console.log('  fresh month (information only): today ' + row(today.f) + '\n                                 final ' + row(cur.f));
