/**
 * Backtest.gs — the backtester you can actually believe (or at least argue with).
 *
 * The quick backtest() in Strategy.gs is a 5-second sanity check: no fees,
 * fills at the signal close, full-equity positions. This file fixes all three:
 *
 *   - Orders fill at the NEXT bar's open, like they would live and like
 *     TradingView's Strategy Tester does by default.
 *   - Every fill pays slippage and a fee, per side.
 *   - Position size risks a fixed % of CURRENT equity (compounding), capped
 *     at maxExposurePct so there's no hidden leverage.
 *
 * It uses the SAME decideAtBar_() as the live monitor. There is one strategy
 * in this project, not a live version and a backtest version that drift apart.
 *
 * Menu functions:
 *   runDetailedBacktest()  full metrics + trade list + equity curve with charts
 *   runSweep()             parameter heatmap — is your setting a peak or a plateau?
 *   runWalkForward()       tune on the past, test on the unseen future, repeat
 *   runMonteCarlo()        how bad could the drawdown have been with different luck?
 *   compareTvTrades()      trade-by-trade diff against TradingView's Strategy Tester
 */

/* ============================== ENGINE ============================== */

function btDefaults_() {
  const B = CONFIG.BACKTEST;
  return {
    fillAt: B.fillAt,
    feePct: B.feePct,
    slippagePct: B.slippagePct,
    startingEquity: B.startingEquityUSD,
    maxExposurePct: B.maxExposurePct,
    startIndex: 0,
    endIndex: undefined,
    closeAtEnd: false,     // force-close an open trade on the last bar
    series: null           // pass precomputed indicators to save time
  };
}

function freshState_() {
  return { position: 'FLAT', entryPrice: null, entryTime: null, entryAtr: null,
           stop: null, barsInTrade: 0, lastBarProcessed: 0 };
}

/**
 * Simulate one parameter set over candles[startIndex..endIndex].
 * Returns { trades, equity[], times[], startIndex, endIndex, ... }.
 */
function simulate_(candles, params, opts) {
  const P = params || CONFIG.STRATEGY;
  const O = Object.assign(btDefaults_(), opts || {});
  const series = O.series || computeSeries_(candles, P);
  const start = O.startIndex;
  const end = (O.endIndex === undefined) ? candles.length - 1 : O.endIndex;

  const fee = O.feePct / 100;
  const slip = O.slippagePct / 100;

  let cash = O.startingEquity;
  let units = 0;
  let state = freshState_();
  let pending = null;
  let open = null;
  let totalFees = 0;
  let barsInMarket = 0;

  const trades = [];
  const equity = [];
  const times = [];

  function fill(sig, rawPrice, t, i) {
    if (sig.type === 'ENTRY_LONG') {
      const price = rawPrice * (1 + slip);
      const affordable = cash / (price * (1 + fee));
      const u = Math.min(sig.plannedUnits, affordable);
      if (u <= 0) return;
      const cost = u * price;
      const f = cost * fee;
      const equityBefore = cash;          // flat, so equity == cash
      cash -= cost + f;
      units = u;
      totalFees += f;
      open = {
        entrySignalTime: sig.barTime, entryTime: t, entryBar: i,
        entryPrice: price, units: u, cost: cost, entryFee: f,
        riskBudget: sig.riskBudget, equityBefore: equityBefore,
        stop: sig.stop
      };
    } else {
      if (!open || units <= 0) return;
      const price = rawPrice * (1 - slip);
      const proceeds = units * price;
      const f = proceeds * fee;
      cash += proceeds - f;
      totalFees += f;
      const pnl = (proceeds - f) - (open.cost + open.entryFee);
      trades.push({
        entrySignalTime: open.entrySignalTime,
        entryTime: open.entryTime,
        entryPrice: open.entryPrice,
        exitSignalTime: sig.barTime,
        exitTime: t,
        exitPrice: price,
        units: open.units,
        pnl: pnl,
        pnlPct: pnl / open.equityBefore * 100,          // % of account
        tradePct: (price / open.entryPrice - 1) * 100,  // % move on the position
        r: open.riskBudget > 0 ? pnl / open.riskBudget : 0,
        bars: i - open.entryBar,
        exitType: sig.type,
        fees: open.entryFee + f,
        equityBefore: open.equityBefore
      });
      units = 0;
      open = null;
    }
  }

  for (let i = start; i <= end; i++) {
    const k = candles[i];

    // 1. Orders decided on the previous bar fill at this bar's open.
    if (pending) { fill(pending, k.o, k.t, i); pending = null; }

    // 2. Decide on this bar's close — the exact function the live bot uses.
    if (state.position === 'LONG') state.barsInTrade++;
    const sig = decideAtBar_(candles, series, i, state, P);

    if (sig) {
      if (sig.type === 'ENTRY_LONG') {
        const eqNow = cash + units * k.c;
        const riskBudget = eqNow * (P.riskPerTradePct / 100);
        const perUnitRisk = sig.price - sig.stop;
        const byRisk = perUnitRisk > 0 ? riskBudget / perUnitRisk : 0;
        const byCap = eqNow * (O.maxExposurePct / 100) / sig.price;
        sig.plannedUnits = Math.min(byRisk, byCap);
        sig.riskBudget = riskBudget;
      }
      if (O.fillAt === 'close') fill(sig, k.c, k.t, i);
      else pending = sig;
      applySignal_(state, sig);
    }

    // 3. Force-close on the final bar if asked (walk-forward windows).
    if (i === end && O.closeAtEnd && units > 0) {
      fill({ type: 'EXIT_WINDOW_END', barTime: k.t }, k.c, k.t, i);
    }

    if (units > 0) barsInMarket++;
    equity.push(cash + units * k.c);
    times.push(k.t);
  }

  return {
    trades: trades, equity: equity, times: times,
    startIndex: start, endIndex: end,
    startingEquity: O.startingEquity,
    endEquity: equity[equity.length - 1],
    totalFees: totalFees,
    barsInMarket: barsInMarket,
    openAtEnd: units > 0,
    pendingAtEnd: !!pending
  };
}

/* ============================== METRICS ============================== */

function metrics_(r, candles) {
  const eq = r.equity;
  const n = eq.length;
  const barsPerYear = (365 * 24 * 60) / CONFIG.MARKET.intervalMinutes;
  const years = (candles[r.endIndex].t - candles[r.startIndex].t) / (365.25 * 86400000);

  // Drawdown depth and duration
  let peak = eq[0], maxDD = 0, run = 0, maxDDBars = 0;
  for (let i = 0; i < n; i++) {
    if (eq[i] >= peak) { peak = eq[i]; run = 0; }
    else {
      run++;
      if (run > maxDDBars) maxDDBars = run;
      const dd = (peak - eq[i]) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  }

  // Per-bar returns -> Sharpe / Sortino
  let sum = 0, sumSq = 0, downSq = 0, m = 0;
  for (let i = 1; i < n; i++) {
    const x = eq[i] / eq[i - 1] - 1;
    sum += x; sumSq += x * x; if (x < 0) downSq += x * x; m++;
  }
  const mean = m ? sum / m : 0;
  const std = m > 1 ? Math.sqrt(Math.max(0, (sumSq - m * mean * mean) / (m - 1))) : 0;
  const dstd = m ? Math.sqrt(downSq / m) : 0;

  const t = r.trades;
  const wins = t.filter(x => x.pnl > 0);
  const losses = t.filter(x => x.pnl <= 0);
  const grossWin = wins.reduce((a, x) => a + x.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, x) => a + x.pnl, 0));
  const avg = (arr, f) => arr.length ? arr.reduce((a, x) => a + f(x), 0) / arr.length : 0;

  let streak = 0, worstStreak = 0;
  t.forEach(x => { if (x.pnl <= 0) { streak++; worstStreak = Math.max(worstStreak, streak); } else streak = 0; });

  const endEq = r.endEquity;
  const totalRet = (endEq / r.startingEquity - 1) * 100;
  const cagr = years > 0.05 ? (Math.pow(endEq / r.startingEquity, 1 / years) - 1) * 100 : null;
  const buyHold = (candles[r.endIndex].c / candles[r.startIndex].o - 1) * 100;

  const avgWinPct = avg(wins, x => x.tradePct);
  const avgLossPct = avg(losses, x => x.tradePct);

  return {
    fromUtc: new Date(candles[r.startIndex].t).toISOString().slice(0, 16),
    toUtc: new Date(candles[r.endIndex].t).toISOString().slice(0, 16),
    bars: n,
    years: years,
    startEquity: r.startingEquity,
    endEquity: endEq,
    totalReturnPct: totalRet,
    cagrPct: cagr,
    buyHoldPct: buyHold,
    maxDrawdownPct: maxDD * 100,
    maxDrawdownBars: maxDDBars,
    marRatio: (cagr !== null && maxDD > 0) ? cagr / (maxDD * 100) : null,
    sharpe: std > 0 ? mean / std * Math.sqrt(barsPerYear) : null,
    sortino: dstd > 0 ? mean / dstd * Math.sqrt(barsPerYear) : null,
    trades: t.length,
    winRatePct: t.length ? wins.length / t.length * 100 : null,
    avgWinPct: avgWinPct,
    avgLossPct: avgLossPct,
    payoffRatio: avgLossPct < 0 ? avgWinPct / Math.abs(avgLossPct) : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    expectancyUSD: avg(t, x => x.pnl),
    avgR: avg(t, x => x.r),
    totalR: t.reduce((a, x) => a + x.r, 0),
    avgBarsHeld: avg(t, x => x.bars),
    exposurePct: n ? r.barsInMarket / n * 100 : 0,
    longestLosingStreak: worstStreak,
    totalFeesUSD: r.totalFees,
    feesPctOfStart: r.totalFees / r.startingEquity * 100,
    openAtEnd: r.openAtEnd
  };
}

/** How many bars the indicators need before signals mean anything. */
function warmupBars_(p) {
  const P = p || CONFIG.STRATEGY;
  return Math.max(P.trendEmaPeriod, P.breakoutLookback, P.exitLookback, P.atrPeriod + 1) + 1;
}

/* ============================ SHEET HELPERS ============================ */

function freshSheet_(name) {
  const s = ss_().getSheetByName(name) || ss_().insertSheet(name);
  s.getCharts().forEach(c => s.removeChart(c));
  s.clear();
  s.clearConditionalFormatRules();
  return s;
}

function fmt_(v, dp) {
  if (v === null || v === undefined) return 'n/a';
  if (v === Infinity) return '∞';
  if (typeof v !== 'number') return v;
  return Number(v.toFixed(dp === undefined ? 2 : dp));
}

function utc_(ms) {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

/* ======================= 1. DETAILED BACKTEST ======================= */

function runDetailedBacktest() {
  const candles = loadHistory_();
  const P = CONFIG.STRATEGY;
  const r = simulate_(candles, P, { startIndex: 0 });
  const m = metrics_(r, candles);

  // ---- Summary ----
  const s = freshSheet_('BT_Summary');
  const B = CONFIG.BACKTEST;
  const rows = [
    ['Detailed backtest', ''],
    ['Symbol', CONFIG.MARKET.provider + ' ' + CONFIG.MARKET.symbol + ' ' + CONFIG.MARKET.intervalMinutes + 'm'],
    ['Period (UTC)', m.fromUtc + '  to  ' + m.toUtc],
    ['Bars / years', m.bars + ' bars / ' + fmt_(m.years) + ' yrs'],
    ['Fills', B.fillAt + ', fee ' + B.feePct + '% + slippage ' + B.slippagePct + '% per side'],
    ['Parameters', 'breakout ' + P.breakoutLookback + ', exit ' + P.exitLookback + ', ATR ' + P.atrPeriod +
                   ' x' + P.stopAtrMult + ', EMA ' + P.trendEmaPeriod + ', max bars ' + P.maxBarsInTrade +
                   ', risk ' + P.riskPerTradePct + '%'],
    ['', ''],
    ['RETURNS', ''],
    ['Start equity $', fmt_(m.startEquity)],
    ['End equity $', fmt_(m.endEquity)],
    ['Total return %', fmt_(m.totalReturnPct)],
    ['CAGR %', fmt_(m.cagrPct)],
    ['Buy & hold %', fmt_(m.buyHoldPct)],
    ['', ''],
    ['RISK', ''],
    ['Max drawdown %', fmt_(m.maxDrawdownPct)],
    ['Longest drawdown (bars)', m.maxDrawdownBars + '  (~' + fmt_(m.maxDrawdownBars * CONFIG.MARKET.intervalMinutes / 1440, 0) + ' days)'],
    ['MAR (CAGR / MaxDD)', fmt_(m.marRatio)],
    ['Sharpe (annualised)', fmt_(m.sharpe)],
    ['Sortino (annualised)', fmt_(m.sortino)],
    ['Time in market %', fmt_(m.exposurePct)],
    ['', ''],
    ['TRADES', ''],
    ['Number of trades', m.trades],
    ['Win rate %', fmt_(m.winRatePct)],
    ['Avg win % (position)', fmt_(m.avgWinPct)],
    ['Avg loss % (position)', fmt_(m.avgLossPct)],
    ['Payoff ratio', fmt_(m.payoffRatio)],
    ['Profit factor', fmt_(m.profitFactor)],
    ['Expectancy $ / trade', fmt_(m.expectancyUSD)],
    ['Avg R / trade', fmt_(m.avgR)],
    ['Total R', fmt_(m.totalR)],
    ['Avg bars held', fmt_(m.avgBarsHeld, 1)],
    ['Longest losing streak', m.longestLosingStreak],
    ['', ''],
    ['COSTS', ''],
    ['Total fees paid $ (slippage is inside fill prices)', fmt_(m.totalFeesUSD)],
    ['Fees as % of starting equity', fmt_(m.feesPctOfStart)],
    ['Open position at end', m.openAtEnd ? 'yes (marked to market)' : 'no']
  ];
  s.getRange(1, 1, rows.length, 2).setValues(rows);
  s.getRange('A1').setFontWeight('bold').setFontSize(13);
  ['RETURNS', 'RISK', 'TRADES', 'COSTS'].forEach(h => {
    const idx = rows.findIndex(x => x[0] === h) + 1;
    s.getRange(idx, 1).setFontWeight('bold');
  });
  s.setColumnWidth(1, 260);
  s.setColumnWidth(2, 420);

  // ---- Trades ----
  const t = freshSheet_('BT_Trades');
  const th = ['#', 'Entry signal', 'Entry fill', 'Entry $', 'Exit signal', 'Exit fill', 'Exit $',
              'Units', 'P&L $', 'P&L % acct', 'Move %', 'R', 'Bars', 'Exit type', 'Fees $'];
  const tr = [th].concat(r.trades.map((x, n) => [
    n + 1, utc_(x.entrySignalTime), utc_(x.entryTime), fmt_(x.entryPrice), utc_(x.exitSignalTime),
    utc_(x.exitTime), fmt_(x.exitPrice), fmt_(x.units, 6), fmt_(x.pnl), fmt_(x.pnlPct),
    fmt_(x.tradePct), fmt_(x.r), x.bars, x.exitType, fmt_(x.fees)
  ]));
  t.getRange(1, 1, tr.length, th.length).setValues(tr);
  t.getRange(1, 1, 1, th.length).setFontWeight('bold');
  t.setFrozenRows(1);

  // ---- Equity curve (downsampled to keep the sheet quick) ----
  const e = freshSheet_('BT_Equity');
  const step = Math.max(1, Math.ceil(r.equity.length / 2500));
  const c0 = candles[r.startIndex].o;
  let peak = -Infinity;
  const er = [['Time (UTC)', 'Strategy $', 'Buy & hold $', 'Drawdown %']];
  for (let i = 0; i < r.equity.length; i++) {
    const v = r.equity[i];
    if (v > peak) peak = v;
    if (i % step === 0 || i === r.equity.length - 1) {
      er.push([utc_(r.times[i]), fmt_(v),
               fmt_(r.startingEquity * candles[r.startIndex + i].c / c0),
               fmt_(-(peak - v) / peak * 100)]);
    }
  }
  e.getRange(1, 1, er.length, 4).setValues(er);
  e.getRange(1, 1, 1, 4).setFontWeight('bold');
  e.setFrozenRows(1);

  e.insertChart(e.newChart().setChartType(Charts.ChartType.LINE)
    .addRange(e.getRange(1, 1, er.length, 3))
    .setPosition(2, 6, 0, 0)
    .setOption('title', 'Equity: strategy vs buy & hold')
    .setOption('width', 820).setOption('height', 360)
    .setOption('legend', { position: 'bottom' })
    .build());

  e.insertChart(e.newChart().setChartType(Charts.ChartType.AREA)
    .addRange(e.getRange(1, 1, er.length, 1))
    .addRange(e.getRange(1, 4, er.length, 1))
    .setPosition(22, 6, 0, 0)
    .setOption('title', 'Drawdown % (how far below the last peak)')
    .setOption('width', 820).setOption('height', 240)
    .setOption('legend', { position: 'none' })
    .setOption('colors', ['#A4243B'])
    .build());

  Logger.log('%s trades | return %s%% vs buy&hold %s%% | maxDD %s%% | PF %s | Sharpe %s | fees $%s',
    m.trades, fmt_(m.totalReturnPct), fmt_(m.buyHoldPct), fmt_(m.maxDrawdownPct),
    fmt_(m.profitFactor), fmt_(m.sharpe), fmt_(m.totalFeesUSD));
  if (m.trades < 30) {
    Logger.log('Only %s trades. Treat every number above as an anecdote, not a statistic.', m.trades);
  }
  return m;
}

/* ========================= 2. PARAMETER SWEEP ========================= */

/**
 * Run every combination of breakout lookback x stop multiple.
 *
 * What you're looking for is a PLATEAU: a region where neighbouring settings
 * all do reasonably. A single bright cell surrounded by bad ones is a
 * coincidence that happened to fit this particular history.
 */
function runSweep() {
  const candles = loadHistory_();
  const B = CONFIG.BACKTEST;
  const base = CONFIG.STRATEGY;
  const rowsP = B.sweepBreakout, colsP = B.sweepStopMult;

  const grids = { ret: [], dd: [], trades: [], pf: [], mar: [] };
  const seriesCache = {};
  const t0 = Date.now();

  rowsP.forEach(b => {
    const rRet = [], rDD = [], rT = [], rPF = [], rMar = [];
    colsP.forEach(mult => {
      const p = Object.assign({}, base, { breakoutLookback: b, stopAtrMult: mult });
      const key = b + '|' + p.exitLookback + '|' + p.atrPeriod + '|' + p.trendEmaPeriod;
      if (!seriesCache[key]) seriesCache[key] = computeSeries_(candles, p);
      const r = simulate_(candles, p, { series: seriesCache[key] });
      const m = metrics_(r, candles);
      rRet.push(fmt_(m.totalReturnPct));
      rDD.push(fmt_(m.maxDrawdownPct));
      rT.push(m.trades);
      rPF.push(m.profitFactor === Infinity ? 99 : fmt_(m.profitFactor));
      rMar.push(fmt_(m.marRatio));
    });
    grids.ret.push(rRet); grids.dd.push(rDD); grids.trades.push(rT);
    grids.pf.push(rPF); grids.mar.push(rMar);
  });

  const s = freshSheet_('BT_Sweep');
  let row = 1;
  const block = (title, grid, goodIsHigh) => {
    s.getRange(row, 1).setValue(title).setFontWeight('bold');
    row++;
    const head = [['breakout \\ stop x ATR'].concat(colsP)];
    s.getRange(row, 1, 1, head[0].length).setValues(head).setFontWeight('bold');
    const body = grid.map((g, i) => [rowsP[i]].concat(g));
    s.getRange(row + 1, 1, body.length, body[0].length).setValues(body);
    s.getRange(row + 1, 1, body.length, 1).setFontWeight('bold');

    const rng = s.getRange(row + 1, 2, body.length, colsP.length);
    const rule = SpreadsheetApp.newConditionalFormatRule()
      .setGradientMinpoint(goodIsHigh ? '#E6B8B7' : '#B7D7C9')
      .setGradientMidpointWithValue('#FFFFFF', SpreadsheetApp.InterpolationType.PERCENTILE, '50')
      .setGradientMaxpoint(goodIsHigh ? '#B7D7C9' : '#E6B8B7')
      .setRanges([rng]).build();
    const rules = s.getConditionalFormatRules(); rules.push(rule); s.setConditionalFormatRules(rules);

    // Outline the currently configured cell
    const ri = rowsP.indexOf(base.breakoutLookback), ci = colsP.indexOf(base.stopAtrMult);
    if (ri !== -1 && ci !== -1) {
      s.getRange(row + 1 + ri, 2 + ci).setBorder(true, true, true, true, false, false, '#17202E',
        SpreadsheetApp.BorderStyle.SOLID_THICK);
    }
    row += body.length + 3;
  };

  block('Total return %  (outlined cell = your current settings)', grids.ret, true);
  block('Max drawdown %', grids.dd, false);
  block('MAR ratio (CAGR / max drawdown) — higher is better', grids.mar, true);
  block('Profit factor', grids.pf, true);
  block('Number of trades — low counts mean the numbers above are noise', grids.trades, true);

  // Plateau check for the current cell
  const ri = rowsP.indexOf(base.breakoutLookback), ci = colsP.indexOf(base.stopAtrMult);
  let result = { current: null, neighbours: null, plateau: null,
                 verdict: 'current setting is not in the sweep grid' };
  if (ri !== -1 && ci !== -1) {
    const here = grids.ret[ri][ci];
    const nb = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = ri + dr, cc = ci + dc;
      if (rr >= 0 && rr < rowsP.length && cc >= 0 && cc < colsP.length) nb.push(grids.ret[rr][cc]);
    }
    const nbMean = nb.reduce((a, x) => a + x, 0) / nb.length;
    const verdict = Math.abs(here - nbMean) <= Math.max(5, Math.abs(here) * 0.5)
      ? 'looks like a plateau — neighbours behave similarly'
      : 'looks like a spike — neighbours behave very differently, be suspicious';
    s.getRange(row, 1).setValue('Current setting returns ' + here + '%, neighbours average ' +
      fmt_(nbMean) + '%: ' + verdict);
    Logger.log('Plateau check: current %s%%, neighbours %s%% — %s', here, fmt_(nbMean), verdict);
    result = { current: here, neighbours: fmt_(nbMean), plateau: verdict.indexOf('plateau') !== -1, verdict: verdict };
  }
  s.setColumnWidth(1, 200);
  Logger.log('Sweep of %s combinations done in %ss.', rowsP.length * colsP.length,
             ((Date.now() - t0) / 1000).toFixed(1));
  return result;
}

/* ========================= 3. WALK-FORWARD ========================= */

/**
 * The honest test. For each window:
 *   1. Pick the best parameters using ONLY the training bars.
 *   2. Run those parameters on the next, unseen, test bars.
 *   3. Slide forward and repeat.
 *
 * The stitched-together test results are the closest thing you have to
 * "how would this have done if I'd been running it for real". Compare them
 * to the training results — the gap is how much you were fooling yourself.
 */
function runWalkForward() {
  return walkForward_(loadHistory_(), {});
}

/**
 * The walk-forward engine, for any market's candles. opts: { sheet (default
 * 'BT_WalkForward'), feePct, slippagePct } — costs default to CONFIG.BACKTEST.
 * The live strategy (runWalkForward) and the challenger markets share it.
 */
function walkForward_(candles, opts) {
  const o = opts || {};
  const costs = {};
  if (o.feePct !== undefined) costs.feePct = o.feePct;
  if (o.slippagePct !== undefined) costs.slippagePct = o.slippagePct;
  const B = CONFIG.BACKTEST;
  const base = CONFIG.STRATEGY;
  const T = B.wfTrainBars, S = B.wfTestBars;

  const maxB = Math.max.apply(null, B.sweepBreakout.concat([base.breakoutLookback]));
  const warm = warmupBars_(Object.assign({}, base, { breakoutLookback: maxB }));
  if (candles.length < warm + T + S) {
    throw new Error('Need at least ' + (warm + T + S) + ' bars for walk-forward, have ' +
      candles.length + '. Run buildHistory() first, or shrink wfTrainBars / wfTestBars.');
  }

  const seriesCache = {};
  const seriesFor = p => {
    const key = p.breakoutLookback + '|' + p.exitLookback + '|' + p.atrPeriod + '|' + p.trendEmaPeriod;
    if (!seriesCache[key]) seriesCache[key] = computeSeries_(candles, p);
    return seriesCache[key];
  };
  const rate = (r) => Math.log(r.endEquity / r.startingEquity) / Math.max(1, r.equity.length);
  const score = (m) => m.totalReturnPct / Math.max(m.maxDrawdownPct, 1);   // return per unit of pain

  const folds = [];
  let oosEq = B.startingEquityUSD, fixedEq = B.startingEquityUSD;
  const oosTrades = [];

  for (let trainStart = warm; trainStart + T + S <= candles.length; trainStart += S) {
    const trainEnd = trainStart + T - 1;
    const testStart = trainEnd + 1;
    const testEnd = testStart + S - 1;

    let best = null;
    B.sweepBreakout.forEach(b => B.sweepStopMult.forEach(mult => {
      const p = Object.assign({}, base, { breakoutLookback: b, stopAtrMult: mult });
      const r = simulate_(candles, p, Object.assign({ startIndex: trainStart, endIndex: trainEnd,
                                        series: seriesFor(p), closeAtEnd: true }, costs));
      if (r.trades.length < B.wfMinTrades) return;
      const m = metrics_(r, candles);
      const sc = score(m);
      if (!best || sc > best.score) best = { p: p, r: r, m: m, score: sc };
    }));

    const chosen = best ? best.p : base;
    const test = simulate_(candles, chosen, Object.assign({ startIndex: testStart, endIndex: testEnd,
      series: seriesFor(chosen), closeAtEnd: true, startingEquity: oosEq }, costs));
    const fixed = simulate_(candles, base, Object.assign({ startIndex: testStart, endIndex: testEnd,
      series: seriesFor(base), closeAtEnd: true, startingEquity: fixedEq }, costs));
    const tm = metrics_(test, candles);

    folds.push({
      train: utc_(candles[trainStart].t).slice(0, 10) + ' → ' + utc_(candles[trainEnd].t).slice(0, 10),
      test: utc_(candles[testStart].t).slice(0, 10) + ' → ' + utc_(candles[testEnd].t).slice(0, 10),
      chosen: best ? ('b' + chosen.breakoutLookback + ' / x' + chosen.stopAtrMult) : 'none qualified — used current',
      isRet: best ? best.m.totalReturnPct : null,
      isTrades: best ? best.m.trades : 0,
      isRate: best ? rate(best.r) : null,
      oosRet: tm.totalReturnPct,
      oosTrades: tm.trades,
      oosRate: rate(test),
      fixedRet: (fixed.endEquity / fixed.startingEquity - 1) * 100,
      bhRet: tm.buyHoldPct
    });

    oosEq = test.endEquity;
    fixedEq = fixed.endEquity;
    test.trades.forEach(x => oosTrades.push(x));
  }

  const isRates = folds.filter(f => f.isRate !== null).map(f => f.isRate);
  const oosRates = folds.map(f => f.oosRate);
  const meanOf = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const wfe = meanOf(isRates) !== 0 ? meanOf(oosRates) / meanOf(isRates) * 100 : null;

  const firstTest = warm + T;
  const lastTest = warm + T + folds.length * S - 1;
  const bhAll = (candles[lastTest].c / candles[firstTest].o - 1) * 100;

  const s = freshSheet_(o.sheet || 'BT_WalkForward');
  const head = ['Fold', 'Train window', 'Test window', 'Chosen params', 'Train return %', 'Train trades',
                'Test return %', 'Test trades', 'Fixed-params test %', 'Buy & hold test %'];
  const body = folds.map((f, i) => [i + 1, f.train, f.test, f.chosen, fmt_(f.isRet), f.isTrades,
    fmt_(f.oosRet), f.oosTrades, fmt_(f.fixedRet), fmt_(f.bhRet)]);
  s.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold');
  if (body.length) s.getRange(2, 1, body.length, head.length).setValues(body);
  s.setFrozenRows(1);

  const r0 = body.length + 3;
  const summary = [
    ['Stitched out-of-sample result', ''],
    ['Re-optimised each fold, return %', fmt_((oosEq / B.startingEquityUSD - 1) * 100)],
    ['Current fixed params, return %', fmt_((fixedEq / B.startingEquityUSD - 1) * 100)],
    ['Buy & hold over the same span %', fmt_(bhAll)],
    ['Out-of-sample trades', oosTrades.length],
    ['Walk-forward efficiency %', fmt_(wfe)],
    ['', ''],
    ['How to read it', 'WFE = test performance as a % of training performance. Around 50%+ is respectable. ' +
      'Near 0 or negative means the training results were mostly curve-fit. If "fixed params" beats ' +
      '"re-optimised", re-tuning is hurting you — keep the rules simple and stop tweaking.']
  ];
  s.getRange(r0, 1, summary.length, 2).setValues(summary);
  s.getRange(r0, 1).setFontWeight('bold');

  Logger.log('Walk-forward: %s folds | OOS re-optimised %s%% | OOS fixed %s%% | buy&hold %s%% | WFE %s%%',
    folds.length, fmt_((oosEq / B.startingEquityUSD - 1) * 100),
    fmt_((fixedEq / B.startingEquityUSD - 1) * 100), fmt_(bhAll), fmt_(wfe));
  return {
    folds: folds.length,
    oosReturnPct: (oosEq / B.startingEquityUSD - 1) * 100,
    fixedReturnPct: (fixedEq / B.startingEquityUSD - 1) * 100,
    buyHoldPct: bhAll,
    wfePct: wfe,
    oosTrades: oosTrades.length
  };
}

/* ========================= 4. MONTE CARLO ========================= */

/** Small seeded RNG so results are reproducible run to run. */
function rng_(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pathStats_(rets) {
  let eq = 1, peak = 1, maxDD = 0, streak = 0, worst = 0;
  rets.forEach(x => {
    eq *= (1 + x);
    if (eq > peak) peak = eq;
    maxDD = Math.max(maxDD, (peak - eq) / peak);
    if (x <= 0) { streak++; worst = Math.max(worst, streak); } else streak = 0;
  });
  return { ret: (eq - 1) * 100, dd: maxDD * 100, streak: worst };
}

function pct_(sorted, q) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Two experiments on your real trade list:
 *
 *  SHUFFLE   — same trades, random order. Final return never changes
 *              (multiplication doesn't care about order) but the drawdown
 *              does. Tells you how much of your historical drawdown was luck.
 *
 *  BOOTSTRAP — resample trades with replacement. Some trades appear twice,
 *              some never. Tells you the range of outcomes a strategy with
 *              this trade distribution could plausibly have produced.
 *
 * Both assume trades are independent of each other. Trend-following trades
 * cluster in trending periods, so treat the spread as a minimum, not a max.
 */
function runMonteCarlo() {
  const candles = loadHistory_();
  const base = simulate_(candles, CONFIG.STRATEGY, {});
  const rets = base.trades.map(x => x.pnl / x.equityBefore);
  if (rets.length < 10) {
    throw new Error('Only ' + rets.length + ' trades. Monte Carlo on fewer than ~10 trades is meaningless. ' +
                    'Build more history first.');
  }

  const N = CONFIG.BACKTEST.monteCarloRuns;
  const rand = rng_(42);
  const hist = pathStats_(rets);
  const shufDD = [], shufStreak = [], bootRet = [], bootDD = [];
  let bootLoss = 0, shufWorse = 0;

  for (let i = 0; i < N; i++) {
    const sh = rets.slice();
    for (let j = sh.length - 1; j > 0; j--) {
      const k = Math.floor(rand() * (j + 1));
      const tmp = sh[j]; sh[j] = sh[k]; sh[k] = tmp;
    }
    const a = pathStats_(sh);
    shufDD.push(a.dd); shufStreak.push(a.streak);
    if (a.dd > hist.dd) shufWorse++;

    const bs = [];
    for (let j = 0; j < rets.length; j++) bs.push(rets[Math.floor(rand() * rets.length)]);
    const b = pathStats_(bs);
    bootRet.push(b.ret); bootDD.push(b.dd);
    if (b.ret < 0) bootLoss++;
  }

  [shufDD, shufStreak, bootRet, bootDD].forEach(a => a.sort((x, y) => x - y));

  const s = freshSheet_('BT_MonteCarlo');
  const rows = [
    ['Monte Carlo on ' + rets.length + ' real trades, ' + N + ' runs each (seed 42)', '', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['Measure', 'Historical', '5th pct', 'Median', '95th pct', 'Worst seen'],
    ['Shuffle: max drawdown % (trade-to-trade)', fmt_(hist.dd), fmt_(pct_(shufDD, 0.05)),
     fmt_(pct_(shufDD, 0.5)), fmt_(pct_(shufDD, 0.95)), fmt_(shufDD[shufDD.length - 1])],
    ['Shuffle: longest losing streak', hist.streak, pct_(shufStreak, 0.05), pct_(shufStreak, 0.5),
     pct_(shufStreak, 0.95), shufStreak[shufStreak.length - 1]],
    ['Bootstrap: total return %', fmt_(hist.ret), fmt_(pct_(bootRet, 0.05)), fmt_(pct_(bootRet, 0.5)),
     fmt_(pct_(bootRet, 0.95)), fmt_(bootRet[0])],
    ['Bootstrap: max drawdown %', fmt_(hist.dd), fmt_(pct_(bootDD, 0.05)), fmt_(pct_(bootDD, 0.5)),
     fmt_(pct_(bootDD, 0.95)), fmt_(bootDD[bootDD.length - 1])],
    ['', '', '', '', '', ''],
    ['Chance a shuffled order had a WORSE drawdown than history', fmt_(shufWorse / N * 100) + '%', '', '', '', ''],
    ['Chance a bootstrapped history LOST money', fmt_(bootLoss / N * 100) + '%', '', '', '', ''],
    ['', '', '', '', '', ''],
    ['How to read it', 'Plan for the 95th-percentile drawdown, not the historical one. ' +
      'If you could not sit through that number without switching the bot off, the risk per trade is too high. ' +
      'Drawdowns here are measured trade-to-trade, so real intra-trade drawdowns are deeper.', '', '', '', '']
  ];
  s.getRange(1, 1, rows.length, 6).setValues(rows);
  s.getRange(1, 1).setFontWeight('bold').setFontSize(12);
  s.getRange(3, 1, 1, 6).setFontWeight('bold');
  s.setColumnWidth(1, 380);

  Logger.log('MC: 95th pct drawdown %s%% (historical %s%%) | bootstrap loss chance %s%%',
    fmt_(pct_(shufDD, 0.95)), fmt_(hist.dd), fmt_(bootLoss / N * 100));
  return { trades: rets.length, historicalDD: hist.dd, dd95: pct_(shufDD, 0.95),
           bootDD95: pct_(bootDD, 0.95), lossChancePct: bootLoss / N * 100 };
}

/* =================== 5. COMPARE WITH TRADINGVIEW =================== */

/**
 * Trade-by-trade diff against TradingView's Strategy Tester.
 *
 * 1. On TradingView: chart timezone UTC, same symbol + interval as CONFIG,
 *    add donchian_analyst.pine, match its inputs to CONFIG.STRATEGY.
 * 2. Strategy Tester -> List of trades -> export.
 * 3. File -> Import that file into a new sheet named TV_Trades.
 * 4. Run this. It matches entries by fill time.
 *
 * Differences in the first few hundred bars are expected (indicator warm-up
 * seeds differ slightly). Differences after that are bugs or data mismatches,
 * and finding them is the whole point.
 */
function compareTvTrades() {
  const s = ss_().getSheetByName('TV_Trades');
  if (!s) throw new Error('No sheet named TV_Trades. See the steps in the comment above.');
  const v = s.getDataRange().getValues();
  const head = v[0].map(h => String(h).toLowerCase());
  const typeCol = head.findIndex(h => h.indexOf('type') !== -1);
  const timeCol = head.findIndex(h => h.indexOf('date') !== -1 || h.indexOf('time') !== -1);
  if (typeCol === -1 || timeCol === -1) {
    throw new Error('Could not find Type and Date/Time columns. Headers: ' + head.join(', '));
  }

  const tvEntries = [];
  for (let r = 1; r < v.length; r++) {
    if (String(v[r][typeCol]).toLowerCase().indexOf('entry') === -1) continue;
    const t = parseTvTime_(v[r][timeCol]);
    if (t) tvEntries.push(t);
  }

  const candles = loadHistory_();
  const r = simulate_(candles, CONFIG.STRATEGY, {});
  const warmCut = candles[Math.min(candles.length - 1, 500)].t;
  const firstBar = candles[0].t, lastBar = candles[candles.length - 1].t;

  const ours = r.trades.map(x => x.entryTime).filter(t => t >= warmCut);
  const theirs = tvEntries.filter(t => t >= warmCut && t >= firstBar && t <= lastBar);
  const tol = CONFIG.MARKET.intervalMinutes * 60 * 1000;

  const matched = [], onlyUs = [], onlyTv = theirs.slice();
  ours.forEach(t => {
    const j = onlyTv.findIndex(x => Math.abs(x - t) <= tol);
    if (j !== -1) { matched.push(t); onlyTv.splice(j, 1); } else onlyUs.push(t);
  });

  const out = freshSheet_('BT_Compare');
  const rows = [
    ['Apps Script vs TradingView — entries after the first 500 bars', ''],
    ['Matched', matched.length],
    ['Only in Apps Script', onlyUs.length],
    ['Only in TradingView', onlyTv.length],
    ['Agreement %', fmt_(matched.length / Math.max(1, matched.length + onlyUs.length + onlyTv.length) * 100)],
    ['', ''],
    ['Only in Apps Script (first 20)', onlyUs.slice(0, 20).map(utc_).join('\n')],
    ['Only in TradingView (first 20)', onlyTv.slice(0, 20).map(utc_).join('\n')],
    ['', ''],
    ['If agreement is low', 'Check in order: (1) same exchange + symbol, (2) chart timezone set to UTC ' +
      'before export, (3) identical inputs, (4) same fee settings, (5) the history ranges overlap.']
  ];
  out.getRange(1, 1, rows.length, 2).setValues(rows);
  out.getRange(1, 1).setFontWeight('bold');
  out.setColumnWidth(1, 320); out.setColumnWidth(2, 420);
  Logger.log('Matched %s | only Apps Script %s | only TradingView %s', matched.length, onlyUs.length, onlyTv.length);
}

/* ================= 7. LIVE PAPER vs BACKTEST (live decay) ================= */

/**
 * Backtest exactly the period the paper account has been running, with the
 * paper account's own fee and slippage settings, and compare.
 *
 * The gap between the two is "live decay": what reality costs you that the
 * backtest didn't model. Run buildHistory() first so History includes the
 * recent bars — otherwise the backtest can't see the live period.
 */
function compareLiveVsBacktest() {
  const acct = getPaper_();
  const candles = loadHistory_();
  const ivMs = CONFIG.MARKET.intervalMinutes * 60 * 1000;

  const startIdx = candles.findIndex(k => k.t >= acct.startedAt);
  if (startIdx === -1) {
    throw new Error('History ends before the paper account started. Run buildHistory() to refresh it.');
  }
  if (startIdx < warmupBars_()) {
    throw new Error('Not enough history before the paper start for indicators to warm up. ' +
                    'Increase BACKTEST.historyDays and run buildHistory().');
  }
  const lastBar = candles[candles.length - 1];
  if (Date.now() - lastBar.t > 3 * ivMs) {
    Logger.log('Note: History is %s bars old. Run buildHistory() for a fair comparison.',
               Math.round((Date.now() - lastBar.t) / ivMs));
  }

  const P = CONFIG.PAPER;
  const r = simulate_(candles, CONFIG.STRATEGY, {
    startIndex: startIdx, startingEquity: P.startingEquityUSD,
    feePct: P.feePct, slippagePct: P.slippagePct, maxExposurePct: P.maxExposurePct
  });
  const m = metrics_(r, candles);
  const live = paperStatus_(lastBar.c);
  const days = (lastBar.t - candles[startIdx].t) / 86400000;

  const s = freshSheet_('BT_LiveVsBacktest');
  const rows = [
    ['Paper account vs backtest of the same period', '', ''],
    ['Period (UTC)', utc_(candles[startIdx].t) + '  to  ' + utc_(lastBar.t), fmt_(days, 0) + ' days'],
    ['', 'Backtest', 'Paper (live)'],
    ['Closed trades', m.trades, live.trades],
    ['Return %', fmt_(m.totalReturnPct), fmt_(live.returnPct)],
    ['Equity $', fmt_(m.endEquity), fmt_(live.equity)],
    ['Fees $', fmt_(m.totalFeesUSD), fmt_(live.feesPaid)],
    ['', '', ''],
    ['Live decay (paper minus backtest), % points', fmt_(live.returnPct - m.totalReturnPct), ''],
    ['', '', ''],
    ['How to read it', 'Different trade counts = a signal was missed or doubled: check the Log and Crosscheck ' +
      'sheets. Same trades but lower return = fills were worse than modelled: raise PAPER/BACKTEST slippagePct ' +
      'until the backtest matches reality, and re-run every backtest with the honest number.', '']
  ];
  s.getRange(1, 1, rows.length, 3).setValues(rows);
  s.getRange(1, 1).setFontWeight('bold').setFontSize(12);
  s.getRange(3, 1, 1, 3).setFontWeight('bold');
  s.setColumnWidth(1, 340); s.setColumnWidth(2, 360); s.setColumnWidth(3, 160);

  Logger.log('Same period: backtest %s trades %s%% | paper %s trades %s%% | decay %s pts',
    m.trades, fmt_(m.totalReturnPct), live.trades, fmt_(live.returnPct), fmt_(live.returnPct - m.totalReturnPct));
  return { days: days, btTrades: m.trades, btReturnPct: m.totalReturnPct,
           paperTrades: live.trades, paperReturnPct: live.returnPct,
           decayPts: live.returnPct - m.totalReturnPct };
}