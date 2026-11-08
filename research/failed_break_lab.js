/**
 * The failed breakdown (Patrick Nill's favourite trade, owner's videos, 8 Nov 2026; owner: "test the failed breakdown
 * first"). Price breaks below a range, cannot stay there and closes back inside: buy the edge, stop under the false low.
 * Rules fixed before the first run.
 *
 *   node research/failed_break_lab.js [runs]
 *
 * On 15-minute bars of data/ (broker server time), 2023-04 to 2026-10-08, long side only (the side he prefers):
 *   range      the previous L bars (L = 24 or 48: 6 or 12 hours; he wants at least half a day); valid when its height
 *              is at most 0.6 x the daily ATR(14) known that day, and its bottom was touched at least 3 times (a touch:
 *              a bar whose low is within 15% of the height from the bottom, the bar before not touching)
 *   context    (C0) any; (C1) a "P" only: the 16 bars before the range rose by at least the range's height
 *   breakdown  a bar closes below the range's bottom; within the next 4 bars one closes back above the bottom
 *              (if none does, no trade); the false low is the lowest low from the break to the close back inside
 *   entry      a buy limit at the range's bottom for the next 8 bars (fills when the Ask reaches it); a bar that opens at
 *              or under the stop gives no trade
 *   stop       the false low; target 3R (he wants at least 3); out at the market after 48 bars (12 hours)
 *   choices    L24/L48 x C0/C1 = 4. One position at a time. Fills as research/fade_lab.js: limit entries and targets at
 *              their price; stops and time exits draw slippage as research/realism_lab.js (live demo fills, x3 near US
 *              news, 2% late +$3) on top of the bar's spread and $0.05; a stop inside the fill bar counts first. 100 runs.
 *   pick / pass best median total R on 2023-2024; pass if 2025-2026 is above 0 in at least 90% of runs, its median
 *              profit factor is over 1.2 and it has at least 30 trades. The fresh month is not used.
 *   also shown  ideal fills (spread + $0.05 only), and the mirror short (a failed breakout above) for the picked choice,
 *              for information: it does not decide anything.
 * Results (8 Nov 2026; a 2-run smoke test showed the first row, then this one 100-run run, rules unchanged):
 *   2023-24 / 2025-26 median R: L24 C0 -69.7 / -27.0; L24 C1 -5.9 / -4.1; L48 C0 -37.1 / -27.6; L48 C1 -1.4 / -3.3
 *   (picked; 3 trades in 2025-26, none won): FAIL. Every choice lost in both halves, also with ideal fills. Win rates
 *   18-30% against the 25% a 3R target needs before costs: with ideal fills (L24 C0) 191 of 257 trades hit the stop.
 *   The "P" context (C1) leaves almost no trades. Mirror short, for information: too few trades to read.
 * Research only: nothing here trades.
 */
const R = require('./daytrade.js');
const I = require('./intraday.js');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const RUNS = Number(process.argv[2]) || 100;
const MIN = 60000, DAY = 86400000, SPLIT = I.SPLIT, FROM = Date.UTC(2023, 3, 1);
const LIVE = [0.03, 0.03, 0.58, 0.16, 0.02, 0.378, 0.085, 1.085, 0.422, 0.11], NEWS_X = 3, NEWS_WIN = 30 * MIN, LATE_P = 0.02, LATE_USD = 3, BASE = 0.05;
const MAX_H = 0.6, TOUCH = 0.15, MIN_TOUCHES = 3, PUSH_BARS = 16, RECLAIM_BARS = 4, ORDER_BARS = 8, TARGET_R = 3, HOLD_BARS = 48;
const bars = R.load('XAUUSD.sml_M15.csv');
const D = I.dailyOf(bars), dayAtr = bars.map(k => { const j = D.index.get(Math.floor(k.t / DAY)); return j === undefined ? null : D.days[j].atrPrev; });
const news = loadReleases(findCalendar(), null).times;
const nearNews = t => { const i = firstFrom(news, t - NEWS_WIN); return i < news.length && news[i] <= t + NEWS_WIN; };
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// The mirror image for shorts: flip prices (and the spread's side) so one long-only engine serves both.
const flip = bs => bs.map(k => ({ t: k.t, o: -k.o - k.sp, h: -k.l - k.sp, l: -k.h - k.sp, c: -k.c - k.sp, sp: k.sp }));
const flipped = flip(bars);

/** A valid range of the L bars before bar i, or null. */
function rangeAt(bs, i, L, C) {
  if (i < L + PUSH_BARS + 1 || !dayAtr[i]) return null;
  let hi = -Infinity, lo = Infinity;
  for (let j = i - L; j < i; j++) { hi = Math.max(hi, bs[j].h); lo = Math.min(lo, bs[j].l); }
  const h = hi - lo;
  if (!(h > 0) || h > MAX_H * dayAtr[i]) return null;
  let touches = 0, prev = false;
  for (let j = i - L; j < i; j++) { const t = bs[j].l <= lo + TOUCH * h; if (t && !prev) touches++; prev = t; }
  if (touches < MIN_TOUCHES) return null;
  if (C === 'C1' && bs[i - L - 1].c - bs[i - L - 1 - PUSH_BARS].c < h) return null;
  return { hi, lo, h };
}

function run(bs, L, C, slip) {
  const tr = [];
  let i = 0;
  while (i < bs.length - 1) {
    const k = bs[i];
    if (k.t < FROM || k.t >= R.FRESH_FROM) { i++; continue; }
    const rg = rangeAt(bs, i, L, C);
    if (!rg || !(k.c < rg.lo)) { i++; continue; }
    // the breakdown: look for a close back above the bottom within the next 4 bars
    let falseLow = k.l, back = -1;
    for (let j = i + 1; j <= i + RECLAIM_BARS && j < bs.length; j++) { falseLow = Math.min(falseLow, bs[j].l); if (bs[j].c > rg.lo) { back = j; break; } }
    if (back < 0) { i++; continue; }
    const level = rg.lo, stop = falseLow, risk = level - stop;
    if (!(risk > 0)) { i = back + 1; continue; }
    // the buy limit rests for the next 8 bars
    let fill = -1;
    for (let j = back + 1; j <= back + ORDER_BARS && j < bs.length; j++) {
      if (bs[j].l + bs[j].sp <= level) { fill = j; break; }        // price must pass the level before the stop
    }
    if (fill < 0) { i = back + 1; continue; }
    const entry = Math.min(bs[fill].o + bs[fill].sp, level), r1 = entry - stop, tp = entry + TARGET_R * r1;
    if (!(r1 > 0)) { i = fill + 1; continue; }                     // opened at or under the stop: no trade
    let out = null;
    for (let j = fill; j < bs.length && !out; j++) {
      const b = bs[j];
      if (b.l <= stop) out = { j, px: Math.min(j === fill ? stop : b.o, stop) - slip(b.t) };
      else if (j > fill && b.h >= tp) out = { j, px: tp };
      else if (j - fill >= HOLD_BARS) out = { j, px: b.o - slip(b.t) };
    }
    if (!out) break;
    tr.push({ t: bs[fill].t, r: (out.px - entry) / r1 });
    i = out.j + 1;
  }
  return tr;
}

const sum = a => a.reduce((x, y) => x + y, 0);
const pf = tr => { const w = sum(tr.filter(t => t.r > 0).map(t => t.r)), l = -sum(tr.filter(t => t.r <= 0).map(t => t.r)); return l ? w / l : Infinity; };
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const f = (v, d) => isFinite(v) ? v.toFixed(d === undefined ? 1 : d) : 'inf';
function many(bs, L, C, seed0) {
  const o = { ra: [], rb: [], pa: [], pb: [], wa: [], wb: [], na: 0, nb: 0 };
  for (let k = 0; k < RUNS; k++) {
    const rand = rng(seed0 + k);
    const tr = run(bs, L, C, t => BASE + LIVE[Math.floor(rand() * LIVE.length)] * (nearNews(t) ? NEWS_X : 1) + (rand() < LATE_P ? LATE_USD : 0));
    const a = tr.filter(t => t.t < SPLIT), b = tr.filter(t => t.t >= SPLIT);
    o.ra.push(sum(a.map(t => t.r))); o.rb.push(sum(b.map(t => t.r))); o.pa.push(pf(a)); o.pb.push(pf(b));
    o.wa.push(a.filter(t => t.r > 0).length / (a.length || 1)); o.wb.push(b.filter(t => t.r > 0).length / (b.length || 1)); o.na = a.length; o.nb = b.length;
  }
  const ideal = run(bs, L, C, () => BASE);
  o.ia = sum(ideal.filter(t => t.t < SPLIT).map(t => t.r)); o.ib = sum(ideal.filter(t => t.t >= SPLIT).map(t => t.r));
  return o;
}
const line = (name, o) => '  ' + name.padEnd(9) + '|' + String(o.na).padStart(10) + f(pct(o.ra, 50)).padStart(7) + f(pct(o.pa, 50), 2).padStart(6) + (pct(o.wa, 50) * 100).toFixed(0).padStart(6) +
  ' |' + String(o.nb).padStart(10) + f(pct(o.rb, 50)).padStart(7) + f(pct(o.pb, 50), 2).padStart(6) + (pct(o.wb, 50) * 100).toFixed(0).padStart(6) + ((o.rb.filter(v => v > 0).length / RUNS * 100).toFixed(0) + '%').padStart(8) +
  ' |' + f(o.ia).padStart(12) + ' / ' + f(o.ib);

console.log('Failed breakdown on 15-minute bars, long only, ' + RUNS + ' runs of random fills');
console.log('  choice   | 2023-24: n  med R    PF  win% | 2025-26: n  med R    PF  win%  runs>0 | ideal fills 2023-24 / 2025-26 R');
const res = [];
[24, 48].forEach(L => ['C0', 'C1'].forEach(C => {
  const o = many(bars, L, C, 5100);
  res.push({ L, C, o, aMed: pct(o.ra, 50) });
  console.log(line('L' + L + ' ' + C, o));
}));
const pick = res.slice().sort((a, b) => b.aMed - a.aMed)[0], o = pick.o;
const bPos = o.rb.filter(v => v > 0).length / RUNS, bPf = pct(o.pb, 50), pass = bPos >= 0.9 && bPf > 1.2 && o.nb >= 30;
console.log('  picked on 2023-2024: L' + pick.L + ' ' + pick.C + ' -> 2025-2026 median ' + f(pct(o.rb, 50)) + ' R, PF ' + f(bPf, 2) + ', above 0 in ' + (bPos * 100).toFixed(0) + '% of runs, ' + o.nb + ' trades -> ' + (pass ? 'PASS' : 'FAIL'));
console.log(line('mirror sh', many(flipped, pick.L, pick.C, 5100)) + '   (information only: the failed breakout above, sold)');
