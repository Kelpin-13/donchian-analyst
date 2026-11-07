/**
 * "Buy when low, sell when high" (owner request, 7 Nov 2026): fade the edges of the recent range, the mirror image of
 * our breakout rules. Rules fixed before the first run.
 *
 *   node research/fade_lab.js [runs]
 *
 * On 1-hour bars of data/ (broker server time), 2023-04 to 2026-10-08:
 *   low / high  the lowest low and highest high of the previous N bars (N = 20 or 50: about 1 or 2.5 trading days)
 *   entry       a buy limit resting at that low and a sell limit at that high (a buy fills when the Ask reaches it);
 *               one position at a time; a level that moved is re-placed each bar
 *   stop        1 x ATR(14, 1-hour) beyond the entry; target the middle of the range when entered; out after 24 bars
 *   filter      (F0) none, or (F1) only on ranging days: efficiency ratio of the last 10 daily closes under 0.25,
 *               known before the day starts (the same test as section 22)
 *   choices     N20/N50 x F0/F1 = 4. Fills: limit entries and targets at their price; stops and time exits draw slippage
 *               as research/realism_lab.js (live demo fills, x3 near US news, 2% late +$3), on top of the spread; 100 runs.
 *   pick / pass best median total R on 2023-2024; pass if 2025-2026 is above 0 in at least 90% of runs with a median
 *               profit factor over 1.2. The fresh month is not used.
 * Results (7 Nov 2026, one run, 100 runs of random fills): every choice lost in both halves, also with ideal fills.
 *   2023-24 / 2025-26 median R: N20 F0 -490.6 / -448.1; N20 F1 -200.0 / -131.0; N50 F0 -366.7 / -311.9;
 *   N50 F1 -143.0 / -99.9 (picked; PF 0.69, win 19%, above 0 in 0% of runs): FAIL. Win rates 18-26%: a touch of the
 *   range's edge was usually followed by more of the same move, also on ranging days.
 * Research only: nothing here trades.
 */
const R = require('./daytrade.js');
const I = require('./intraday.js');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const RUNS = Number(process.argv[2]) || 100;
const MIN = 60000, DAY = 86400000, SPLIT = I.SPLIT, FROM = Date.UTC(2023, 3, 1);
const LIVE = [0.03, 0.03, 0.58, 0.16, 0.02, 0.378, 0.085, 1.085, 0.422, 0.11], NEWS_X = 3, NEWS_WIN = 30 * MIN, LATE_P = 0.02, LATE_USD = 3, BASE = 0.05;
const bars = R.load('XAUUSD.sml_H1.csv'), atr = I.atr(bars, 14);
const news = loadReleases(findCalendar(), null).times;
const nearNews = t => { const i = firstFrom(news, t - NEWS_WIN); return i < news.length && news[i] <= t + NEWS_WIN; };
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

// Ranging days: efficiency ratio of the previous 10 daily closes < 0.25 (known at the day's start).
const dayClose = new Map(); bars.forEach(b => dayClose.set(Math.floor(b.t / DAY), b.c));
const dkeys = [...dayClose.keys()].sort((a, b) => a - b), ranging = new Set();
dkeys.forEach((d, i) => { if (i < 11) return; const c = j => dayClose.get(dkeys[j]); let path = 0; for (let j = i - 10; j < i; j++) path += Math.abs(c(j) - c(j - 1));
  if (path && Math.abs(c(i - 1) - c(i - 11)) / path < 0.25) ranging.add(d); });

function run(N, F, slip) {
  const tr = []; let pos = null;
  for (let i = N + 1; i < bars.length; i++) {
    const k = bars[i];
    if (pos) {
      const stopHit = pos.side === 1 ? k.l <= pos.stop : k.h + k.sp >= pos.stop, tpHit = pos.side === 1 ? k.h >= pos.tp : k.l + k.sp <= pos.tp;
      if (stopHit) { const px = (pos.side === 1 ? Math.min(k.o, pos.stop) : Math.max(k.o + k.sp, pos.stop)) - pos.side * slip(k.t); tr.push({ t: pos.t, r: (px - pos.entry) * pos.side / pos.risk }); pos = null; }
      else if (tpHit && i > pos.i) { tr.push({ t: pos.t, r: (pos.tp - pos.entry) * pos.side / pos.risk }); pos = null; }
      else if (i - pos.i >= 24) { const px = (pos.side === 1 ? k.o : k.o + k.sp) - pos.side * slip(k.t); tr.push({ t: pos.t, r: (px - pos.entry) * pos.side / pos.risk }); pos = null; }
      if (pos) continue;
    }
    if (k.t < FROM || !atr[i - 1]) continue;
    if (F === 'F1' && !ranging.has(Math.floor(k.t / DAY))) continue;
    let hi = -Infinity, lo = Infinity;
    for (let j = i - N; j < i; j++) { hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l); }
    const mid = (hi + lo) / 2, a = atr[i - 1];
    const buy = k.l + k.sp <= lo, sell = k.h >= hi;
    if (!buy && !sell) continue;
    const side = buy && sell ? (Math.abs(k.o - lo) < Math.abs(k.o - hi) ? 1 : -1) : buy ? 1 : -1;
    const entry = side === 1 ? Math.min(k.o + k.sp, lo) : Math.max(k.o, hi);
    const stop = entry - side * a, tp = mid;
    if ((tp - entry) * side <= 0) continue;
    pos = { side, entry, stop, tp, risk: a, t: k.t, i };
    // the fill bar itself: a stop inside it counts first (the worst case)
    if (side === 1 ? k.l <= stop : k.h + k.sp >= stop) { const px = stop - side * slip(k.t); tr.push({ t: pos.t, r: (px - entry) * side / a }); pos = null; }
  }
  return tr;
}
const sum = a => a.reduce((x, y) => x + y, 0);
const pf = tr => { const w = sum(tr.filter(t => t.r > 0).map(t => t.r)), l = -sum(tr.filter(t => t.r <= 0).map(t => t.r)); return l ? w / l : Infinity; };
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const f = (v, d) => isFinite(v) ? v.toFixed(d === undefined ? 1 : d) : 'inf';

console.log('Fade the range edges on 1-hour bars, ' + RUNS + ' runs of random fills; ' + ranging.size + ' ranging days of ' + dkeys.length);
console.log('  choice   | 2023-24: n  med R    PF  win% | 2025-26: n  med R    PF  win%  runs>0 | ideal fills 2023-24 / 2025-26 R');
const res = [];
[20, 50].forEach(N => ['F0', 'F1'].forEach(F => {
  const ra = [], rb = [], pa = [], pb = [], wa = [], wb = []; let na = 0, nb = 0;
  for (let k = 0; k < RUNS; k++) {
    const rand = rng(4100 + k);
    const tr = run(N, F, t => BASE + LIVE[Math.floor(rand() * LIVE.length)] * (nearNews(t) ? NEWS_X : 1) + (rand() < LATE_P ? LATE_USD : 0));
    const a = tr.filter(t => t.t < SPLIT), b = tr.filter(t => t.t >= SPLIT);
    ra.push(sum(a.map(t => t.r))); rb.push(sum(b.map(t => t.r))); pa.push(pf(a)); pb.push(pf(b));
    wa.push(a.filter(t => t.r > 0).length / (a.length || 1)); wb.push(b.filter(t => t.r > 0).length / (b.length || 1)); na = a.length; nb = b.length;
  }
  const ideal = run(N, F, () => BASE), ia = sum(ideal.filter(t => t.t < SPLIT).map(t => t.r)), ib = sum(ideal.filter(t => t.t >= SPLIT).map(t => t.r));
  const x = { N, F, aMed: pct(ra, 50), bMed: pct(rb, 50), bPf: pct(pb, 50), bPos: rb.filter(v => v > 0).length / RUNS };
  res.push(x);
  console.log('  N' + N + ' ' + F + '  |' + String(na).padStart(10) + f(x.aMed).padStart(7) + f(pct(pa, 50), 2).padStart(6) + (pct(wa, 50) * 100).toFixed(0).padStart(6) +
              ' |' + String(nb).padStart(10) + f(x.bMed).padStart(7) + f(x.bPf, 2).padStart(6) + (pct(wb, 50) * 100).toFixed(0).padStart(6) + ((x.bPos * 100).toFixed(0) + '%').padStart(8) +
              ' |' + f(ia).padStart(12) + ' / ' + f(ib));
}));
const pick = res.slice().sort((a, b) => b.aMed - a.aMed)[0], pass = pick.bPos >= 0.9 && pick.bPf > 1.2;
console.log('  picked on 2023-2024: N' + pick.N + ' ' + pick.F + ' -> 2025-2026 median ' + f(pick.bMed) + ' R, PF ' + f(pick.bPf, 2) + ', above 0 in ' + (pick.bPos * 100).toFixed(0) + '% of runs -> ' + (pass ? 'PASS' : 'FAIL'));
