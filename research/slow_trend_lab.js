/**
 * Slow trend on daily bars (time-series momentum, after AQR and Man AHL's published research), owner request 7 Nov 2026.
 * The rules below were written and committed BEFORE the 2008-2026 daily data was exported, so nothing here was chosen
 * after seeing it.
 *
 *   node research/slow_trend_lab.js [runs]          needs data/XAUUSD.sml_D1_2008.csv (mt5/ExportBars.mq5 1.20)
 *
 * Rules, fixed in advance (daily bars on the broker's server days; ATR = Wilder ATR(20) of daily bars):
 *   signal     at each day's close: the sign of close - close L days ago. Four choices: L = 63, 126 or 252 days
 *              (about 3, 6, 12 months), or the blend: the sign of the sum of the three signs.
 *   trade      long and short. Enter at the next day's open when the signal is +1 / -1 and flat; when the signal turns
 *              against the position, close and reverse at the next open.
 *   stop       our rule 1 needs a stop on every trade: a broker stop 3 x ATR from the entry, then trailing 3 x ATR
 *              behind the best close since the entry (moved at each close, fires inside the day; a gap fills at the
 *              open). After a stop-out the same side re-enters only on a new 20-day closing high (low for a short);
 *              the other side enters as soon as the signal turns.
 *   size       0.5% risk at the first stop, so 1 R = 3 x ATR; results in R. No $150 cap: that cap measures a stop
 *              at 0.01 lots, and these stops are wider by design (a decision for the owner if this is ever built).
 *   costs      the bar's spread, $0.05 and the realistic draw of research/realism_lab.js on every fill (live demo
 *              fills, x3 within 30 min of US news, 2% late +$3), 100 runs; swap every day held, at today's demo rates
 *              (long -5.92%, short +3.67% a year of the price, as research/parity_mt5.js), one charge a day.
 *   periods    pick on 2008-2016; judge once on 2017-01-01 to 2026-10-08; the fresh month (from 9 Oct 2026) for
 *              information. Pass: on 2017-2026 the picked choice's median total R is above 0 in at least 90% of
 *              runs, its median profit factor is over 1.3, and both halves (2017-2021, 2022-2026) are above 0 at the
 *              median. Buy-and-hold gold is shown for comparison: a long-biased trend rule must be judged against it.
 * Research only: nothing here trades.
 */
const fs = require('fs');
const path = require('path');
const R = require('./daytrade.js');
const I = require('./intraday.js');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const FILE = 'XAUUSD.sml_D1_2008.csv';
if (!fs.existsSync(path.join(__dirname, '..', 'data', FILE))) { console.log('Missing data/' + FILE + ': run mt5/ExportBars.mq5 (1.20) and copy its files to data/.'); process.exit(1); }
const RUNS = Number(process.argv[2]) || 100;
const MIN = 60000, DAY = 86400000, FRESH = R.FRESH_FROM;
const DESIGN_TO = Date.UTC(2017, 0, 1), HALF = Date.UTC(2022, 0, 1);
const LIVE = [0.03, 0.03, 0.58, 0.16, 0.02, 0.378, 0.085, 1.085, 0.422, 0.11], NEWS_X = 3, NEWS_WIN = 30 * MIN, LATE_P = 0.02, LATE_USD = 3, BASE = 0.05;
const STOP_K = 3, REENTRY = 20, SWAP_LONG = -5.92, SWAP_SHORT = 3.67;

const bars = R.load(FILE, { fresh: true });
const atr = I.atr(bars, 20), closes = bars.map(b => b.c);
const news = loadReleases(findCalendar(), null).times;
const nearNews = t => { const i = firstFrom(news, t - NEWS_WIN); return i < news.length && news[i] <= t + NEWS_WIN; };
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const sign = x => x > 0 ? 1 : x < 0 ? -1 : 0;
function signalAt(i, choice) {
  const s = L => i >= L ? sign(closes[i] - closes[i - L]) : 0;
  if (choice === 'blend') return i >= 252 ? sign(s(63) + s(126) + s(252)) : 0;
  return s(choice);
}

function simulate(choice, slip) {
  const trades = [];
  let pos = null, pending = null, stoppedSide = 0;
  const open = (side, i) => {
    const k = bars[i], a = atr[i - 1];
    if (!a) return null;
    const entry = (side === 1 ? k.o + k.sp : k.o) + side * slip(k.t);
    return { side, t: k.t, entry, risk: STOP_K * a, stop: entry - side * STOP_K * a, best: entry, swap: 0, days: 0 };
  };
  const close = (p, i, px, why) => { trades.push({ t: p.t, exitT: bars[i].t, side: p.side, r: ((px - p.entry) * p.side + p.swap) / p.risk, why, days: p.days, swapR: p.swap / p.risk }); };
  for (let i = 1; i < bars.length; i++) {
    const k = bars[i];
    if (pos) { pos.swap += bars[i - 1].c * (pos.side === 1 ? SWAP_LONG : SWAP_SHORT) / 100 / 360; pos.days++; }
    if (pending) {                                   // yesterday's close decided: execute at this open
      if (pos && pending.exit) { close(pos, i, (pos.side === 1 ? k.o : k.o + k.sp) - pos.side * slip(k.t), 'SIGNAL'); pos = null; }
      if (!pos && pending.side) { pos = open(pending.side, i); stoppedSide = 0; }
      pending = null;
    }
    if (pos && (pos.side === 1 ? k.l <= pos.stop : k.h + k.sp >= pos.stop)) {
      const px = (pos.side === 1 ? Math.min(k.o, pos.stop) : Math.max(k.o + k.sp, pos.stop)) - pos.side * slip(k.t);
      close(pos, i, px, 'STOP'); stoppedSide = pos.side; pos = null;
    }
    const sig = signalAt(i, choice);
    if (pos) {
      pos.best = pos.side === 1 ? Math.max(pos.best, k.c) : Math.min(pos.best, k.c);
      if (atr[i]) { const s = pos.best - pos.side * STOP_K * atr[i]; if ((s - pos.stop) * pos.side > 0) pos.stop = s; }
      if (sig === -pos.side) pending = { exit: true, side: sig };
    } else if (sig) {
      let ok = sig !== stoppedSide;                  // the other side enters at once
      if (!ok && i >= REENTRY) {                     // the same side again: a new 20-day closing extreme
        const prev = closes.slice(i - REENTRY, i);
        ok = sig === 1 ? k.c > Math.max(...prev) : k.c < Math.min(...prev);
      }
      if (ok) pending = { side: sig };
    }
  }
  if (pos) close(pos, bars.length - 1, bars[bars.length - 1].c, 'END');
  return trades;
}

function score(tr) {
  let cu = 0, pk = 0, dd = 0, gw = 0, gl = 0;
  tr.slice().sort((a, b) => a.exitT - b.exitT).forEach(t => { cu += t.r; pk = Math.max(pk, cu); dd = Math.max(dd, pk - cu); if (t.r > 0) gw += t.r; else gl -= t.r; });
  return { n: tr.length, r: cu, dd, pf: gl ? gw / gl : Infinity, ratio: dd ? cu / dd : cu > 0 ? Infinity : 0, win: tr.length ? tr.filter(t => t.r > 0).length / tr.length : 0 };
}
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const f = (v, d) => isFinite(v) ? v.toFixed(d === undefined ? 1 : d) : 'inf';
const per = { design: t => t.t < DESIGN_TO, judge: t => t.t >= DESIGN_TO && t.t < FRESH, h1: t => t.t >= DESIGN_TO && t.t < HALF, h2: t => t.t >= HALF && t.t < FRESH, fresh: t => t.t >= FRESH };

console.log('Daily bars ' + new Date(bars[0].t).toISOString().slice(0, 10) + ' to ' + new Date(bars[bars.length - 1].t).toISOString().slice(0, 10) + ' (' + bars.length + ' days), ' + RUNS + ' runs of random fills');
const CHOICES = [63, 126, 252, 'blend'];
const res = CHOICES.map(choice => {
  const runs = [];
  for (let k = 0; k < RUNS; k++) {
    const rand = rng(2100 + k);
    const slip = t => BASE + LIVE[Math.floor(rand() * LIVE.length)] * (nearNews(t) ? NEWS_X : 1) + (rand() < LATE_P ? LATE_USD : 0);
    const tr = simulate(choice, slip);
    const o = { tr }; Object.keys(per).forEach(p => { o[p] = score(tr.filter(per[p])); }); runs.push(o);
  }
  const m = p => ({ n: runs[0][p].n, r: pct(runs.map(x => x[p].r), 50), dd: pct(runs.map(x => x[p].dd), 50), pf: pct(runs.map(x => x[p].pf), 50),
                    ratio: pct(runs.map(x => x[p].ratio), 50), win: pct(runs.map(x => x[p].win), 50), pos: runs.filter(x => x[p].r > 0).length / runs.length });
  const out = { choice, runs }; Object.keys(per).forEach(p => { out[p] = m(p); });
  return out;
});
console.log('\n  choice  | 2008-16: n   med R    dd     PF  ratio | 2017-26: n   med R    dd     PF  ratio  runs>0 | 2017-21 R  2022-26 R');
res.forEach(x => console.log('  ' + String(x.choice).padEnd(7) + ' |' + String(x.design.n).padStart(10) + f(x.design.r).padStart(8) + f(x.design.dd).padStart(6) + f(x.design.pf, 2).padStart(7) + f(x.design.ratio, 2).padStart(7) +
  ' |' + String(x.judge.n).padStart(10) + f(x.judge.r).padStart(8) + f(x.judge.dd).padStart(6) + f(x.judge.pf, 2).padStart(7) + f(x.judge.ratio, 2).padStart(7) + ((x.judge.pos * 100).toFixed(0) + '%').padStart(8) +
  ' |' + f(x.h1.r).padStart(10) + f(x.h2.r).padStart(10)));
const pick = res.slice().sort((a, b) => b.design.ratio - a.design.ratio)[0];
const pass = pick.judge.pos >= 0.9 && pick.judge.pf > 1.3 && pick.h1.r > 0 && pick.h2.r > 0;
console.log('\n  picked on 2008-2016 (best median profit / drawdown): ' + pick.choice + ' -> 2017-2026: median ' + f(pick.judge.r) + ' R, PF ' + f(pick.judge.pf, 2) +
            ', above 0 in ' + (pick.judge.pos * 100).toFixed(0) + '% of runs, halves ' + f(pick.h1.r) + ' / ' + f(pick.h2.r) + ' R -> ' + (pass ? 'PASS' : 'FAIL'));

// The picked choice in detail, from its median run.
const mid = pick.runs.slice().sort((a, b) => a.judge.r - b.judge.r)[Math.floor(pick.runs.length / 2)].tr;
const years = {};
mid.forEach(t => { const y = new Date(t.exitT).getUTCFullYear(); years[y] = (years[y] || 0) + t.r; });
console.log('  by year (median run): ' + Object.keys(years).map(y => y + ' ' + f(years[y])).join(' | '));
const side = s => mid.filter(t => t.side === s);
console.log('  longs ' + side(1).length + ' trades ' + f(side(1).reduce((a, t) => a + t.r, 0)) + ' R, shorts ' + side(-1).length + ' trades ' + f(side(-1).reduce((a, t) => a + t.r, 0)) + ' R; ' +
            'average hold ' + f(mid.reduce((a, t) => a + t.days, 0) / mid.length, 0) + ' days; swap ' + f(mid.reduce((a, t) => a + t.swapR, 0)) + ' R in total');
console.log('  fresh month (information only): ' + pick.fresh.n + ' trades, median ' + f(pick.fresh.r) + ' R');
// Against buy-and-hold: the strategy at 0.5% risk a trade (not compounded) vs holding gold, per period.
const at = t => bars[Math.max(0, firstFrom(bars.map(b => b.t), t) - 1)].c;
[['2008-16', bars[0].t, DESIGN_TO, 'design'], ['2017-26', DESIGN_TO, FRESH, 'judge']].forEach(([n, a, b, p]) =>
  console.log('  ' + n + ': buy-and-hold gold ' + f((at(b) / at(a) - 1) * 100, 0) + '%; the strategy at 0.5% risk a trade ' + f(pick[p].r * 0.5, 0) + '% (worst drop about ' + f(pick[p].dd * 0.5, 0) + '% of the start)'));
