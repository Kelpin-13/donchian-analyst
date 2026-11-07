/**
 * AMD (accumulation, manipulation, distribution; ICT's "power of three"), owner request 7 Nov 2026.
 * The public idea: price builds a range in the Asian session (accumulation), London runs one side of it to take the
 * stops there (manipulation, the "Judas swing"), then the real move goes the other way into New York (distribution).
 *
 *   node research/amd_lab.js [runs]
 *
 * Rules, fixed before the first run (broker server time = New York + 7 h; M15 bars of data/, to 8 Oct 2026):
 *   accumulation  the Asian range: high and low of the bars opening 01:00-08:45 (at least 20 bars)
 *   manipulation  a bar opening 09:00-15:45 trades beyond one side by at least 0.1 x the daily ATR(14) (yesterday's)
 *                 = a sweep; it counts when, within 8 bars (2 hours) of the first sweep bar, a bar CLOSES back
 *                 inside the range. First side to do so wins; one trade a day.
 *   distribution  enter the other way at the next bar's open (a market order: buy at Ask, sell at Bid); stop
 *                 0.05 x ATR beyond the sweep's extreme; out at the take-profit, the stop, or the 23:00 bar's open
 *                 (flat before the rollover, as every intraday strategy). Stops of $2-$150 only (the EAs' cap).
 *   choices (4)   target: (T1) the far side of the Asian range, skipped if that is under 1R away, or (T2) 2R;
 *                 filter: (F0) none, or (F1) only in the H4 trend's direction (research/intraday.js h4Trend).
 *   fills         every non-limit fill draws its own slippage as in research/realism_lab.js (live demo fills,
 *                 x3 within 30 min of US news, 2% late +$3), on top of the bar's spread and $0.05; 100 runs.
 *   pick / pass   pick the choice with the best median total R on 2023-2024; it passes if on 2025-2026 its median
 *                 total R is above 0 in at least 90% of runs with a median profit factor over 1.2. Information only:
 *                 the same with $0.05 fills (--ideal), and the effect on the book of five + H4.
 * Results (7 Nov 2026, one run): 289 setup days (139 buys, 150 sells), 2023-04 to 2026-10.
 *   realistic fills: every choice lost in both halves; picked T1 F1 (2023-24 median -14.9 R, PF 0.43) ->
 *   2025-26 median -11.3 R, PF 0.62, above 0 in 0% of runs: FAIL. With $0.05 fills every choice also lost (PF 0.45-0.76).
 *   About two thirds of the trades were stopped out: the sweep held as the day's extreme on only 35% of setups, so a
 *   run past the Asian range usually kept going. (The opposite, trading the breakout, is what ASIAN_NARROW does.
 *   Testing that reversal of this rule now would be choosing after seeing the result, so it is not done here.)
 * Research only: nothing here trades.
 */
const R = require('./daytrade.js');
const I = require('./intraday.js');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const RUNS = Number(process.argv[2]) || 100, IDEAL = process.argv.includes('--ideal');
const MIN = 60000, DAY = 86400000, SPLIT = I.SPLIT;
const LIVE = [0.03, 0.03, 0.58, 0.16, 0.02, 0.378, 0.085, 1.085, 0.422, 0.11], NEWS_X = 3, NEWS_WIN = 30 * MIN, LATE_P = 0.02, LATE_USD = 3, BASE = 0.05;
const ACC_FROM = 60, ACC_TO = 9 * 60, MAN_TO = 16 * 60, FLAT = 23 * 60, SWEEP_K = 0.1, BUF_K = 0.05, WAIT_BARS = 8;

const bars = R.load('XAUUSD.sml_M15.csv');
const { days, index } = I.dailyOf(bars), trend = I.h4Trend(bars);
const news = loadReleases(findCalendar(), null).times;
const nearNews = t => { const i = firstFrom(news, t - NEWS_WIN); return i < news.length && news[i] <= t + NEWS_WIN; };
const mod = t => Math.floor((t % DAY) / MIN);
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/** The day's setup (independent of fills): side, entry bar, the stop level, the range. */
const setups = [];
days.forEach((dy, j) => {
  if (!dy.atrPrev) return;
  const end = j + 1 < days.length ? days[j + 1].i : bars.length;
  let hi = -Infinity, lo = Infinity, n = 0;
  for (let i = dy.i; i < end; i++) { const m = mod(bars[i].t); if (m >= ACC_FROM && m < ACC_TO) { hi = Math.max(hi, bars[i].h); lo = Math.min(lo, bars[i].l); n++; } }
  if (n < 20) return;
  const a = dy.atrPrev, up = { first: -1, ext: -Infinity }, dn = { first: -1, ext: Infinity };
  for (let i = dy.i; i < end; i++) {
    const b = bars[i], m = mod(b.t);
    if (m < ACC_TO) continue;
    if (m >= MAN_TO) break;
    if (b.h + b.sp >= hi + SWEEP_K * a && up.first < 0) up.first = i;
    if (b.l <= lo - SWEEP_K * a && dn.first < 0) dn.first = i;
    if (up.first >= 0) up.ext = Math.max(up.ext, b.h + b.sp);
    if (dn.first >= 0) dn.ext = Math.min(dn.ext, b.l);
    const sell = up.first >= 0 && i - up.first <= WAIT_BARS && b.c < hi;
    const buy = dn.first >= 0 && i - dn.first <= WAIT_BARS && b.c > lo;
    if ((sell || buy) && i + 1 < end) {
      const side = sell ? -1 : 1;                      // a bar closing inside after both sweeps: the sell side was checked first
      setups.push({ t: bars[i + 1].t, i: i + 1, end, side, hi, lo, atr: a,
                    stop: side === -1 ? up.ext + BUF_K * a : dn.ext - BUF_K * a, trend: trend[i + 1] });
      return;
    }
  }
});

function trade(s, target, filter, slip) {
  if (filter === 'F1' && s.trend !== s.side) return null;
  const k = bars[s.i], side = s.side;
  const entry = (side === 1 ? k.o + k.sp : k.o) + side * slip(k.t);
  const risk = (entry - s.stop) * side;
  if (!(risk >= 2 && risk <= 150)) return null;
  let tp = target === 'T2' ? entry + side * 2 * risk : (side === 1 ? s.hi : s.lo + 0);
  if (target === 'T1' && (tp - entry) * side < risk) return null;
  for (let i = s.i; i < s.end; i++) {
    const b = bars[i];
    if (mod(b.t) >= FLAT) { const px = (side === 1 ? b.o : b.o + b.sp) - side * slip(b.t); return { t: s.t, r: (px - entry) * side / risk, why: 'SESSION' }; }
    const hitStop = side === 1 ? b.l <= s.stop : b.h + b.sp >= s.stop;
    const hitTp = side === 1 ? b.h >= tp : b.l + b.sp <= tp;
    if (hitStop) { const px = (side === 1 ? Math.min(b.o, s.stop) : Math.max(b.o + b.sp, s.stop)) - side * slip(b.t); return { t: s.t, r: (px - entry) * side / risk, why: 'STOP' }; }
    if (hitTp) return { t: s.t, r: (tp - entry) * side / risk, why: 'TARGET' };
  }
  const b = bars[s.end - 1], px = (side === 1 ? b.c : b.c + b.sp) - side * slip(b.t);
  return { t: s.t, r: (px - entry) * side / risk, why: 'SESSION' };
}

const sum = a => a.reduce((x, y) => x + y, 0);
const pf = tr => { const w = sum(tr.filter(t => t.r > 0).map(t => t.r)), l = -sum(tr.filter(t => t.r <= 0).map(t => t.r)); return l ? w / l : Infinity; };
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const slipper = rand => IDEAL ? () => BASE : t => BASE + LIVE[Math.floor(rand() * LIVE.length)] * (nearNews(t) ? NEWS_X : 1) + (rand() < LATE_P ? LATE_USD : 0);

const CHOICES = [['T1', 'F0'], ['T1', 'F1'], ['T2', 'F0'], ['T2', 'F1']];
console.log('AMD: ' + setups.length + ' days with a sweep and a close back inside (' + setups.filter(s => s.side === 1).length + ' buys, ' +
            setups.filter(s => s.side === -1).length + ' sells), ' + (IDEAL ? '$0.05 fills' : RUNS + ' runs of random fills'));
console.log('  choice   2023-24: n  median R    PF  worst 5% | 2025-26: n  median R    PF  worst 5%  runs > 0   win%  stop  tp  session');
const res = CHOICES.map(([T, F]) => {
  const ra = [], rb = [], pa = [], pb = []; let last = null;
  for (let k = 0; k < (IDEAL ? 1 : RUNS); k++) {
    const slip = slipper(rng(900 + k));
    const tr = setups.map(s => trade(s, T, F, slip)).filter(Boolean);
    const a = tr.filter(t => t.t < SPLIT), b = tr.filter(t => t.t >= SPLIT);
    ra.push(sum(a.map(t => t.r))); rb.push(sum(b.map(t => t.r))); pa.push(pf(a)); pb.push(pf(b)); last = { a, b };
  }
  const x = { T, F, aMed: pct(ra, 50), bMed: pct(rb, 50), aPf: pct(pa, 50), bPf: pct(pb, 50), a5: pct(ra, 5), b5: pct(rb, 5), bPos: rb.filter(v => v > 0).length / rb.length, last };
  const b = last.b, share = w => b.length ? (b.filter(t => t.why === w).length / b.length * 100).toFixed(0) : '-';
  console.log('  ' + (T + ' ' + F).padEnd(7) + String(last.a.length).padStart(11) + x.aMed.toFixed(1).padStart(10) + x.aPf.toFixed(2).padStart(6) + x.a5.toFixed(1).padStart(10) +
              ' |' + String(b.length).padStart(10) + x.bMed.toFixed(1).padStart(10) + x.bPf.toFixed(2).padStart(6) + x.b5.toFixed(1).padStart(10) +
              ((x.bPos * 100).toFixed(0) + '%').padStart(10) + (b.length ? (b.filter(t => t.r > 0).length / b.length * 100).toFixed(0) : '-').padStart(7) +
              share('STOP').padStart(6) + share('TARGET').padStart(4) + share('SESSION').padStart(9));
  return x;
});
const pick = res.slice().sort((x, y) => y.aMed - x.aMed)[0];
const pass = pick.bMed > 0 && pick.bPos >= 0.9 && pick.bPf > 1.2;
console.log('  picked on 2023-2024: ' + pick.T + ' ' + pick.F + ' -> 2025-2026 median ' + pick.bMed.toFixed(1) + ' R, PF ' + pick.bPf.toFixed(2) + ', above 0 in ' +
            (pick.bPos * 100).toFixed(0) + '% of runs -> ' + (pass ? 'PASS' : 'FAIL'));
// How often the sweep side was the day's real high/low: does "manipulation" happen more than chance?
const real = setups.filter(s => { const end = s.end; let h = -Infinity, l = Infinity; for (let i = s.i; i < end; i++) { h = Math.max(h, bars[i].h); l = Math.min(l, bars[i].l); }
  return s.side === -1 ? h < s.stop : l > s.stop; }).length;
console.log('  the sweep held as the day\'s extreme (price never came back past the stop before 23:00) on ' + (real / setups.length * 100).toFixed(0) + '% of setups');
