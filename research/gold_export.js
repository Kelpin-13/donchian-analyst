/**
 * Exports the gold book's backtest for research/gold_report.js (the shareable report). No new rule, no tuning:
 * it re-runs what research/realism_lab.js and research/fresh_lab.js already run and adds two read-only views.
 *
 *   node research/gold_export.js [runs]   -> data/reports/gold.json
 *
 *   book     the five strategies as the EAs trade now (GoldIntraday 1.17: Asian Narrow, Dual Thrust, R-Breaker,
 *            MOM_16; DonchianGold 1.08: H4 with its trail), 0.5% risk a trade = $50 a 1 R on $10,000, not
 *            compounded, 2023-04-03 to 2026-10-08 (the bars before the fresh cut). Research costs once, and
 *            `runs` runs with the section 24 random fills (live demo slippage, x3 near US news, 2% late fills).
 *   halves   settings were chosen on 2023-24 and judged on 2025-26 (DESIGN section 22): both halves reported.
 *   fresh    9 Oct - 6 Nov 2026, bars never used for any choice (section 27/39), research costs and random fills.
 *   H4 long  DonchianGold alone on the 2008-2026 hourly file (fresh bars included): 2008-2022 was never used to
 *            choose anything. Research costs, and +$0.50 a side. The file's early bars carry no spread (0), so
 *            the +$0.50 run is the fairer one there.
 *   gold     buy-and-hold gold (daily closes) over each window, for reference.
 * Research only: nothing here trades.
 */
const fs = require('fs'), path = require('path');
const I = require('./intraday.js');
const R = require('./daytrade.js');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const RUNS = Number(process.argv[2]) || 200;
const DAY = 86400000, MIN = 60000, FROM = Date.UTC(2023, 3, 3), SPLIT = Date.UTC(2025, 0, 1), RISK_USD = 50, ACCOUNT = 10000;
const FRESH = R.FRESH_FROM, FRESH_TO = Date.UTC(2026, 10, 7);
const LIVE = [0.03, 0.03, 0.58, 0.16, 0.02, 0.378, 0.085, 1.085, 0.422, 0.11];
const H4_CFG = { dir: 'both', N: 20, M: 10, k: 2, ema: 100, maxBars: 60, barMin: 240, flat: false, swapLong: -5.92, swapShort: 3.67,
                 hardK: 4, targetR: 1.5, targetWait: true, maxStop: I.MAX_STOP, trail: { at: 1, dist: 0.5, broker: true },
                 firstEntryMin: 0, lastEntryMin: 24 * 60, flatMin: Infinity, from: -Infinity, to: Infinity };
const NAMES = { ASIAN_NARROW: 'Asian Narrow', DUAL_THRUST: 'Dual Thrust', R_BREAKER: 'R-Breaker', MOM_16: 'Momentum 16:00', H4: 'H4 Donchian' };

const cal = loadReleases(findCalendar(), null), news = cal.times;
const nearNews = t => { const i = firstFrom(news, t - 30 * MIN); return i < news.length && news[i] <= t + 30 * MIN; };
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const slipper = seed => { const rand = rng(seed); return t => { let x = LIVE[Math.floor(rand() * LIVE.length)]; if (nearNews(t)) x *= 3; if (rand() < 0.02) x += 3; return x; }; };

function book(m15, h4, slipFn) {
  const P = I.portfolio(m15), tr = [];
  Object.keys(P).forEach(id => I.backtest(m15, P[id], { slip: I.COSTS.real.slip, slipFn }).forEach(t => tr.push({ id, t: t.t, x: t.exitT, r: t.r })));
  R.simulate(h4, Object.assign({}, H4_CFG, { slipFn })).forEach(t => tr.push({ id: 'H4', t: t.t, x: t.exitT, r: t.r }));
  return tr.sort((a, b) => a.x - b.x);
}
const day = t => new Date(t).toISOString().slice(0, 10);
function curve(tr, from, to) {            // daily closed-trade equity in $ on $10,000 at $50 a 1 R
  const byDay = new Map(); tr.filter(t => t.t >= from && t.t < to).forEach(t => { const d = day(t.x); byDay.set(d, (byDay.get(d) || 0) + t.r * RISK_USD); });
  let eq = ACCOUNT; return [...byDay.keys()].sort().map(d => [d, +(eq += byDay.get(d)).toFixed(2)]);
}
function stats(tr, from, to) {
  const s = tr.filter(t => t.t >= from && t.t < to);
  let eq = ACCOUNT, pk = eq, dd = 0; s.forEach(t => { eq += t.r * RISK_USD; pk = Math.max(pk, eq); dd = Math.max(dd, (pk - eq) / pk); });
  const w = s.filter(t => t.r > 0).reduce((a, t) => a + t.r, 0), l = -s.filter(t => t.r <= 0).reduce((a, t) => a + t.r, 0);
  const yrs = (Math.min(to, s.length ? s[s.length - 1].x : to) - from) / (365.25 * DAY);
  return { n: s.length, r: w - l, net: (w - l) * RISK_USD, dd, pf: l ? w / l : null, win: s.length ? s.filter(t => t.r > 0).length / s.length : 0,
           avgR: s.length ? (w - l) / s.length : 0, perYear: (w - l) * RISK_USD / ACCOUNT / yrs };
}
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

// ---- the book, 2023-04 to the fresh cut
const m15 = R.load('XAUUSD.sml_M15.csv'), h4 = R.toH4(R.load('XAUUSD.sml_H1.csv'));
const END = m15[m15.length - 1].t + DAY;
const base = book(m15, h4, null);
const ids = Object.keys(I.portfolio(m15)).concat(['H4']);
const per = (tr, from, to) => Object.fromEntries(ids.map(id => [id, stats(tr.filter(t => t.id === id), from, to)]));
const runs = [];
for (let k = 0; k < RUNS; k++) {
  const tr = book(m15, h4, slipper(1000 + k));
  runs.push({ all: stats(tr, FROM, END), a: stats(tr, FROM, SPLIT), b: stats(tr, SPLIT, END), per: per(tr, FROM, END), eq: curve(tr, FROM, END) });
}
const medRun = runs.slice().sort((x, y) => x.all.net - y.all.net)[Math.floor(RUNS / 2)];
const band = (() => {                      // 5th / 95th percentile of equity by day across runs
  const days = [...new Set(runs.flatMap(r => r.eq.map(p => p[0])))].sort();
  const at = runs.map(r => { const m = new Map(r.eq); let last = ACCOUNT; return days.map(d => (last = m.has(d) ? m.get(d) : last)); });
  return days.map((d, i) => { const v = at.map(a => a[i]); return [d, +pct(v, 5).toFixed(2), +pct(v, 95).toFixed(2)]; }).filter((x, i, a) => i % 3 === 0 || i === a.length - 1);
})();
const yearly = tr => { const o = {}; tr.filter(t => t.t >= FROM).forEach(t => { const y = day(t.x).slice(0, 4); o[y] = (o[y] || 0) + t.r * RISK_USD; }); return o; };

// ---- fresh month
const m15f = R.load('XAUUSD.sml_M15.csv', { fresh: true }), h4f = R.toH4(R.load('XAUUSD.sml_H1.csv', { fresh: true }));
const freshBase = stats(book(m15f, h4f, null), FRESH, FRESH_TO);
const freshRuns = []; for (let k = 0; k < RUNS; k++) freshRuns.push(stats(book(m15f, h4f, slipper(5000 + k)), FRESH, FRESH_TO).r);

// ---- H4 alone, 2008-2026
const h1L = R.load('XAUUSD.sml_H1_2008.csv', { fresh: true }), h4L = R.toH4(h1L);
const h4long = (slipUsd) => R.simulate(h4L, Object.assign({}, H4_CFG, slipUsd ? { slipUsd } : {})).map(t => ({ id: 'H4', t: t.t, x: t.exitT, r: t.r }));
const L0 = h4long(0), L50 = h4long(0.5), LFROM = h4L[0].t + 120 * 4 * 3600000, LEND = h4L[h4L.length - 1].t + DAY;
const longYearly = tr => { const o = {}; tr.forEach(t => { const y = day(t.x).slice(0, 4); o[y] = (o[y] || 0) + t.r; }); return o; };

// ---- gold buy-and-hold
const d1 = R.load('XAUUSD.sml_D1_2008.csv', { fresh: true });
const goldEq = (from, to) => { const s = d1.filter(b => b.t >= from && b.t < to); return s.map(b => [day(b.t), +(ACCOUNT * b.c / s[0].c).toFixed(2)]); };
const goldStats = (from, to) => { const e = goldEq(from, to); let pk = 0, dd = 0; e.forEach(p => { pk = Math.max(pk, p[1]); dd = Math.max(dd, 1 - p[1] / pk); });
  return { ret: e[e.length - 1][1] / ACCOUNT - 1, dd, perYear: Math.pow(e[e.length - 1][1] / ACCOUNT, 365.25 * DAY / (Date.parse(e[e.length - 1][0]) - Date.parse(e[0][0]))) - 1 }; };

const out = {
  built: day(Date.now()), from: day(FROM), to: day(END - DAY), split: day(SPLIT), runs: RUNS, names: NAMES, ids,
  base: { all: stats(base, FROM, END), a: stats(base, FROM, SPLIT), b: stats(base, SPLIT, END), per: per(base, FROM, END), yearly: yearly(base), eq: curve(base, FROM, END) },
  rand: {
    net: [5, 50, 95].map(p => pct(runs.map(r => r.all.net), p)), dd: [5, 50, 95].map(p => pct(runs.map(r => r.all.dd), p)),
    a: [5, 50, 95].map(p => pct(runs.map(r => r.a.net), p)), b: [5, 50, 95].map(p => pct(runs.map(r => r.b.net), p)),
    bDd: pct(runs.map(r => r.b.dd), 50), aDd: pct(runs.map(r => r.a.dd), 50),
    losing: runs.filter(r => r.all.net < 0).length, stop15: runs.filter(r => r.all.dd >= 0.15).length,
    per: Object.fromEntries(ids.map(id => [id, { med: pct(runs.map(r => r.per[id].r), 50), p5: pct(runs.map(r => r.per[id].r), 5), below: runs.filter(r => r.per[id].r < 0).length,
                                                  n: medRun.per[id].n, win: medRun.per[id].win, pf: medRun.per[id].pf }])),
    medEq: medRun.eq, band
  },
  fresh: { from: day(FRESH), to: '2026-11-06', base: freshBase, rand: [5, 50, 95].map(p => pct(freshRuns, p)), runsBelow0: freshRuns.filter(x => x < 0).length },
  h4long: { from: day(LFROM), to: day(LEND - DAY), base: stats(L0, LFROM, LEND), slip: stats(L50, LFROM, LEND), pre2023: stats(L50, LFROM, Date.UTC(2023, 0, 1)), post: stats(L50, Date.UTC(2023, 0, 1), LEND),
            yearlyR: longYearly(L50), eq: curve(L50, LFROM, LEND).filter((x, i, a) => i % 3 === 0 || i === a.length - 1) },
  gold: { book: goldStats(FROM, END), long: goldStats(LFROM, LEND), bookEq: goldEq(FROM, END).filter((x, i) => i % 2 === 0), longEq: goldEq(LFROM, LEND).filter((x, i) => i % 5 === 0) }
};
fs.writeFileSync(path.join(__dirname, '..', 'data', 'reports', 'gold.json'), JSON.stringify(out, (k, v) => typeof v === 'number' ? +v.toFixed(5) : v));
const $ = v => Math.round(v);
console.log('book research costs: net $' + $(out.base.all.net) + ', DD ' + (out.base.all.dd * 100).toFixed(1) + '%, trades ' + out.base.all.n + ', PF ' + out.base.all.pf.toFixed(2));
console.log('random fills net p5/50/95: ' + out.rand.net.map($).join(' / ') + ' | DD ' + out.rand.dd.map(v => (v * 100).toFixed(1)).join(' / ') + ' | stop fired ' + out.rand.stop15 + '/' + RUNS + ' | losing ' + out.rand.losing);
console.log('halves median net: 2023-24 ' + $(out.rand.a[1]) + ', 2025-26 ' + $(out.rand.b[1]) + ' | research a ' + $(out.base.a.net) + ' b ' + $(out.base.b.net));
console.log('per strategy median R:', ids.map(id => id + ' ' + out.rand.per[id].med.toFixed(1) + ' (below0 ' + out.rand.per[id].below + ')').join(', '));
console.log('fresh: research ' + out.fresh.base.r.toFixed(1) + ' R; random ' + out.fresh.rand.map(v => v.toFixed(1)).join(' / '));
console.log('H4 long ' + out.h4long.from + '..' + out.h4long.to + ': research R ' + out.h4long.base.r.toFixed(1) + ', +$0.50 R ' + out.h4long.slip.r.toFixed(1) + ' (pre-2023 ' + out.h4long.pre2023.r.toFixed(1) + ' R on ' + out.h4long.pre2023.n + ', 2023+ ' + out.h4long.post.r.toFixed(1) + ' R on ' + out.h4long.post.n + ')');
console.log('H4 long yearly R:', Object.entries(out.h4long.yearlyR).map(([y, v]) => y.slice(2) + ':' + v.toFixed(1)).join(' '));
console.log('gold hold: book window ' + (out.gold.book.ret * 100).toFixed(0) + '% (DD ' + (out.gold.book.dd * 100).toFixed(0) + '%), long ' + (out.gold.long.perYear * 100).toFixed(1) + '%/yr DD ' + (out.gold.long.dd * 100).toFixed(0) + '%');
