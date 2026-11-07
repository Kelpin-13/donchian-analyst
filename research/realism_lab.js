/**
 * Realistic fills: the book as it trades now, run 200 times, each run with its own random fills, so the backtest is
 * never the one perfect, fixed-cost path (owner, 6 Nov 2026: "don't make it perfect, with the fixed variable every time").
 *
 *   node research/realism_lab.js [runs]
 *
 * The book: the five intraday strategies still trading + H4 with its trailing stop (GoldIntraday 1.16, DonchianGold 1.08),
 * 0.5% risk a trade (1 R = $50 on $10,000, not compounded), 2023-04-03 to the end of data/.
 * Fill model, fixed before running, ON TOP of the research's own costs (bar spread + $0.05 a side intraday, 0.01% H4):
 *   - every entry, stop-loss and market exit draws its own extra slippage from the live demo's stop-order fills,
 *     12 Oct - 5 Nov 2026 (10 fills: $0.02 to $1.09, mean $0.29); take-profits are limit orders and fill at their level
 *   - within 30 minutes of a high-importance US release (MT5 calendar) that draw is tripled: spreads and gaps widen
 *   - 2% of fills are late (a dropped connection, a requote): $3.00 more
 * Reported: the spread of outcomes over the runs, and how often the 15% account stop would have fired.
 * Research only: nothing here trades.
 */
const I = require('./intraday.js');
const R = require('./daytrade.js');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const RUNS = Number(process.argv[2]) || 200;
const DAY = 86400000, MIN = 60000, FROM = Date.UTC(2023, 3, 3), RISK_USD = 50, ACCOUNT = 10000;
const LIVE = [0.03, 0.03, 0.58, 0.16, 0.02, 0.378, 0.085, 1.085, 0.422, 0.11];
const NEWS_X = 3, NEWS_WIN = 30 * MIN, LATE_P = 0.02, LATE_USD = 3;
const H4_CFG = { dir: 'both', N: 20, M: 10, k: 2, ema: 100, maxBars: 60, barMin: 240, flat: false, swapLong: -5.92, swapShort: 3.67,
                 hardK: 4, targetR: 1.5, targetWait: true, maxStop: I.MAX_STOP, trail: { at: 1, dist: 0.5, broker: true },
                 firstEntryMin: 0, lastEntryMin: 24 * 60, flatMin: Infinity, from: -Infinity, to: Infinity };

const cal = loadReleases(findCalendar(), null), news = cal.times;
const nearNews = t => { const i = firstFrom(news, t - NEWS_WIN); return i < news.length && news[i] <= t + NEWS_WIN; };
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }

const m15 = R.load('XAUUSD.sml_M15.csv'), h4 = R.toH4(R.load('XAUUSD.sml_H1.csv'));
const P = I.portfolio(m15);
const IDS = Object.keys(P).concat(['H4']);

function book(slipFn) {
  const tr = [];
  Object.keys(P).forEach(id => I.backtest(m15, P[id], { slip: I.COSTS.real.slip, slipFn }).forEach(t => tr.push({ id, t: t.t, x: t.exitT, r: t.r })));
  R.simulate(h4, Object.assign({}, H4_CFG, { slipFn })).forEach(t => tr.push({ id: 'H4', t: t.t, x: t.exitT, r: t.r }));
  return tr.filter(t => t.t >= FROM).sort((a, b) => a.x - b.x);
}
function score(tr) {
  let eq = ACCOUNT, pk = eq, dd = 0; const by = {};
  tr.forEach(t => { eq += t.r * RISK_USD; pk = Math.max(pk, eq); dd = Math.max(dd, (pk - eq) / pk * 100); by[t.id] = (by[t.id] || 0) + t.r; });
  return { net: eq - ACCOUNT, dd, by, n: tr.length };
}

const base = score(book(null));
const runs = [];
let newsFills = 0, fills = 0;
for (let k = 0; k < RUNS; k++) {
  const rand = rng(1000 + k);
  const slipFn = t => {
    fills++;
    let x = LIVE[Math.floor(rand() * LIVE.length)];
    if (nearNews(t)) { x *= NEWS_X; newsFills++; }
    if (rand() < LATE_P) x += LATE_USD;
    return x;
  };
  runs.push(score(book(slipFn)));
}
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const f = (v, d) => v.toFixed(d === undefined ? 0 : d);

console.log('Book: ' + IDS.join(', ') + '; 0.5% risk a trade ($' + RISK_USD + ' a 1 R), ' + RUNS + ' runs with random fills. ' +
            (newsFills / fills * 100).toFixed(1) + '% of fills fell within 30 minutes of US news.');
console.log('\n                         research costs |  random fills: worst 5%   median   best 5%');
const nets = runs.map(r => r.net), dds = runs.map(r => r.dd);
console.log('  net profit $         ' + f(base.net).padStart(12) + '   |' + f(pct(nets, 5)).padStart(22) + f(pct(nets, 50)).padStart(9) + f(pct(nets, 95)).padStart(10));
console.log('  worst drawdown %     ' + f(base.dd, 1).padStart(12) + '   |' + f(pct(dds, 95), 1).padStart(22) + f(pct(dds, 50), 1).padStart(9) + f(pct(dds, 5), 1).padStart(10));
console.log('  runs losing money: ' + runs.filter(r => r.net < 0).length + ' of ' + RUNS + '; runs where the 15% account stop fires: ' + runs.filter(r => r.dd >= 15).length + ' of ' + RUNS +
            '; worst run: $' + f(Math.min(...nets)) + ', drawdown ' + f(Math.max(...dds), 1) + '%');
console.log('\n  R per strategy        research costs |  random fills: worst 5%   median   runs below 0');
IDS.forEach(id => {
  const v = runs.map(r => r.by[id] || 0);
  console.log('  ' + id.padEnd(20) + f(base.by[id] || 0, 1).padStart(14) + '   |' + f(pct(v, 5), 1).padStart(22) + f(pct(v, 50), 1).padStart(9) + String(v.filter(x => x < 0).length).padStart(13));
});
