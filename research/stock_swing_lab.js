/**
 * A momentum swing strategy for liquid US stocks, compiled from the owner's videos (owner, 19 Nov 2026: "refer to the
 * videos i sent you previously, all the stock trade entering strategy ... analysis all the strategy and compile a
 * suitable one"). Rules fixed before the first run.
 *
 *   node research/fetch_yahoo.js SPY AAPL MSFT ...   (the STOCKS list below, once)
 *   node research/stock_swing_lab.js [randomRuns]
 *
 * Sources (videos of 7 Nov 2026, docs/DESIGN.md section 33):
 *   Kristjan Kullamagi: trade only the strongest stocks, in a good market; buy the break of a tight range after a move
 *   up; stop near the low; sell part after 3-5 days, ride the rest until a close below the 10-day average.
 *   Martin Luk: in a strong uptrend, buy the first pullback to the 9/21 EMA as it turns up; risk 0.5% a trade.
 *   MACD video (above zero, pullback, cross near zero): the same pullback in an uptrend, so it is covered by E2.
 *   Exits video (part off, trail the rest): X1.
 *   Not used: the gold scalping clip, the 3-candle bias (failed, section 33), smart-money "rejection blocks" (the same
 *   family as the order blocks that failed), Patrick Nill's failed breakdown (failed, section 34). The value-area idea
 *   needs exchange volume and is left for later.
 *
 * Data: Yahoo daily bars, split-adjusted open/high/low/close (dividends left out, which slightly understates the
 * strategy). SPY uses its adjusted close for the benchmark. A stock joins once it has 252 days of history.
 * SURVIVORSHIP: the list is today's large, liquid names, which survived and grew; any rule on them looks better than it
 * would have in real time. The random-entry control below trades the SAME stocks, so it carries the same bias; the
 * strategy must beat it, not just make money.
 *
 *   market    new entries only while SPY closed above its 200-day average
 *   stock     close > 50-day average > 200-day average; 20-day average dollar volume at least $50M; and among the top
 *             20% of the list by 126-day return that day (relative strength)
 *   E1        breakout (Kullamagi): the last 10 days' range (highest high - lowest low) is at most 2.5 x ATR(14);
 *             a buy stop at that 10-day high for the next day only (re-set each day). Stop: the 10-day low, but no
 *             further than 1.5 x ATR below the fill
 *   E2        pullback (Luk): EMA10 > EMA21 > 50-day average, the day's low at or under 1.01 x EMA21 and its close above
 *             the 50-day average; a buy stop above that day's high for the next 2 days. Stop: that day's low, no further
 *             than 1.5 x ATR below the fill
 *   X1        (Kullamagi) half out at the close of the 3rd day held (the fill day is day 1), the rest's stop moves to
 *             the entry price; the rest out at the next open after a close below the 10-day average
 *   X2        all out at the next open after a close below the 20-day average
 *   fills     a buy stop fills at its level, or at the open if the day opens above it; a stop fills at its level, or at
 *             the open if the day opens below it; on the fill day a low at or under the stop counts as stopped (worst
 *             case). 0.05% cost per side.
 *   sizing    0.5% of equity at risk per trade (fill - stop), the position at most 20% of equity, no borrowing, at most
 *             10 positions; when orders compete, the highest 126-day return first. Idle cash earns the T-bill rate.
 *   choices   E1/E2 x X1/X2 = 4
 *   control   for each choice, 100 runs of random entries: on each day the strategy filled n trades, n random stocks
 *             from the list that pass only the $50M liquidity rule and are not held are bought at that day's open,
 *             with the same stop distance in ATRs as the strategy's trade, the same exit and the same sizing
 *   split     design 2008-01-01 to 2016-12-31, test 2017-01-01 to the end; each half measured on its own
 *   pick      the best MAR (CAGR / worst drawdown) on the design half
 *   pass      on the test half, all three: (1) MAR above SPY buy-and-hold's; (2) CAGR above the 95th percentile of its
 *             random-entry control; (3) profit factor at least 1.3 on at least 100 trades. A pass goes into the paper
 *             portfolio in the Sheet, not real money.
 * Results (19 Nov 2026, one run, 100 random runs per choice; design | test, CAGR / worst DD / MAR / trades / PF):
 *   SPY buy-and-hold 7.2% / 51.9% / 0.14 | 14.4% / 33.7% / 0.43.
 *   E1 X1 2.2% / 4.3% / 0.51 / 316 / 1.40 | 3.5% / 7.3% / 0.48 / 394 / 1.18 (random p50 3.2%, p95 4.3%; picked)
 *   E1 X2 4.0% / 10.8% / 0.37 / 265 / 1.52 | 5.8% / 13.8% / 0.42 / 340 / 1.36 (random 4.1%, 6.5%)
 *   E2 X1 -2.5% / 32.7% / -0.08 / 1167 / 0.87 | 3.3% / 18.0% / 0.18 / 1563 / 1.03 (random 7.5%, 10.4%)
 *   E2 X2 1.0% / 25.7% / 0.04 / 866 / 1.04 | 6.4% / 18.2% / 0.35 / 1165 / 1.14 (random 8.0%, 12.8%)
 *   Picked E1 X1: test MAR beats SPY (0.48 vs 0.43), but CAGR 3.5% does not beat random entries on the same stocks
 *   (p95 4.3%) and PF 1.18 < 1.3 -> FAIL. No choice beat its own random control on the test half. The pullback (E2)
 *   did worse than random buys of the same names. Random entries made 7-8% a year on this list: that is the
 *   survivorship bias, and why a backtest on today's winners must be judged against random entries.
 * Research only: nothing here trades.
 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'data', 'yahoo');
const RANDOM_RUNS = Number(process.argv[2]) || 100;
const DAY = 86400000, FROM = Date.UTC(2008, 0, 1), SPLIT = Date.UTC(2017, 0, 1);
const COST = 0.0005, RISK = 0.005, MAX_POS = 10, MAX_W = 0.2, MIN_DV = 50e6, TOP = 0.2, CAP_ATR = 1.5;
const TBILL = { 2007: 4.36, 2008: 1.37, 2009: 0.15, 2010: 0.14, 2011: 0.05, 2012: 0.09, 2013: 0.06, 2014: 0.03, 2015: 0.05, 2016: 0.32,
                2017: 0.93, 2018: 1.94, 2019: 2.06, 2020: 0.36, 2021: 0.05, 2022: 2.02, 2023: 5.07, 2024: 4.97, 2025: 4.2, 2026: 3.8 };
const STOCKS = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'AMD', 'NFLX', 'ORCL', 'CRM', 'ADBE', 'QCOM', 'MU',
  'INTC', 'PLTR', 'UBER', 'COIN', 'JPM', 'BAC', 'WFC', 'GS', 'V', 'MA', 'PYPL', 'XOM', 'CVX', 'UNH', 'LLY', 'JNJ', 'PFE',
  'MRK', 'ABBV', 'KO', 'PEP', 'WMT', 'COST', 'HD', 'NKE', 'SBUX', 'DIS', 'BA', 'CAT', 'GE', 'F', 'T', 'VZ', 'BABA'];

const read = t => fs.readFileSync(path.join(DIR, t + '.csv'), 'utf8').trim().split(/\r?\n/).slice(1).map(l => {
  const p = l.split(','); return { t: Date.parse(p[0] + 'T00:00:00Z'), o: +p[1], h: +p[2], l: +p[3], c: +p[4], a: +p[5], v: +p[6] };
}).filter(b => b.c > 0 && b.o > 0 && b.h > 0 && b.l > 0);
const spyBars = read('SPY').filter(b => b.t >= Date.UTC(2006, 0, 1));
const dates = spyBars.map(b => b.t), N = dates.length;
const smaOf = (x, n) => { const o = new Array(x.length).fill(null); let s = 0, k = 0; for (let i = 0; i < x.length; i++) { if (x[i] === null) { s = 0; k = 0; continue; } s += x[i]; k++; if (k > n) s -= x[i - n]; if (k >= n) o[i] = s / n; } return o; };
const emaOf = (x, n) => { const o = new Array(x.length).fill(null), a = 2 / (n + 1); let e = null; for (let i = 0; i < x.length; i++) { if (x[i] === null) { e = null; continue; } e = e === null ? x[i] : e + a * (x[i] - e); o[i] = e; } return o; };
const spyC = spyBars.map(b => b.c), spy200 = smaOf(spyC, 200), spyA = spyBars.map(b => b.a);

// Each stock aligned on SPY's dates (null where it did not trade), with its indicators.
const S = STOCKS.map(tk => {
  const m = new Map(read(tk).map(b => [b.t, b]));
  const bars = dates.map(t => m.get(t) || null);
  const c = bars.map(b => b ? b.c : null), n = bars.map((b, i) => b ? 1 : 0);
  let run = 0; const age = n.map(x => (run = x ? run + 1 : 0));
  const tr = bars.map((b, i) => !b ? null : i && bars[i - 1] ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l);
  const dv = bars.map(b => b ? b.c * b.v : null);
  const hi10 = bars.map((b, i) => { if (age[i] < 10) return null; let h = -Infinity, l = Infinity; for (let j = i - 9; j <= i; j++) { h = Math.max(h, bars[j].h); l = Math.min(l, bars[j].l); } return { h, l }; });
  return { tk, bars, age, c, sma10: smaOf(c, 10), sma20: smaOf(c, 20), sma50: smaOf(c, 50), sma200: smaOf(c, 200),
           ema10: emaOf(c, 10), ema21: emaOf(c, 21), atr: smaOf(tr, 14), dv20: smaOf(dv, 20), hl10: hi10,
           r126: c.map((x, i) => x !== null && age[i] > 126 ? x / c[i - 126] - 1 : null) };
});
const liquid = (s, i) => s.age[i] >= 252 && s.dv20[i] >= MIN_DV && s.atr[i] > 0;
const strong = i => {   // top 20% by 126-day return among the stocks with history that day
  const r = S.filter(s => s.age[i] >= 252 && s.r126[i] !== null).map(s => s.r126[i]).sort((a, b) => b - a);
  return r.length ? r[Math.max(0, Math.ceil(r.length * TOP) - 1)] : Infinity;
};
const cutoff = dates.map((t, i) => strong(i));

/** Orders decided at day i's close, for day i+1 (E1) or days i+1..i+2 (E2). */
function setups(entry, i) {
  if (!(spyC[i] > spy200[i])) return [];
  const out = [];
  S.forEach((s, k) => {
    if (!liquid(s, i) || !(s.c[i] > s.sma50[i] && s.sma50[i] > s.sma200[i]) || !(s.r126[i] >= cutoff[i])) return;
    const b = s.bars[i];
    if (entry === 'E1') {
      const r = s.hl10[i];
      if (r && r.h - r.l <= 2.5 * s.atr[i]) out.push({ k, level: r.h, stop: r.l, until: i + 1, pri: s.r126[i] });
    } else if (s.ema10[i] > s.ema21[i] && s.ema21[i] > s.sma50[i] && b.l <= 1.01 * s.ema21[i] && b.c > s.sma50[i]) {
      out.push({ k, level: b.h, stop: b.l, until: i + 2, pri: s.r126[i] });
    }
  });
  return out;
}

/**
 * The portfolio. entry 'E1'|'E2' or a random plan; exit 'X1'|'X2'. plan (random control): Map day -> [{atrK}], filled
 * with random liquid stocks at the open. Returns { eq: [{t, v}], trades: [{t, k, pnl}], fills: Map day -> [atrK] }.
 */
function run(entry, exit, plan, rand) {
  let cash = 1, orders = [];
  const pos = [], eq = [], trades = [], fills = new Map();
  const start = dates.findIndex(t => t >= FROM);
  const value = i => cash + pos.reduce((s, p) => s + p.sh * (S[p.k].c[i] !== null ? S[p.k].c[i] : p.last), 0);
  const sell = (p, sh, px, i) => { cash += sh * px * (1 - COST); p.pnl += sh * (px * (1 - COST) - p.cost); p.sh -= sh; };
  for (let i = start; i < N; i++) {
    const yr = new Date(dates[i]).getUTCFullYear();
    cash *= 1 + (TBILL[yr] !== undefined ? TBILL[yr] : 3.8) / 100 / 252;
    const eqOpen = value(i - 1);
    // 1. exits decided at yesterday's close, at today's open
    for (const p of pos) { const b = S[p.k].bars[i]; if (p.exitNext && b) { sell(p, p.sh, b.o, i); } }
    // 2. new entries: buy stops (strategy) or random buys at the open (control)
    const held = new Set(pos.filter(p => p.sh > 0).map(p => p.k));
    let cands = [];
    if (plan) {
      (plan.get(i) || []).forEach(x => {
        const pool = S.map((s, k) => k).filter(k => !held.has(k) && liquid(S[k], i - 1) && S[k].bars[i]);
        if (!pool.length) return;
        const k = pool[Math.floor(rand() * pool.length)]; held.add(k);
        const b = S[k].bars[i];
        cands.push({ k, fill: b.o, stop: b.o - x.atrK * S[k].atr[i - 1], atr: S[k].atr[i - 1], pri: 0 });
      });
    } else {
      orders = orders.filter(o => o.until >= i);
      orders.slice().sort((a, b) => b.pri - a.pri).forEach(o => {
        const b = S[o.k].bars[i];
        if (!b || held.has(o.k) || !(b.h >= o.level)) return;
        const fill = Math.max(b.o, o.level), atr = S[o.k].atr[i - 1];
        cands.push({ k: o.k, fill, stop: Math.max(o.stop, fill - CAP_ATR * atr), atr, pri: o.pri, o });
        held.add(o.k);
      });
    }
    for (const c of cands) {
      if (pos.filter(p => p.sh > 0).length >= MAX_POS || !(c.fill > c.stop)) continue;
      const risk = c.fill - c.stop;
      let sh = Math.min(RISK * eqOpen / risk, MAX_W * eqOpen / c.fill, cash / (c.fill * (1 + COST)));
      if (!(sh > 0)) continue;
      cash -= sh * c.fill * (1 + COST);
      const p = { k: c.k, sh, cost: c.fill * (1 + COST), entry: c.fill, stop: c.stop, day: 0, half: false, pnl: 0, last: c.fill, t: dates[i], exitNext: false };
      pos.push(p);
      if (c.o) orders = orders.filter(o => o !== c.o);
      if (!fills.has(i)) fills.set(i, []);
      fills.get(i).push({ atrK: risk / c.atr });
    }
    // 3. during the day: stops; at the close: X1's half and the exit signals for tomorrow's open
    for (const p of pos) {
      if (!(p.sh > 0)) continue;
      const s = S[p.k], b = s.bars[i];
      if (!b) continue;
      p.day++; p.last = b.c;
      if (b.l <= p.stop) { sell(p, p.sh, p.day === 1 ? p.stop : Math.min(b.o, p.stop), i); continue; }
      if (exit === 'X1') {
        if (p.day === 3 && !p.half) { sell(p, p.sh / 2, b.c, i); p.half = true; p.stop = Math.max(p.stop, p.entry); }
        p.exitNext = s.sma10[i] !== null && b.c < s.sma10[i];
      } else p.exitNext = s.sma20[i] !== null && b.c < s.sma20[i];
    }
    for (let j = pos.length - 1; j >= 0; j--) if (!(pos[j].sh > 1e-12)) { trades.push({ t: pos[j].t, k: pos[j].k, pnl: pos[j].pnl }); pos.splice(j, 1); }
    // 4. tomorrow's orders
    if (!plan) orders = orders.filter(o => o.until > i).concat(setups(entry, i).filter(o => !orders.some(x => x.k === o.k)));
    eq.push({ t: dates[i], v: value(i) });
  }
  return { eq, trades, fills };
}
function stats(eq, trades, from, to) {
  const s = eq.filter(p => p.t >= from && p.t < to), tr = trades.filter(t => t.t >= from && t.t < to);
  const yrs = (s[s.length - 1].t - s[0].t) / (365.25 * DAY), cagr = Math.pow(s[s.length - 1].v / s[0].v, 1 / yrs) - 1;
  let pk = 0, dd = 0; s.forEach(p => { pk = Math.max(pk, p.v); dd = Math.max(dd, 1 - p.v / pk); });
  const w = tr.filter(t => t.pnl > 0).reduce((a, t) => a + t.pnl, 0), l = -tr.filter(t => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  return { cagr, dd, mar: dd ? cagr / dd : Infinity, n: tr.length, pf: l ? w / l : Infinity, win: tr.length ? tr.filter(t => t.pnl > 0).length / tr.length : 0 };
}
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const pc = v => (v * 100).toFixed(1).padStart(6) + '%';
const pct = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };

// SPY buy-and-hold (adjusted close, dividends in)
const bhEq = dates.map((t, i) => ({ t, v: spyA[i] })).filter(p => p.t >= FROM);
const bh = [stats(bhEq, [], FROM, SPLIT), stats(bhEq, [], SPLIT, Infinity)];
console.log('Momentum swing on ' + STOCKS.length + ' liquid US stocks (today\'s list: survivorship bias, see the header)');
console.log('  SPY buy-and-hold: design CAGR' + pc(bh[0].cagr) + ', worst DD' + pc(bh[0].dd) + ', MAR ' + bh[0].mar.toFixed(2) +
            ' | test CAGR' + pc(bh[1].cagr) + ', worst DD' + pc(bh[1].dd) + ', MAR ' + bh[1].mar.toFixed(2));
console.log('  choice | design: CAGR  worst DD   MAR  trades   PF  win% | test: CAGR  worst DD   MAR  trades   PF  win% | random test CAGR p50 / p95');
const res = {};
['E1', 'E2'].forEach(e => ['X1', 'X2'].forEach(x => {
  const r = run(e, x), a = stats(r.eq, r.trades, FROM, SPLIT), b = stats(r.eq, r.trades, SPLIT, Infinity);
  const rc = [];
  for (let k = 0; k < RANDOM_RUNS; k++) { const q = run(null, x, r.fills, rng(9100 + k)); rc.push(stats(q.eq, q.trades, SPLIT, Infinity).cagr); }
  const id = e + ' ' + x; res[id] = { a, b, rc, r };
  const row = z => pc(z.cagr).padStart(11) + pc(z.dd).padStart(10) + z.mar.toFixed(2).padStart(6) + String(z.n).padStart(8) + z.pf.toFixed(2).padStart(6) + (z.win * 100).toFixed(0).padStart(6);
  console.log('  ' + id.padEnd(6) + ' |' + row(a) + ' |' + row(b) + ' |' + pc(pct(rc, 50)) + ' /' + pc(pct(rc, 95)));
}));
let pick = null; Object.keys(res).forEach(id => { if (!pick || res[id].a.mar > res[pick].a.mar) pick = id; });
const p = res[pick], t1 = p.b.mar > bh[1].mar, t2 = p.b.cagr > pct(p.rc, 95), t3 = p.b.pf >= 1.3 && p.b.n >= 100;
console.log('  picked on design: ' + pick + ' -> test: (1) MAR ' + p.b.mar.toFixed(2) + ' vs SPY ' + bh[1].mar.toFixed(2) + (t1 ? ' ok' : ' NO') +
            '; (2) CAGR' + pc(p.b.cagr) + ' vs random p95' + pc(pct(p.rc, 95)) + (t2 ? ' ok' : ' NO') +
            '; (3) PF ' + p.b.pf.toFixed(2) + ' on ' + p.b.n + ' trades' + (t3 ? ' ok' : ' NO') + ' -> ' + (t1 && t2 && t3 ? 'PASS (paper portfolio)' : 'FAIL'));
// Information: which stocks the pick's test-half profit came from
const by = {}; p.r.trades.filter(t => t.t >= SPLIT).forEach(t => { by[S[t.k].tk] = (by[S[t.k].tk] || 0) + t.pnl; });
const tot = Object.values(by).reduce((a, b) => a + b, 0), top = Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 5);
console.log('  information: test-half profit from the top 5 stocks: ' + top.map(([k, v]) => k + ' ' + (v / tot * 100).toFixed(0) + '%').join(', '));
