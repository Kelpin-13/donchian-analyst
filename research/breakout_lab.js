/**
 * Refining the Asian range breakout (ASIAN_NARROW): a more precise entry, stop loss and take-profit, and a stricter
 * "quiet night" filter (owner request, 7 Nov 2026).
 *
 *   node research/breakout_lab.js [runs]
 *
 * Today's rule (research/intraday.js): the Asian range = bars opening 01:00-08:45 server time; on nights when it is
 * narrow (range / daily ATR below the 2023-2024 median), a buy stop at its high and a sell stop at its low rest from
 * 09:00 to 15:00, the stop loss is the other side of the range, the take-profit 1.5R, flat at 23:00, one trade a day.
 *
 * Fixed before the first run. One thing changes at a time, in this order, each picked on 2023-2024 only; a change is
 * kept only if it beats what came before on 2023-2024 (higher median profit / worst drawdown, in R, and at least 90% of
 * its median profit); otherwise the current rule stays:
 *   1. entry   E0 stop order at the edge (now) | E1 stop order 0.1 x ATR beyond the edge (skips small pokes) |
 *              E2 wait for a 15-minute CLOSE beyond the edge, then buy/sell at the next open |
 *              E3 after that close, a limit order back at the edge (the retest), until 15:00
 *   2. stop    S0 the other side of the range (now) | S1 the middle of the range (half the risk)
 *   3. target  T1.5 (now) | T2.5 x the risk
 *   4. filter  F50 range below the 2023-2024 median of range/ATR (now) | F33 below its lowest third (quieter nights only)
 * Fills: the research engine (intraday.js backtest) with every non-limit fill drawing its own slippage as in
 * research/realism_lab.js (live demo fills, x3 within 30 min of US news, 2% late +$3) on top of the bar spread and
 * $0.05; 100 runs. Pass (2025-2026, to 8 Oct, seen once): the final rule's median profit / worst drawdown is better
 * than today's, with at least 90% of its median profit, above 0 in at least 90% of runs. The fresh month (9 Oct -
 * 6 Nov 2026) is reported once, for information. Check first: E0 S0 T1.5 F50 must reproduce ASIAN_NARROW exactly.
 * Results (7 Nov 2026, one run, 100 runs of random fills; engine check identical, 331 trades). 2023-2024, median R /
 * drawdown R / ratio: today E0 S0 T1.5 F50 +8.6 / 21.0 / 0.41; E1 -16.0 / 30.8; E2 -17.6 / 37.0; E3 -0.9 / 18.2;
 * S1 -33.0 / 48.1; T2.5 +3.1 / 34.2; F33 +3.4 / 21.5. Nothing beat today's rule, so the rule stays as it is.
 * Today's rule on 2025-2026 with realistic fills: 86 trades, median -2.0 R, drawdown 15.8 R, above 0 in 13% of runs.
 * Fresh month: 3 trades, median -0.5 R.
 * Research only: nothing here trades.
 */
const R = require('./daytrade.js');
const I = require('./intraday.js');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const RUNS = Number(process.argv[2]) || 100;
const MIN = 60000, DAY = 86400000, SPLIT = I.SPLIT, FRESH = R.FRESH_FROM;
const LIVE = [0.03, 0.03, 0.58, 0.16, 0.02, 0.378, 0.085, 1.085, 0.422, 0.11], NEWS_X = 3, NEWS_WIN = 30 * MIN, LATE_P = 0.02, LATE_USD = 3;
const hm = (h, m) => h * 60 + (m || 0), mod = t => Math.floor((t % DAY) / MIN), dayOf = t => Math.floor(t / DAY);

const all = R.load('XAUUSD.sml_M15.csv', { fresh: true });
const seen = all.filter(b => b.t < FRESH);                            // everything but the fresh month
const news = loadReleases(findCalendar(), null).times;
const nearNews = t => { const i = firstFrom(news, t - NEWS_WIN); return i < news.length && news[i] <= t + NEWS_WIN; };
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// The quiet-night thresholds, from 2023-2024 only, exactly as intraday.js computes the median.
function thresholds(bars) {
  const { days } = I.dailyOf(bars), ratio = [];
  days.forEach(x => {
    if (!x.atrPrev || x.d * DAY >= SPLIT) return;
    let hi = -Infinity, lo = Infinity;
    for (let j = x.i; j < bars.length && dayOf(bars[j].t) === x.d && mod(bars[j].t) < hm(9); j++) { hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l); }
    if (hi > lo) ratio.push((hi - lo) / x.atrPrev);
  });
  ratio.sort((a, b) => a - b);
  return { F50: ratio[ratio.length >> 1], F33: ratio[Math.floor(ratio.length / 3)] };
}
const TH = thresholds(seen);

function asian(bars, o) {
  const { days, index } = I.dailyOf(bars);
  const dayAt = i => days[index.get(dayOf(bars[i].t))];
  const stopFor = (D, side) => o.S === 'S1' ? (D.hi + D.lo) / 2 : side === 1 ? D.lo : D.hi;
  return {
    name: 'Asian breakout ' + [o.E, o.S, 'T' + o.T, o.F].join(' '), family: 'breakout', flatMin: hm(23), maxPerDay: 1, maxStop: I.MAX_STOP,
    onDay: () => ({ hi: -Infinity, lo: Infinity, n: 0, ok: false, done: false }),
    onClose(i, pos, D) {
      const k = bars[i], m = mod(k.t);
      if (m >= hm(1) && m < hm(9)) { D.hi = Math.max(D.hi, k.h); D.lo = Math.min(D.lo, k.l); D.n++; }
      if (m === hm(8, 45)) {
        if (D.n < (hm(9) - hm(1)) / 15 * 0.75) return null;           // range not complete (data gap)
        const a = dayAt(i).atrPrev;
        if (!(a && (D.hi - D.lo) / a < TH[o.F])) return null;
        D.ok = true; D.a = a;
        if (o.E === 'E0' || o.E === 'E1') {
          const b = o.E === 'E1' ? 0.1 * a : 0;
          return { orders: [{ side: 1, level: D.hi + b, stop: stopFor(D, 1), targetR: o.T, until: hm(15) },
                            { side: -1, level: D.lo - b, stop: stopFor(D, -1), targetR: o.T, until: hm(15) }] };
        }
        return null;
      }
      if ((o.E === 'E2' || o.E === 'E3') && D.ok && !D.done && !pos && m >= hm(9) && m < hm(15)) {
        const side = k.c > D.hi ? 1 : k.c < D.lo ? -1 : 0;
        if (!side) return null;
        D.done = true;
        if (o.E === 'E2') return { enter: { side, stop: stopFor(D, side), targetR: o.T } };
        return { orders: [{ side, level: side === 1 ? D.hi : D.lo, stop: stopFor(D, side), targetR: o.T, until: hm(15), limit: true }] };
      }
      return null;
    }
  };
}

function score(tr) {
  let cu = 0, pk = 0, dd = 0;
  tr.slice().sort((a, b) => a.exitT - b.exitT).forEach(t => { cu += t.r; pk = Math.max(pk, cu); dd = Math.max(dd, pk - cu); });
  return { n: tr.length, r: cu, dd, ratio: dd ? cu / dd : cu > 0 ? Infinity : 0 };
}
const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
function evaluate(o, bars) {
  const S = asian(bars, o), out = { a: [], b: [], f: [] };
  for (let k = 0; k < RUNS; k++) {
    const rand = rng(300 + k);
    const slipFn = t => LIVE[Math.floor(rand() * LIVE.length)] * (nearNews(t) ? NEWS_X : 1) + (rand() < LATE_P ? LATE_USD : 0);
    const tr = I.backtest(bars, S, { slip: I.COSTS.real.slip, slipFn });
    out.a.push(score(tr.filter(t => t.t < SPLIT))); out.b.push(score(tr.filter(t => t.t >= SPLIT && t.t < FRESH))); out.f.push(score(tr.filter(t => t.t >= FRESH)));
  }
  const sum = (arr) => ({ n: arr[0].n, r: med(arr.map(x => x.r)), dd: med(arr.map(x => x.dd)), ratio: med(arr.map(x => x.ratio)), pos: arr.filter(x => x.r > 0).length / arr.length });
  return { o, a: sum(out.a), b: sum(out.b), f: sum(out.f) };
}
const f = (v, d) => isFinite(v) ? v.toFixed(d === undefined ? 1 : d) : 'inf';
const line = x => '  ' + [x.o.E, x.o.S, 'T' + x.o.T, x.o.F].join(' ').padEnd(16) +
  '| ' + String(x.a.n).padStart(4) + f(x.a.r).padStart(8) + f(x.a.dd).padStart(7) + f(x.a.ratio, 2).padStart(7) + ' ';
const better = (x, cur) => x.a.ratio > cur.a.ratio && x.a.r >= 0.9 * cur.a.r;

// 0. The engine check: today's rule through this file must give ASIAN_NARROW's trades exactly.
const P = I.portfolio(seen), now = { E: 'E0', S: 'S0', T: 1.5, F: 'F50' };
const ref = I.backtest(seen, P.ASIAN_NARROW, I.COSTS.real), mine = I.backtest(seen, asian(seen, now), I.COSTS.real);
const same = ref.length === mine.length && ref.every((t, i) => t.t === mine[i].t && t.side === mine[i].side && Math.abs(t.r - mine[i].r) < 1e-9);
console.log('Engine check: today\'s rule here = ASIAN_NARROW in intraday.js: ' + (same ? 'identical (' + ref.length + ' trades)' : 'DIFFERENT, stop'));
if (!same) process.exit(1);
console.log('Quiet-night thresholds (range / daily ATR, 2023-2024): F50 below ' + TH.F50.toFixed(3) + ', F33 below ' + TH.F33.toFixed(3));
console.log('\n  choice          | 2023-24:  n  med R  med dd  ratio  (median over ' + RUNS + ' runs of random fills)');

let cur = evaluate(now, seen);
console.log(line(cur) + ' today');
[['E', ['E1', 'E2', 'E3']], ['S', ['S1']], ['T', [2.5]], ['F', ['F33']]].forEach(([key, alts]) => {
  const cands = alts.map(v => evaluate(Object.assign({}, cur.o, { [key]: v }), seen));
  cands.forEach(x => console.log(line(x)));
  const best = cands.filter(x => better(x, cur)).sort((x, y) => y.a.ratio - x.a.ratio)[0];
  console.log('    step ' + key + ': ' + (best ? 'keep ' + best.o[key] : 'no change, ' + cur.o[key] + ' stays'));
  if (best) cur = best;
});

// The judgement, once.
const today = evaluate(now, all), fin = evaluate(cur.o, all);
const row = (x, w) => w + ': ' + String(x.n).padStart(4) + ' trades, median ' + f(x.r) + ' R, drawdown ' + f(x.dd) + ' R, ratio ' + f(x.ratio, 2) + ', above 0 in ' + (x.pos * 100).toFixed(0) + '% of runs';
console.log('\nFinal rule: ' + [cur.o.E, cur.o.S, 'T' + cur.o.T, cur.o.F].join(' ') + (JSON.stringify(cur.o) === JSON.stringify(now) ? ' (= today\'s rule: nothing beat it on 2023-2024)' : ''));
console.log('  today  ' + row(today.b, '2025-26') + '\n  final  ' + row(fin.b, '2025-26'));
const pass = JSON.stringify(cur.o) !== JSON.stringify(now) && fin.b.ratio > today.b.ratio && fin.b.r >= 0.9 * today.b.r && fin.b.pos >= 0.9;
console.log('  -> ' + (JSON.stringify(cur.o) === JSON.stringify(now) ? 'nothing to judge' : pass ? 'PASS' : 'FAIL'));
console.log('  fresh month (information only): today ' + row(today.f, '9 Oct-6 Nov') + '\n                                 final ' + row(fin.f, '9 Oct-6 Nov'));
