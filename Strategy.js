/**
 * Strategy.gs — the deterministic core.
 *
 * RULES (long-only, v1)
 *   Regime : close > EMA(100)                         -> longs allowed
 *   Entry  : close > highest high of prior 20 bars
 *   Stop   : entry - (2.0 x ATR at entry)             -> checked on bar CLOSE
 *   Exit   : close < lowest low of prior 10 bars
 *   Time   : force exit after 60 bars in trade
 *
 * The LLM has no vote here. Same candles in, same signal out, every time.
 * That is what makes the journal in Journal.gs worth anything.
 */

/**
 * Build the indicator series once, so live runs, the quick backtest and the
 * detailed backtester (Backtest.gs) all share exactly one code path.
 * `params` is optional and defaults to CONFIG.STRATEGY — the sweep and
 * walk-forward tests pass their own.
 */
function computeSeries_(candles, params) {
  const S = params || CONFIG.STRATEGY;
  const closes = candles.map(k => k.c);
  return {
    ema:   ema_(closes, S.trendEmaPeriod),
    atr:   atr_(candles, S.atrPeriod),
    entry: donchian_(candles, S.breakoutLookback),
    exit:  donchian_(candles, S.exitLookback),
    volAvg: priorAverage_(candles.map(k => k.v), S.breakoutLookback)
  };
}

/** Average of the PRIOR n values (current bar excluded, same rule as the channel). */
function priorAverage_(values, n) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i >= n) out[i] = sum / n;
    sum += values[i];
    if (i >= n) sum -= values[i - n];
  }
  return out;
}

/**
 * Optional entry filters, all OFF by default so the live strategy and the
 * Pine script behave exactly as before. The research lab (Lab.gs) switches
 * them on in experiments. If one is ever promoted to live, the Pine script
 * needs the same filter added, or the TradingView cross-check will flag it.
 *
 * Returns null when the entry is allowed, or the reason it was blocked.
 */
function entryBlockedBy_(candles, series, i, S) {
  const k = candles[i];
  if (S.skipWeekendEntries) {
    const d = new Date(k.t).getUTCDay();
    if (d === 0 || d === 6) return 'weekend';
  }
  if (S.minVolumeRatio > 0) {
    const avg = series.volAvg ? series.volAvg[i] : null;
    if (avg === null || avg <= 0 || k.v < S.minVolumeRatio * avg) return 'volume';
  }
  const atrPct = series.atr[i] / k.c * 100;
  if (S.minAtrPct > 0 && atrPct < S.minAtrPct) return 'too quiet';
  if (S.maxAtrPct > 0 && atrPct > S.maxAtrPct) return 'too wild';
  return null;
}

/**
 * Decide what to do at bar index i, given the current position state.
 * Returns null (do nothing) or a signal object.
 *
 * `state` is mutated by the caller, not here — this stays a pure decision.
 */
function decideAtBar_(candles, series, i, state, params) {
  const S = params || CONFIG.STRATEGY;
  const k = candles[i];
  const ema = series.ema[i];
  const atr = series.atr[i];
  const upper = series.entry.upper[i];
  const lower = series.exit.lower[i];

  if (ema === null || atr === null || upper === null || lower === null) return null;

  if (state.position === 'FLAT') {
    const breakout = k.c > upper;
    const inUptrend = k.c > ema;

    if (breakout && inUptrend && !entryBlockedBy_(candles, series, i, S)) {
      const stop = k.c - (S.stopAtrMult * atr);
      const riskPerUnit = k.c - stop;
      const riskBudget = S.accountSizeUSD * (S.riskPerTradePct / 100);
      return {
        type: 'ENTRY_LONG',
        barTime: k.t,
        price: k.c,
        stop: stop,
        atr: atr,
        ema: ema,
        channelHigh: upper,
        units: riskPerUnit > 0 ? riskBudget / riskPerUnit : 0,
        reason: 'Close ' + k.c.toFixed(2) + ' broke ' + S.breakoutLookback +
                '-bar high ' + upper.toFixed(2) + ' while above EMA' +
                S.trendEmaPeriod + ' (' + ema.toFixed(2) + ')'
      };
    }
    return null;
  }

  // ---- in a LONG ----
  if (k.c <= state.stop) {
    return exitSignal_('EXIT_STOP', k, state,
      'Close ' + k.c.toFixed(2) + ' at or below stop ' + state.stop.toFixed(2));
  }
  if (k.c < lower) {
    return exitSignal_('EXIT_CHANNEL', k, state,
      'Close ' + k.c.toFixed(2) + ' below ' + S.exitLookback +
      '-bar low ' + lower.toFixed(2));
  }
  if (state.barsInTrade >= S.maxBarsInTrade) {
    return exitSignal_('EXIT_TIME', k, state,
      'Held ' + state.barsInTrade + ' bars, past the ' + S.maxBarsInTrade + '-bar limit');
  }
  return null;
}

function exitSignal_(type, k, state, reason) {
  return {
    type: type,
    barTime: k.t,
    price: k.c,
    entryPrice: state.entryPrice,
    pnlPct: pctChange_(state.entryPrice, k.c),
    rMultiple: (k.c - state.entryPrice) / (state.entryPrice - state.stop),
    barsHeld: state.barsInTrade,
    reason: reason
  };
}

/** Apply a signal to state. Shared by live runs and the backtester. */
function applySignal_(state, sig) {
  if (sig.type === 'ENTRY_LONG') {
    state.position = 'LONG';
    state.entryPrice = sig.price;
    state.entryTime = sig.barTime;
    state.entryAtr = sig.atr;
    state.stop = sig.stop;
    state.barsInTrade = 0;
  } else {
    state.position = 'FLAT';
    state.entryPrice = null;
    state.entryTime = null;
    state.entryAtr = null;
    state.stop = null;
    state.barsInTrade = 0;
  }
  return state;
}

/**
 * QUICK BACKTEST — signal-to-signal, no fees, fills at the signal close.
 * Good for a 5-second sanity check. For anything you'd actually believe,
 * use runDetailedBacktest() in Backtest.gs.
 *
 * Read the output before you trust a single live signal. If the edge isn't
 * visible here it does not exist, and fees and slippage aren't even modelled.
 */
function backtest() {
  const candles = fetchCandles_();
  const series = computeSeries_(candles);

  let state = {
    position: 'FLAT', entryPrice: null, entryTime: null,
    entryAtr: null, stop: null, barsInTrade: 0
  };

  const trades = [];
  let open = null;

  for (let i = 0; i < candles.length; i++) {
    if (state.position === 'LONG') state.barsInTrade++;

    const sig = decideAtBar_(candles, series, i, state);
    if (!sig) continue;

    if (sig.type === 'ENTRY_LONG') {
      open = { entryTime: sig.barTime, entryPrice: sig.price, stop: sig.stop };
    } else if (open) {
      trades.push({
        entryTime: open.entryTime,
        exitTime: sig.barTime,
        entryPrice: open.entryPrice,
        exitPrice: sig.price,
        pnlPct: sig.pnlPct,
        r: sig.rMultiple,
        bars: sig.barsHeld,
        exit: sig.type
      });
      open = null;
    }
    state = applySignal_(state, sig);
  }

  if (!trades.length) {
    Logger.log('No completed trades in %s candles. Loosen the filters or fetch more history.',
               candles.length);
    return;
  }

  const wins = trades.filter(t => t.pnlPct > 0);
  const avgR = trades.reduce((a, t) => a + t.r, 0) / trades.length;
  const totalR = trades.reduce((a, t) => a + t.r, 0);

  let equity = 100;
  const curve = [equity];
  trades.forEach(t => { equity *= (1 + t.pnlPct / 100); curve.push(equity); });

  const first = Utilities.formatDate(new Date(candles[0].t), CONFIG.TZ, 'yyyy-MM-dd');
  const last  = Utilities.formatDate(new Date(candles[candles.length - 1].t), CONFIG.TZ, 'yyyy-MM-dd');

  Logger.log('=== BACKTEST %s %sm | %s to %s ===',
             CONFIG.MARKET.symbol, CONFIG.MARKET.intervalMinutes, first, last);
  Logger.log('Trades: %s   Win rate: %s%%   Avg R: %s   Total R: %s',
    trades.length,
    ((wins.length / trades.length) * 100).toFixed(1),
    avgR.toFixed(2),
    totalR.toFixed(2));
  Logger.log('Buy-and-hold: %s%%   Strategy: %s%%   Max DD: %s%%',
    pctChange_(candles[0].c, candles[candles.length - 1].c).toFixed(1),
    (equity - 100).toFixed(1),
    maxDrawdownPct_(curve).toFixed(1));
  Logger.log('Avg bars held: %s',
    (trades.reduce((a, t) => a + t.bars, 0) / trades.length).toFixed(1));

  trades.forEach((t, n) => {
    Logger.log('#%s %s -> %s | %s%% | %sR | %s',
      n + 1,
      Utilities.formatDate(new Date(t.entryTime), CONFIG.TZ, 'MM-dd HH:mm'),
      Utilities.formatDate(new Date(t.exitTime), CONFIG.TZ, 'MM-dd HH:mm'),
      t.pnlPct.toFixed(2), t.r.toFixed(2), t.exit);
  });

  Logger.log('Reminder: no fees, no slippage, one symbol, one parameter set. ' +
             'Treat this as a sanity check, not evidence.');
}