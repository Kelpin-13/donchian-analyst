/**
 * One row per GoldIntraday tester trade, with what the EA knew at the moment it entered, for the
 * trade-filter study (research/trade_filter.py).
 *
 *   node research/trade_features.js [--out data/trade_features.csv] [journal ...]
 *
 * Journals: every GoldIntraday tester journal (the last run in each, one per era), or the paths given.
 * Every feature comes from the journal itself (the day's DAY row, the entry, earlier closed trades)
 * and the big-four US releases (research/calendar.js), so the EA can compute the same live.
 * Prices are in daily-ATR units; "with" = signed by the trade's side (+ = in the trade's favour).
 * Nothing after the entry is used, except the label: r (R multiple), usd (the EA's profit).
 */
const fs = require('fs');
const path = require('path');
const { testerJournals, readRun } = require('./journal_stats');
const { findCalendar, loadReleases, firstFrom } = require('./calendar');

const MIN = 60000, DAY = 86400000;
const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i === -1 ? def : args[i + 1]; };
const out = opt('--out', path.join(__dirname, '..', 'data', 'trade_features.csv'));
const given = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

const calFile = findCalendar();
if (!calFile) { console.log('No calendar_events.csv found. Run mt5/ExportCalendar.mq5 in MT5 first.'); process.exit(1); }
const news = loadReleases(calFile, 'top').times;

const num = (re, s) => { const m = re.exec(s); return m ? Number(m[1]) : null; };
const iso = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const round = v => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : '');

const files = given.length ? given : testerJournals(/^GoldIntraday_journal_.*\.csv$/);
const runs = files.map(readRun).filter(r => r.trades.length).sort((a, b) => a.rows[0].t - b.rows[0].t);
if (!runs.length) { console.log('No GoldIntraday tester journal with trades found.'); process.exit(1); }

const COLS = ['era', 'eq0', 'strat', 'entry_time', 'exit_time', 'r', 'usd',
  'side', 'hour', 'dow', 'risk_atr', 'move_open', 'gap', 'yrange', 'dtrange', 'atr_pct', 'atr_ratio',
  'trend20', 'vs_yhigh', 'vs_ylow', 'news_day', 'mins_to_news', 'mins_since_news', 'strat_last10', 'all_last20'];
const lines = [COLS.join(',')];

runs.forEach(run => {
  const era = new Date(run.rows[0].t).getUTCFullYear() + '-' + String(new Date(run.rows[run.rows.length - 1].t).getUTCFullYear()).slice(2);
  // The day's facts the EA logs at its first bar: one per day.
  const days = [];
  run.rows.filter(r => r.ev === 'DAY').forEach(r => {
    const d = r.detail, day = Math.floor(r.t / DAY);
    if (days.length && days[days.length - 1].day === day) return;
    const dt = /Dual Thrust ([\d.]+)-([\d.]+)/.exec(d), y = /H\/L\/C ([\d.]+)\/([\d.]+)\/([\d.]+)/.exec(d);
    if (!dt || !y) return;
    days.push({ t: r.t, day, open: num(/open ([\d.]+)/, d), atr: num(/daily ATR ([\d.]+)/, d),
                dtDn: +dt[1], dtUp: +dt[2], yH: +y[1], yL: +y[2], yC: +y[3] });
  });
  const dayTimes = days.map(d => d.t);

  // Recent results before an entry: closed trades only (cumulative R by exit time).
  const byExit = run.trades.slice().sort((a, b) => a.exitT - b.exitT);
  const cum = list => { const c = [0]; list.forEach(t => c.push(c[c.length - 1] + t.r)); return { exits: list.map(t => t.exitT), c }; };
  const all = cum(byExit), per = {};
  [...new Set(byExit.map(t => t.strat))].forEach(s => { per[s] = cum(byExit.filter(t => t.strat === s)); });
  const lastN = (h, t, n) => { const i = firstFrom(h.exits, t); return h.c[i] - h.c[Math.max(0, i - n)]; };

  run.trades.forEach(tr => {
    const di = firstFrom(dayTimes, tr.t + 1) - 1;
    if (di < 0) return;
    const d = days[di], atr = d.atr, back = di >= 20 ? days[di - 20] : null, s = tr.side;
    const ni = firstFrom(news, tr.t), next = ni < news.length ? news[ni] : null, prev = ni > 0 ? news[ni - 1] : null;
    const when = new Date(tr.t);
    const f = {
      era, eq0: run.rows[0].eq, strat: tr.strat, entry_time: iso(tr.t), exit_time: iso(tr.exitT), r: round(tr.r), usd: tr.usd === null ? '' : tr.usd,
      side: s,
      hour: round(when.getUTCHours() + when.getUTCMinutes() / 60),
      dow: when.getUTCDay(),
      risk_atr: round(tr.risk / atr),                                  // stop distance
      move_open: round((tr.entry - d.open) * s / atr),                 // how far gold had moved the trade's way since the open
      gap: round((d.open - d.yC) * s / atr),                           // today's open vs yesterday's close
      yrange: round((d.yH - d.yL) / atr),                              // yesterday's range
      dtrange: round((d.dtUp - d.dtDn) / atr),                         // Dual Thrust's 4-day range
      atr_pct: round(atr / tr.entry * 100),                            // volatility, % of price
      atr_ratio: back ? round(atr / back.atr) : '',                     // volatility now vs 20 days ago
      trend20: back ? round((d.open - back.open) * s / atr) : '',       // 20-day move, the trade's way
      vs_yhigh: round((tr.entry - d.yH) * s / atr),
      vs_ylow: round((tr.entry - d.yL) * s / atr),
      news_day: news.some(t => Math.floor(t / DAY) === d.day) ? 1 : 0,
      mins_to_news: next !== null ? Math.min(1440, Math.round((next - tr.t) / MIN)) : 1440,
      mins_since_news: prev !== null ? Math.min(1440, Math.round((tr.t - prev) / MIN)) : 1440,
      strat_last10: round(lastN(per[tr.strat], tr.t, 10)),
      all_last20: round(lastN(all, tr.t, 20)),
    };
    lines.push(COLS.map(c => f[c]).join(','));
  });
  console.log(era + ': ' + run.trades.length + ' trades, ' + days.length + ' days');
});

fs.writeFileSync(out, lines.join('\n') + '\n');
console.log('Wrote ' + (lines.length - 1) + ' trades to ' + out);
