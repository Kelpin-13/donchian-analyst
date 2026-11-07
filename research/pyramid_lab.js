/**
 * Adding to a winning H4 trade: when the trend is going well, open another 0.01 lots the same way, but only while the
 * loss if every open stop were hit stays within what the account accepts for one trade ($150, the EAs' cap).
 *
 *   node research/pyramid_lab.js
 *
 * Fixed before running (5 Nov 2026), on H4 as it trades now (0.01 lots, take-profit 1.5R from the fill, the $150
 * cap, the broker stop trailing 0.5R behind the best price from +1R):
 *   - when to add: (A) a new breakout close beyond the 20-bar channel on the trend's side of the EMA, the entry rule
 *     again; or (B) a close 1R beyond the newest entry. Filled at the next open, like an entry.
 *   - how many: at most 2 or 3 positions in all. So four choices, against "none".
 *   - each add is a trade of its own: its own 2 x ATR strategy stop, broker stop, take-profit and trail. A close
 *     through the 10-bar exit channel closes them all; the strategy stop and the 60-bar time limit close each alone.
 *   - the budget: an add goes only if, with every open position at its current stop (the tighter of its strategy stop
 *     and its broker stop, so a trailed stop counts its locked-in gain), plus the add at its own stop, the total loss
 *     would be at most $150.
 *   - pick: the best profit / worst drop in dollars on 2023-2024 only, and it must beat "none" there. Pass: on
 *     2025-2026, seen once, a better profit / worst drop than "none" and at least 90% of its profit.
 * Not for the six intraday strategies: one trade a day each, closed the same day, with their targets close by.
 * With adding switched off this file's engine gives research/daytrade.js's trades exactly (checked below). Research only.
 *
 * Results (5 Nov 2026, profit / worst drop / worst day):
 *   none                      2023-24 +$362 / $150 / -$60    2025-26 +$2,263 / $263 / -$125
 *   A: new breakout, up to 3  2023-24 +$834 / $250 / -$99    2025-26 +$3,168 / $604 / -$190   picked, FAIL
 *   (A up to 2: 2025-26 +$3,030 / $423; B, each +1R: 2023-24 +$117 / $297, worse than none)
 * More money, but the drawdown grows faster than the profit: 39% of the adds were stopped out. Not built.
 * See docs/DESIGN.md section 21.
 */
const I = require('./intraday.js');
const R = require('./daytrade.js');

const SLIP = 0.0001;                       // as research/daytrade.js
const BUDGET = I.MAX_STOP;
const H4_CFG = { dir: 'both', N: 20, M: 10, k: 2, ema: 100, maxBars: 60, barMin: 240, flat: false, swapLong: -5.92, swapShort: 3.67,
                 hardK: 4, targetR: 1.5, targetWait: true, maxStop: I.MAX_STOP, trail: { at: 1, dist: 0.5, broker: true },
                 firstEntryMin: 0, lastEntryMin: 24 * 60, flatMin: Infinity, from: -Infinity, to: Infinity };
const H4_FROM = Date.UTC(2023, 3, 1);
const DAY = 86400000;
const dayOf = t => Math.floor(t / DAY);
const CHOICES = [
  { name: 'none', maxPos: 1 },
  { name: 'A: new breakout, up to 2', when: 'breakout', maxPos: 2 },
  { name: 'A: new breakout, up to 3', when: 'breakout', maxPos: 3 },
  { name: 'B: each +1R, up to 2', when: 'plus1R', maxPos: 2 },
  { name: 'B: each +1R, up to 3', when: 'plus1R', maxPos: 3 }
];

/** research/daytrade.js simulate() for the H4 settings above, with a book of positions instead of one. */
function simulate(bars, cfg, add, ser) {
  const s = ser || R.series(bars, cfg);
  const trades = [];
  let book = [], pend = null, waitSide = 0;   // pend: { exits: [[position, why]], entry: signal }
  const effStop = p => (p.side === 1 ? Math.max(p.stop, p.hard) : Math.min(p.stop, p.hard));
  for (let i = 1; i < bars.length; i++) {
    const k = bars[i];
    if (k.t >= cfg.to) { book.forEach(p => close(p, k, 'WINDOW_END')); book = []; break; }
    if (k.t < cfg.from) continue;
    if (book.length && dayOf(k.t) !== dayOf(bars[i - 1].t))
      book.forEach(p => { p.swap += bars[i - 1].c * (p.side === 1 ? cfg.swapLong : cfg.swapShort) / 100 / 360; });
    if (pend) {
      pend.exits.forEach(([p, why]) => { if (book.includes(p)) { close(p, k, why); book = book.filter(x => x !== p); } });
      if (pend.entry) { const p = open(pend.entry, k); if (p) book.push(p); }
      pend = null;
    }
    book.forEach(p => p.bars++);
    book = book.filter(p => {
      if ((cfg.hardK || p.trailed) && (p.side === 1 ? k.l <= p.hard : k.h + k.sp >= p.hard)) {
        close(p, k, p.trailed ? 'TRAIL' : 'HARDSTOP', p.side === 1 ? Math.min(k.o, p.hard) : Math.max(k.o + k.sp, p.hard));
        return false;
      }
      if (p.target !== null && (p.side === 1 ? k.h >= p.target : k.l + k.sp <= p.target)) {
        close(p, k, 'TARGET', p.side === 1 ? Math.max(k.o, p.target) : Math.min(k.o + k.sp, p.target), true);
        if (cfg.targetWait) waitSide = p.side;
        return false;
      }
      return true;
    });
    const up = s.entry.upper[i], lo = s.entry.lower[i], xu = s.exit.upper[i], xl = s.exit.lower[i];
    const e = s.ema[i], a = s.atr[i];
    if (up === null || lo === null || xu === null || xl === null || e === null || a === null) continue;
    if ((waitSide === 1 && k.c <= up) || (waitSide === -1 && k.c >= lo)) waitSide = 0;
    if (!book.length) {
      if (cfg.dir !== 'short' && k.c > up && k.c > e && waitSide !== 1) pend = { exits: [], entry: { type: 'LONG', stopDist: cfg.k * a } };
      else if (cfg.dir !== 'long' && k.c < lo && k.c < e && waitSide !== -1) pend = { exits: [], entry: { type: 'SHORT', stopDist: cfg.k * a } };
      continue;
    }
    const side = book[0].side, channel = side === 1 ? k.c < xl : k.c > xu;
    const exits = [];
    book.forEach(p => {
      if (side === 1 ? k.c <= p.stop : k.c >= p.stop) exits.push([p, 'STOP']);
      else if (channel) exits.push([p, 'CHANNEL']);
      else if (p.bars >= cfg.maxBars) exits.push([p, 'TIME']);
    });
    book.forEach(p => {                       // the trail, after this close's checks, as in research/daytrade.js
      if (!cfg.trail) return;
      const best = p.side === 1 ? k.h : k.l;
      p.best = p.best === undefined ? best : p.side === 1 ? Math.max(p.best, best) : Math.min(p.best, best);
      if ((p.best - p.entry) * p.side >= cfg.trail.at * p.risk) {
        const st = cfg.trail.lock ? p.entry : p.best - p.side * cfg.trail.dist * p.risk;
        if (cfg.trail.broker) { if ((st - p.hard) * p.side > 0) { p.hard = st; p.trailed = true; } }
        else if ((st - p.stop) * p.side > 0) p.stop = st;
      }
    });
    let entry = null;
    const staying = book.filter(p => !exits.some(([x]) => x === p));
    if (add && add.when && !channel && staying.length && staying.length < add.maxPos && waitSide !== side) {
      const newest = staying[staying.length - 1];
      const go = add.when === 'breakout' ? (side === 1 ? k.c > up && k.c > e : k.c < lo && k.c < e)
                                         : (k.c - newest.entry) * side >= newest.risk;
      const risk = cfg.k * a;
      const atStops = staying.reduce((sum, p) => sum + (effStop(p) - p.entry) * p.side, 0) - risk;   // P&L if every stop is hit
      if (go && atStops >= -BUDGET) entry = { type: side === 1 ? 'LONG' : 'SHORT', stopDist: risk, add: true };
    }
    if (exits.length || entry) pend = { exits, entry };
  }
  return trades;

  function open(sig, k) {
    if (cfg.maxStop && sig.stopDist > cfg.maxStop) return null;
    const side = sig.type === 'LONG' ? 1 : -1;
    const fill = side === 1 ? (k.o + k.sp) * (1 + SLIP) : k.o * (1 - SLIP);
    const hard = (side === 1 ? k.o + k.sp : k.o) - side * (cfg.hardK || 0) * sig.stopDist / cfg.k;
    return { side, t: k.t, entry: fill, stop: fill - side * sig.stopDist, hard, risk: sig.stopDist, bars: 0, spreadIn: k.sp, swap: 0,
             add: !!sig.add, target: cfg.targetR ? fill + side * cfg.targetR * sig.stopDist : null };
  }
  function close(p, k, why, px, isLimit) {
    if (px === undefined) px = p.side === 1 ? k.o : k.o + k.sp;
    const fill = isLimit ? px : px * (1 - p.side * SLIP);
    trades.push({ t: p.t, exitT: k.t, side: p.side, r: ((fill - p.entry) * p.side + p.swap) / p.risk, risk: p.risk, why, add: p.add });
  }
}

function st(tr) {
  let cu = 0, pu = 0, dd = 0, gw = 0, gl = 0;
  const days = new Map();
  tr.slice().sort((a, b) => a.exitT - b.exitT || a.t - b.t).forEach(x => {
    const u = x.r * x.risk; cu += u; pu = Math.max(pu, cu); dd = Math.max(dd, pu - cu);
    if (u > 0) gw += u; else gl -= u;
    const d = dayOf(x.exitT); days.set(d, (days.get(d) || 0) + u);
  });
  return { n: tr.length, adds: tr.filter(t => t.add).length, win: tr.length ? tr.filter(t => t.r > 0).length / tr.length * 100 : 0,
           pf: gl ? gw / gl : Infinity, usd: cu, dd, ratio: dd ? cu / dd : 0, worstDay: Math.min(0, ...days.values()) };
}
const f = (v, d) => (v === undefined || v === null || !isFinite(v)) ? '-' : v.toFixed(d === undefined ? 2 : d);
const row = s => String(s.n).padStart(5) + String(s.adds).padStart(5) + f(s.win, 0).padStart(5) + f(s.pf).padStart(6) + f(s.usd, 0).padStart(7) +
                 f(s.dd, 0).padStart(6) + f(s.ratio).padStart(6) + f(s.worstDay, 0).padStart(6);
const HEAD = '      n adds  win    PF      $    dd ratio  wDay';

const h4 = R.toH4(R.load('XAUUSD.sml_H1.csv'));
const ser = R.series(h4, H4_CFG);
const key = t => [t.t, t.exitT, t.side, t.why, t.r.toFixed(9)].join('|');
const ref = R.simulate(h4, H4_CFG, ser), mine = simulate(h4, H4_CFG, null, ser);
const same = ref.length === mine.length && ref.every((t, i) => key(t) === key(mine[i]));
console.log('engine check, adding off vs research/daytrade.js: ' + ref.length + ' vs ' + mine.length + ' trades, ' + (same ? 'identical' : 'DIFFERENT'));
if (!same) process.exit(1);

console.log('\n=== H4, adding to winners (budget: at most $' + BUDGET + ' lost if every open stop is hit)\n  choice                     |  2023-24' + HEAD + ' |  2025-26' + HEAD);
const res = CHOICES.map(c => {
  const tr = simulate(h4, H4_CFG, c.when ? c : null, ser).filter(t => t.t >= H4_FROM);
  return { c, tr, a: st(tr.filter(t => t.t < I.SPLIT)), b: st(tr.filter(t => t.t >= I.SPLIT)) };
});
res.forEach(x => console.log('  ' + x.c.name.padEnd(26) + ' |         ' + row(x.a) + ' |         ' + row(x.b)));
const base = res[0], pick = res.slice(1).filter(x => x.a.ratio > base.a.ratio).sort((x, y) => y.a.ratio - x.a.ratio)[0];
if (!pick) console.log('  picked on 2023-2024: nothing beats "none" there, so no adding');
else {
  const pass = pick.b.ratio > base.b.ratio && pick.b.usd >= 0.9 * base.b.usd;
  console.log('  picked on 2023-2024: ' + pick.c.name + ' | 2025-2026: profit/drop ' + f(pick.b.ratio) + ' vs ' + f(base.b.ratio) +
              ', profit $' + f(pick.b.usd, 0) + ' vs $' + f(base.b.usd, 0) + ' -> ' + (pass ? 'PASS' : 'FAIL'));
}
// Information only: the largest loss the book could have taken at once (all stops hit at the same moment).
res.forEach(x => {
  const worstTrade = Math.min(...x.tr.map(t => t.r * t.risk));
  console.log('  ' + x.c.name.padEnd(26) + ' worst single trade $' + f(worstTrade, 0) + ', adds that were stopped out: ' +
              x.tr.filter(t => t.add && t.r < 0).length + ' of ' + x.tr.filter(t => t.add).length);
});
