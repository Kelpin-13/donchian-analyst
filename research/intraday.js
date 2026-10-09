/**
 * Intraday strategy study on the broker's own gold data (MT5 M15 export in data/).
 *
 *   node research/intraday.js
 *
 * Every strategy is flat before the daily rollover (last exit at the 23:00 bar's open, server time),
 * so no swap is ever paid, and every trade has a stop. Each uses textbook settings fixed before testing.
 *
 * Fills, modelled from M15 bars:
 *   - bars are Bid prices; buys trade at Ask = Bid + the bar's spread
 *   - stop orders (entries and stop losses) fill at their level, or at the open if the bar gapped
 *     through it, plus slippage; profit targets are limit orders: their level, no slippage
 *   - when one bar touches both a position's stop and its target, the stop is assumed to come first,
 *     and no target is credited on the bar a stop order entered (the order inside a bar is unknown)
 * Costs: "real" = bar spread + $0.05 a side; "stressed" = bar spread + 0.01% of price a side.
 * Results are in R (P&L ÷ the risk at entry). Design period 2023-2024, unseen 2025-2026.
 * Research only: nothing here trades.
 */
const { load } = require('./daytrade.js');

const DAY = 86400000;
const dayOf = t => Math.floor(t / DAY);
const mod = t => { const d = new Date(t); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const hm = (h, m) => h * 60 + (m || 0);
const SPLIT = Date.UTC(2025, 0, 1);
const COSTS = { real: { slip: 0.05 }, stressed: { slipPct: 0.0001 } };

/* ---------------- indicators (Wilder where the textbook says so) ---------------- */
function ema(vals, p) {
  const out = new Array(vals.length).fill(null);
  let sum = 0, prev = null;
  for (let i = 0; i < vals.length; i++) {
    if (i < p) { sum += vals[i]; if (i === p - 1) out[i] = prev = sum / p; continue; }
    out[i] = prev = vals[i] * 2 / (p + 1) + prev * (1 - 2 / (p + 1));
  }
  return out;
}
function rsi(closes, p) {
  const out = new Array(closes.length).fill(null);
  let up = 0, dn = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1], u = Math.max(ch, 0), d = Math.max(-ch, 0);
    if (i <= p) { up += u / p; dn += d / p; if (i < p) continue; }
    else { up = (up * (p - 1) + u) / p; dn = (dn * (p - 1) + d) / p; }
    out[i] = dn === 0 ? 100 : 100 - 100 / (1 + up / dn);
  }
  return out;
}
function atr(bars, p) {
  const out = new Array(bars.length).fill(null);
  let prev = null, sum = 0;
  for (let i = 1; i < bars.length; i++) {
    const pc = bars[i - 1].c, b = bars[i];
    const tr = Math.max(b.h - b.l, Math.abs(b.h - pc), Math.abs(b.l - pc));
    if (i <= p) { sum += tr; if (i === p) out[i] = prev = sum / p; continue; }
    out[i] = prev = (prev * (p - 1) + tr) / p;
  }
  return out;
}
function bollinger(closes, p, k) {
  const mid = new Array(closes.length).fill(null), up = mid.slice(), lo = mid.slice();
  for (let i = p - 1; i < closes.length; i++) {
    let s = 0, s2 = 0;
    for (let j = i - p + 1; j <= i; j++) { s += closes[j]; s2 += closes[j] * closes[j]; }
    const m = s / p, sd = Math.sqrt(Math.max(s2 / p - m * m, 0));
    mid[i] = m; up[i] = m + k * sd; lo[i] = m - k * sd;
  }
  return { mid, up, lo };
}

/** Server-day bars from M15, plus each day's ATR(14) known at its open (previous days only). */
function dailyOf(bars) {
  const days = [], index = new Map();
  bars.forEach((b, i) => {
    const d = dayOf(b.t);
    let x = days[days.length - 1];
    if (!x || x.d !== d) { x = { d, i, o: b.o, h: b.h, l: b.l, c: b.c }; days.push(x); index.set(d, days.length - 1); }
    else { x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); x.c = b.c; }
  });
  const a = atr(days, 14);
  days.forEach((x, j) => { x.atrPrev = j > 0 ? a[j - 1] : null; });
  return { days, index };
}

/* ---------------- the engine ---------------- */
/**
 * S: { name, flatMin, maxPerDay, onDay(i) → day state (may carry .orders), onClose(i, pos, D, dayTrades) →
 *      { exit: why } | { enter: { side, stopDist|stop, targetR } } | { orders: [...] } | null }
 * An order: { side, level, stop, targetR, until (minute of day), reverse (stop-and-reverse) }.
 */
function backtest(bars, S, cost) {
  const trades = [];
  const slip = px => cost.slipPct ? px * cost.slipPct : cost.slip;
  let pos = null, orders = [], pendEntry = null, pendExit = null, D = {}, dayTrades = 0;

  function enter(side, raw, i, spec, viaStop) {
    const fill = raw + side * slip(raw);                   // raw is already Ask for a buy, Bid for a sell
    const stop = spec.stop !== undefined ? spec.stop : fill - side * spec.stopDist;
    const risk = (fill - stop) * side;
    if (!(risk > 0)) return;                               // gapped past its own stop: no trade
    pos = { side, t: bars[i].t, entryBar: i, entry: fill, stop, risk, viaStop, level: spec.level,
            target: spec.targetR ? fill + side * spec.targetR * risk : null, reverse: spec.reverse };
    dayTrades++;
  }
  function exit(i, raw, why, isLimit) {
    const fill = isLimit ? raw : raw - pos.side * slip(raw);
    trades.push({ t: pos.t, exitT: bars[i].t, side: pos.side, r: (fill - pos.entry) * pos.side / pos.risk, why, entry: pos.entry, risk: pos.risk });
    pos = null;
  }
  const atOpen = (k, side) => side === 1 ? k.o + k.sp : k.o;      // what a market order trades at
  const exitAtOpen = (k, side) => side === 1 ? k.o : k.o + k.sp;  // closing a long sells at Bid

  for (let i = 0; i < bars.length; i++) {
    const k = bars[i], m = mod(k.t);
    if (i === 0 || dayOf(k.t) !== dayOf(bars[i - 1].t)) {
      orders = []; pendEntry = null; pendExit = null; dayTrades = 0;
      D = S.onDay ? (S.onDay(i) || {}) : {};
      if (D.orders) orders = D.orders;
    }
    const late = m >= S.flatMin;
    if (late) { orders = []; pendEntry = null; }
    if (pos && (late || pendExit)) exit(i, exitAtOpen(k, pos.side), late ? 'SESSION' : pendExit);
    pendExit = null;
    if (pendEntry && !pos && !late) enter(pendEntry.side, atOpen(k, pendEntry.side), i, pendEntry, false);
    pendEntry = null;

    orders = orders.filter(o => m < o.until);
    if (!pos && orders.length && dayTrades < S.maxPerDay) {
      const hit = orders.filter(o => o.side === 1 ? k.h + k.sp >= o.level : k.l <= o.level);
      if (hit.length) {
        // Both sides in one bar: take the one nearer the open; the stop check below then assumes the worst.
        const o = hit.sort((a, b) => Math.abs(a.level - k.o) - Math.abs(b.level - k.o))[0];
        enter(o.side, o.side === 1 ? Math.max(k.o + k.sp, o.level) : Math.min(k.o, o.level), i, o, true);
        orders = [];
      }
    }

    if (pos) {
      const p = pos, fresh = p.entryBar === i;
      if (p.side === 1 ? k.l <= p.stop : k.h + k.sp >= p.stop) {
        const px = fresh ? p.stop : p.side === 1 ? Math.min(k.o, p.stop) : Math.max(k.o + k.sp, p.stop);
        exit(i, px, 'STOP');
        if (p.reverse && dayTrades < S.maxPerDay && m < (S.entryUntil || S.flatMin))
          enter(-p.side, px, i, { stop: p.level, level: p.stop, reverse: true }, true);
      } else if (p.target !== null && !(fresh && p.viaStop) &&
                 (p.side === 1 ? k.h >= p.target : k.l + k.sp <= p.target)) {
        exit(i, fresh ? p.target : p.side === 1 ? Math.max(k.o, p.target) : Math.min(k.o + k.sp, p.target), 'TARGET', true);
      }
    }

    const lastOfDay = i + 1 === bars.length || dayOf(bars[i + 1].t) !== dayOf(k.t);
    if (lastOfDay) { if (pos) exit(i, pos.side === 1 ? k.c : k.c + k.sp, 'SESSION'); continue; }
    if (late || !S.onClose) continue;
    const d = S.onClose(i, pos, D, dayTrades);
    if (!d) continue;
    if (d.orders) orders = d.orders;
    if (d.exit && pos) pendExit = d.exit;
    if (d.enter && (!pos || d.exit) && dayTrades < S.maxPerDay) pendEntry = d.enter;
  }
  return trades;
}

/* ---------------- the strategies ---------------- */
function strategies(bars) {
  const closes = bars.map(b => b.c);
  const { days, index } = dailyOf(bars);
  const dayAt = i => days[index.get(dayOf(bars[i].t))];
  const prevDays = (i, n) => { const j = index.get(dayOf(bars[i].t)); return j >= n ? days.slice(j - n, j) : null; };
  const ema200 = ema(closes, 200), rsi2 = rsi(closes, 2), atr14 = atr(bars, 14), bb = bollinger(closes, 20, 2);
  const out = [];

  // Opening-range breakout: the range's high and low become a buy stop and a sell stop (one trade a day),
  // stop at the other side of the range, out at the target or the session end.
  const orb = (name, from, to, until, targetR) => out.push({
    name, family: 'breakout', flatMin: hm(23), maxPerDay: 1,
    onDay: () => ({ hi: -Infinity, lo: Infinity, n: 0 }),
    onClose(i, pos, D) {
      const k = bars[i], m = mod(k.t);
      if (m >= from && m < to) { D.hi = Math.max(D.hi, k.h); D.lo = Math.min(D.lo, k.l); D.n++; }
      if (m !== to - 15 || D.n < (to - from) / 15 * 0.75) return null;   // range not complete (data gap)
      return { orders: [{ side: 1, level: D.hi, stop: D.lo, targetR, until: until },
                        { side: -1, level: D.lo, stop: D.hi, targetR, until: until }] };
    }
  });
  orb('London ORB (first hour 10:00-11:00), out at session end', hm(10), hm(11), hm(15), null);
  orb('London ORB, 2R target', hm(10), hm(11), hm(15), 2);
  orb('New York ORB (16:30-17:00), out at session end', hm(16, 30), hm(17), hm(20), null);
  orb('Asian range breakout (01:00-09:00 range, trade 09:00-15:00)', hm(1), hm(9), hm(15), null);

  // Dual Thrust (Michael Chalek): range = max(HH-LC, HC-LL) of the last 4 days; buy above open + 0.5 range,
  // sell below open - 0.5 range, stop and reverse at the other trigger; flat at the session end.
  out.push({
    name: 'Dual Thrust (N=4, k=0.5), stop-and-reverse', family: 'breakout', flatMin: hm(23), maxPerDay: 3, entryUntil: hm(20),
    onDay(i) {
      const p = prevDays(i, 4);
      if (!p) return {};
      const HH = Math.max(...p.map(x => x.h)), LL = Math.min(...p.map(x => x.l));
      const HC = Math.max(...p.map(x => x.c)), LC = Math.min(...p.map(x => x.c));
      const range = Math.max(HH - LC, HC - LL), o = bars[i].o;
      const up = o + 0.5 * range, dn = o - 0.5 * range;
      return { orders: [{ side: 1, level: up, stop: dn, reverse: true, until: hm(20) },
                        { side: -1, level: dn, stop: up, reverse: true, until: hm(20) }] };
    }
  });

  // R-Breaker (Richard Saidenberg): six levels from yesterday's high, low and close. Trend entries beyond the
  // breakout levels; reversal entries after the day overshoots a setup level and comes back through its
  // enter level. Stop 0.5 x daily ATR; flat at the session end.
  out.push({
    name: 'R-Breaker (classic levels), stop 0.5 x daily ATR', family: 'breakout + reversal', flatMin: hm(23), maxPerDay: 2,
    onDay(i) {
      const p = prevDays(i, 1), today = dayAt(i);
      if (!p || !today.atrPrev) return {};
      const { h: H, l: L, c: C } = p[0], P = (H + L + C) / 3;
      return { hi: -Infinity, lo: Infinity, atr: today.atrPrev,
               bBreak: H + 2 * (P - L), sSetup: P + (H - L), sEnter: 2 * P - L,
               bEnter: 2 * P - H, bSetup: P - (H - L), sBreak: L - 2 * (H - P) };
    },
    onClose(i, pos, D) {
      if (!D.atr) return null;
      const k = bars[i], c = k.c;
      D.hi = Math.max(D.hi, k.h); D.lo = Math.min(D.lo, k.l);
      if (mod(k.t) >= hm(20)) return null;
      const stopDist = 0.5 * D.atr;
      const revShort = D.hi > D.sSetup && c < D.sEnter, revLong = D.lo < D.bSetup && c > D.bEnter;
      if (!pos) {
        if (c > D.bBreak || revLong) return { enter: { side: 1, stopDist } };
        if (c < D.sBreak || revShort) return { enter: { side: -1, stopDist } };
        return null;
      }
      if (pos.side === 1 && revShort) return { exit: 'REVERSE', enter: { side: -1, stopDist } };
      if (pos.side === -1 && revLong) return { exit: 'REVERSE', enter: { side: 1, stopDist } };
      return null;
    }
  });

  // Intraday momentum (Gao, Han, Li & Zhou 2018; Baltussen et al. 2021 across futures): the day's move so far
  // predicts the rest of the day. Trade its direction from the signal time to the session end.
  const momentum = (name, at) => out.push({
    name, family: 'momentum', flatMin: hm(23), maxPerDay: 1,
    onClose(i, pos) {
      const k = bars[i], today = dayAt(i);
      if (pos || mod(k.t) !== at - 15 || !today.atrPrev || k.c === today.o) return null;
      return { enter: { side: k.c > today.o ? 1 : -1, stopDist: 0.5 * today.atrPrev } };
    }
  });
  momentum('Intraday momentum: day open -> 16:00 direction, held to session end', hm(16));
  momentum('Intraday momentum: day open -> 20:00 direction, held to session end', hm(20));

  // RSI(2) pullback in the trend (Connors): buy an oversold dip above the 200-bar EMA, sell an overbought pop
  // below it; out when RSI(2) crosses 50, after 8 bars (2 hours) or at the stop (2 x ATR).
  out.push({
    name: 'RSI(2) pullback with EMA200 trend filter (M15)', family: 'mean reversion', flatMin: hm(23), maxPerDay: 20,
    onClose(i, pos) {
      const k = bars[i], m = mod(k.t), r = rsi2[i], e = ema200[i], a = atr14[i];
      if (r === null || e === null || a === null) return null;
      if (pos) {
        if (pos.side === 1 ? r > 50 : r < 50) return { exit: 'SIGNAL' };
        if (i - pos.entryBar + 1 >= 8) return { exit: 'TIME' };
        return null;
      }
      if (m < hm(3) || m >= hm(21)) return null;
      if (r < 10 && k.c > e) return { enter: { side: 1, stopDist: 2 * a } };
      if (r > 90 && k.c < e) return { enter: { side: -1, stopDist: 2 * a } };
      return null;
    }
  });

  // Asian-session fade: in the quiet hours, a close outside the 20-bar Bollinger band (2 sd) reverts to the
  // middle; stop 1.5 x ATR beyond, out at the middle band, after 8 bars, or at 10:00 before London opens.
  out.push({
    name: 'Asian-session Bollinger fade (02:00-09:00, flat 10:00)', family: 'mean reversion', flatMin: hm(10), maxPerDay: 20,
    onClose(i, pos) {
      const k = bars[i], m = mod(k.t), a = atr14[i];
      if (bb.mid[i] === null || a === null) return null;
      if (pos) {
        if (pos.side === 1 ? k.c >= bb.mid[i] : k.c <= bb.mid[i]) return { exit: 'SIGNAL' };
        if (i - pos.entryBar + 1 >= 8) return { exit: 'TIME' };
        return null;
      }
      if (m < hm(2) || m >= hm(9)) return null;
      if (k.c < bb.lo[i]) return { enter: { side: 1, stopDist: 1.5 * a } };
      if (k.c > bb.up[i]) return { enter: { side: -1, stopDist: 1.5 * a } };
      return null;
    }
  });

  // Crabel (1990): a range breakout works best after compression. Asian range breakout only when tonight's
  // range is narrow next to the daily ATR (below the design period's median ratio, 2023-2024 only).
  const asianRatio = [];
  days.forEach(x => {
    if (!x.atrPrev || x.d * DAY >= SPLIT) return;
    let hi = -Infinity, lo = Infinity;
    for (let j = x.i; j < bars.length && dayOf(bars[j].t) === x.d && mod(bars[j].t) < hm(9); j++) { hi = Math.max(hi, bars[j].h); lo = Math.min(lo, bars[j].l); }
    if (hi > lo) asianRatio.push((hi - lo) / x.atrPrev);
  });
  asianRatio.sort((a, b) => a - b);
  const narrow = asianRatio[asianRatio.length >> 1];
  const base = out.find(s => s.name.startsWith('Asian range breakout'));
  out.forEach(s => { s.group = s.name; });
  out.push(Object.assign({}, base, {
    name: 'Asian range breakout, narrow nights only (Crabel)',
    onClose(i, pos, D) {
      const d = base.onClose(i, pos, D), today = dayAt(i);
      if (d && d.orders && !(today.atrPrev && (D.hi - D.lo) / today.atrPrev < narrow)) return null;
      return d;
    }
  }));
  return out;
}

/** The proven H4 trend: last closed H4 bar's close against its EMA100 (+1 up, -1 down), for every M15 bar. */
function h4Trend(bars) {
  const H4 = 4 * 3600000, h4 = [], at = new Array(bars.length);
  bars.forEach((b, i) => {
    const t = Math.floor(b.t / H4) * H4, last = h4[h4.length - 1];
    if (last && last.t === t) last.c = b.c; else h4.push({ t, c: b.c });
    at[i] = h4.length - 1;
  });
  const e = ema(h4.map(x => x.c), 100);
  return at.map(j => (j < 1 || e[j - 1] === null) ? 0 : h4[j - 1].c > e[j - 1] ? 1 : -1);
}

/** Same strategy, but only trades in the H4 trend's direction (no stop-and-reverse into the other side). */
function withTrend(S, trend) {
  const keep = (i, d) => {
    if (!d) return d;
    const x = Object.assign({}, d);
    if (x.orders) x.orders = x.orders.filter(o => o.side === trend[i]).map(o => Object.assign({}, o, { reverse: false }));
    if (x.enter && x.enter.side !== trend[i]) delete x.enter;
    return x;
  };
  return Object.assign({}, S, {
    name: S.name + ' + H4 trend',
    onDay: S.onDay && (i => keep(i, S.onDay(i))),
    onClose: S.onClose && ((i, pos, D, n) => keep(i, S.onClose(i, pos, D, n)))
  });
}

/* ---------------- statistics ---------------- */
function stats(tr, weeks) {
  const n = tr.length;
  if (!n) return { n: 0, totalR: 0 };
  const rs = tr.map(t => t.r), sum = rs.reduce((a, b) => a + b, 0), mean = sum / n;
  const sd = Math.sqrt(rs.reduce((a, r) => a + (r - mean) * (r - mean), 0) / Math.max(1, n - 1));
  const gw = rs.filter(r => r > 0).reduce((a, b) => a + b, 0), gl = -rs.filter(r => r <= 0).reduce((a, b) => a + b, 0);
  let cum = 0, peak = 0, ddR = 0, eq = 1, peakEq = 1, ddPct = 0;
  rs.forEach(r => {
    cum += r; peak = Math.max(peak, cum); ddR = Math.max(ddR, peak - cum);
    eq *= 1 + 0.005 * r; peakEq = Math.max(peakEq, eq); ddPct = Math.max(ddPct, 1 - eq / peakEq);   // 0.5% risk a trade
  });
  return { n, perWeek: n / weeks, win: rs.filter(r => r > 0).length / n * 100, pf: gl ? gw / gl : Infinity,
           avgR: mean, t: sd ? mean / sd * Math.sqrt(n) : 0, totalR: sum, ddR, ddPct: ddPct * 100,
           growthPct: (eq - 1) * 100 };
}

/** Bootstrap 15-trading-day windows (Monday 13 Oct → Friday 31 Oct) from the unseen period's days. */
function threeWeeks(tr, sims) {
  const byDay = new Map();
  tr.forEach(t => byDay.set(dayOf(t.t), (byDay.get(dayOf(t.t)) || 0) + t.r));
  const firstDay = dayOf(SPLIT), lastDay = Math.max(...tr.map(t => dayOf(t.t)));
  const tradingDays = [];
  for (let d = firstDay; d <= lastDay; d++) { const wd = new Date(d * DAY).getUTCDay(); if (wd >= 1 && wd <= 5) tradingDays.push(byDay.get(d) || 0); }
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const res = [];
  for (let s = 0; s < sims; s++) {
    const start = Math.floor(rnd() * (tradingDays.length - 15));     // a real 3-week stretch, order kept
    let tot = 0; for (let j = 0; j < 15; j++) tot += tradingDays[start + j];
    res.push(tot);
  }
  res.sort((a, b) => a - b);
  return { pPositive: res.filter(x => x > 0).length / sims * 100, p5: res[Math.floor(sims * 0.05)], median: res[sims >> 1], p95: res[Math.floor(sims * 0.95)] };
}

/* ---------------- report ---------------- */
if (require.main === module) {
  const bars = load('XAUUSD.sml_M15.csv');
  const f = (v, d) => (v === undefined || v === null || !isFinite(v)) ? '-' : v.toFixed(d === undefined ? 2 : d);
  const weeksOf = (a, b) => (b - a) / (7 * DAY);
  const t0 = bars[0].t, t1 = bars[bars.length - 1].t;
  console.log('Gold M15 (OANDA XAUUSD.sml), ' + bars.length + ' bars, ' + new Date(t0).toISOString().slice(0, 10) + ' to ' +
              new Date(t1).toISOString().slice(0, 10) + '. Design 2023-2024 | unseen 2025-2026. R = P&L / risk; DD% at 0.5% risk a trade.');

  // How gold moves through the day: mean M15 return by server hour, design vs unseen half, in basis points.
  const hours = Array.from({ length: 24 }, () => ({ a: [], b: [] }));
  bars.forEach(b => { if (b.o > 0) hours[new Date(b.t).getUTCHours()][b.t < SPLIT ? 'a' : 'b'].push((b.c - b.o) / b.o * 1e4); });
  const meanT = xs => { const n = xs.length, m = xs.reduce((a, b) => a + b, 0) / (n || 1); const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, n - 1)); return [m * 4, n ? m / sd * Math.sqrt(n) : 0]; };
  console.log('\nGold\'s average move by server hour (bp per hour; t-stat): design | unseen');
  hours.forEach((h, H) => { if (!h.a.length) return; const [ma, ta] = meanT(h.a), [mb, tb] = meanT(h.b);
    console.log('  ' + String(H).padStart(2, '0') + ':00  ' + f(ma, 1).padStart(6) + ' (' + f(ta, 1).padStart(5) + ') | ' + f(mb, 1).padStart(6) + ' (' + f(tb, 1).padStart(5) + ')'); });

  const trend = h4Trend(bars);
  const S0 = strategies(bars);
  const S = S0.concat(S0.filter(s => s.family !== 'mean reversion').map(s => withTrend(s, trend)));
  const rows = [];
  ['real', 'stressed'].forEach(cname => {
    console.log('\n=== Costs: ' + cname + (cname === 'real' ? ' (bar spread + $0.05 a side)' : ' (bar spread + 0.01% of price a side)'));
    console.log('strategy'.padEnd(66) + '  trades /wk  win%   PF  avgR     t  totalR ddR  dd% | design R  PF | unseen R  PF | long R short R | 2023 2024 2025 2026');
    S.forEach(s => {
      const tr = backtest(bars, s, COSTS[cname]);
      const all = stats(tr, weeksOf(t0, t1)), a = stats(tr.filter(t => t.t < SPLIT), 1), b = stats(tr.filter(t => t.t >= SPLIT), 1);
      const lr = tr.filter(t => t.side === 1).reduce((x, t) => x + t.r, 0), sr = tr.filter(t => t.side === -1).reduce((x, t) => x + t.r, 0);
      const yr = [2023, 2024, 2025, 2026].map(y => f(tr.filter(t => new Date(t.t).getUTCFullYear() === y).reduce((x, t) => x + t.r, 0), 0).padStart(5));
      console.log(s.name.slice(0, 66).padEnd(66) + String(all.n).padStart(8) + f(all.perWeek, 1).padStart(5) + f(all.win, 0).padStart(5) +
                  f(all.pf).padStart(6) + f(all.avgR, 3).padStart(7) + f(all.t, 1).padStart(6) + f(all.totalR, 0).padStart(7) +
                  f(all.ddR, 0).padStart(5) + f(all.ddPct, 0).padStart(4) + '% | ' + f(a.totalR, 0).padStart(8) + f(a.pf).padStart(5) +
                  ' | ' + f(b.totalR, 0).padStart(8) + f(b.pf).padStart(5) + ' | ' + f(lr, 0).padStart(6) + f(sr, 0).padStart(7) + ' |' + yr.join(''));
      rows.push({ s, cname, tr, all, a, b });
    });
  });

  // Pass mark, fixed before looking: profitable in BOTH halves at real costs (PF > 1.1 each), t > 2 overall,
  // and still profitable (PF > 1) under stressed costs.
  console.log('\nPass mark: PF > 1.1 in the design AND the unseen half at real costs, t-stat > 2, PF > 1 at stressed costs.');
  const passed = S.filter(s => {
    const r = rows.find(x => x.s === s && x.cname === 'real'), st = rows.find(x => x.s === s && x.cname === 'stressed');
    return r.a.pf > 1.1 && r.b.pf > 1.1 && r.all.t > 2 && st.all.pf > 1;
  });
  if (!passed.length) console.log('  No strategy passes.');
  passed.forEach(s => {
    const r = rows.find(x => x.s === s && x.cname === 'real');
    const w = threeWeeks(r.tr, 4000);
    console.log('  PASS  ' + s.name + '\n        a random 3 weeks of 2025-2026: ' + f(w.pPositive, 0) + '% of them ended positive; median ' +
                f(w.median, 1) + 'R, 5th-95th percentile ' + f(w.p5, 1) + 'R to ' + f(w.p95, 1) + 'R');
  });

  // Portfolio: several weak, unrelated edges traded together. Chosen on the DESIGN half only: per strategy
  // family, the variant with the best design PF, if that PF is at least 1.10. Then judged on 2025-2026.
  const pick = [];
  [...new Set(S.map(s => s.group))].forEach(g => {
    const best = rows.filter(x => x.s.group === g && x.cname === 'real').sort((x, y) => y.a.pf - x.a.pf)[0];
    if (best && best.a.pf >= 1.10) pick.push(best.s);
  });
  console.log('\nPortfolio chosen on 2023-2024 only (best variant per family, design PF >= 1.10), 0.5% risk per trade:');
  pick.forEach(s => console.log('  - ' + s.name));
  ['real', 'stressed'].forEach(cname => {
    const tr = [].concat(...pick.map(s => rows.find(x => x.s === s && x.cname === cname).tr)).sort((x, y) => x.exitT - y.exitT);
    const all = stats(tr, weeksOf(t0, t1)), a = stats(tr.filter(t => t.t < SPLIT), 1), b = stats(tr.filter(t => t.t >= SPLIT), 1);
    const yr = [2023, 2024, 2025, 2026].map(y => y + ' ' + f(tr.filter(t => new Date(t.t).getUTCFullYear() === y).reduce((x, t) => x + t.r, 0), 0) + 'R').join(', ');
    console.log('  ' + cname.padEnd(8) + ': ' + all.n + ' trades (' + f(all.perWeek, 1) + '/week), win ' + f(all.win, 0) + '%, PF ' + f(all.pf) +
                ', t ' + f(all.t, 1) + ', ' + f(all.totalR, 0) + 'R, worst drawdown ' + f(all.ddR, 0) + 'R = ' + f(all.ddPct, 1) + '%, growth ' +
                f(all.growthPct, 0) + '% | design ' + f(a.totalR, 0) + 'R PF ' + f(a.pf) + ' | unseen ' + f(b.totalR, 0) + 'R PF ' + f(b.pf) + ' | ' + yr);
    if (cname === 'real') {
      const w = threeWeeks(tr, 4000);
      console.log('            a random 3 weeks of 2025-2026: ' + f(w.pPositive, 0) + '% ended positive; median ' + f(w.median, 1) +
                  'R, 5th-95th percentile ' + f(w.p5, 1) + 'R to ' + f(w.p95, 1) + 'R');
    }
  });
}

/** The portfolio the EA trades (mt5/GoldIntraday.mq5), keyed by the EA's strategy names. */
const PORTFOLIO = {
  NY_ORB: 'New York ORB (16:30-17:00), out at session end + H4 trend',
  ASIAN_NARROW: 'Asian range breakout, narrow nights only (Crabel)',
  DUAL_THRUST: 'Dual Thrust (N=4, k=0.5), stop-and-reverse',
  R_BREAKER: 'R-Breaker (classic levels), stop 0.5 x daily ATR + H4 trend',
  MOM_16: 'Intraday momentum: day open -> 16:00 direction, held to session end + H4 trend',
  MOM_20: 'Intraday momentum: day open -> 20:00 direction, held to session end + H4 trend'
};
function portfolio(bars) {
  const trend = h4Trend(bars), S0 = strategies(bars);
  const all = S0.concat(S0.filter(s => s.family !== 'mean reversion').map(s => withTrend(s, trend)));
  const out = {};
  Object.keys(PORTFOLIO).forEach(id => { out[id] = all.find(s => s.name === PORTFOLIO[id]); });
  return out;
}

module.exports = { backtest, strategies, h4Trend, withTrend, portfolio, PORTFOLIO, stats, threeWeeks, ema, rsi, atr, bollinger, dailyOf, COSTS, SPLIT };
