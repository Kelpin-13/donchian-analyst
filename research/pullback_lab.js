/**
 * A second way into a trend: buy the pullback (owner, 11 Nov 2026: "chasing the trend is good, can we add more rule for
 * entering?"; the idea from the Martin Luk and MACD videos, queue item 15 brought forward on 4-hour bars). Today the H4
 * EA only enters on a breakout of the 20-bar channel; this adds an entry when a trend dips back to its average and
 * turns up again. Rules fixed before the first run.
 *
 *   node research/pullback_lab.js [runs]
 *
 * On 4-hour bars built from data/ 1-hour bars (broker server time), 2023-04 to 2026-10-08, long and short (mirror):
 *   trend      EMA 9 > EMA 21 > EMA 50 on closed H4 bars, all three higher than one bar before (short: the mirror)
 *   pullback   a closed bar whose low reached the average A (A = EMA 9 or EMA 21) while its close stayed above EMA 50
 *   entry      a buy stop just above that bar's high (the turn back up), working for the next 2 bars; the trend must still
 *              hold on the bar it is placed; one position at a time
 *   stop       the pullback bar's low; no trade if that is more than 2 x ATR(14) away or would cost over $150 at 0.01 lots
 *   exit       (X1) target 2R; (X2) no target: out at the next open after a close below EMA 21 (short: above)
 *   choices    A9/A21 x X1/X2 = 4. Costs: the bar's spread, $0.05, and swap for each night held (long -5.92% / short
 *              +3.67% a year of the price, as research/slow_trend_lab.js). Every stop entry, stop and market exit draws
 *              slippage as research/realism_lab.js (live demo fills, x3 near US news, 2% late +$3); a 2R target is a limit
 *              and fills at its price; a stop inside the fill bar counts first. 100 runs.
 *   pick       best median total R on 2023-2024.
 *   pass       on 2025-2026, both: (1) on its own, above 0 in at least 90% of runs with a median profit factor over 1.2
 *              and at least 30 trades; (2) added to today's H4 breakout (research/realism_lab.js settings, same fills),
 *              the pair's median profit / worst drawdown beats the H4 breakout alone. A pass is not built: it goes to the
 *              owner first. The fresh month is not used.
 * Results (11 Nov 2026, one run, 100 runs of random fills):
 *   2023-24 / 2025-26 median R (PF 2025-26): A9 X1 1.4 / 6.6 (1.06); A9 X2 26.3 / 43.8 (1.57); A21 X1 8.4 / 8.1 (1.16);
 *   A21 X2 38.9 / 11.4 (1.26; picked). Every choice made money in 2025-26 in all 100 runs, also with ideal fills.
 *   (1) on its own: A21 X2 passes (78 trades, PF 1.26, 100% of runs above 0).
 *   (2) with the H4 breakout, 2025-26 medians: breakout alone 32.4 R, worst drawdown 5.9 R, ratio 5.56; with the
 *   pullback 44.0 R, 13.1 R, ratio 3.35: more profit, but the drawdown more than doubles, because both enter the same
 *   trends and lose together when one ends. FAIL on the written rule. A9 X2 did better in 2025-26, but it was not the
 *   2023-24 pick, so it does not count.
 * Research only: nothing here trades.
 */
const R = require('./daytrade.js');
const I = require('./intraday.js');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const RUNS = Number(process.argv[2]) || 100;
const MIN = 60000, DAY = 86400000, SPLIT = I.SPLIT, FROM = Date.UTC(2023, 3, 3);
const LIVE = [0.03, 0.03, 0.58, 0.16, 0.02, 0.378, 0.085, 1.085, 0.422, 0.11], NEWS_X = 3, NEWS_WIN = 30 * MIN, LATE_P = 0.02, LATE_USD = 3, BASE = 0.05;
const SWAP_LONG = -5.92, SWAP_SHORT = 3.67, MAX_ATR = 2, MAX_STOP = I.MAX_STOP, ORDER_BARS = 2, TARGET_R = 2;
const H4_CFG = { dir: 'both', N: 20, M: 10, k: 2, ema: 100, maxBars: 60, barMin: 240, flat: false, swapLong: -5.92, swapShort: 3.67,
                 hardK: 4, targetR: 1.5, targetWait: true, maxStop: I.MAX_STOP, trail: { at: 1, dist: 0.5, broker: true },
                 firstEntryMin: 0, lastEntryMin: 24 * 60, flatMin: Infinity, from: -Infinity, to: Infinity };

const news = loadReleases(findCalendar(), null).times;
const nearNews = t => { const i = firstFrom(news, t - NEWS_WIN); return i < news.length && news[i] <= t + NEWS_WIN; };
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const h4 = R.toH4(R.load('XAUUSD.sml_H1.csv'));
const C = h4.map(k => k.c), E9 = I.ema(C, 9), E21 = I.ema(C, 21), E50 = I.ema(C, 50), ATR = I.atr(h4, 14);
const trendAt = j => {   // trend on closed bar j: 1, -1 or 0
  if (j < 1 || E50[j - 1] === null || E50[j] === null) return 0;
  if (E9[j] > E21[j] && E21[j] > E50[j] && E9[j] > E9[j - 1] && E21[j] > E21[j - 1] && E50[j] > E50[j - 1]) return 1;
  if (E9[j] < E21[j] && E21[j] < E50[j] && E9[j] < E9[j - 1] && E21[j] < E21[j - 1] && E50[j] < E50[j - 1]) return -1;
  return 0;
};
const nights = (t0, t1) => Math.max(0, Math.floor(t1 / DAY) - Math.floor(t0 / DAY));

function run(A, X, slip) {
  const avg = A === 'A9' ? E9 : E21, tr = [];
  let j = 51;
  while (j < h4.length - 1) {
    const k = h4[j], side = trendAt(j);
    if (k.t < FROM || k.t >= R.FRESH_FROM || !side || !ATR[j]) { j++; continue; }
    const touched = side === 1 ? k.l <= avg[j] && k.c > E50[j] : k.h >= avg[j] && k.c < E50[j];
    if (!touched) { j++; continue; }
    const level = side === 1 ? k.h : k.l, stop = side === 1 ? k.l : k.h, dist = Math.abs(level - stop);
    if (!(dist > 0) || dist > MAX_ATR * ATR[j] || dist > MAX_STOP) { j++; continue; }
    // the stop order works for the next 2 bars
    let fill = -1, entry = 0;
    for (let n = j + 1; n <= j + ORDER_BARS && n < h4.length; n++) {
      const b = h4[n];
      if (side === 1 ? b.h >= level : b.l <= level) {          // the Bid trades through the bar's high (low)
        const raw = side === 1 ? Math.max(b.o, level) + b.sp : Math.min(b.o, level);
        entry = raw + side * slip(b.t); fill = n; break;
      }
      if (side === 1 ? b.l <= stop : b.h + b.sp >= stop) break;   // the dip went on through its low first: cancelled
    }
    if (fill < 0) { j++; continue; }
    const risk = (entry - stop) * side;
    if (!(risk > 0)) { j = fill + 1; continue; }
    const tp = entry + side * TARGET_R * risk;
    let out = null;
    for (let n = fill; n < h4.length && !out; n++) {
      const b = h4[n];
      const hitStop = side === 1 ? b.l <= stop : b.h + b.sp >= stop;
      if (hitStop) { const px = n === fill ? stop : side === 1 ? Math.min(b.o, stop) : Math.max(b.o + b.sp, stop); out = { n, t: b.t, px: px - side * slip(b.t) }; break; }
      if (X === 'X1' && n > fill && (side === 1 ? b.h >= tp : b.l + b.sp <= tp)) { out = { n, t: b.t, px: tp }; break; }
      const closeOut = side === 1 ? b.c < E21[n] : b.c > E21[n];
      if (X === 'X2' && closeOut && n + 1 < h4.length) { const o = h4[n + 1]; out = { n: n + 1, t: o.t, px: (side === 1 ? o.o : o.o + o.sp) - side * slip(o.t) }; break; }
    }
    if (!out) break;
    const swap = (side === 1 ? SWAP_LONG : SWAP_SHORT) / 100 / 365 * entry * nights(h4[fill].t, out.t);
    tr.push({ t: h4[fill].t, x: out.t, r: ((out.px - entry) * side + swap) / risk });
    j = out.n + 1;
  }
  return tr;
}

const sum = a => a.reduce((x, y) => x + y, 0);
const pf = tr => { const w = sum(tr.filter(t => t.r > 0).map(t => t.r)), l = -sum(tr.filter(t => t.r <= 0).map(t => t.r)); return l ? w / l : Infinity; };
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const f = (v, d) => isFinite(v) ? v.toFixed(d === undefined ? 1 : d) : 'inf';
const ratio = tr => { let eq = 0, pk = 0, dd = 0; tr.slice().sort((a, b) => a.x - b.x).forEach(t => { eq += t.r; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }); return { r: eq, dd, q: dd ? eq / dd : Infinity }; };
const slipper = rand => t => BASE + LIVE[Math.floor(rand() * LIVE.length)] * (nearNews(t) ? NEWS_X : 1) + (rand() < LATE_P ? LATE_USD : 0);

console.log('Pullback entries on 4-hour bars, long and short, ' + RUNS + ' runs of random fills');
console.log('  choice  | 2023-24: n  med R    PF  win% | 2025-26: n  med R    PF  win%  runs>0 | ideal fills 2023-24 / 2025-26 R');
const res = [];
['A9', 'A21'].forEach(A => ['X1', 'X2'].forEach(X => {
  const ra = [], rb = [], pa = [], pb = [], wa = [], wb = []; let na = 0, nb = 0;
  for (let k = 0; k < RUNS; k++) {
    const tr = run(A, X, slipper(rng(8800 + k))), a = tr.filter(t => t.t < SPLIT), b = tr.filter(t => t.t >= SPLIT);
    ra.push(sum(a.map(t => t.r))); rb.push(sum(b.map(t => t.r))); pa.push(pf(a)); pb.push(pf(b));
    wa.push(a.filter(t => t.r > 0).length / (a.length || 1)); wb.push(b.filter(t => t.r > 0).length / (b.length || 1)); na = a.length; nb = b.length;
  }
  const ideal = run(A, X, () => BASE), ia = sum(ideal.filter(t => t.t < SPLIT).map(t => t.r)), ib = sum(ideal.filter(t => t.t >= SPLIT).map(t => t.r));
  const x = { A, X, aMed: pct(ra, 50), bMed: pct(rb, 50), bPf: pct(pb, 50), bPos: rb.filter(v => v > 0).length / RUNS, nb };
  res.push(x);
  console.log('  ' + (A + ' ' + X).padEnd(7) + ' |' + String(na).padStart(10) + f(x.aMed).padStart(7) + f(pct(pa, 50), 2).padStart(6) + (pct(wa, 50) * 100).toFixed(0).padStart(6) +
              ' |' + String(nb).padStart(10) + f(x.bMed).padStart(7) + f(x.bPf, 2).padStart(6) + (pct(wb, 50) * 100).toFixed(0).padStart(6) + ((x.bPos * 100).toFixed(0) + '%').padStart(8) +
              ' |' + f(ia).padStart(12) + ' / ' + f(ib));
}));
const pick = res.slice().sort((a, b) => b.aMed - a.aMed)[0];
const alone = pick.bPos >= 0.9 && pick.bPf > 1.2 && pick.nb >= 30;
// (2) added to the H4 breakout, same fill draws for both
const h4Only = [], pair = [];
for (let k = 0; k < RUNS; k++) {
  const rand = rng(9900 + k), slip = slipper(rand);
  const brk = R.simulate(h4, Object.assign({}, H4_CFG, { slipFn: t => slip(t) - BASE })).filter(t => t.t >= SPLIT && t.t < R.FRESH_FROM).map(t => ({ t: t.t, x: t.exitT, r: t.r }));
  const pb2 = run(pick.A, pick.X, slip).filter(t => t.t >= SPLIT);
  h4Only.push(ratio(brk)); pair.push(ratio(brk.concat(pb2)));
}
const qOnly = pct(h4Only.map(x => x.q), 50), qPair = pct(pair.map(x => x.q), 50), together = qPair > qOnly;
console.log('  picked on 2023-2024: ' + pick.A + ' ' + pick.X + ' -> 2025-2026 on its own: median ' + f(pick.bMed) + ' R, PF ' + f(pick.bPf, 2) + ', above 0 in ' + (pick.bPos * 100).toFixed(0) + '% of runs, ' + pick.nb + ' trades -> ' + (alone ? 'pass' : 'fail'));
console.log('  with the H4 breakout, 2025-2026 medians: breakout alone ' + f(pct(h4Only.map(x => x.r), 50)) + ' R, worst drawdown ' + f(pct(h4Only.map(x => x.dd), 50)) + ' R, ratio ' + f(qOnly, 2) +
            '; with the pullback ' + f(pct(pair.map(x => x.r), 50)) + ' R, ' + f(pct(pair.map(x => x.dd), 50)) + ' R, ratio ' + f(qPair, 2) + ' -> ' + (together ? 'better' : 'not better'));
console.log('  overall: ' + (alone && together ? 'PASS (goes to the owner; not built)' : 'FAIL'));
