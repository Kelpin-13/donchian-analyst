/**
 * The "3-candle daily bias" (owner's videos, 8 Nov 2026): read the day's direction from the last two closed daily bars,
 * then trade only that way. Rules fixed before the first run.
 *
 *   node research/three_bar_lab.js [runs]
 *
 * The rule, on broker-server days (bar 1 = two days ago, bar 2 = yesterday, bar 3 = today):
 *   long bias   bar 2 CLOSED above bar 1's high (the body, not the wick)      -> today should trade above bar 2's high
 *   short bias  bar 2 closed below bar 1's low                                -> today should trade below bar 2's low
 *   outside bar bar 2's high above bar 1's high AND its low below bar 1's low  -> no bias (checked first)
 *   inside bar  bar 2 inside bar 1's range                                    -> yesterday's bias carries on
 *   otherwise   no bias
 * Part 1, the claim: how often today's high beats bar 2's high on long-bias days (and the low on short-bias days),
 *   against all days, on D1 and on H4 bars. The video says "must".
 * Part 2, as a filter on the four intraday strategies still trading (research/intraday.js portfolio):
 *   F1 trade only the bias side, nothing on no-bias days; F2 block only the side against the bias.
 *   Realistic fills as research/realism_lab.js (live demo fills, x3 near US news, 2% late +$3), 100 runs, same seeds
 *   for the filtered and unfiltered book. Score: total R and total R / worst drawdown in R, per half.
 *   Pick F1 or F2 on 2023-04 to 2024 by median ratio; adopt only if on 2025-2026 its median ratio beats the unfiltered
 *   book AND its median total R is at least 90% of the unfiltered book's. The fresh month is not used.
 * Results (8 Nov 2026; one 3-run smoke test, then this one 100-run run, rules unchanged):
 *   the claim: after a long bias, today beat bar 2's high on 74% of days (52% on all days) but CLOSED up on only 51%;
 *   after a short bias, 54% broke bar 2's low (43% on all days), 43% closed down. H4: 65% / 60%, closed with the bias
 *   50% / 46%. The target is near (bar 2 closed beyond bar 1, so close to its own extreme), so it is touched more
 *   often, but the day's direction is a coin toss: no edge to trade on.
 *   the filter (median R, R / worst drawdown): none 12.4 R, 0.31 / 22.4 R, 1.57; F1 15.4, 1.62 / -9.8, -0.74;
 *   F2 -1.5, -0.04 / 30.9, 3.75. Picked F1 on 2023-24; on 2025-26 it lost: FAIL. F2 flipped from worst to best
 *   between the halves, the sign of noise, not of a rule.
 * Research only: nothing here trades.
 */
const R = require('./daytrade.js');
const I = require('./intraday.js');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const RUNS = Number(process.argv[2]) || 100;
const MIN = 60000, SPLIT = I.SPLIT, FROM = Date.UTC(2023, 3, 3);
const LIVE = [0.03, 0.03, 0.58, 0.16, 0.02, 0.378, 0.085, 1.085, 0.422, 0.11], NEWS_X = 3, NEWS_WIN = 30 * MIN, LATE_P = 0.02, LATE_USD = 3;
const news = loadReleases(findCalendar(), null).times;
const nearNews = t => { const i = firstFrom(news, t - NEWS_WIN); return i < news.length && news[i] <= t + NEWS_WIN; };
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const f = (v, d) => isFinite(v) ? v.toFixed(d === undefined ? 1 : d) : 'inf';
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

/** Bias of each bar in `bs` (needs h, l, c) for the bar after it: index j holds the bias for bar j, from bars j-2, j-1. */
function biasOf(bs) {
  const b = new Array(bs.length).fill(0);
  for (let j = 2; j < bs.length; j++) {
    const one = bs[j - 2], two = bs[j - 1];
    if (two.h > one.h && two.l < one.l) b[j] = 0;
    else if (two.c > one.h) b[j] = 1;
    else if (two.c < one.l) b[j] = -1;
    else if (two.h <= one.h && two.l >= one.l) b[j] = b[j - 1];
    else b[j] = 0;
  }
  return b;
}

// ---------------- part 1: the claim ----------------
function claim(name, bs) {
  const b = biasOf(bs), rows = { 1: [0, 0], '-1': [0, 0], 0: [0, 0] }; let upAll = 0, dnAll = 0, n = 0, dirL = [0, 0], dirS = [0, 0];
  for (let j = 2; j < bs.length; j++) {
    if (bs[j].t < FROM || bs[j].t >= R.FRESH_FROM) continue;
    const up = bs[j].h > bs[j - 1].h, dn = bs[j].l < bs[j - 1].l; n++; if (up) upAll++; if (dn) dnAll++;
    if (b[j] === 1) { rows[1][0]++; if (up) rows[1][1]++; dirL[0]++; if (bs[j].c > bs[j].o) dirL[1]++; }
    else if (b[j] === -1) { rows['-1'][0]++; if (dn) rows['-1'][1]++; dirS[0]++; if (bs[j].c < bs[j].o) dirS[1]++; }
    else rows[0][0]++;
  }
  const p = (a, x) => (a / (x || 1) * 100).toFixed(0) + '%';
  console.log('  ' + name.padEnd(4) + ' bars ' + n + ': long bias ' + rows[1][0] + ' (beat bar 2 high ' + p(rows[1][1], rows[1][0]) + ' vs ' + p(upAll, n) + ' on all bars; closed up ' + p(dirL[1], dirL[0]) + ')' +
              ', short bias ' + rows['-1'][0] + ' (broke bar 2 low ' + p(rows['-1'][1], rows['-1'][0]) + ' vs ' + p(dnAll, n) + '; closed down ' + p(dirS[1], dirS[0]) + '), no bias ' + rows[0][0]);
}
const h1 = R.load('XAUUSD.sml_H1.csv'), m15 = R.load('XAUUSD.sml_M15.csv');
const D = I.dailyOf(m15), dayBias = biasOf(D.days.map(x => ({ t: x.d, h: x.h, l: x.l, c: x.c, o: x.o })));
console.log('3-candle bias. Part 1, the claim (2023-04 to 2026-10-08):');
claim('D1', I.dailyOf(h1).days.map(x => Object.assign({ t: h1[x.i].t }, x)));
claim('H4', R.toH4(h1));

// ---------------- part 2: as a filter ----------------
const barBias = m15.map(k => { const j = D.index.get(Math.floor(k.t / 86400000)); return j === undefined ? 0 : dayBias[j]; });
const dayKeyOk = D.index.has(Math.floor(m15[0].t / 86400000));
if (!dayKeyOk) { console.log('day index does not match the bars: stop'); process.exit(1); }
function filtered(S, mode) {
  const ok = (side, b) => mode === 'F1' ? side === b : b === 0 || side === b;
  const keep = (i, d) => {
    if (!d) return d;
    const b = barBias[i], x = Object.assign({}, d);
    if (x.orders) x.orders = x.orders.filter(o => ok(o.side, b)).map(o => Object.assign({}, o, { reverse: o.reverse && ok(-o.side, b) }));
    if (x.enter && !ok(x.enter.side, b)) delete x.enter;
    return x;
  };
  return Object.assign({}, S, { onDay: S.onDay && (i => keep(i, S.onDay(i))), onClose: S.onClose && ((i, pos, Dd, n) => keep(i, S.onClose(i, pos, Dd, n))) });
}
const P = I.portfolio(m15), IDS = Object.keys(P);
function book(mode, slipFn) {
  const tr = [];
  IDS.forEach(id => I.backtest(m15, mode ? filtered(P[id], mode) : P[id], { slip: I.COSTS.real.slip, slipFn }).forEach(t => { if (t.t >= FROM && t.t < R.FRESH_FROM) tr.push({ t: t.t, x: t.exitT, r: t.r }); }));
  return tr.sort((a, b) => a.x - b.x);
}
function score(tr) {
  const s = part => { let eq = 0, pk = 0, dd = 0; part.forEach(t => { eq += t.r; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }); return { r: eq, dd, ratio: dd ? eq / dd : Infinity, n: part.length }; };
  return { a: s(tr.filter(t => t.t < SPLIT)), b: s(tr.filter(t => t.t >= SPLIT)) };
}
const MODES = ['none', 'F1', 'F2'], res = { none: [], F1: [], F2: [] };
for (let k = 0; k < RUNS; k++) {
  MODES.forEach(mode => {
    const rand = rng(7300 + k);   // the same seed for every mode: the same stream of draws
    const slipFn = t => LIVE[Math.floor(rand() * LIVE.length)] * (nearNews(t) ? NEWS_X : 1) + (rand() < LATE_P ? LATE_USD : 0);
    res[mode].push(score(book(mode === 'none' ? null : mode, slipFn)));
  });
}
console.log('Part 2, as a filter on ' + IDS.join(', ') + ' (' + RUNS + ' runs of random fills, medians):');
console.log('  filter | 2023-24: trades   R   worst DD  R/DD | 2025-26: trades   R   worst DD  R/DD');
const med = (mode, h, key) => pct(res[mode].map(x => x[h][key]), 50);
MODES.forEach(mode => console.log('  ' + mode.padEnd(6) + ' |' + String(med(mode, 'a', 'n')).padStart(15) + f(med(mode, 'a', 'r')).padStart(7) + f(med(mode, 'a', 'dd')).padStart(9) + f(med(mode, 'a', 'ratio'), 2).padStart(7) +
                                   ' |' + String(med(mode, 'b', 'n')).padStart(15) + f(med(mode, 'b', 'r')).padStart(7) + f(med(mode, 'b', 'dd')).padStart(9) + f(med(mode, 'b', 'ratio'), 2).padStart(7)));
const pick = med('F1', 'a', 'ratio') >= med('F2', 'a', 'ratio') ? 'F1' : 'F2';
const pass = med(pick, 'b', 'ratio') > med('none', 'b', 'ratio') && med(pick, 'b', 'r') >= 0.9 * med('none', 'b', 'r');
console.log('  picked on 2023-24: ' + pick + ' -> 2025-26 ratio ' + f(med(pick, 'b', 'ratio'), 2) + ' vs ' + f(med('none', 'b', 'ratio'), 2) + ', R ' + f(med(pick, 'b', 'r')) + ' vs ' + f(med('none', 'b', 'r')) + ' -> ' + (pass ? 'PASS' : 'FAIL'));
