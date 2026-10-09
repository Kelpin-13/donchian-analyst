/**
 * Challenger.gs — the same rules on several markets, as separate paper books.
 *
 * Why: BTC alone gives 2-3 signals a month. The same 4h rules on several
 * markets give a few a week, and a result after one month says more when it
 * comes from many trades in many markets. The live strategy is untouched.
 *
 * Same rules, different inputs: every market calls decideAtBar_() with
 * CONFIG.STRATEGY + CONFIG.CHALLENGER.overrides. No second copy of the rules.
 * Each market has its own position state (CH_STATE_<ID>), its own $1,000
 * paper book (CH_PAPER_<ID>) and its own start point (CH_START_<ID>).
 * Rows go to the shared MM_Trades / MM_Equity sheets with a Market column.
 * No agent notes, no AI gate, no alerts — paper and log only.
 *
 * Data: Twelve Data for gold and forex (TWELVEDATA_API_KEY), Coinbase for crypto,
 * OANDA v20 as an option (OANDA_API_KEY; not available to OANDA Global Markets accounts).
 * Each market can set its own feePct / slippagePct (gold and FX are spread-only).
 * Changing the challenger's name, interval or overrides starts a new
 * comparison; adding a market (e.g. switching gold on) only adds a book.
 */

const CH_TRADES_SHEET = 'MM_Trades';
const CH_EQUITY_SHEET = 'MM_Equity';
const CH_BACKTEST_SHEET = 'MM_Backtest';
const CH_WF_SHEET = 'MM_WalkForward';

function challengerParams_() {
  return Object.assign({}, CONFIG.STRATEGY, CONFIG.CHALLENGER.overrides || {});
}

function chBook_(m) {
  return { stateKey: 'CH_PAPER_' + m.id, tradesSheet: CH_TRADES_SHEET, equitySheet: CH_EQUITY_SHEET, tag: m.id,
           feePct: m.feePct, slippagePct: m.slippagePct };
}

/** Backtest/walk-forward options carrying this market's own costs and swap. */
function chCostOpts_(m) {
  const o = {};
  ['feePct', 'slippagePct', 'swapLongPctYear', 'swapDays', 'rolloverHourUtc']
    .forEach(key => { if (m[key] !== undefined) o[key] = m[key]; });
  o.barMs = CONFIG.CHALLENGER.intervalMinutes * 60000;
  return o;
}

/** Script Property each provider needs, if any. */
const CH_PROVIDER_KEYS = { oanda: 'OANDA_API_KEY', twelvedata: 'TWELVEDATA_API_KEY' };
function chHasKey_(m) { return !CH_PROVIDER_KEYS[m.provider] || !!secret_(CH_PROVIDER_KEYS[m.provider], false); }

function chGet_(key) {
  const raw = PropertiesService.getScriptProperties().getProperty(key);
  return raw ? JSON.parse(raw) : null;
}

function chSet_(key, v) {
  PropertiesService.getScriptProperties().setProperty(key, JSON.stringify(v));
}

/** Enabled markets whose data source is usable right now. */
function chActiveMarkets_() {
  return (CONFIG.CHALLENGER.markets || []).filter(m => m.enabled && chHasKey_(m));
}

/* ---------------- data ---------------- */

/** Closed candles for one market, oldest first. */
function chCandles_(m, intervalMinutes, count, params) {
  const size = intervalMinutes * 60 * 1000;
  let candles;
  if (m.provider === 'coinbase') {
    const gran = coinbaseBaseGran_(intervalMinutes);
    const startMs = Math.floor((Date.now() - (count + 2) * size) / size) * size;   // bucket-aligned start
    const raw = fetchCoinbaseRange_(m.symbol, gran, startMs, Date.now());
    candles = (gran === intervalMinutes * 60) ? raw : aggregateCandles_(raw, intervalMinutes);
  } else if (m.provider === 'oanda') {
    candles = oandaCandles_(m.symbol, intervalMinutes, { count: count + 1 });
  } else if (m.provider === 'twelvedata') {
    candles = twelveCandles_(m.symbol, intervalMinutes, count + 1);
  } else {
    throw new Error('Unknown challenger provider: ' + m.provider);
  }
  candles = candles
    .filter(k => Number.isFinite(k.c) && k.c > 0 && k.t + size <= Date.now())   // closed bars only
    .sort((a, b) => a.t - b.t)
    .slice(-count);
  const need = params.trendEmaPeriod + params.breakoutLookback + 5;
  if (candles.length < need) throw new Error(m.id + ': only ' + candles.length + ' closed candles, need ' + need);
  return candles;
}

/** Latest price, for paper fills. */
function chPrice_(m) {
  if (m.provider === 'coinbase') {
    return Number(httpJson_('https://api.exchange.coinbase.com/products/' + encodeURIComponent(m.symbol) + '/ticker').price);
  }
  if (m.provider === 'oanda') {
    const last = oandaCandles_(m.symbol, 0, { count: 1, includeOpen: true });
    if (!last.length) throw new Error('OANDA returned no price');
    return last[last.length - 1].c;
  }
  if (m.provider === 'twelvedata') {
    const p = Number(twelveGet_('/price', { symbol: m.symbol }).price);
    if (!(p > 0)) throw new Error('Twelve Data returned no price for ' + m.symbol);
    return p;
  }
  throw new Error('Unknown challenger provider: ' + m.provider);
}

/**
 * Twelve Data REST call. The key goes in a header, not the URL, so it never lands in logs.
 * Errors come back as HTTP 200 with {status: "error"} as well as real HTTP errors.
 */
function twelveGet_(path, params) {
  const q = Object.keys(params).map(k => k + '=' + encodeURIComponent(params[k])).join('&');
  const res = UrlFetchApp.fetch(CONFIG.TWELVEDATA.host + path + '?' + q, {
    muteHttpExceptions: true,
    headers: { 'Authorization': 'apikey ' + secret_('TWELVEDATA_API_KEY', true) }
  });
  let body = null;
  try { body = JSON.parse(res.getContentText()); } catch (e) {}
  if (res.getResponseCode() !== 200 || !body || body.status === 'error') {
    throw new Error('Twelve Data ' + ((body && body.code) || res.getResponseCode()) + ': ' +
                    String((body && body.message) || res.getContentText()).slice(0, 200));
  }
  return body;
}

/** Twelve Data candles, oldest first, times in UTC. The newest bar may still be forming. */
function twelveCandles_(symbol, intervalMinutes, count) {
  const iv = { 60: '1h', 240: '4h', 1440: '1day' }[intervalMinutes];
  if (!iv) throw new Error('Twelve Data: unsupported interval ' + intervalMinutes + 'm');
  const body = twelveGet_('/time_series', { symbol: symbol, interval: iv, outputsize: Math.min(5000, count),
                                            timezone: 'UTC', order: 'ASC' });
  return (body.values || []).map(v => {
    const d = String(v.datetime);
    return { t: Date.parse(d.length <= 10 ? d + 'T00:00:00Z' : d.replace(' ', 'T') + 'Z'),
             o: Number(v.open), h: Number(v.high), l: Number(v.low), c: Number(v.close), v: Number(v.volume) || 0 };
  }).filter(k => Number.isFinite(k.t));
}

/**
 * OANDA v20 candles (mid prices). intervalMinutes 0 = 5-second bars (used for
 * the latest price). 4h bars are aligned to 00/04/08… UTC like the crypto feed.
 * Gold trades 24/5: there are no weekend bars. opts: {count} or {fromMs, count};
 * includeOpen keeps the still-forming bar.
 */
function oandaCandles_(instrument, intervalMinutes, opts) {
  const G = { 0: 'S5', 60: 'H1', 240: 'H4', 1440: 'D' }[intervalMinutes];
  if (!G) throw new Error('OANDA: unsupported interval ' + intervalMinutes + 'm');
  const q = ['price=M', 'granularity=' + G, 'count=' + Math.min(5000, opts.count || 500),
             'alignmentTimezone=UTC', 'dailyAlignment=0'];
  if (opts.fromMs) q.push('from=' + Math.floor(opts.fromMs / 1000));
  const res = UrlFetchApp.fetch(CONFIG.OANDA.host + '/v3/instruments/' + encodeURIComponent(instrument) +
                                '/candles?' + q.join('&'), {
    muteHttpExceptions: true,
    headers: { 'Authorization': 'Bearer ' + secret_('OANDA_API_KEY', true), 'Accept-Datetime-Format': 'UNIX' }
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('OANDA HTTP ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 200));
  }
  return (JSON.parse(res.getContentText()).candles || [])
    .filter(c => opts.includeOpen || c.complete)
    .map(c => ({ t: Math.round(Number(c.time) * 1000), o: Number(c.mid.o), h: Number(c.mid.h),
                 l: Number(c.mid.l), c: Number(c.mid.c), v: Number(c.volume) || 0 }));
}

/* ---------------- the run ---------------- */

/** A new name, interval or overrides means a new comparison: clear every CH_ property. */
function chVersionCheck_() {
  const C = CONFIG.CHALLENGER;
  const version = JSON.stringify({ name: C.name, iv: C.intervalMinutes, o: C.overrides || {} });
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('CH_VERSION') === version) return;
  Object.keys(props.getProperties()).filter(k => k.indexOf('CH_') === 0).forEach(k => props.deleteProperty(k));
  props.setProperty('CH_VERSION', version);
  logLine_('INFO', 'Challenger settings changed: new comparison started (' + C.name + ')');
}

/** Trigger: every 15 min. Each market acts once per closed candle. */
function runChallenger() {
  const C = CONFIG.CHALLENGER;
  if (!C || !C.enabled) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;   // the live monitor is running; try again next time

  try {
    chVersionCheck_();
    const t0 = Date.now();
    const P = challengerParams_();
    const skipped = [];
    chActiveMarkets_().forEach(m => {
      if (Date.now() - t0 > 4 * 60 * 1000) { skipped.push(m.id); return; }   // stay inside the 6-min limit
      try { chRunMarket_(m, P); }
      catch (e) { logLine_('ERROR', 'Challenger ' + m.id + ': ' + e.message); }
    });
    if (skipped.length) logLine_('WARN', 'Challenger out of time, skipped ' + skipped.join(', ') + ' (next run catches up)');
  } finally {
    lock.releaseLock();
  }
}

function chRunMarket_(m, P) {
  const C = CONFIG.CHALLENGER;
  const ivMs = C.intervalMinutes * 60 * 1000;
  const key = 'CH_STATE_' + m.id;
  const state = chGet_(key) || Object.assign(freshState_(), { lastBarProcessed: 0 });
  const now = Date.now();
  if (state.lastBarProcessed && now < state.lastBarProcessed + 2 * ivMs) return;   // no new bar can have closed
  if (state.retryAt && now < state.retryAt) return;                                 // e.g. gold over the weekend

  const candles = chCandles_(m, C.intervalMinutes, C.candlesToFetch, P);
  const i = candles.length - 1;
  const last = candles[i];
  if (last.t <= state.lastBarProcessed) {         // market closed or bar late: check again in 30 min
    state.retryAt = now + 30 * 60 * 1000;
    chSet_(key, state);
    return;
  }
  chStart_(m, last.c);

  const series = computeSeries_(candles, P);
  // Held through this bar? Then pay its overnight swap first (same rule as the backtest).
  const held = getPaper_(chBook_(m)).units;
  const sw = swapForBar_(last, held, Object.assign(btDefaults_(), chCostOpts_(m)));
  if (sw) paperChargeSwap_(chBook_(m), sw);
  if (state.position === 'LONG') state.barsInTrade++;
  const sig = decideAtBar_(candles, series, i, state, P);
  if (sig) applySignal_(state, sig);
  state.lastBarProcessed = last.t;
  state.lastClose = last.c;
  state.retryAt = 0;
  chSet_(key, state);    // commit before the paper fill, same order as the live monitor

  if (sig) {
    logLine_('SIGNAL', 'CHALLENGER ' + m.id + ' ' + sig.type + ' @ ' + round_(sig.price));
    let px = null;
    try { px = chPrice_(m); } catch (e) { logLine_('WARN', 'Challenger ' + m.id + ' price: ' + e.message); }
    paperOnSignal_(sig, chBook_(m), P.riskPerTradePct, px || sig.price);
  }
  paperSnapshot_(last.t, last.c, chBook_(m));
}

/** First bar for a market: remember its price. First bar overall: also the live account's equity. */
function chStart_(m, price) {
  if (!chGet_('CH_START')) {
    let live = null;
    try { live = fetchTickerPrice_(); } catch (e) {}
    chSet_('CH_START', { at: Date.now(), liveEquity: paperStatus_(live).equity });
    logLine_('INFO', 'Challenger started: ' + CONFIG.CHALLENGER.name);
  }
  if (!chGet_('CH_START_' + m.id)) chSet_('CH_START_' + m.id, { at: Date.now(), price: price });
}

/* ---------------- reporting ---------------- */

/** Live account vs every challenger market, all measured from their own start. */
function challengerCompare_(livePrice) {
  const C = CONFIG.CHALLENGER;
  const start = C && C.enabled ? chGet_('CH_START') : null;
  if (!start) return null;
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

  const markets = (C.markets || []).filter(m => m.enabled).map(m => {
    const st = chGet_('CH_STATE_' + m.id), ms = chGet_('CH_START_' + m.id);
    if (!st || !ms) return { id: m.id, waiting: true, note: chHasKey_(m) ? 'starts at its next closed bar' : 'needs ' + CH_PROVIDER_KEYS[m.provider] };
    const s = paperStatus_(st.lastClose, chBook_(m));
    return { id: m.id, returnPct: s.returnPct, trades: s.trades, wins: s.trades ? Math.round(s.winRate * s.trades / 100) : 0,
             winRate: s.winRate, drawdownPct: s.drawdownPct, fees: s.feesPaid, position: st.position,
             buyHoldPct: (st.lastClose / ms.price - 1) * 100 };
  });
  const run = markets.filter(x => !x.waiting);
  const trades = run.reduce((a, x) => a + x.trades, 0), wins = run.reduce((a, x) => a + x.wins, 0);
  const live = paperStatus_(livePrice || null);

  return {
    name: C.name,
    days: (Date.now() - start.at) / 86400000,
    startedAt: start.at,
    live: { label: 'Current (BTC ' + CONFIG.MARKET.intervalMinutes / 60 + 'h, ' + CONFIG.STRATEGY.breakoutLookback + '/' +
                   CONFIG.STRATEGY.exitLookback + ')',
            returnPct: start.liveEquity ? (live.equity / start.liveEquity - 1) * 100 : null, position: getState_().position },
    total: { label: 'Challenger: ' + C.name + ' (equal split)', returnPct: avg(run.map(x => x.returnPct)),
             trades: trades, winRate: trades ? wins / trades * 100 : null,
             drawdownPct: run.length ? Math.max.apply(null, run.map(x => x.drawdownPct)) : null,
             fees: run.reduce((a, x) => a + x.fees, 0),
             position: run.filter(x => x.position === 'LONG').length + ' of ' + run.length + ' long' },
    markets: markets,
    buyHoldPct: avg(run.map(x => x.buyHoldPct))
  };
}

/** Menu: Live → Challenger vs current. */
function showChallengerReport() {
  let price = null;
  try { price = fetchTickerPrice_(); } catch (e) {}
  const r = challengerCompare_(price);
  const p = v => v === null || v === undefined ? '—' : (v >= 0 ? '+' : '') + round_(v) + '%';
  let msg;
  if (!r) {
    msg = 'The challenger hasn\'t run yet. Run setup() once to install its trigger, or run runChallenger by hand.';
  } else {
    msg = 'Running ' + round_(r.days) + ' days, since ' + Utilities.formatDate(new Date(r.startedAt), CONFIG.TZ, 'dd MMM yyyy HH:mm') + '\n\n' +
      r.live.label + ': ' + p(r.live.returnPct) + '  (now ' + r.live.position + ')\n' +
      r.total.label + ': ' + p(r.total.returnPct) + '  (' + r.total.position + ')\n' +
      '   ' + r.total.trades + ' closed trades' + (r.total.winRate === null ? '' : ', ' + round_(r.total.winRate) + '% won') +
      ', fees $' + round_(r.total.fees) + '\n' +
      'Buy & hold, same markets: ' + p(r.buyHoldPct) + '\n\nBy market:\n' +
      r.markets.map(x => '  ' + x.id + ': ' + (x.waiting ? x.note
        : p(x.returnPct) + ', ' + x.trades + ' trades, now ' + x.position + ', buy & hold ' + p(x.buyHoldPct))).join('\n') +
      '\n\nOne month is a small sample. Judge the total over many trades, not one market or one week.';
  }
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Challenger vs current', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
}

/** Menu: Reset → Challenger. Starts the comparison over (the next run starts fresh). */
function resetChallenger() {
  const props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).filter(k => k.indexOf('CH_') === 0).forEach(k => props.deleteProperty(k));
  logLine_('INFO', 'Challenger reset');
}

/* ---------------- walk-forward per market ---------------- */

/**
 * Menu: Live → Challenger: walk-forward test. Runs the same walk-forward engine
 * as the live strategy (walkForward_) on every enabled challenger market, with
 * that market's own costs. Folds go to WF_<ID>; one summary row per market per
 * run goes to MM_WalkForward, with the same pass rule as the weekly backtest:
 * the current settings must not lose money on unseen data, and walk-forward
 * efficiency must reach BACKTEST.minWfePct.
 */
function challengerWalkForward() {
  const C = CONFIG.CHALLENGER, B = CONFIG.BACKTEST, P = challengerParams_();
  const headers = ['Run at', 'Market', 'Bars', 'Folds', 'Unseen trades', 'Unseen return, current settings %',
                   'Unseen return, re-tuned each fold %', 'Buy & hold, same span %', 'Walk-forward efficiency %',
                   'Verdict', 'Why'];
  const sum = sheet_(CH_WF_SHEET, headers);
  const markets = (C.markets || []).filter(m => m.enabled);
  const lines = [];
  if (!markets.length) lines.push('No challenger market is switched on.');

  markets.forEach(m => {
    if (!chHasKey_(m)) { lines.push(m.id + ': skipped, add ' + CH_PROVIDER_KEYS[m.provider]); return; }
    try {
      const candles = chHistory_(m, C.intervalMinutes, P);
      const wf = walkForward_(candles, Object.assign({ sheet: 'WF_' + m.id }, chCostOpts_(m)));
      const why = [];
      if (wf.fixedReturnPct < 0) why.push('loses money on unseen data');
      if (wf.wfePct === null || wf.wfePct < B.minWfePct) why.push('walk-forward efficiency ' + (wf.wfePct === null ? 'n/a' : Math.round(wf.wfePct) + '%') + ' is below ' + B.minWfePct + '% — likely curve-fit');
      if (wf.folds < 4) why.push('only ' + wf.folds + ' folds — too few to trust');
      const verdict = !why.length ? 'HOLDS UP' : (wf.fixedReturnPct < 0 || wf.wfePct === null || wf.wfePct < B.minWfePct ? 'FAILS ON NEW DATA' : 'FRAGILE');
      const n = v => v === null || v === undefined || !isFinite(v) ? '' : round_(v);
      const up = (wf.fixedFoldReturns || []).filter(x => x > 0).length;
      const tuning = wf.fixedReturnPct >= wf.oosReturnPct ? 're-tuning did not help (keep the settings as they are)' : 're-tuning helped a little';
      sum.appendRow([new Date(), m.id, candles.length, wf.folds, wf.oosTrades, n(wf.fixedReturnPct), n(wf.oosReturnPct),
                     n(wf.buyHoldPct), n(wf.wfePct), verdict, why.join('; ') ||
                     ('made money on unseen data overall; ' + up + ' of ' + wf.folds + ' unseen stretches positive; ' + tuning)]);
      lines.push(m.id + ': ' + verdict + ' — unseen-data return ' + n(wf.fixedReturnPct) + '% over ' + wf.folds +
                 ' folds (' + wf.oosTrades + ' trades), WFE ' + n(wf.wfePct) + '%, buy & hold ' + n(wf.buyHoldPct) + '%');
    } catch (e) {
      lines.push(m.id + ': error — ' + e.message);
    }
  });

  const msg = lines.join('\n') + '\n\nFold-by-fold detail: the WF_<market> sheets. Summary: ' + CH_WF_SHEET + '.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Challenger walk-forward', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
  return lines;
}

/** As much closed history as one provider call gives (Twelve Data: 5000 bars), oldest first. */
function chHistory_(m, iv, P) {
  const size = iv * 60 * 1000;
  let candles;
  if (m.provider === 'twelvedata') candles = twelveCandles_(m.symbol, iv, 5000);
  else candles = chCandles_(m, iv, 5000, P);
  return candles.filter(k => k.t + size <= Date.now()).sort((a, b) => a.t - b.t);
}

/* ---------------- 3-year backtest per market ---------------- */

/**
 * Menu: Live → Challenger → Backtest each market (3 years). Runs every market in
 * CONFIG.CHALLENGER.markets (enabled or not — that's how gold gets vetted),
 * one row each in MM_Backtest. Coinbase history is slow to page, so this stops
 * after ~4.5 min; run it again and it continues with the markets not done today.
 */
function challengerBacktest() {
  const C = CONFIG.CHALLENGER, P = challengerParams_();
  const t0 = Date.now(), iv = C.intervalMinutes, size = iv * 60 * 1000;
  const headers = ['Run at', 'Market', 'From (UTC)', 'To (UTC)', 'Bars', 'Trades', 'Return %', 'Buy & hold %',
                   'Profit factor', 'Max DD %', 'Win rate %', 'Year 1 %', 'Year 2 %', 'Year 3 %', 'Note',
                   'Avg R', 'Cost % per side', 'Swap long %/yr', 'Swap paid $'];
  const s = sheet_(CH_BACKTEST_SHEET, headers);
  const today = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd');
  const doneToday = s.getLastRow() > 1 ? s.getRange(2, 1, s.getLastRow() - 1, 2).getValues()
    .filter(r => r[0] && Utilities.formatDate(new Date(r[0]), CONFIG.TZ, 'yyyy-MM-dd') === today).map(r => String(r[1])) : [];
  if (CONFIG.MARKET.intervalMinutes !== iv) throw new Error('Backtest each market assumes the challenger uses the live interval');

  const endMs = Date.now(), yearMs = 365 * 86400000, testFrom = endMs - 3 * yearMs;
  const warmFrom = Math.floor((testFrom - (P.trendEmaPeriod + P.breakoutLookback + 10) * size * 1.5) / size) * size;
  const left = [];

  (C.markets || []).forEach(m => {
    if (doneToday.indexOf(m.id) !== -1) return;
    if (Date.now() - t0 > 4.5 * 60 * 1000) { left.push(m.id); return; }
    try {
      let candles;
      if (m.provider === 'coinbase') {
        const gran = coinbaseBaseGran_(iv);
        const raw = fetchCoinbaseRange_(m.symbol, gran, warmFrom, endMs);
        candles = (gran === iv * 60) ? raw : aggregateCandles_(raw, iv);
      } else if (!chHasKey_(m)) {
        s.appendRow([new Date(), m.id, '', '', '', '', '', '', '', '', '', '', '', '', 'skipped: add ' + CH_PROVIDER_KEYS[m.provider]]);
        return;
      } else if (m.provider === 'twelvedata') {
        candles = twelveCandles_(m.symbol, iv, 5000);                                      // ~3.2 years of 24/5 4h bars
      } else if (m.provider === 'oanda') {
        candles = [];
        let from = warmFrom;
        while (from < endMs) {
          const page = oandaCandles_(m.symbol, iv, { fromMs: from, count: 5000 });
          if (!page.length) break;
          candles = candles.concat(page);
          from = page[page.length - 1].t + size;
          if (page.length < 5000) break;
        }
      }
      candles = candles.filter(k => k.t + size <= endMs).sort((a, b) => a.t - b.t);
      const series = computeSeries_(candles, P);
      const idx = t => { const j = candles.findIndex(k => k.t >= t); return j === -1 ? candles.length : j; };
      const run = (a, b) => {
        const si = Math.min(idx(a), candles.length - 1), ei = Math.max(si, Math.min(candles.length - 1, idx(b) - 1));
        const r = simulate_(candles, P, Object.assign({ startIndex: si, endIndex: ei, series: series }, chCostOpts_(m)));
        return { m: metrics_(r, candles), bh: (candles[ei].c / candles[si].o - 1) * 100, swap: r.totalSwap };
      };
      const all = run(testFrom, endMs + 1);
      const ys = [0, 1, 2].map(y => run(testFrom + y * yearMs, testFrom + (y + 1) * yearMs).m.totalReturnPct);
      const n = v => v === null || v === undefined || !isFinite(v) ? '' : round_(v);
      s.appendRow([new Date(), m.id, utc_(candles[Math.min(idx(testFrom), candles.length - 1)].t), utc_(candles[candles.length - 1].t), candles.length,
                   all.m.trades, n(all.m.totalReturnPct), n(all.bh), n(all.m.profitFactor), n(all.m.maxDrawdownPct),
                   n(all.m.winRatePct), n(ys[0]), n(ys[1]), n(ys[2]),
                   (candles[0].t > testFrom ? 'only ' + round_((endMs - candles[0].t) / yearMs) + ' yrs of data. ' : '') +
                   (m.enabled ? '' : 'not in the challenger yet'),
                   n(all.m.avgR),
                   round_((m.feePct !== undefined ? m.feePct : CONFIG.BACKTEST.feePct) +
                          (m.slippagePct !== undefined ? m.slippagePct : CONFIG.BACKTEST.slippagePct)),
                   m.swapLongPctYear || 0, n(all.swap)]);
    } catch (e) {
      s.appendRow([new Date(), m.id, '', '', '', '', '', '', '', '', '', '', '', '', 'error: ' + e.message]);
    }
  });

  const msg = left.length
    ? 'Out of time. Done so far is in the MM_Backtest sheet. Run this again to continue with: ' + left.join(', ')
    : 'All markets done. Results are in the MM_Backtest sheet.';
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert('Backtest each market', msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) {}
}
