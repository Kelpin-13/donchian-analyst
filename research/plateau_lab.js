/**
 * Neighbouring settings (plateau): does each strategy still make money when its main settings are moved one and two
 * steps either side? A rule that only works at exactly the chosen number is curve-fit (research queue item 2, 12 Nov 2026).
 *
 *   node research/plateau_lab.js [runs]
 *
 * Fixed before running:
 *   - book     the five strategies still trading: H4 with the trail (DonchianGold 1.08, as realism_lab.js), DUAL_THRUST,
 *              ASIAN_NARROW, R_BREAKER, MOM_16 (GoldIntraday 1.17: targets, H4 trend filter and the $150 cap as in
 *              I.portfolio). Each strategy alone, in R (R does not depend on the trade size).
 *   - grid     ONE setting moves at a time, the others stay at today's value; two steps down, one down, one up, two up:
 *                H4            entry channel N  10, 15, [20], 25, 30
 *                              exit channel M    6,  8, [10], 12, 14
 *                              stop k x ATR      1.5, 1.75, [2], 2.25, 2.5  (target 1.5R and the trail stay in R, so they scale with it)
 *                              trend EMA         50, 75, [100], 125, 150
 *                DUAL_THRUST   days N            2, 3, [4], 5, 6
 *                              trigger k         0.3, 0.4, [0.5], 0.6, 0.7  (x the range, either side of the open)
 *                ASIAN_NARROW  quiet-night threshold = that percentile of range / daily ATR on 2023-2024:
 *                                                30, 40, [50], 60, 70
 *                R_BREAKER     stop x daily ATR  0.3, 0.4, [0.5], 0.6, 0.7
 *                MOM_16        signal hour       14:00, 15:00, [16:00], 17:00, 18:00 server time
 *              36 neighbours in all. The intraday strategies are rebuilt here with the setting as a parameter (intraday.js
 *              is not edited); check first: at today's values each must reproduce I.portfolio's trades exactly, else stop.
 *   - data     2023-04-03 to 2026-10-08 (fresh bars not loaded).
 *   - fills    realism_lab.js model (live demo draws, x3 within 30 min of US news, 2% late +$3) on top of the research
 *              costs, 100 runs, the SAME seeds (1000 + run) for every setting. Reported per setting: worst 5%, median and
 *              best 5% of the total R over the runs; for information the median R of each half and the share of runs above 0.
 *   - pass     per strategy: EVERY neighbour has a median total R above 0 on 2023-26 AND at least 60% of today's setting's
 *              median R. If today's setting itself has a median R of 0 or less, the strategy fails. A strategy that fails
 *              is flagged as curve-fit (which neighbours failed is listed).
 *   - nothing is picked. A neighbour that does better than today's setting is NOT adopted: that would be tuning on
 *     2023-26, the 2025-26 half included. This study only measures how flat the ground around today's settings is.
 *
 * Results (12 Nov 2026, one run, 100 runs of random fills, same seeds for every setting; engine check identical for all
 * four intraday strategies: 284, 331, 102 and 542 trades). Median total R 2023-04 to 2026-10, two down | one down |
 * [today] | one up | two up, with the % of today kept; * = fails the rule:
 *   H4 N            46.6 (94%) | 45.5 (92%) | [49.4] | 42.9 (87%) | 45.0 (91%)
 *   H4 M            36.4 (74%) | 42.2 (85%) | [49.4] | 53.2 (108%) | 48.8 (99%)
 *   H4 k            25.5 (52%)* | 36.3 (74%) | [49.4] | 44.0 (89%) | 29.9 (61%)
 *   H4 EMA          43.2 (87%) | 45.4 (92%) | [49.4] | 41.2 (83%) | 42.4 (86%)
 *   DUAL_THRUST N    3.2 (44%)* |  7.3 (100%) | [7.3] |  3.3 (45%)* |  0.2 (3%)*
 *   DUAL_THRUST k   -7.7* |  2.2 (30%)* | [7.3] |  6.7 (92%) |  1.2 (17%)*
 *   ASIAN_NARROW     5.8 (78%) | 10.3 (140%) | [7.4] | 10.4 (141%) |  5.2 (71%)
 *   R_BREAKER        7.6 (73%) |  9.7 (92%) | [10.5] |  9.2 (88%) |  7.0 (67%)
 *   MOM_16 hour     10.8 (100%) | -0.3* | [10.8] | -3.0* | 14.2 (132%)
 * Verdict by the written rule: ASIAN_NARROW PASS (4 of 4), R_BREAKER PASS (4 of 4); H4 FAIL (15 of 16: only the 1.5 ATR
 * stop, 52% of today, and every one of its 16 neighbours made money in every run); DUAL_THRUST FAIL, flagged curve-fit
 * (2 of 8; k 0.3 lost in every run); MOM_16 FAIL, flagged curve-fit (2 of 4: 15:00 and 17:00 lose, 14:00 and 18:00 do
 * as well or better, so the hour itself carries no edge that neighbours share).
 * Reading: H4 sits on a broad plateau and misses the rule by one stop width; Dual Thrust and MOM_16 depend on their exact
 * numbers. ASIAN_NARROW passes on ratios but is thin everywhere (worst 5% of runs 0.5 R at today's setting). Dual Thrust's
 * profit at every setting comes from 2025-26 only (2023-24 median negative at all nine). Nothing was picked or changed.
 * Full table: data/reports/plateau_lab.txt.
 * Research only: nothing here trades.
 */
const I = require('./intraday.js');
const R = require('./daytrade.js');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const RUNS = Number(process.argv[2]) || 100;
const MIN = 60000, DAY = 86400000, FROM = Date.UTC(2023, 3, 3), SPLIT = I.SPLIT;
const LIVE = [0.03, 0.03, 0.58, 0.16, 0.02, 0.378, 0.085, 1.085, 0.422, 0.11];
const NEWS_X = 3, NEWS_WIN = 30 * MIN, LATE_P = 0.02, LATE_USD = 3;
const H4_CFG = { dir: 'both', N: 20, M: 10, k: 2, ema: 100, maxBars: 60, barMin: 240, flat: false, swapLong: -5.92, swapShort: 3.67,
                 hardK: 4, targetR: 1.5, targetWait: true, maxStop: I.MAX_STOP, trail: { at: 1, dist: 0.5, broker: true },
                 firstEntryMin: 0, lastEntryMin: 24 * 60, flatMin: Infinity, from: -Infinity, to: Infinity };
const hm = (h, m) => h * 60 + (m || 0), mod = t => Math.floor((t % DAY) / MIN), dayOf = t => Math.floor(t / DAY);

const news = loadReleases(findCalendar(), null).times;
const nearNews = t => { const i = firstFrom(news, t - NEWS_WIN); return i < news.length && news[i] <= t + NEWS_WIN; };
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const m15 = R.load('XAUUSD.sml_M15.csv'), h4 = R.toH4(R.load('XAUUSD.sml_H1.csv'));
const trend = I.h4Trend(m15);
const { days, index } = I.dailyOf(m15);
const dayAt = i => days[index.get(dayOf(m15[i].t))];
const prevDays = (i, n) => { const j = index.get(dayOf(m15[i].t)); return j >= n ? days.slice(j - n, j) : null; };
const finish = (S, id, withH4Trend) => Object.assign(I.withTarget(withH4Trend ? I.withTrend(S, trend) : S, I.TARGETS[id]), { maxStop: I.MAX_STOP });

/* The four intraday strategies, as in intraday.js strategies(), with the studied setting as a parameter. */
function dualThrust(N, kk) {
  return finish({
    name: 'Dual Thrust N' + N + ' k' + kk, family: 'breakout', flatMin: hm(23), maxPerDay: 3, entryUntil: hm(20),
    onDay(i) {
      const p = prevDays(i, N);
      if (!p) return {};
      const HH = Math.max(...p.map(x => x.h)), LL = Math.min(...p.map(x => x.l));
      const HC = Math.max(...p.map(x => x.c)), LC = Math.min(...p.map(x => x.c));
      const range = Math.max(HH - LC, HC - LL), o = m15[i].o;
      const up = o + kk * range, dn = o - kk * range;
      return { orders: [{ side: 1, level: up, stop: dn, reverse: true, until: hm(20) },
                        { side: -1, level: dn, stop: up, reverse: true, until: hm(20) }] };
    }
  }, 'DUAL_THRUST', false);
}
function rBreaker(stopK) {
  return finish({
    name: 'R-Breaker stop ' + stopK, family: 'breakout + reversal', flatMin: hm(23), maxPerDay: 2,
    onDay(i) {
      const p = prevDays(i, 1), today = dayAt(i);
      if (!p || !today.atrPrev) return {};
      const { h: H, l: L, c: C } = p[0], P = (H + L + C) / 3;
      return { hi: -Infinity, lo: Infinity, atr: today.atrPrev,
               bBreak: H + 2 * (P - L), sSetup: P + (H - L), sEnter: 2 * P - L,
               bEnter: 2 * P - H, bSetup: P - (H - L), sBreak: L - 2 * (H - P) };
    },
    onClose(i, pos, D) {
      if (!D.atr) return null;
      const k = m15[i], c = k.c;
      D.hi = Math.max(D.hi, k.h); D.lo = Math.min(D.lo, k.l);
      if (mod(k.t) >= hm(20)) return null;
      const stopDist = stopK * D.atr;
      const revShort = D.hi > D.sSetup && c < D.sEnter, revLong = D.lo < D.bSetup && c > D.bEnter;
      if (!pos) {
        if (c > D.bBreak || revLong) return { enter: { side: 1, stopDist } };
        if (c < D.sBreak || revShort) return { enter: { side: -1, stopDist } };
        return null;
      }
      if (pos.side === 1 && revShort) return { exit: 'REVERSE', enter: { side: -1, stopDist } };
      if (pos.side === -1 && revLong) return { exit: 'REVERSE', enter: { side: 1, stopDist } };
      return null;
    }
  }, 'R_BREAKER', true);
}
function momentum(hour) {
  const at = hm(hour);
  return finish({
    name: 'Momentum ' + hour + ':00', family: 'momentum', flatMin: hm(23), maxPerDay: 1,
    onClose(i, pos) {
      const k = m15[i], today = dayAt(i);
      if (pos || mod(k.t) !== at - 15 || !today.atrPrev || k.c === today.o) return null;
      return { enter: { side: k.c > today.o ? 1 : -1, stopDist: 0.5 * today.atrPrev } };
    }
  }, 'MOM_16', true);
}
// The night's range / daily ATR on 2023-2024, sorted, exactly as intraday.js builds it for its median.
const asianRatio = [];
days.forEach(x => {
  if (!x.atrPrev || x.d * DAY >= SPLIT) return;
  let hi = -Infinity, lo = Infinity;
  for (let j = x.i; j < m15.length && dayOf(m15[j].t) === x.d && mod(m15[j].t) < hm(9); j++) { hi = Math.max(hi, m15[j].h); lo = Math.min(lo, m15[j].l); }
  if (hi > lo) asianRatio.push((hi - lo) / x.atrPrev);
});
asianRatio.sort((a, b) => a - b);
const asianTh = pctile => asianRatio[Math.floor(asianRatio.length * pctile / 100)];
function asianNarrow(pctile) {
  const narrow = asianTh(pctile), from = hm(1), to = hm(9), until = hm(15);
  return finish({
    name: 'Asian narrow below the ' + pctile + 'th percentile', family: 'breakout', flatMin: hm(23), maxPerDay: 1,
    onDay: () => ({ hi: -Infinity, lo: Infinity, n: 0 }),
    onClose(i, pos, D) {
      const k = m15[i], m = mod(k.t);
      if (m >= from && m < to) { D.hi = Math.max(D.hi, k.h); D.lo = Math.min(D.lo, k.l); D.n++; }
      if (m !== to - 15 || D.n < (to - from) / 15 * 0.75) return null;
      const today = dayAt(i);
      if (!(today.atrPrev && (D.hi - D.lo) / today.atrPrev < narrow)) return null;
      return { orders: [{ side: 1, level: D.hi, stop: D.lo, targetR: null, until },
                        { side: -1, level: D.lo, stop: D.hi, targetR: null, until }] };
    }
  }, 'ASIAN_NARROW', false);
}

/* The grid. Each row: strategy, setting, today's value, the four neighbours, how to run one value. */
const intr = S => cost => I.backtest(m15, S, cost);
const h4run = over => cost => R.simulate(h4, Object.assign({}, H4_CFG, over, cost.slipFn ? { slipFn: cost.slipFn } : {}));
const GRID = [
  { id: 'H4', set: 'entry channel N', now: 20, alts: [10, 15, 25, 30], make: v => h4run({ N: v }) },
  { id: 'H4', set: 'exit channel M', now: 10, alts: [6, 8, 12, 14], make: v => h4run({ M: v }) },
  { id: 'H4', set: 'stop k x ATR', now: 2, alts: [1.5, 1.75, 2.25, 2.5], make: v => h4run({ k: v }) },
  { id: 'H4', set: 'trend EMA', now: 100, alts: [50, 75, 125, 150], make: v => h4run({ ema: v }) },
  { id: 'DUAL_THRUST', set: 'days N', now: 4, alts: [2, 3, 5, 6], make: v => intr(dualThrust(v, 0.5)) },
  { id: 'DUAL_THRUST', set: 'trigger k', now: 0.5, alts: [0.3, 0.4, 0.6, 0.7], make: v => intr(dualThrust(4, v)) },
  { id: 'ASIAN_NARROW', set: 'threshold percentile', now: 50, alts: [30, 40, 60, 70], make: v => intr(asianNarrow(v)) },
  { id: 'R_BREAKER', set: 'stop x daily ATR', now: 0.5, alts: [0.3, 0.4, 0.6, 0.7], make: v => intr(rBreaker(v)) },
  { id: 'MOM_16', set: 'signal hour', now: 16, alts: [14, 15, 17, 18], make: v => intr(momentum(v)) }
];

// 0. Engine check: today's values through this file = the portfolio in intraday.js, trade for trade.
const P = I.portfolio(m15);
let checked = true;
GRID.filter(g => g.id !== 'H4').forEach(g => {
  const ref = I.backtest(m15, P[g.id], I.COSTS.real), mine = g.make(g.now)(I.COSTS.real);
  const same = ref.length === mine.length && ref.every((t, i) => t.t === mine[i].t && t.exitT === mine[i].exitT && t.side === mine[i].side && Math.abs(t.r - mine[i].r) < 1e-9);
  console.log('Engine check ' + g.id.padEnd(13) + '(' + g.set + '): ' + (same ? 'identical (' + ref.length + ' trades)' : 'DIFFERENT, stop'));
  if (!same) checked = false;
});
if (!checked) process.exit(1);
console.log('Asian quiet-night thresholds (range / daily ATR, 2023-2024): ' + [30, 40, 50, 60, 70].map(p => p + 'th ' + asianTh(p).toFixed(3)).join(', '));

const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const f = (v, d) => v.toFixed(d === undefined ? 1 : d);
function evaluate(run) {
  const tot = [], a = [], b = []; let n = 0;
  for (let k = 0; k < RUNS; k++) {
    const rand = rng(1000 + k);
    const slipFn = t => { let x = LIVE[Math.floor(rand() * LIVE.length)]; if (nearNews(t)) x *= NEWS_X; if (rand() < LATE_P) x += LATE_USD; return x; };
    const tr = run({ slip: I.COSTS.real.slip, slipFn }).filter(t => t.t >= FROM);
    const sum = xs => xs.reduce((s, t) => s + t.r, 0);
    tot.push(sum(tr)); a.push(sum(tr.filter(t => t.t < SPLIT))); b.push(sum(tr.filter(t => t.t >= SPLIT)));
    if (k === 0) n = tr.length;
  }
  return { n, p5: pct(tot, 5), med: pct(tot, 50), p95: pct(tot, 95), a: pct(a, 50), b: pct(b, 50), pos: tot.filter(x => x > 0).length / RUNS };
}

console.log('\nTotal R per setting, 2023-04-03 to 2026-10-08, ' + RUNS + ' runs of random fills (same seeds for every setting). [x] = today\'s setting.');
const cache = {}, verdicts = {};
GRID.forEach(g => {
  const base = cache[g.id] || (cache[g.id] = evaluate(g.make(g.now)));
  console.log('\n=== ' + g.id + ', ' + g.set + ' (today ' + g.now + ')');
  console.log('  value   trades | total R worst5%  median  best5% | median 2023-24  2025-26 | runs >0 | % of today | test');
  const vals = g.alts.slice(0, 2).concat([g.now]).concat(g.alts.slice(2));
  vals.forEach(v => {
    const isNow = v === g.now, x = isNow ? base : evaluate(g.make(v));
    const keep = base.med > 0 ? x.med / base.med * 100 : NaN;
    const ok = isNow ? base.med > 0 : (x.med > 0 && base.med > 0 && x.med >= 0.6 * base.med);
    const V = verdicts[g.id] || (verdicts[g.id] = { fails: [], n: 0, baseOk: base.med > 0 });
    if (!isNow) { V.n++; if (!ok) V.fails.push(g.set + ' ' + v + ' (' + f(x.med) + ' R' + (base.med > 0 ? ', ' + f(keep, 0) + '%' : '') + ')'); }
    console.log('  ' + (isNow ? '[' + v + ']' : String(v)).padEnd(8) + String(x.n).padStart(6) + ' |' + f(x.p5).padStart(16) + f(x.med).padStart(8) + f(x.p95).padStart(8) + ' |' +
                f(x.a).padStart(15) + f(x.b).padStart(9) + ' |' + (f(x.pos * 100, 0) + '%').padStart(8) + ' |' + (isNaN(keep) ? '-' : f(keep, 0) + '%').padStart(11) + ' | ' +
                (isNow ? (ok ? 'today' : 'today: NOT profitable') : ok ? 'pass' : 'FAIL'));
  });
});

console.log('\nVERDICT per strategy (every neighbour: median R > 0 and >= 60% of today\'s median R):');
Object.keys(verdicts).forEach(id => {
  const V = verdicts[id], pass = V.baseOk && !V.fails.length;
  console.log('  ' + id.padEnd(13) + (pass ? 'PASS (' + V.n + ' of ' + V.n + ' neighbours)' :
    'FAIL, flagged as curve-fit' + (V.baseOk ? '' : ' (today\'s setting itself has a median R of 0 or less)') + ': ' + (V.n - V.fails.length) + ' of ' + V.n + ' neighbours pass; failed: ' + V.fails.join('; ')));
});
