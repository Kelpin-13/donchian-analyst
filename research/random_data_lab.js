/**
 * Random-data test (Monte Carlo permutation): does each strategy make more on the real gold prices than on fake prices
 * built from the same days with the bars inside each day in a random order? (research queue item 3, 12 Nov 2026).
 *
 *   node research/random_data_lab.js [shuffles]
 *
 * Fixed before running:
 *   - book     the five strategies still trading: H4 with the trail (DonchianGold 1.08, as realism_lab.js), DUAL_THRUST,
 *              ASIAN_NARROW, R_BREAKER, MOM_16 (I.portfolio default: targets, H4 trend filter, the $150 cap). Each strategy
 *              alone, in R; the five added together as "BOOK" for information only.
 *   - shuffle  inside each server day the 15-minute bars' moves are put in a random order (Fisher-Yates, seed 5000 + k).
 *              A bar's move = its high, low and close as ratios of its own open. Kept in place: the day's first open (so
 *              the overnight gap), every bar's time and spread (the spread belongs to the clock, not to the move), and the
 *              small gaps between one bar's close and the next bar's open. So every fake day has the real day's open, the
 *              real day's close and the real day's set of bar sizes: the daily chart closes are the real ones, only the
 *              path inside the day is random. A reordering cannot keep the day's high and low exactly; how close the fake
 *              day's range comes to the real one is measured and printed (median and 5%-95% of fake / real range).
 *              200 shuffles. Bars before the test period are shuffled too (they only warm up the indicators).
 *   - fake run on each fake M15 series the strategies are built afresh by I.portfolio (its daily bars, daily ATR, H4 trend
 *              and the Asian quiet-night median all come from the fake series, as they come from the real one), and H4
 *              runs on 4-hour bars made from the fake M15 bars (M15 -> H1 with the hour's lowest spread, which is what the
 *              exported H1 file holds, then R.toH4). Engine checks first, else stop: (1) the unshuffled order through the
 *              fake-price builder gives the real prices back to 1e-6; (2) 4-hour bars made from the real M15 file give
 *              the same H4 trades as the H1 file; (3) a shuffled series keeps every day's open and close to 1e-6.
 *   - data     2023-04-03 to 2026-10-08 (fresh bars not loaded).
 *   - fills    realism_lab.js model (live demo draws, x3 within 30 min of US news, 2% late +$3) on top of the research
 *              costs. Real prices: 200 runs, seeds 1000 + run, each strategy its own stream; reported worst 5%, median,
 *              best 5% of the total R. Each shuffle k gets ONE run with fill seed 1000 + k, so the fake results carry the
 *              same fill noise as a real run does; reported 5%, median, 95% over the 200 shuffles.
 *   - p-value  per strategy: the share of the 200 shuffles whose total R is above the real prices' median total R,
 *              2023-04-03 to 2026-10-08. For information: the same share on each half (2023-24, 2025-26) and for BOOK.
 *   - pass     p < 0.05 (at most 9 of 200 shuffles beat the real median). A strategy at 0.05 or more is flagged: it does
 *              as well on shuffled prices.
 *   - what the test can and cannot say (written before running). The shuffle keeps each day's direction and size, so a
 *     rule that only needs "today went up a lot" earns on the fake days as well; only the ORDER of the bars inside the
 *     day is destroyed. PASS = the real order inside the day adds profit beyond what the day's net move gives any path.
 *     FAIL = no such addition was measured; it does not by itself mean the strategy loses money. H4 holds for days and
 *     reads 20 four-hour bars, and the shuffle leaves everything from one day to the next untouched, so for H4 this test
 *     is weak by design: a fail there says its profit comes from the multi-day trend, which this shuffle keeps.
 *   - nothing is picked or changed.
 *
 * Results (12 Nov 2026, one run, no bug fixes; all three engine checks ok, H4 from the M15 file identical, 222 trades).
 * Fake day range / real day range: median 0.99, 5% 0.67, 95% 1.48; only 35% of fake days within 10% of the real range,
 * so the day's open and close are kept exactly but its range only on average.
 * Total R 2023-04-03 to 2026-10-08, real worst 5% | median | best 5%  vs  shuffled 5% | median | 95%  ->  p (2023-24, 2025-26):
 *   H4             44.8 | 49.5 | 53.0   vs    3.3 |  19.4 | 34.7   ->  p 0.005 (0.010, 0.020)  PASS
 *   ASIAN_NARROW    0.2 |  7.2 | 13.9   vs  -50.7 | -26.3 |  1.0   ->  p 0.015 (0.000, 0.430)  PASS
 *   DUAL_THRUST     6.2 |  7.3 |  8.2   vs   -2.9 |   4.0 | 10.6   ->  p 0.195 (0.765, 0.010)  FAIL
 *   R_BREAKER       8.9 | 10.5 | 11.4   vs   -6.2 |   3.9 | 16.2   ->  p 0.175 (0.305, 0.210)  FAIL
 *   MOM_16          6.0 | 10.1 | 14.0   vs  -38.3 | -14.7 |  5.7   ->  p 0.000 (0.005, 0.340)  PASS
 *   BOOK (info)    73.8 | 84.1 | 94.8   vs  -49.6 | -14.7 | 26.8   ->  p 0.000 (0.000, 0.045)
 * Verdict by the written rule: H4, ASIAN_NARROW and MOM_16 PASS; DUAL_THRUST and R_BREAKER FAIL, flagged: they do as
 * well on shuffled prices (39 and 35 of 200 shuffles beat the real median; both still made money on the fake days,
 * median +4.0 R and +3.9 R, so about half of their profit is the day's net move, which any path gives).
 * Reading, written after the run (the rule above is not changed by it):
 *   - H4 was expected to be the weak case and is the clearest pass: with the same daily closes but random 4-hour bars
 *     inside the day it keeps 39% of its R. Where the 4-hour closes fall inside the day matters to it.
 *   - The passes of ASIAN_NARROW and MOM_16 are easier than they look. The shuffle moves New York-sized bars into the
 *     night (the "quiet night" then means something else: 408 fake trades against 306), and with the close pinned a
 *     fake day's later move leans against its earlier one, which hurts any "the move so far continues" rule (MOM_16
 *     shuffled median -14.7 R, not 0). They beat a random order; that is partly the clock's known pattern of busy and
 *     quiet hours, not proof of a directional edge. Both pass on 2023-24 and not on 2025-26 alone (p 0.43, 0.34).
 *   - The same tilt makes the two fails more telling. DUAL_THRUST fails here and in plateau_lab.js (flagged twice, by
 *     two independent tests); on 2023-24 it did worse than 77% of the shuffles. R_BREAKER passed the plateau and
 *     fails here: its settings are stable, but its timing inside the day is not shown to add anything.
 * Nothing was picked or changed. Full table: data/reports/random_data_lab.txt.
 * Research only: nothing here trades.
 */
const fs = require('fs');
const path = require('path');
const I = require('./intraday.js');
const R = require('./daytrade.js');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const SHUFFLES = Number(process.argv[2]) || 200, REAL_RUNS = 200;
const MIN = 60000, HOUR = 3600000, DAY = 86400000, FROM = Date.UTC(2023, 3, 3), SPLIT = I.SPLIT;
const LIVE = [0.03, 0.03, 0.58, 0.16, 0.02, 0.378, 0.085, 1.085, 0.422, 0.11];
const NEWS_X = 3, NEWS_WIN = 30 * MIN, LATE_P = 0.02, LATE_USD = 3;
const H4_CFG = { dir: 'both', N: 20, M: 10, k: 2, ema: 100, maxBars: 60, barMin: 240, flat: false, swapLong: -5.92, swapShort: 3.67,
                 hardK: 4, targetR: 1.5, targetWait: true, maxStop: I.MAX_STOP, trail: { at: 1, dist: 0.5, broker: true },
                 firstEntryMin: 0, lastEntryMin: 24 * 60, flatMin: Infinity, from: -Infinity, to: Infinity };
const dayOf = t => Math.floor(t / DAY);

const news = loadReleases(findCalendar(), null).times;
const nearNews = t => { const i = firstFrom(news, t - NEWS_WIN); return i < news.length && news[i] <= t + NEWS_WIN; };
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const fillFn = seed => { const rand = rng(seed); return t => { let x = LIVE[Math.floor(rand() * LIVE.length)]; if (nearNews(t)) x *= NEWS_X; if (rand() < LATE_P) x += LATE_USD; return x; }; };

const lines = [];
const say = s => { console.log(s); lines.push(s); };

const m15 = R.load('XAUUSD.sml_M15.csv');
const dayStart = [];
m15.forEach((b, i) => { if (i === 0 || dayOf(b.t) !== dayOf(m15[i - 1].t)) dayStart.push(i); });
dayStart.push(m15.length);
const NDAYS = dayStart.length - 1;

/** The fake series: inside each day the bars' moves in a random order (rand null = the real order). */
function shuffled(rand) {
  const out = new Array(m15.length);
  for (let d = 0; d < NDAYS; d++) {
    const a = dayStart[d], n = dayStart[d + 1] - a, order = [];
    for (let j = 0; j < n; j++) order.push(j);
    if (rand) for (let j = n - 1; j > 0; j--) { const x = Math.floor(rand() * (j + 1)), tmp = order[j]; order[j] = order[x]; order[x] = tmp; }
    let prevC = 0;
    for (let j = 0; j < n; j++) {
      const slot = m15[a + j], src = m15[a + order[j]];
      const o = j === 0 ? slot.o : prevC * (slot.o / m15[a + j - 1].c);
      const f = o / src.o;
      out[a + j] = { t: slot.t, o, h: src.h * f, l: src.l * f, c: src.c * f, v: slot.v, sp: slot.sp };
      prevC = out[a + j].c;
    }
  }
  return out;
}
/** M15 -> H1 (the hour's lowest spread, as the exported H1 file) -> H4 as research/daytrade.js makes it. */
function h4Of(bars) {
  const h1 = [];
  bars.forEach(b => {
    const t = Math.floor(b.t / HOUR) * HOUR, last = h1[h1.length - 1];
    if (last && last.t === t) { last.h = Math.max(last.h, b.h); last.l = Math.min(last.l, b.l); last.c = b.c; last.v += b.v; last.sp = Math.min(last.sp, b.sp); }
    else h1.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, sp: b.sp });
  });
  return R.toH4(h1);
}

const IDS = ['H4'].concat(Object.keys(I.portfolio(m15)));
const sumR = xs => xs.reduce((s, t) => s + t.r, 0);
/** One run of every strategy on one series. seed null = research costs. Returns per id { n, tot, a, b }. */
function runAll(bars, P, h4, seed) {
  const out = {}, book = { n: 0, tot: 0, a: 0, b: 0 };
  IDS.forEach(id => {
    const slipFn = seed === null ? null : fillFn(seed);
    const tr = (id === 'H4' ? R.simulate(h4, Object.assign({}, H4_CFG, slipFn ? { slipFn } : {}))
                            : I.backtest(bars, P[id], slipFn ? { slip: I.COSTS.real.slip, slipFn } : I.COSTS.real)).filter(t => t.t >= FROM);
    const x = { n: tr.length, tot: sumR(tr), a: sumR(tr.filter(t => t.t < SPLIT)), b: sumR(tr.filter(t => t.t >= SPLIT)) };
    out[id] = x; book.n += x.n; book.tot += x.tot; book.a += x.a; book.b += x.b;
  });
  out.BOOK = book;
  return out;
}

/* 0. Engine checks. */
const same = (x, y) => x.length === y.length && x.every((t, i) => t.t === y[i].t && t.exitT === y[i].exitT && t.side === y[i].side && Math.abs(t.r - y[i].r) < 1e-9);
const ident = shuffled(null);
let worst = 0;
ident.forEach((b, i) => { const k = m15[i]; worst = Math.max(worst, Math.abs(b.o - k.o), Math.abs(b.h - k.h), Math.abs(b.l - k.l), Math.abs(b.c - k.c)); });
say('Engine check 1, the real order through the fake-price builder: largest price difference ' + worst.toExponential(1) + (worst < 1e-6 ? ' (ok)' : ' DIFFERENT, stop'));
const h4File = R.toH4(R.load('XAUUSD.sml_H1.csv')), h4Real = h4Of(m15);
const h4Same = same(R.simulate(h4File, H4_CFG), R.simulate(h4Real, H4_CFG));
say('Engine check 2, H4 trades from 4-hour bars made of the M15 file against the H1 file: ' + (h4Same ? 'identical (' + R.simulate(h4Real, H4_CFG).length + ' trades)' : 'DIFFERENT, stop'));
const first = shuffled(rng(5000));
let ocWorst = 0, moved = 0;
for (let d = 0; d < NDAYS; d++) {
  const a = dayStart[d], z = dayStart[d + 1] - 1;
  ocWorst = Math.max(ocWorst, Math.abs(first[a].o - m15[a].o), Math.abs(first[z].c - m15[z].c));
}
first.forEach((b, i) => { if (Math.abs(b.c - m15[i].c) > 1e-6) moved++; });
say('Engine check 3, shuffle 0 keeps every day\'s open and close: largest difference ' + ocWorst.toExponential(1) + (ocWorst < 1e-6 ? ' (ok)' : ' DIFFERENT, stop') +
    '; ' + (moved / m15.length * 100).toFixed(0) + '% of its bars close at a different price than the real bar');
if (!(worst < 1e-6) || !h4Same || !(ocWorst < 1e-6) || moved === 0) process.exit(1);

const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const f = (v, d) => v.toFixed(d === undefined ? 1 : d);
const ALL = IDS.concat(['BOOK']);

/* 1. The real prices: 200 runs of random fills. */
const P0 = I.portfolio(m15);
const real = {};
ALL.forEach(id => { real[id] = { n: 0, tot: [], a: [], b: [] }; });
for (let k = 0; k < REAL_RUNS; k++) {
  const r = runAll(m15, P0, h4Real, 1000 + k);
  ALL.forEach(id => { real[id].n = r[id].n; real[id].tot.push(r[id].tot); real[id].a.push(r[id].a); real[id].b.push(r[id].b); });
}

/* 2. The shuffles: one run of random fills each. */
const fake = {};
ALL.forEach(id => { fake[id] = { n: [], tot: [], a: [], b: [] }; });
const ratios = [];
for (let k = 0; k < SHUFFLES; k++) {
  const bars = k === 0 ? first : shuffled(rng(5000 + k));
  for (let d = 0; d < NDAYS; d++) {
    let h = -Infinity, l = Infinity, H = -Infinity, L = Infinity;
    for (let i = dayStart[d]; i < dayStart[d + 1]; i++) { h = Math.max(h, bars[i].h); l = Math.min(l, bars[i].l); H = Math.max(H, m15[i].h); L = Math.min(L, m15[i].l); }
    if (H > L) ratios.push((h - l) / (H - L));
  }
  const r = runAll(bars, I.portfolio(bars), h4Of(bars), 1000 + k);
  ALL.forEach(id => { fake[id].n.push(r[id].n); fake[id].tot.push(r[id].tot); fake[id].a.push(r[id].a); fake[id].b.push(r[id].b); });
}

say('\nFake day range / real day range over ' + ratios.length + ' fake days: median ' + f(pct(ratios, 50), 2) + ', 5% ' + f(pct(ratios, 5), 2) + ', 95% ' + f(pct(ratios, 95), 2) +
    '; within 10% of the real range: ' + f(ratios.filter(x => x >= 0.9 && x <= 1.1).length / ratios.length * 100, 0) + '% of days');
say('\nTotal R, 2023-04-03 to 2026-10-08. Real prices: ' + REAL_RUNS + ' runs of random fills. Shuffled prices: ' + SHUFFLES + ' shuffles, one run of random fills each.');
say('p = share of shuffles above the real median. Pass: p < 0.05.');
say('\n  strategy       trades real | real R worst5%  median  best5% | trades fake | shuffled R  5%  median     95% |  p all | p 2023-24 | p 2025-26 | real - shuffled median | test');
const verdict = {};
ALL.forEach(id => {
  const x = real[id], y = fake[id], med = pct(x.tot, 50), ma = pct(x.a, 50), mb = pct(x.b, 50);
  const share = (arr, m) => arr.filter(v => v > m).length / arr.length;
  const p = share(y.tot, med), pa = share(y.a, ma), pb = share(y.b, mb), ok = p < 0.05;
  verdict[id] = { p, ok, med, fmed: pct(y.tot, 50), ma, mb, fa: pct(y.a, 50), fb: pct(y.b, 50) };
  say('  ' + id.padEnd(13) + String(x.n).padStart(12) + ' |' + f(pct(x.tot, 5)).padStart(15) + f(med).padStart(8) + f(pct(x.tot, 95)).padStart(8) + ' |' +
      f(pct(y.n, 50), 0).padStart(12) + ' |' + f(pct(y.tot, 5)).padStart(14) + f(pct(y.tot, 50)).padStart(8) + f(pct(y.tot, 95)).padStart(8) + ' |' +
      f(p, 3).padStart(7) + ' |' + f(pa, 3).padStart(10) + ' |' + f(pb, 3).padStart(10) + ' |' + f(med - pct(y.tot, 50)).padStart(23) + ' | ' +
      (id === 'BOOK' ? '(information)' : ok ? 'PASS' : 'FAIL'));
});
say('\nMedian R by half, real | shuffled:');
ALL.forEach(id => { const v = verdict[id]; say('  ' + id.padEnd(13) + ' 2023-24 ' + f(v.ma).padStart(7) + ' | ' + f(v.fa).padStart(7) + '    2025-26 ' + f(v.mb).padStart(7) + ' | ' + f(v.fb).padStart(7)); });
say('\nVERDICT per strategy (p < 0.05: the real order of the bars inside the day earns more than a random order):');
IDS.forEach(id => {
  const v = verdict[id];
  say('  ' + id.padEnd(13) + (v.ok ? 'PASS' : 'FAIL, does as well on shuffled prices') + ' (p = ' + f(v.p, 3) + ', ' + Math.round(v.p * SHUFFLES) + ' of ' + SHUFFLES +
      ' shuffles beat the real median ' + f(v.med) + ' R; shuffled median ' + f(v.fmed) + ' R)');
});
fs.writeFileSync(path.join(__dirname, '..', 'data', 'reports', 'random_data_lab.txt'), lines.join('\n') + '\n');
