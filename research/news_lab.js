/**
 * News study (owner, 6 Nov 2026: "news can push the market in a faster momentum ... use the news to determine the
 * market bias"). Two questions on the broker's M1 gold bars (2023 onwards) and MT5's calendar:
 *
 *   node research/news_lab.js [runs] [--ideal]      --ideal: $0.05 a side, for information (how much the fills cost)
 *
 * A. Momentum after the release. Big four US releases (jobs report, CPI, Fed decision, Fed press conference).
 *    Fixed before running: wait W minutes after the release (W = 5 or 15); trade in the direction gold moved from the
 *    last price before the release to the close W minutes after; stop at the far side of that move (the low since
 *    the release for a buy); take-profit 1.5 x the risk; otherwise out after H minutes (H = 60 or 120). Skipped when
 *    the stop is under $2 or over $150 away. Fills: the realistic model of research/realism_lab.js with the news
 *    multiplier on every fill (each run draws its own slippage), plus the bar's spread. One choice of W x H is picked
 *    on 2023-2024 (median total R over the runs); it passes if on 2025-2026 its median total R is above 0, in at
 *    least 90% of the runs, with a profit factor over 1.2 at the median.
 * B. The surprise as a bias. For the jobs report and CPI, surprise = actual - forecast. A stronger number is good
 *    for the dollar and bad for gold, so the expected direction is the opposite of the surprise's sign. Counted:
 *    how often gold moved that way by 60 minutes after, and by the end of the trading day (23:00 broker time).
 *    Useful as a bias only if it is right clearly more than half the time in both halves (55%+), not just overall.
 * Research only: nothing here trades.
 */
const R = require('./daytrade.js');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const MIN = 60000, DAY = 86400000, SPLIT = Date.UTC(2025, 0, 1), RUNS = Number(process.argv[2]) || 100;
const IDEAL = process.argv.includes('--ideal');   // information only: $0.05 a side and the spread, no news slippage
const LIVE = [0.03, 0.03, 0.58, 0.16, 0.02, 0.378, 0.085, 1.085, 0.422, 0.11], NEWS_X = 3, LATE_P = 0.02, LATE_USD = 3, BASE = 0.05;
const m1 = R.load('XAUUSD.sml_M1.csv'), times = m1.map(b => b.t);
const rel = loadReleases(findCalendar(), 'top').releases.filter(e => e.t >= m1[0].t + DAY && e.t <= m1[m1.length - 1].t - DAY);
const idx = t => firstFrom(times, t);            // first bar at or after t
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/* ---------- A: momentum ---------- */
function trade(e, W, H, slip) {
  const i0 = idx(e.t); if (i0 <= 0 || m1[i0].t - e.t > 5 * MIN) return null;          // no bars at the release
  const before = m1[i0 - 1].c, iw = idx(e.t + W * MIN); if (iw >= m1.length) return null;
  const last = m1[iw - 1], dir = Math.sign(last.c - before); if (!dir) return null;
  let ext = dir === 1 ? Infinity : -Infinity;
  for (let j = i0; j < iw; j++) ext = dir === 1 ? Math.min(ext, m1[j].l) : Math.max(ext, m1[j].h + m1[j].sp);
  const k = m1[iw];
  const entry = (dir === 1 ? k.o + k.sp : k.o) + dir * slip();
  const risk = (entry - ext) * dir;
  if (!(risk >= 2 && risk <= 150)) return null;
  const target = entry + dir * 1.5 * risk, end = e.t + (W + H) * MIN;
  for (let j = iw; j < m1.length && m1[j].t < end; j++) {
    const b = m1[j];
    const hitStop = dir === 1 ? b.l <= ext : b.h + b.sp >= ext, hitTp = dir === 1 ? b.h >= target : b.l + b.sp <= target;
    if (hitStop) { const px = (dir === 1 ? Math.min(b.o, ext) : Math.max(b.o + b.sp, ext)) - dir * slip(); return { t: e.t, r: (px - entry) * dir / risk, why: 'STOP' }; }
    if (hitTp && j > iw) return { t: e.t, r: 1.5, why: 'TARGET' };
  }
  const jx = Math.min(idx(end), m1.length - 1), b = m1[jx];
  const px = (dir === 1 ? b.o : b.o + b.sp) - dir * slip();
  return { t: e.t, r: (px - entry) * dir / risk, why: 'TIME' };
}
const sum = a => a.reduce((x, y) => x + y, 0);
const pf = tr => { const w = sum(tr.filter(t => t.r > 0).map(t => t.r)), l = -sum(tr.filter(t => t.r <= 0).map(t => t.r)); return l ? w / l : Infinity; };
const med = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pctl = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

const CHOICES = [[5, 60], [5, 120], [15, 60], [15, 120]];
console.log('A. Momentum after the big four US releases, ' + rel.length + ' releases with M1 bars, ' + RUNS + ' runs of random fills each');
console.log('   W  H      2023-24: n  median R  PF   worst 5% R |  2025-26: n  median R  PF   worst 5% R  runs > 0');
const res = CHOICES.map(([W, H]) => {
  const a = [], b = [], pa = [], pb = []; let na = 0, nb = 0;
  for (let k = 0; k < RUNS; k++) {
    const rand = rng(500 + k), slip = IDEAL ? () => BASE : () => BASE + LIVE[Math.floor(rand() * LIVE.length)] * NEWS_X + (rand() < LATE_P ? LATE_USD : 0);
    const tr = rel.map(e => trade(e, W, H, slip)).filter(Boolean);
    const ta = tr.filter(t => t.t < SPLIT), tb = tr.filter(t => t.t >= SPLIT);
    a.push(sum(ta.map(t => t.r))); b.push(sum(tb.map(t => t.r))); pa.push(pf(ta)); pb.push(pf(tb)); na = ta.length; nb = tb.length;
  }
  const x = { W, H, aMed: med(a), bMed: med(b), aPf: med(pa), bPf: med(pb), a5: pctl(a, 5), b5: pctl(b, 5), bPos: b.filter(v => v > 0).length / RUNS };
  console.log('  ' + String(W).padStart(2) + String(H).padStart(4) + String(na).padStart(15) + x.aMed.toFixed(1).padStart(10) + x.aPf.toFixed(2).padStart(6) + x.a5.toFixed(1).padStart(12) +
              ' |' + String(nb).padStart(11) + x.bMed.toFixed(1).padStart(10) + x.bPf.toFixed(2).padStart(6) + x.b5.toFixed(1).padStart(12) + ((x.bPos * 100).toFixed(0) + '%').padStart(10));
  return x;
});
const pick = res.slice().sort((x, y) => y.aMed - x.aMed)[0];
const pass = pick.bMed > 0 && pick.bPos >= 0.9 && pick.bPf > 1.2;
console.log('  picked on 2023-2024: W ' + pick.W + ', H ' + pick.H + ' -> 2025-2026 median ' + pick.bMed.toFixed(1) + ' R, PF ' + pick.bPf.toFixed(2) + ', above 0 in ' +
            (pick.bPos * 100).toFixed(0) + '% of runs -> ' + (pass ? 'PASS' : 'FAIL'));

/* ---------- B: surprise as a bias ---------- */
console.log('\nB. Surprise (actual - forecast) as a bias: gold expected to move against the surprise');
const priceAt = t => { const i = idx(t); return i < m1.length ? m1[Math.max(0, i - 1)].c : null; };
['Nonfarm Payrolls', 'CPI m/m'].forEach(name => {
  const ev = rel.filter(e => e.name === name && e.actual !== null && e.forecast !== null && isFinite(e.actual) && isFinite(e.forecast) && e.actual !== e.forecast);
  const row = (list, label) => {
    let h1 = 0, hd = 0;
    list.forEach(e => {
      const p0 = priceAt(e.t), p1 = priceAt(e.t + 60 * MIN), pd = priceAt(Math.floor(e.t / DAY) * DAY + 23 * 60 * MIN);
      const want = -Math.sign(e.actual - e.forecast);
      if (Math.sign(p1 - p0) === want) h1++;
      if (Math.sign(pd - p0) === want) hd++;
    });
    console.log('  ' + (name + ' ' + label).padEnd(30) + String(list.length).padStart(4) + ' surprises   right after 60 min ' + (list.length ? (h1 / list.length * 100).toFixed(0) : '-').padStart(3) +
                '%   by the day\'s end ' + (list.length ? (hd / list.length * 100).toFixed(0) : '-').padStart(3) + '%');
  };
  row(ev.filter(e => e.t < SPLIT), '2023-24'); row(ev.filter(e => e.t >= SPLIT), '2025-26');
});
