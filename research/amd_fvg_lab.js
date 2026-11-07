/**
 * AMD with a liquidity sweep and a fair value gap entry (owner request, 7 Nov 2026: "add liquidity sweep and FVG
 * concept while testing AMD"). A second AMD study after research/amd_lab.js failed: the more versions tried on the
 * same years, the likelier one passes by luck, so the choices are few and fixed here, and the fresh month
 * (9 Oct - 6 Nov 2026, never used before) is reported once at the end.
 *
 *   node research/amd_fvg_lab.js [runs] [--ideal]
 *
 * On 5-minute bars made from data/XAUUSD.sml_M1.csv (broker server time = New York + 7 h). Fixed before the first run:
 *   liquidity    (L1) the Asian range's high and low (bars opening 01:00-08:55), or (L2) those plus the previous
 *                server day's high and low.
 *   sweep        a bar opening 09:00-15:55 trades beyond a pool by at least 0.1 x the daily ATR(14) (yesterday's);
 *                the first sweep of the day sets the side (a sweep above = look for a sell).
 *   shift + FVG  within 24 bars (2 hours) of the sweep, a fair value gap forms the other way: for a sell, bar[n-2]'s
 *                low is above bar[n]'s high (a bearish gap left by a fast move down), and bar[n] closes back on the
 *                inside of the swept level. The first such gap counts.
 *   entry        a limit order at the gap's middle (ICT's "consequent encroachment"), from the next bar until 16:00;
 *                a sell limit fills when the Bid reaches it, a buy limit when the Ask does. Cancelled if the stop is
 *                hit first or 16:00 passes. One trade a day.
 *   stop         0.05 x ATR beyond the sweep's extreme (stops of $2-$150 only, the EAs' cap).
 *   target       (T1) the opposite side of the Asian range, skipped if under 1R, or (T2) 2R; out at 23:00 otherwise.
 *   choices      L1/L2 x T1/T2 = 4. Fills: limit entries and take-profits at their price; stop and session exits
 *                draw slippage as in research/realism_lab.js (live demo fills, x3 within 30 min of US news, 2% late
 *                +$3) on top of the spread; 100 runs. 5-minute spread = the widest 1-minute spread in it.
 *   pick / pass  best median total R on 2023-2024; pass if 2025-2026 (to 8 Oct) has a median total R above 0 in at
 *                least 90% of runs with a median profit factor over 1.2. The fresh month: information only.
 * Results (7 Nov 2026, one run): 244-251 setup days, 2023-04 to 2026-10; about 70-78% of filled trades stopped out.
 *   realistic fills: every choice lost in both halves; picked L2 T2 (2023-24 median -12.8 R, PF 0.83) ->
 *   2025-26 median -21.8 R, PF 0.60, above 0 in 0% of runs: FAIL. With $0.05 fills every choice also lost
 *   (PF 0.46-0.94). Fresh month: 3 trades, about 0 R (too few to mean anything).
 * Research only: nothing here trades.
 */
const R = require('./daytrade.js');
const I = require('./intraday.js');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const RUNS = Number(process.argv[2]) || 100, IDEAL = process.argv.includes('--ideal');
const MIN = 60000, DAY = 86400000, SPLIT = I.SPLIT, FRESH = R.FRESH_FROM;
const LIVE = [0.03, 0.03, 0.58, 0.16, 0.02, 0.378, 0.085, 1.085, 0.422, 0.11], NEWS_X = 3, NEWS_WIN = 30 * MIN, LATE_P = 0.02, LATE_USD = 3, BASE = 0.05;
const ACC_FROM = 60, ACC_TO = 9 * 60, LAST_ENTRY = 16 * 60, FLAT = 23 * 60, SWEEP_K = 0.1, BUF_K = 0.05, FVG_BARS = 24;

// 5-minute bars from M1, including the fresh month (kept apart in the results).
const m5 = [];
R.load('XAUUSD.sml_M1.csv', { fresh: true }).forEach(b => {
  const t = Math.floor(b.t / (5 * MIN)) * 5 * MIN, x = m5[m5.length - 1];
  if (x && x.t === t) { x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.c = b.c; x.sp = Math.max(x.sp, b.sp); }
  else m5.push({ t, o: b.o, h: b.h, l: b.l, c: b.c, sp: b.sp });
});
const mod = t => Math.floor((t % DAY) / MIN), dayOf = t => Math.floor(t / DAY);
const { days } = I.dailyOf(m5);
const news = loadReleases(findCalendar(), null).times;
const nearNews = t => { const i = firstFrom(news, t - NEWS_WIN); return i < news.length && news[i] <= t + NEWS_WIN; };
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

/** One setup a day per liquidity choice: independent of the fills. */
function setupsFor(L) {
  const out = [];
  days.forEach((dy, j) => {
    if (!dy.atrPrev || j === 0) return;
    const end = j + 1 < days.length ? days[j + 1].i : m5.length, a = dy.atrPrev, prev = days[j - 1];
    let ah = -Infinity, al = Infinity, n = 0;
    for (let i = dy.i; i < end; i++) { const m = mod(m5[i].t); if (m >= ACC_FROM && m < ACC_TO) { ah = Math.max(ah, m5[i].h); al = Math.min(al, m5[i].l); n++; } }
    if (n < 60) return;
    const highs = L === 'L2' ? [ah, prev.h] : [ah], lows = L === 'L2' ? [al, prev.l] : [al];
    let side = 0, swept = null, sweepAt = -1, ext = null;
    for (let i = dy.i; i < end; i++) {
      const b = m5[i], m = mod(b.t);
      if (m < ACC_TO) continue;
      if (m >= LAST_ENTRY) break;
      if (!side) {
        const hUp = highs.find(h => b.h + b.sp >= h + SWEEP_K * a), hDn = lows.find(l => b.l <= l - SWEEP_K * a);
        if (hUp !== undefined) { side = -1; swept = hUp; sweepAt = i; ext = b.h + b.sp; }
        else if (hDn !== undefined) { side = 1; swept = hDn; sweepAt = i; ext = b.l; }
        continue;
      }
      if (i - sweepAt > FVG_BARS) return;
      if (side === -1) ext = Math.max(ext, b.h + b.sp); else ext = Math.min(ext, b.l);
      const b2 = m5[i - 2];
      const gap = side === -1 ? b2.l > b.h && b.c < swept : b2.h < b.l && b.c > swept;
      if (gap && i - 2 > sweepAt - 1) {
        const top = side === -1 ? b2.l : b.l, bottom = side === -1 ? b.h : b2.h;
        out.push({ t: m5[i].t, from: i + 1, end, side, entry: (top + bottom) / 2, stop: side === -1 ? ext + BUF_K * a : ext - BUF_K * a, ah, al });
        return;
      }
    }
  });
  return out;
}

function trade(s, T, slip) {
  const side = s.side, risk = (s.entry - s.stop) * side;
  if (!(risk >= 2 && risk <= 150)) return null;
  const tp = T === 'T2' ? s.entry + side * 2 * risk : (side === 1 ? s.ah : s.al);
  if (T === 'T1' && (tp - s.entry) * side < risk) return null;
  let i = s.from, filled = false;
  for (; i < s.end; i++) {                                      // waiting for the limit
    const b = m5[i];
    if (mod(b.t) >= LAST_ENTRY) return null;
    const stopFirst = side === 1 ? b.l <= s.stop : b.h + b.sp >= s.stop;
    const fill = side === 1 ? b.l + b.sp <= s.entry : b.h >= s.entry;
    if (fill) { filled = true; break; }
    if (stopFirst) return null;
  }
  if (!filled) return null;
  for (; i < s.end; i++) {                                      // in the trade (the fill bar too: stop first, the worst case)
    const b = m5[i];
    if (mod(b.t) >= FLAT) { const px = (side === 1 ? b.o : b.o + b.sp) - side * slip(b.t); return { t: s.t, r: (px - s.entry) * side / risk, why: 'SESSION' }; }
    if (side === 1 ? b.l <= s.stop : b.h + b.sp >= s.stop) {
      const px = (side === 1 ? Math.min(b.o, s.stop) : Math.max(b.o + b.sp, s.stop)) - side * slip(b.t);
      return { t: s.t, r: (px - s.entry) * side / risk, why: 'STOP' };
    }
    if (side === 1 ? b.h >= tp : b.l + b.sp <= tp) return { t: s.t, r: (tp - s.entry) * side / risk, why: 'TARGET' };
  }
  const b = m5[s.end - 1], px = (side === 1 ? b.c : b.c + b.sp) - side * slip(b.t);
  return { t: s.t, r: (px - s.entry) * side / risk, why: 'SESSION' };
}

const sum = a => a.reduce((x, y) => x + y, 0);
const pf = tr => { const w = sum(tr.filter(t => t.r > 0).map(t => t.r)), l = -sum(tr.filter(t => t.r <= 0).map(t => t.r)); return l ? w / l : Infinity; };
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const slipper = rand => IDEAL ? () => BASE : t => BASE + LIVE[Math.floor(rand() * LIVE.length)] * (nearNews(t) ? NEWS_X : 1) + (rand() < LATE_P ? LATE_USD : 0);

console.log('AMD + liquidity sweep + FVG on 5-minute bars, ' + (IDEAL ? '$0.05 fills' : RUNS + ' runs of random fills'));
console.log('  choice  setups | 2023-24: n  median R    PF  worst 5% | 2025-26: n  median R    PF  worst 5%  runs > 0  win% stop% | fresh: n  median R');
const res = [];
['L1', 'L2'].forEach(L => {
  const S = setupsFor(L);
  ['T1', 'T2'].forEach(T => {
    const ra = [], rb = [], rf = [], pa = [], pb = []; let last = null;
    for (let k = 0; k < (IDEAL ? 1 : RUNS); k++) {
      const slip = slipper(rng(700 + k));
      const tr = S.map(s => trade(s, T, slip)).filter(Boolean);
      const a = tr.filter(t => t.t < SPLIT), b = tr.filter(t => t.t >= SPLIT && t.t < FRESH), f = tr.filter(t => t.t >= FRESH);
      ra.push(sum(a.map(t => t.r))); rb.push(sum(b.map(t => t.r))); rf.push(sum(f.map(t => t.r))); pa.push(pf(a)); pb.push(pf(b)); last = { a, b, f };
    }
    const x = { L, T, aMed: pct(ra, 50), bMed: pct(rb, 50), fMed: pct(rf, 50), aPf: pct(pa, 50), bPf: pct(pb, 50), a5: pct(ra, 5), b5: pct(rb, 5), bPos: rb.filter(v => v > 0).length / rb.length };
    res.push(x);
    const b = last.b;
    console.log('  ' + (L + ' ' + T).padEnd(7) + String(S.length).padStart(7) + ' |' + String(last.a.length).padStart(10) + x.aMed.toFixed(1).padStart(10) + x.aPf.toFixed(2).padStart(6) + x.a5.toFixed(1).padStart(10) +
                ' |' + String(b.length).padStart(10) + x.bMed.toFixed(1).padStart(10) + x.bPf.toFixed(2).padStart(6) + x.b5.toFixed(1).padStart(10) + ((x.bPos * 100).toFixed(0) + '%').padStart(10) +
                (b.length ? (b.filter(t => t.r > 0).length / b.length * 100).toFixed(0) : '-').padStart(6) + (b.length ? (b.filter(t => t.why === 'STOP').length / b.length * 100).toFixed(0) : '-').padStart(6) +
                ' |' + String(last.f.length).padStart(8) + x.fMed.toFixed(1).padStart(10));
  });
});
const pick = res.slice().sort((x, y) => y.aMed - x.aMed)[0];
const pass = pick.bMed > 0 && pick.bPos >= 0.9 && pick.bPf > 1.2;
console.log('  picked on 2023-2024: ' + pick.L + ' ' + pick.T + ' -> 2025-2026 median ' + pick.bMed.toFixed(1) + ' R, PF ' + pick.bPf.toFixed(2) + ', above 0 in ' +
            (pick.bPos * 100).toFixed(0) + '% of runs -> ' + (pass ? 'PASS' : 'FAIL') + '; fresh month (information only) median ' + pick.fMed.toFixed(1) + ' R');
