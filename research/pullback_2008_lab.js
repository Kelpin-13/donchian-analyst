/**
 * The pullback entry of research/pullback_lab.js on the older bars, 2008-2022 (research queue item 15, the part left
 * "still to do" on 11 Nov 2026, now that data/XAUUSD.sml_H1_2008.csv exists, exported 19 Nov 2026). Section 36 found the
 * pullback makes money alone on 2025-26 but more than doubles the H4 breakout's drawdown when added to it. The question
 * here: on 15 earlier years, where the H4 breakout had weaker years, does the pair do better than the breakout alone?
 * Everything below was written before the first run.
 *
 *   node research/pullback_2008_lab.js [runs]
 *
 * Rules: exactly research/pullback_lab.js (trend EMA 9 > 21 > 50 all rising; a bar dips to the average and closes above
 * EMA 50; buy stop above its high for 2 bars; stop at its low, at most 2 ATR(14) and $150 at 0.01 lots; long and short).
 * Its run() is copied here with the bars as an argument (pullback_lab.js runs on require); nothing in it is changed.
 * The H4 breakout: the same H4_CFG as pullback_lab.js (today's DonchianGold 1.08 with the trail), R.simulate unchanged.
 *   bars       4-hour bars built with R.toH4 from data/XAUUSD.sml_H1_2008.csv (server time; R.load keeps bars before
 *              9 Oct 2026, and this study cuts them at 2023-02-01 so nothing after 2022 is read except to close a trade
 *              still open at the end of 2022).
 *   period     entries 2008-03-03 to 2022-12-31 (the EMAs and the breakout's EMA 100 warm up on Jan-Feb 2008).
 *              Eras for information: 2008-12, 2013-17, 2018-22.
 *   choice     FIXED: A21 X2, the 2023-24 pick of section 36. No new picking. The other three choices are printed for
 *              information only.
 *   costs      as pullback_lab.js: the bar's spread, $0.05, the realistic fill draws of research/realism_lab.js (live demo
 *              fills, x3 within 30 min of US news, 2% late +$3), swap at today's demo rates, 100 runs. The broker's file has
 *              spread 0 on every bar before 2021, so a bar with spread 0 gets $0.30 (about 2022's average, above 2023-26's
 *              $0.11): the main result. The spread-0 version is printed for information.
 *   check      (information) the same code on this file's 2023-04 to 2025-12 bars, ideal fills, A21 X2, should give about
 *              the trade count and R of pullback_lab.js on the 2023-26 file (differences only from a different export).
 *   pass       on 2008-2022, A21 X2, both: (1) on its own, total R above 0 in at least 90% of runs, median profit factor
 *              over 1.2, at least 30 trades; (2) added to the H4 breakout (same fill draws), the pair's median total R /
 *              worst drawdown beats the breakout alone. Same rule as section 36, only the period differs.
 *   meaning    the pair already failed 2025-26 (section 36). Section 36: a pair that helps in only one era is not built.
 *              So a PASS here means "helps on 2008-22 but not 2025-26": reported to the owner, still not built.
 *              A FAIL closes item 15.
 *
 * Results (21 Nov 2026, one run, 100 runs of random fills; output in data/reports/pullback_2008.txt):
 *   check: this file's 2023-04..2026-10 bars give 68 trades +45.6 R (2023-24) and 78 trades +14.0 R (2025-26) at ideal
 *   fills, the same as pullback_lab.js on the 2023-26 file.
 *   2008-22 median R (PF): A9 X1 -219.4 (0.77); A9 X2 -28.5 (0.96); A21 X1 -78.7 (0.82); A21 X2 -30.7 (0.93), 615 trades,
 *   0% of runs above 0; by era 2008-12 +12.0, 2013-17 +12.9, 2018-22 -53.8. With spread 0 (no $0.30 fill): A21 X2 -7.2.
 *   (1) on its own: FAIL. (2) pair ratio -0.63 vs breakout alone -0.68, "better" only because both lose: breakout alone
 *   -44.3 R, worst drawdown 65.3 R; with the pullback -74.2 R, 119.1 R. Overall FAIL; item 15 closed.
 *   Seen after the run, information only: the H4 breakout itself loses 2008-22 at these costs (-44.3 R median); with spread
 *   0 and no slippage it makes +30.8 R on 900 trades. The live-demo slippage is in dollars, and gold's price and stops were
 *   3-5 times smaller in 2008-2019, so the same dollar costs weigh 3-5 times more in R there.
 *
 * Research only: nothing here trades.
 */
const R = require('./daytrade.js');
const I = require('./intraday.js');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const RUNS = Number(process.argv[2]) || 100;
const MIN = 60000, DAY = 86400000;
const FROM = Date.UTC(2008, 2, 3), TO = Date.UTC(2023, 0, 1), CUT = Date.UTC(2023, 1, 1);
const ERAS = [['2008-12', FROM, Date.UTC(2013, 0, 1)], ['2013-17', Date.UTC(2013, 0, 1), Date.UTC(2018, 0, 1)], ['2018-22', Date.UTC(2018, 0, 1), TO]];
const FILL_SPREAD = 0.30;
const LIVE = [0.03, 0.03, 0.58, 0.16, 0.02, 0.378, 0.085, 1.085, 0.422, 0.11], NEWS_X = 3, NEWS_WIN = 30 * MIN, LATE_P = 0.02, LATE_USD = 3, BASE = 0.05;
const SWAP_LONG = -5.92, SWAP_SHORT = 3.67, MAX_ATR = 2, MAX_STOP = I.MAX_STOP, ORDER_BARS = 2, TARGET_R = 2;
const H4_CFG = { dir: 'both', N: 20, M: 10, k: 2, ema: 100, maxBars: 60, barMin: 240, flat: false, swapLong: -5.92, swapShort: 3.67,
                 hardK: 4, targetR: 1.5, targetWait: true, maxStop: I.MAX_STOP, trail: { at: 1, dist: 0.5, broker: true },
                 firstEntryMin: 0, lastEntryMin: 24 * 60, flatMin: Infinity, from: -Infinity, to: Infinity };

const news = loadReleases(findCalendar(), null).times;
const nearNews = t => { const i = firstFrom(news, t - NEWS_WIN); return i < news.length && news[i] <= t + NEWS_WIN; };
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const nights = (t0, t1) => Math.max(0, Math.floor(t1 / DAY) - Math.floor(t0 / DAY));

function prepare(h1) {   // 4-hour bars and the indicators pullback_lab.js uses
  const h4 = R.toH4(h1);
  const C = h4.map(k => k.c);
  return { h4, E9: I.ema(C, 9), E21: I.ema(C, 21), E50: I.ema(C, 50), ATR: I.atr(h4, 14) };
}

// run() of research/pullback_lab.js, with the bars, indicators and entry window as arguments
function run(D, A, X, slip, from, to) {
  const { h4, E9, E21, E50, ATR } = D;
  const trendAt = j => {
    if (j < 1 || E50[j - 1] === null || E50[j] === null) return 0;
    if (E9[j] > E21[j] && E21[j] > E50[j] && E9[j] > E9[j - 1] && E21[j] > E21[j - 1] && E50[j] > E50[j - 1]) return 1;
    if (E9[j] < E21[j] && E21[j] < E50[j] && E9[j] < E9[j - 1] && E21[j] < E21[j - 1] && E50[j] < E50[j - 1]) return -1;
    return 0;
  };
  const avg = A === 'A9' ? E9 : E21, tr = [];
  let j = 51;
  while (j < h4.length - 1) {
    const k = h4[j], side = trendAt(j);
    if (k.t < from || k.t >= to || !side || !ATR[j]) { j++; continue; }
    const touched = side === 1 ? k.l <= avg[j] && k.c > E50[j] : k.h >= avg[j] && k.c < E50[j];
    if (!touched) { j++; continue; }
    const level = side === 1 ? k.h : k.l, stop = side === 1 ? k.l : k.h, dist = Math.abs(level - stop);
    if (!(dist > 0) || dist > MAX_ATR * ATR[j] || dist > MAX_STOP) { j++; continue; }
    let fill = -1, entry = 0;
    for (let n = j + 1; n <= j + ORDER_BARS && n < h4.length; n++) {
      const b = h4[n];
      if (side === 1 ? b.h >= level : b.l <= level) {
        const raw = side === 1 ? Math.max(b.o, level) + b.sp : Math.min(b.o, level);
        entry = raw + side * slip(b.t); fill = n; break;
      }
      if (side === 1 ? b.l <= stop : b.h + b.sp >= stop) break;
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
const inWin = (a, b) => t => t.t >= a && t.t < b;

const raw = R.load('XAUUSD.sml_H1_2008.csv');
const h1Old = raw.filter(b => b.t < CUT);
const MAIN = prepare(h1Old.map(b => Object.assign({}, b, { sp: b.sp > 0 ? b.sp : FILL_SPREAD })));
const ZERO = prepare(h1Old);

console.log('Pullback entries (pullback_lab.js rules) on 4-hour bars 2008-03 to 2022-12, ' + RUNS + ' runs of random fills');
console.log('  bars: ' + MAIN.h4.length + ' 4-hour bars, ' + new Date(MAIN.h4[0].t).toISOString().slice(0, 10) + ' to ' + new Date(MAIN.h4[MAIN.h4.length - 1].t).toISOString().slice(0, 10) +
            '; H1 bars with spread 0 before 2023: ' + h1Old.filter(b => !(b.sp > 0)).length + ' of ' + h1Old.length);

// check: same code on this file's 2023-04 .. 2025-12 bars, ideal fills
{
  const D = prepare(raw);
  const tr = run(D, 'A21', 'X2', () => BASE, Date.UTC(2023, 3, 3), R.FRESH_FROM);
  const a = tr.filter(t => t.t < I.SPLIT), b = tr.filter(t => t.t >= I.SPLIT);
  console.log('  check, this file 2023-04..2026-10, A21 X2 ideal fills: 2023-24 ' + a.length + ' trades ' + f(sum(a.map(t => t.r))) + ' R; 2025-26 ' + b.length + ' trades ' + f(sum(b.map(t => t.r))) + ' R');
}

console.log('\n  choice   | 2008-22: n  med R  5%    95%    PF  runs>0 | median R by era 2008-12 / 2013-17 / 2018-22 | spread-0 med R');
const res = {};
['A9', 'A21'].forEach(A => ['X1', 'X2'].forEach(X => {
  const tot = [], pfs = [], era = ERAS.map(() => []), zero = []; let n = 0;
  for (let k = 0; k < RUNS; k++) {
    const tr = run(MAIN, A, X, slipper(rng(8800 + k)), FROM, TO);
    tot.push(sum(tr.map(t => t.r))); pfs.push(pf(tr)); n = tr.length;
    ERAS.forEach((e, i) => era[i].push(sum(tr.filter(inWin(e[1], e[2])).map(t => t.r))));
    zero.push(sum(run(ZERO, A, X, slipper(rng(8800 + k)), FROM, TO).map(t => t.r)));
  }
  const x = { n, med: pct(tot, 50), pf: pct(pfs, 50), pos: tot.filter(v => v > 0).length / RUNS };
  res[A + ' ' + X] = x;
  console.log('  ' + (A + ' ' + X + (A === 'A21' && X === 'X2' ? '*' : '')).padEnd(8) + ' |' + String(n).padStart(10) + f(x.med).padStart(7) + f(pct(tot, 5)).padStart(7) + f(pct(tot, 95)).padStart(7) +
              f(x.pf, 2).padStart(6) + ((x.pos * 100).toFixed(0) + '%').padStart(7) + ' | ' + era.map(e => f(pct(e, 50))).join(' / ').padStart(22) + ' '.repeat(22) + '|' + f(pct(zero, 50)).padStart(8));
}));
const pick = res['A21 X2'];
const alone = pick.pos >= 0.9 && pick.pf > 1.2 && pick.n >= 30;

// (2) added to the H4 breakout, same fill draws for both
const only = [], pair = [], eraOnly = ERAS.map(() => []), eraPair = ERAS.map(() => []), brkN = [];
for (let k = 0; k < RUNS; k++) {
  const rand = rng(9900 + k), slip = slipper(rand);
  const brk = R.simulate(MAIN.h4, Object.assign({}, H4_CFG, { slipFn: t => slip(t) - BASE })).filter(t => t.t >= FROM && t.t < TO).map(t => ({ t: t.t, x: t.exitT, r: t.r }));
  const pb = run(MAIN, 'A21', 'X2', slip, FROM, TO);
  only.push(ratio(brk)); pair.push(ratio(brk.concat(pb))); brkN.push(brk.length);
  ERAS.forEach((e, i) => { eraOnly[i].push(ratio(brk.filter(inWin(e[1], e[2])))); eraPair[i].push(ratio(brk.concat(pb).filter(inWin(e[1], e[2])))); });
}
const med = (a, key) => pct(a.map(x => x[key]), 50);
const qOnly = med(only, 'q'), qPair = med(pair, 'q'), together = qPair > qOnly;
console.log('\n  with the H4 breakout (' + pct(brkN, 50) + ' breakout trades), 2008-2022 medians: total R / worst drawdown / ratio');
console.log('    all 2008-22   breakout alone ' + f(med(only, 'r')) + ' / ' + f(med(only, 'dd')) + ' / ' + f(qOnly, 2) + '   with the pullback ' + f(med(pair, 'r')) + ' / ' + f(med(pair, 'dd')) + ' / ' + f(qPair, 2));
ERAS.forEach((e, i) => console.log('    ' + e[0].padEnd(13) + ' breakout alone ' + f(med(eraOnly[i], 'r')) + ' / ' + f(med(eraOnly[i], 'dd')) + ' / ' + f(med(eraOnly[i], 'q'), 2) +
                                   '   with the pullback ' + f(med(eraPair[i], 'r')) + ' / ' + f(med(eraPair[i], 'dd')) + ' / ' + f(med(eraPair[i], 'q'), 2) + '   (information)'));
console.log('\n  (1) A21 X2 on its own 2008-22: ' + pick.n + ' trades, median ' + f(pick.med) + ' R, PF ' + f(pick.pf, 2) + ', above 0 in ' + (pick.pos * 100).toFixed(0) + '% of runs -> ' + (alone ? 'pass' : 'fail'));
console.log('  (2) pair ratio ' + f(qPair, 2) + ' vs breakout alone ' + f(qOnly, 2) + ' -> ' + (together ? 'better' : 'not better'));
console.log('  2008-2022: ' + (alone && together ? 'PASS (but 2025-26 failed, section 36: helps in one era only, not built)' : 'FAIL (item 15 closed)'));
