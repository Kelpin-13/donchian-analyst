/**
 * A strategy for ranging markets (research queue item 5, owner approved 6 Nov 2026; run 14 Nov 2026).
 *
 *   node research/range_lab.js [runs]
 *
 * Question: the book makes most of its money on trending, volatile days (DESIGN section 22). Does a mean-reversion
 * strategy that trades ONLY on ranging days add to the book at realistic fills?
 * Everything below was fixed before the first run.
 *   - range day   efficiency ratio of the last 10 daily closes under 0.25 (|close[-1] - close[-11]| / sum of the ten
 *                 daily moves), server days built from the M15 bars, known before the day starts (as sections 22, 32).
 *                 Every candidate trades on range days only.
 *   - candidates  three, each a published rule, on M15 bars, flat by 23:00, one position at a time, $150 stop cap,
 *                 1 R = the stop distance, same size as the others (0.5% = $50 a 1 R):
 *       A ASIAN_FADE   Asian-range fade (the "London fake-out" of the Asian box, the mirror of our Asian breakout):
 *                      at 09:00 a sell limit at the 01:00-09:00 high and a buy limit at its low, good until 15:00;
 *                      stop half the range's width beyond the edge, take-profit the middle of the range (1 R).
 *                      The first edge touched is the day's only trade.
 *       B BB_REVERT    Bollinger(20, 2) reversion (Bollinger; the queue's wording): an M15 close outside the band,
 *                      03:00-20:00, enter at the next open back towards the 20-bar average; out on a close at or
 *                      beyond the average; stop 1.5 x ATR(14, M15). At most 3 trades a day.
 *       C VWAP_REVERT  VWAP band fade: VWAP from the day's first bar (typical price x tick volume) and its
 *                      volume-weighted standard deviation; an M15 close more than 2 sd from VWAP, 03:00-20:00, enter
 *                      at the next open towards VWAP; out on a close at or beyond VWAP; stop 1.5 x ATR(14, M15).
 *                      At most 2 trades a day.
 *   - book        the strategies still trading (I.portfolio default) + H4 with the trail (as realism_lab.js),
 *                 from 2023-04-03 to 2026-10-08 (fresh bars not loaded, never used here).
 *   - fills       realism_lab.js model on top of the research costs (live demo draws, x3 within 30 min of US news,
 *                 2% late +$3), 100 runs. The book is run once per run (seed 1000 + run) and is the SAME trades under
 *                 every choice; each candidate draws its own fills. Limit entries fill at their level without slippage
 *                 (a stop inside the entry bar counts first, no target on the entry bar); every market entry, signal
 *                 exit and stop draws slippage.
 *   - measure     profit / drawdown in dollars (R x 50, not compounded), drawdown = largest peak-to-trough on the
 *                 trades in exit order. "Range days only" = the trades ENTERED on a range day (book and candidate).
 *   - pick        on 2023-2024 only: the candidate with the best median profit/drawdown of book + candidate on range
 *                 days. It must beat "none" (the book alone) there AND make money by itself there (its own median
 *                 total R above 0; added by this script, stricter than the queue's rule). If no candidate does,
 *                 the study is FAIL at once and nothing is judged on 2025-2026.
 *   - pass        judged once on 2025-2026 for the picked candidate, all three needed:
 *                 (1) range days: worst-5% profit/drawdown of book + candidate better than the book alone;
 *                 (2) range days: median profit at least 90% of the book alone's;
 *                 (3) all days: the whole book's worst-5% drawdown with the candidate not worse than without it.
 *                 The other candidates' 2025-2026 numbers are printed for information only.
 * Past failures to beat: RSI(2) pullback and the Asian Bollinger fade (intraday.js; both lost at research costs),
 * the 1-hour range-edge fade (fade_lab.js, section 32).
 * A pass is not built: it goes to the owner under "Needs the owner".
 *
 * Results (14 Nov 2026, one run, 100 runs of random fills; no bug fix, nothing changed after the run):
 *   Range days: 212 of 452 in 2023-24, 200 of 457 in 2025-26 (about 45%).
 *   Candidates alone, 2023-24, median total R / PF / win% (runs above 0): ASIAN_FADE -14.0 / 0.87 / 49% (0%);
 *     BB_REVERT -202.4 / 0.54 / 39% (0%); VWAP_REVERT -132.6 / 0.54 / 39% (0%). At research costs only (no random fills)
 *     they still lose there: -3.8, -41.4, -26.2 R.
 *   Book + candidate on range days, 2023-24, median profit/drawdown: book alone -0.22 (median profit +$29, drawdown
 *     $1,274); + ASIAN_FADE -0.46; + BB_REVERT -0.94; + VWAP_REVERT -0.97. All days: 0.77 alone; 0.32, -0.93, -0.76 with.
 *   No candidate beats the book alone on range days or makes money by itself on 2023-24: FAIL at once. Nothing was
 *   judged on 2025-26 (the candidates-alone table printed their 2025-26 medians for information: -5.8, -43.2, -48.4 R,
 *   no run above 0; at research costs -3.6, +5.6, -22.2 R; not a result, nothing was picked from it).
 *   Reading: the Asian-range fade is close to a coin toss (49% wins at 1 R) that pays the spread; the two band fades
 *   lose before any extra slippage. On this broker's gold a stretched price on a range day still keeps going more often
 *   than it comes back. Side finding: the book itself makes nothing on range days in 2023-24 (median +$29 on 382 trades).
 *   Output kept in data/reports/range_lab.txt.
 * Research only: nothing here trades.
 */
const I = require('./intraday.js');
const R = require('./daytrade.js');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const RUNS = Number(process.argv[2]) || 100;
const MIN = 60000, DAY = 86400000, FROM = Date.UTC(2023, 3, 3), RISK_USD = 50, ER_MAX = 0.25;
const LIVE = [0.03, 0.03, 0.58, 0.16, 0.02, 0.378, 0.085, 1.085, 0.422, 0.11];
const NEWS_X = 3, NEWS_WIN = 30 * MIN, LATE_P = 0.02, LATE_USD = 3;
const H4_CFG = { dir: 'both', N: 20, M: 10, k: 2, ema: 100, maxBars: 60, barMin: 240, flat: false, swapLong: -5.92, swapShort: 3.67,
                 hardK: 4, targetR: 1.5, targetWait: true, maxStop: I.MAX_STOP, trail: { at: 1, dist: 0.5, broker: true },
                 firstEntryMin: 0, lastEntryMin: 24 * 60, flatMin: Infinity, from: -Infinity, to: Infinity };

const news = loadReleases(findCalendar(), null).times;
const nearNews = t => { const i = firstFrom(news, t - NEWS_WIN); return i < news.length && news[i] <= t + NEWS_WIN; };
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const draw = rand => t => { let x = LIVE[Math.floor(rand() * LIVE.length)]; if (nearNews(t)) x *= NEWS_X; if (rand() < LATE_P) x += LATE_USD; return x; };
const dayOf = t => Math.floor(t / DAY);
const mod = t => { const d = new Date(t); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const hm = (h, m) => h * 60 + (m || 0);

const m15 = R.load('XAUUSD.sml_M15.csv'), h4 = R.toH4(R.load('XAUUSD.sml_H1.csv'));
const P = I.portfolio(m15);
const IDS = Object.keys(P).concat(['H4']);

// Range days: efficiency ratio of the previous 10 daily closes under ER_MAX, known at the day's first bar.
const { days } = I.dailyOf(m15);
const ranging = new Set();
days.forEach((x, j) => {
  if (j < 11) return;
  let len = 0;
  for (let q = j - 10; q < j; q++) len += Math.abs(days[q].c - days[q - 1].c);
  if (len && Math.abs(days[j - 1].c - days[j - 11].c) / len < ER_MAX) ranging.add(x.d);
});
const isRange = t => ranging.has(dayOf(t));

const closes = m15.map(b => b.c), atr14 = I.atr(m15, 14), bb = I.bollinger(closes, 20, 2);
const CANDS = [
  { id: 'ASIAN_FADE', S: {
    name: 'ASIAN_FADE', flatMin: hm(23), maxPerDay: 1, maxStop: I.MAX_STOP,
    onDay: i => ({ on: isRange(m15[i].t), hi: -Infinity, lo: Infinity, n: 0 }),
    onClose(i, pos, D) {
      if (!D.on) return null;
      const k = m15[i], m = mod(k.t);
      if (m >= hm(1) && m < hm(9)) { D.hi = Math.max(D.hi, k.h); D.lo = Math.min(D.lo, k.l); D.n++; }
      if (m !== hm(9) - 15 || D.n < 24) return null;          // range not complete (data gap), as the Asian breakout
      const W = D.hi - D.lo;
      if (!(W > 0)) return null;
      return { orders: [{ side: -1, level: D.hi, stop: D.hi + 0.5 * W, targetR: 1, until: hm(15), limit: true },
                        { side: 1, level: D.lo, stop: D.lo - 0.5 * W, targetR: 1, until: hm(15), limit: true }] };
    } } },
  { id: 'BB_REVERT', S: {
    name: 'BB_REVERT', flatMin: hm(23), maxPerDay: 3, maxStop: I.MAX_STOP,
    onDay: i => ({ on: isRange(m15[i].t) }),
    onClose(i, pos, D) {
      const k = m15[i], m = mod(k.t), a = atr14[i];
      if (!D.on || bb.mid[i] === null || a === null) return null;
      if (pos) return (pos.side === 1 ? k.c >= bb.mid[i] : k.c <= bb.mid[i]) ? { exit: 'SIGNAL' } : null;
      if (m < hm(3) || m >= hm(20)) return null;
      if (k.c < bb.lo[i]) return { enter: { side: 1, stopDist: 1.5 * a } };
      if (k.c > bb.up[i]) return { enter: { side: -1, stopDist: 1.5 * a } };
      return null;
    } } },
  { id: 'VWAP_REVERT', S: {
    name: 'VWAP_REVERT', flatMin: hm(23), maxPerDay: 2, maxStop: I.MAX_STOP,
    onDay: i => ({ on: isRange(m15[i].t), pv: 0, pv2: 0, v: 0 }),
    onClose(i, pos, D) {
      if (!D.on) return null;
      const k = m15[i], m = mod(k.t), a = atr14[i], tp = (k.h + k.l + k.c) / 3, w = k.v > 0 ? k.v : 1;
      D.pv += tp * w; D.pv2 += tp * tp * w; D.v += w;
      const vwap = D.pv / D.v, sd = Math.sqrt(Math.max(D.pv2 / D.v - vwap * vwap, 0));
      if (pos) return (pos.side === 1 ? k.c >= vwap : k.c <= vwap) ? { exit: 'SIGNAL' } : null;
      if (a === null || !(sd > 0) || m < hm(3) || m >= hm(20)) return null;
      if (k.c < vwap - 2 * sd) return { enter: { side: 1, stopDist: 1.5 * a } };
      if (k.c > vwap + 2 * sd) return { enter: { side: -1, stopDist: 1.5 * a } };
      return null;
    } } }
];

function book(slipFn) {
  const tr = [];
  Object.keys(P).forEach(id => I.backtest(m15, P[id], { slip: I.COSTS.real.slip, slipFn }).forEach(t => tr.push({ id, t: t.t, x: t.exitT, r: t.r })));
  R.simulate(h4, Object.assign({}, H4_CFG, { slipFn })).forEach(t => tr.push({ id: 'H4', t: t.t, x: t.exitT, r: t.r }));
  return tr.filter(t => t.t >= FROM);
}
const cand = (c, slipFn) => I.backtest(m15, c.S, { slip: I.COSTS.real.slip, slipFn }).map(t => ({ id: c.id, t: t.t, x: t.exitT, r: t.r })).filter(t => t.t >= FROM);
function score(tr) {
  let cu = 0, pk = 0, dd = 0;
  tr.slice().sort((a, b) => a.x - b.x).forEach(t => { cu += t.r * RISK_USD; pk = Math.max(pk, cu); dd = Math.max(dd, pk - cu); });
  return { usd: cu, dd, ratio: dd > 0 ? cu / dd : (cu > 0 ? 99 : 0), n: tr.length };
}
const sumR = tr => tr.reduce((x, t) => x + t.r, 0);
const pf = tr => { const w = sumR(tr.filter(t => t.r > 0)), l = -sumR(tr.filter(t => t.r <= 0)); return l ? w / l : Infinity; };
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const f = (v, d) => isFinite(v) ? v.toFixed(d === undefined ? 0 : d) : 'inf';
const HALF = { a: t => t.t < I.SPLIT, b: t => t.t >= I.SPLIT };

// res[choice][half][scope] = score per run; choice 0 = none (the book alone), 1..3 = book + candidate.
const res = [0, 1, 2, 3].map(() => ({ a: { range: [], all: [] }, b: { range: [], all: [] } }));
// own[candidate][half] = per run { r, pf, win, n }
const own = CANDS.map(() => ({ a: [], b: [] }));
for (let k = 0; k < RUNS; k++) {
  const bk = book(draw(rng(1000 + k)));
  const cs = CANDS.map((c, j) => cand(c, draw(rng(900000 + 1000 * j + k))));
  ['a', 'b'].forEach(h => {
    const b = bk.filter(HALF[h]);
    [null].concat(cs).forEach((c, ci) => {
      const tr = c ? b.concat(c.filter(HALF[h])) : b;
      res[ci][h].all.push(score(tr));
      res[ci][h].range.push(score(tr.filter(t => isRange(t.t))));
      if (c) { const o = c.filter(HALF[h]); own[ci - 1][h].push({ r: sumR(o), pf: pf(o), win: o.filter(t => t.r > 0).length / (o.length || 1) * 100, n: o.length }); }
    });
  });
}
const S = (ci, h, scope) => {
  const a = res[ci][h][scope], q = a.map(s => s.ratio), u = a.map(s => s.usd), d = a.map(s => s.dd);
  return { r5: pct(q, 5), r50: pct(q, 50), r95: pct(q, 95), u5: pct(u, 5), u50: pct(u, 50), u95: pct(u, 95), d50: pct(d, 50), d95: pct(d, 95), n: pct(a.map(s => s.n), 50) };
};
const O = (j, h, key) => pct(own[j][h].map(x => x[key]), 50);
const NAMES = ['none'].concat(CANDS.map(c => '+ ' + c.id));

const rangeDays = days.filter(x => x.d * DAY >= FROM), nA = rangeDays.filter(x => x.d * DAY < I.SPLIT), nB = rangeDays.filter(x => x.d * DAY >= I.SPLIT);
console.log('Ranging-market strategy, book: ' + IDS.join(', ') + '; $' + RISK_USD + ' a 1 R, ' + RUNS + ' runs of random fills (the book is the same trades under every choice).');
console.log('Range days (efficiency ratio of 10 daily closes < ' + ER_MAX + '): 2023-24 ' + nA.filter(x => ranging.has(x.d)).length + ' of ' + nA.length +
            ', 2025-26 ' + nB.filter(x => ranging.has(x.d)).length + ' of ' + nB.length + '.');

console.log('\n=== The candidates by themselves (range days only by rule), medians over the runs');
console.log('  candidate    | 2023-24: n  total R    PF  win%  runs>0 | 2025-26: n  total R    PF  win%  runs>0 | research costs only: R 2023-24 / 2025-26');
CANDS.forEach((c, j) => {
  const ideal = cand(c, null), ia = sumR(ideal.filter(HALF.a)), ib = sumR(ideal.filter(HALF.b));
  const row = h => String(O(j, h, 'n')).padStart(10) + f(O(j, h, 'r'), 1).padStart(9) + f(O(j, h, 'pf'), 2).padStart(6) + f(O(j, h, 'win')).padStart(6) +
                   (f(own[j][h].filter(x => x.r > 0).length / RUNS * 100) + '%').padStart(8);
  console.log('  ' + c.id.padEnd(12) + ' |' + row('a') + ' |' + row('b') + ' |' + f(ia, 1).padStart(12) + ' / ' + f(ib, 1));
});

const line = s => String(s.n).padStart(7) + f(s.u5).padStart(8) + f(s.u50).padStart(7) + f(s.u95).padStart(7) + ' |' + f(s.d50).padStart(6) + f(s.d95).padStart(6) + ' |' +
                  f(s.r5, 2).padStart(7) + f(s.r50, 2).padStart(6) + f(s.r95, 2).padStart(6);
const HEAD = '  choice          trades  profit $ worst5% med best5% | dd $ med worst5% | profit/dd worst5% med best5%';
function table(h, scope, title, only) {
  console.log('\n=== ' + title);
  console.log(HEAD);
  NAMES.forEach((n, ci) => { if (!only || only.includes(ci)) console.log('  ' + n.padEnd(15) + line(S(ci, h, scope))); });
}
table('a', 'range', 'Book + candidate, range days only, 2023-24 (the pick is made here)');
table('a', 'all', 'Book + candidate, all days, 2023-24');

// Pick on 2023-24: best range-day median profit/dd, must beat none and make money by itself.
const a0 = S(0, 'a', 'range');
const ok = CANDS.map((c, j) => ({ c, ci: j + 1, s: S(j + 1, 'a', 'range'), ownR: O(j, 'a', 'r') })).filter(x => x.s.r50 > a0.r50 && x.ownR > 0).sort((x, y) => y.s.r50 - x.s.r50);
let verdict;
if (!ok.length) {
  verdict = 'FAIL (no candidate both beats the book alone on range days and makes money by itself on 2023-24; nothing judged on 2025-26)';
  console.log('\nPicked on 2023-24: nothing. Book alone, range days: median profit/dd ' + f(a0.r50, 2) + '. ' +
              CANDS.map((c, j) => c.id + ' ' + f(S(j + 1, 'a', 'range').r50, 2) + ' (own median ' + f(O(j, 'a', 'r'), 1) + ' R)').join('; ') + '.');
} else {
  const pk = ok[0];
  console.log('\nPicked on 2023-24: ' + pk.c.id + ' (range days median profit/dd ' + f(pk.s.r50, 2) + ' vs ' + f(a0.r50, 2) + ' for the book alone; own median ' + f(pk.ownR, 1) + ' R).');
  table('b', 'range', 'Book + candidate, range days only, 2025-26 (judged once, the picked candidate; the others for information)');
  table('b', 'all', 'Book + candidate, all days, 2025-26');
  const n = S(0, 'b', 'range'), g = S(pk.ci, 'b', 'range'), nAll = S(0, 'b', 'all'), gAll = S(pk.ci, 'b', 'all');
  const t1 = g.r5 > n.r5, t2 = g.u50 >= 0.9 * n.u50, t3 = gAll.d95 <= nAll.d95;
  console.log('\n2025-26, seen once, ' + pk.c.id + ':');
  console.log('  (1) range days worst-5% profit/dd ' + f(g.r5, 2) + ' vs ' + f(n.r5, 2) + ' (needs better): ' + (t1 ? 'yes' : 'no'));
  console.log('  (2) range days median profit $' + f(g.u50) + ' vs $' + f(n.u50) + ' = ' + f(g.u50 / n.u50 * 100) + '% (needs >= 90%): ' + (t2 ? 'yes' : 'no'));
  console.log('  (3) all days worst-5% drawdown $' + f(gAll.d95) + ' vs $' + f(nAll.d95) + ' (needs not worse): ' + (t3 ? 'yes' : 'no'));
  verdict = t1 && t2 && t3 ? 'PASS (goes to the owner; not built)' : 'FAIL';
}
console.log('\nVERDICT: ' + verdict);
