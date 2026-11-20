/**
 * Kullamagi's "episodic pivot": buy a large stock that gaps up hard on news and holds the gap (owner's videos, 7 Nov
 * 2026; the one stock entry from them not yet tested, research/stock_swing_lab.js tested the others). Rules fixed
 * before the first run.
 *
 *   node research/gap_lab.js [randomRuns]
 *
 * Same data, list, survivorship warning, sizing, costs, split and random-entry control as research/stock_swing_lab.js
 * (49 large US stocks, Yahoo daily bars, 2008-2026). Earnings dates are not in the data; a gap this size on a large
 * stock is almost always news (earnings, guidance, a deal), which is what he trades.
 *
 *   market    SPY closed above its 200-day average the day before
 *   stock     20-day average dollar volume at least $50M (the day before), 252 days of history
 *   gap       today's open at least G above yesterday's close (G6 = 6%, G10 = 10%), and today's close at or above
 *             today's open (the gap held all day; daily bars cannot show his opening-range break, this is the closest
 *             thing known by the close)
 *   entry     buy at today's close. Stop: today's low; no trade if that is more than 2 x ATR(14) below the close
 *   exit      (his) half out at the close of the 3rd day after entry, the rest's stop moves to the entry price; the
 *             rest out at the next open after a close below the 10-day average. A stop fills at its level, or at the
 *             open if the day opens below it
 *   sizing    0.5% of equity at risk, a position at most 20% of equity, no borrowing, at most 10 positions; several
 *             gaps the same day: the biggest gap first. 0.05% cost per side. Idle cash earns the T-bill rate.
 *   choices   G6, G10
 *   control   100 runs per choice: on each day the strategy bought n stocks, n random liquid stocks not held are bought
 *             at that day's close with the same stop distance in ATRs, the same exit and sizing
 *   pick      the better MAR on 2008-2016
 *   pass      on 2017 to the end, all three: (1) MAR above SPY buy-and-hold's; (2) CAGR above the 95th percentile of
 *             its random control; (3) profit factor at least 1.3 on at least 50 trades. A pass goes to the paper
 *             portfolio, not real money.
 * Results (19 Nov 2026, one run, 100 random runs; design | test, CAGR / worst DD / MAR / trades / PF):
 *   SPY 14.4% / 33.7% / 0.43 on the test half.  G6 1.1% / 3.7% / 0.29 / 56 / 1.70 | 4.3% / 4.6% / 0.92 / 129 / 1.51
 *   (random p50 2.5%, p95 3.6%; picked);  G10 0.4% / 2.0% / 0.17 / 17 / 1.25 | 3.2% / 3.2% / 1.02 / 37 / 1.75 (random 2.5%, 3.1%).
 *   G6 PASSES all three. Caveats: it is in cash most of the time (about 13 trades a year at 0.5% risk), so it earns
 *   4.3% a year against 14.4% for holding SPY: a small extra, not a replacement; and it is one pass among about two
 *   dozen ideas tested, so luck is possible.
 * Replication (added after that run, rules fixed before this part ran): the same G6 rule, unchanged, on a second list
 *   of 52 large US stocks that were not in the first list (other S&P 100 members, chosen by membership, not by
 *   results): node research/gap_lab.js 100 --list B. It passes only if, on the test half, the same three tests hold.
 * Replication result (19 Nov 2026, one run; BK skipped, Yahoo returns no data for it, so 51 stocks): G6 on list B,
 *   test half: 3.6% a year, worst DD 2.6%, MAR 1.39 vs SPY 0.43; random p50 2.5%, p95 3.1%; PF 2.31 on 50 trades
 *   -> PASS (by the smallest margin on the trade count). Its design half lost (-0.2%, PF 0.24 on 18 trades): calmer
 *   stocks gap less, and 2008-2016 gave few trades on either list. Goes to the paper portfolio (Stocks.gs signal).
 * Realism check (added 19 Nov 2026 after the two passes, fixed before it ran): the owner is asleep at the US close
 *   (05:00 in Malaysia), so: --next-open buys at the NEXT day's open instead of the close, everything else unchanged
 *   (same stop at the gap day's low, skipped if the open is at or under it; the day-3 half on the same calendar day;
 *   the random control also buys at the next open). G6 on both lists. It passes only if both lists pass the same
 *   three tests on the test half. node research/gap_lab.js 100 --next-open [--list B]
 * Realism check result (19 Nov 2026, one run each): list A G6 at the next open: 4.3% a year, worst DD 3.0%, PF 1.60,
 *   123 trades, random p95 3.5% -> passes. List B: 2.9% a year, PF 1.41, 49 trades, random p95 2.9% -> fails by the
 *   smallest margins (CAGR equal to the 95th percentile, one trade short of 50). Written rule: FAIL. Reading: the edge
 *   survives a next-morning entry on list A and weakens to borderline on list B; buying at the close stays the tested
 *   version, and the paper portfolio records it at the close.
 * --export <file.json>: also writes the picked choice's daily equity, trades, SPY and the random control for
 *   research/gap_report.js (the shareable report). Changes no result.
 * Research only: nothing here trades.
 */
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, '..', 'data', 'yahoo');
const RANDOM_RUNS = Number(process.argv[2]) || 100;
const DAY = 86400000, FROM = Date.UTC(2008, 0, 1), SPLIT = Date.UTC(2017, 0, 1);
const COST = 0.0005, RISK = 0.005, MAX_POS = 10, MAX_W = 0.2, MIN_DV = 50e6, MAX_ATR = 2;
const TBILL = { 2007: 4.36, 2008: 1.37, 2009: 0.15, 2010: 0.14, 2011: 0.05, 2012: 0.09, 2013: 0.06, 2014: 0.03, 2015: 0.05, 2016: 0.32,
                2017: 0.93, 2018: 1.94, 2019: 2.06, 2020: 0.36, 2021: 0.05, 2022: 2.02, 2023: 5.07, 2024: 4.97, 2025: 4.2, 2026: 3.8 };
const LIST_A = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'AMD', 'NFLX', 'ORCL', 'CRM', 'ADBE', 'QCOM', 'MU',
  'INTC', 'PLTR', 'UBER', 'COIN', 'JPM', 'BAC', 'WFC', 'GS', 'V', 'MA', 'PYPL', 'XOM', 'CVX', 'UNH', 'LLY', 'JNJ', 'PFE',
  'MRK', 'ABBV', 'KO', 'PEP', 'WMT', 'COST', 'HD', 'NKE', 'SBUX', 'DIS', 'BA', 'CAT', 'GE', 'F', 'T', 'VZ', 'BABA'];
const LIST_B = ['ABT', 'ACN', 'AIG', 'AMGN', 'AXP', 'BK', 'BKNG', 'BLK', 'BMY', 'C', 'CHTR', 'CL', 'CMCSA', 'COF', 'COP', 'CSCO',
  'CVS', 'DE', 'DHR', 'DUK', 'EMR', 'FDX', 'GD', 'GILD', 'GM', 'HON', 'IBM', 'ISRG', 'LIN', 'LMT', 'LOW', 'MCD', 'MDLZ', 'MDT',
  'MET', 'MMM', 'MO', 'MS', 'NEE', 'NOW', 'PG', 'PM', 'RTX', 'SCHW', 'SO', 'SPG', 'TGT', 'TMO', 'TXN', 'UNP', 'UPS', 'USB'];
const LIST = process.argv.includes('--list') && process.argv[process.argv.indexOf('--list') + 1] === 'B' ? 'B' : 'A';
const OPEN = process.argv.includes('--next-open');
const STOCKS = (LIST === 'B' ? LIST_B : LIST_A).filter(t => fs.existsSync(path.join(DIR, t + '.csv')));   // BK: Yahoo returns no data, skipped

const read = t => fs.readFileSync(path.join(DIR, t + '.csv'), 'utf8').trim().split(/\r?\n/).slice(1).map(l => {
  const p = l.split(','); return { t: Date.parse(p[0] + 'T00:00:00Z'), o: +p[1], h: +p[2], l: +p[3], c: +p[4], a: +p[5], v: +p[6] };
}).filter(b => b.c > 0 && b.o > 0 && b.h > 0 && b.l > 0);
const spyBars = read('SPY').filter(b => b.t >= Date.UTC(2006, 0, 1));
const dates = spyBars.map(b => b.t), N = dates.length;
const smaOf = (x, n) => { const o = new Array(x.length).fill(null); let s = 0, k = 0; for (let i = 0; i < x.length; i++) { if (x[i] === null) { s = 0; k = 0; continue; } s += x[i]; k++; if (k > n) s -= x[i - n]; if (k >= n) o[i] = s / n; } return o; };
const spyC = spyBars.map(b => b.c), spy200 = smaOf(spyC, 200), spyA = spyBars.map(b => b.a);
const S = STOCKS.map(tk => {
  const m = new Map(read(tk).map(b => [b.t, b]));
  const bars = dates.map(t => m.get(t) || null);
  const c = bars.map(b => b ? b.c : null);
  let run = 0; const age = bars.map(b => (run = b ? run + 1 : 0));
  const tr = bars.map((b, i) => !b ? null : i && bars[i - 1] ? Math.max(b.h - b.l, Math.abs(b.h - bars[i - 1].c), Math.abs(b.l - bars[i - 1].c)) : b.h - b.l);
  return { tk, bars, age, c, sma10: smaOf(c, 10), atr: smaOf(tr, 14), dv20: smaOf(bars.map(b => b ? b.c * b.v : null), 20) };
});
const liquid = (s, i) => s.age[i] >= 252 && s.dv20[i] >= MIN_DV && s.atr[i] > 0;

/** Buys at day i's close: [{k, stop, pri}] for the strategy. */
function gaps(G, i) {
  if (!(spyC[i - 1] > spy200[i - 1])) return [];
  const out = [];
  S.forEach((s, k) => {
    const b = s.bars[i], p = s.bars[i - 1];
    if (!b || !p || !liquid(s, i - 1) || !(b.o >= p.c * (1 + G)) || !(b.c >= b.o)) return;
    if (b.c - b.l > MAX_ATR * s.atr[i - 1] || !(b.c > b.l)) return;
    out.push({ k, stop: b.l, atr: s.atr[i - 1], pri: b.o / p.c });
  });
  return out.sort((a, b) => b.pri - a.pri);
}

function run(G, plan, rand) {
  let cash = 1;
  const pos = [], eq = [], trades = [], fills = new Map(), start = dates.findIndex(t => t >= FROM);
  const value = i => cash + pos.reduce((s, p) => s + p.sh * (S[p.k].c[i] !== null ? S[p.k].c[i] : p.last), 0);
  const sell = (p, sh, px) => { cash += sh * px * (1 - COST); p.pnl += sh * (px * (1 - COST) - p.cost); p.sh -= sh; };
  let pending = [];
  for (let i = start; i < N; i++) {
    const yr = new Date(dates[i]).getUTCFullYear();
    cash *= 1 + (TBILL[yr] !== undefined ? TBILL[yr] : 3.8) / 100 / 252;
    const eqStart = value(i - 1);
    if (OPEN) {                           // --next-open: yesterday's signals fill at today's open
      for (const c of pending) {
        const b = S[c.k].bars[i];
        if (!b || pos.length >= MAX_POS || pos.some(p => p.k === c.k)) continue;
        const px = b.o, risk = px - c.stop;
        if (!(risk > 0)) continue;
        const sh = Math.min(RISK * eqStart / risk, MAX_W * eqStart / px, cash / (px * (1 + COST)));
        if (!(sh > 0)) continue;
        cash -= sh * px * (1 + COST);
        pos.push({ k: c.k, sh, cost: px * (1 + COST), entry: px, stop: c.stop, day: 0, half: false, pnl: 0, last: px, t: dates[i], exitNext: false });
        if (!fills.has(c.dec)) fills.set(c.dec, []);
        fills.get(c.dec).push({ atrK: risk / c.atr });
      }
      pending = [];
    }
    for (const p of pos) {
      const s = S[p.k], b = s.bars[i];
      if (!b || !(p.sh > 0)) continue;
      if (p.exitNext) { sell(p, p.sh, b.o); continue; }
      p.day++; p.last = b.c;
      if (b.l <= p.stop) { sell(p, p.sh, Math.min(b.o, p.stop)); continue; }
      if (p.day === 3 && !p.half) { sell(p, p.sh / 2, b.c); p.half = true; p.stop = Math.max(p.stop, p.entry); }
      p.exitNext = s.sma10[i] !== null && b.c < s.sma10[i];
    }
    for (let j = pos.length - 1; j >= 0; j--) if (!(pos[j].sh > 1e-12)) { trades.push({ t: pos[j].t, k: pos[j].k, pnl: pos[j].pnl }); pos.splice(j, 1); }
    // buys at today's close
    const held = new Set(pos.map(p => p.k));
    let cands;
    if (plan) {
      cands = [];
      (plan.get(i) || []).forEach(x => {
        const pool = S.map((s, k) => k).filter(k => !held.has(k) && liquid(S[k], i - 1) && S[k].bars[i]);
        if (!pool.length) return;
        const k = pool[Math.floor(rand() * pool.length)]; held.add(k);
        cands.push({ k, stop: S[k].bars[i].c - x.atrK * S[k].atr[i - 1], atr: S[k].atr[i - 1], atrK: x.atrK });
      });
    } else cands = gaps(G, i).filter(c => !held.has(c.k));
    if (OPEN) {
      pending = cands.map(c => Object.assign({}, c, { dec: i }));
      if (plan) pending.forEach(c => { const nb = S[c.k].bars[i + 1]; if (nb) c.stop = nb.o - c.atrK * c.atr; });   // same ATR distance from the fill
      eq.push({ t: dates[i], v: value(i) });
      continue;
    }
    for (const c of cands) {
      if (pos.length >= MAX_POS) break;
      const px = S[c.k].bars[i].c, risk = px - c.stop;
      if (!(risk > 0)) continue;
      const sh = Math.min(RISK * eqStart / risk, MAX_W * eqStart / px, cash / (px * (1 + COST)));
      if (!(sh > 0)) continue;
      cash -= sh * px * (1 + COST);
      pos.push({ k: c.k, sh, cost: px * (1 + COST), entry: px, stop: c.stop, day: 0, half: false, pnl: 0, last: px, t: dates[i], exitNext: false });
      if (!fills.has(i)) fills.set(i, []);
      fills.get(i).push({ atrK: risk / c.atr });
    }
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

const bhEq = dates.map((t, i) => ({ t, v: spyA[i] })).filter(p => p.t >= FROM);
const bh = [stats(bhEq, [], FROM, SPLIT), stats(bhEq, [], SPLIT, Infinity)];
console.log((OPEN ? '[entry at the NEXT open] ' : '') + 'Episodic pivot (gap up that holds) on ' + STOCKS.length + ' large US stocks (survivorship bias: judged against random entries)');
console.log('  SPY buy-and-hold: design MAR ' + bh[0].mar.toFixed(2) + ' | test CAGR' + pc(bh[1].cagr) + ', worst DD' + pc(bh[1].dd) + ', MAR ' + bh[1].mar.toFixed(2));
console.log('  choice | design: CAGR  worst DD   MAR  trades   PF  win% | test: CAGR  worst DD   MAR  trades   PF  win% | random test CAGR p50 / p95');
const res = {};
[['G6', 0.06], ['G10', 0.10]].forEach(([id, G]) => {
  const r = run(G), a = stats(r.eq, r.trades, FROM, SPLIT), b = stats(r.eq, r.trades, SPLIT, Infinity), rc = [];
  for (let k = 0; k < RANDOM_RUNS; k++) { const q = run(G, r.fills, rng(9300 + k)); rc.push(stats(q.eq, q.trades, SPLIT, Infinity).cagr); }
  res[id] = { a, b, rc, r };
  const row = z => pc(z.cagr).padStart(11) + pc(z.dd).padStart(10) + z.mar.toFixed(2).padStart(6) + String(z.n).padStart(8) + z.pf.toFixed(2).padStart(6) + (z.win * 100).toFixed(0).padStart(6);
  console.log('  ' + id.padEnd(6) + ' |' + row(a) + ' |' + row(b) + ' |' + pc(pct(rc, 50)) + ' /' + pc(pct(rc, 95)));
});
const pick = LIST === 'B' || OPEN ? 'G6' : res.G10.a.mar > res.G6.a.mar ? 'G10' : 'G6', p = res[pick];   // list B: replication of the list A pick
const t1 = p.b.mar > bh[1].mar, t2 = p.b.cagr > pct(p.rc, 95), t3 = p.b.pf >= 1.3 && p.b.n >= 50;
console.log((LIST === 'B' ? '  replication on list B, G6 as picked on list A' : '  picked on design: ' + pick) + ' -> test: (1) MAR ' + p.b.mar.toFixed(2) + ' vs SPY ' + bh[1].mar.toFixed(2) + (t1 ? ' ok' : ' NO') +
            '; (2) CAGR' + pc(p.b.cagr) + ' vs random p95' + pc(pct(p.rc, 95)) + (t2 ? ' ok' : ' NO') +
            '; (3) PF ' + p.b.pf.toFixed(2) + ' on ' + p.b.n + ' trades' + (t3 ? ' ok' : ' NO') + ' -> ' + (t1 && t2 && t3 ? 'PASS (paper portfolio)' : 'FAIL'));
const EXP = process.argv.indexOf('--export');
if (EXP > 0) {
  const day = t => new Date(t).toISOString().slice(0, 10);
  fs.writeFileSync(process.argv[EXP + 1], JSON.stringify({
    choices: Object.fromEntries(Object.entries(res).map(([k, v]) => [k, { a: v.a, b: v.b }])),
    list: LIST, nextOpen: OPEN, stocks: STOCKS, pick, randomRuns: RANDOM_RUNS, split: day(SPLIT),
    design: p.a, test: p.b, spy: bh, randomCagr: p.rc, pass: [t1, t2, t3],
    eq: p.r.eq.map(x => [day(x.t), +x.v.toFixed(6)]), spyEq: bhEq.map(x => [day(x.t), +(x.v / bhEq[0].v).toFixed(6)]),
    trades: p.r.trades.map(x => [day(x.t), S[x.k].tk, +x.pnl.toFixed(6)])
  }));
  console.log('  exported ' + process.argv[EXP + 1]);
}
