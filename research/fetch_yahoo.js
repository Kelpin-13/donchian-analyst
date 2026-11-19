/**
 * Daily prices of US ETFs and stocks from Yahoo Finance (owner approved Yahoo, 19 Nov 2026), for the stock research.
 *
 *   node research/fetch_yahoo.js SPY QQQ XLK ...
 *
 * Writes data/yahoo/<TICKER>.csv: date,open,high,low,close,adjclose,volume (adjclose includes dividends and splits;
 * open/high/low/close are split-adjusted only, as Yahoo gives them). The whole history Yahoo has. Free, no account.
 * A generic client name is sent, nothing about the owner.
 */
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, '..', 'data', 'yahoo');

async function fetchOne(ticker) {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) +
              '?period1=0&period2=' + Math.floor(Date.now() / 1000) + '&interval=1d&events=div%2Csplit&includeAdjustedClose=true';
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (research script)' } });
    if (res.status === 429) { await new Promise(r => setTimeout(r, 3000 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error(ticker + ': HTTP ' + res.status);
    const j = await res.json(), r = j.chart && j.chart.result && j.chart.result[0];
    if (!r || !r.timestamp) throw new Error(ticker + ': no data');
    const q = r.indicators.quote[0], adj = (r.indicators.adjclose && r.indicators.adjclose[0].adjclose) || q.close;
    const rows = ['date,open,high,low,close,adjclose,volume'];
    r.timestamp.forEach((ts, i) => {
      if (q.close[i] == null || adj[i] == null) return;
      const d = new Date((ts + (r.meta.gmtoffset || 0)) * 1000).toISOString().slice(0, 10);
      rows.push([d, q.open[i], q.high[i], q.low[i], q.close[i], adj[i], q.volume[i] || 0].join(','));
    });
    return rows;
  }
  throw new Error(ticker + ': rate limited');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const t of process.argv.slice(2)) {
    try {
      const rows = await fetchOne(t);
      fs.writeFileSync(path.join(OUT, t + '.csv'), rows.join('\n') + '\n');
      console.log(t + ': ' + (rows.length - 1) + ' days, ' + rows[1].slice(0, 10) + ' to ' + rows[rows.length - 1].slice(0, 10));
    } catch (e) { console.log(e.message); }
    await new Promise(r => setTimeout(r, 400));
  }
})();
