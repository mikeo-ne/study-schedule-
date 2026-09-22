// CLI backtest runner.  Usage:
//   node server/backtest-cli.js [--steps 300] [--stepHours 6] [--edge 0.08]
//     [--kelly 0.25] [--maxpos 0.06] [--exposure 0.60] [--universe 500]
//
// Replays the built-in simulator through the exact live strategy + risk logic
// and prints performance metrics. Override any config knob via flags or .env.

import { config } from './config.js';
import { SimProvider } from './providers/simProvider.js';
import { runBacktest } from './backtest.js';

function argFlag(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const steps = Number(argFlag('steps', 300));
const stepMs = Number(argFlag('stepHours', 6)) * 3_600_000;

// Allow strategy overrides from the command line for quick sweeps.
config.edgeThreshold = Number(argFlag('edge', config.edgeThreshold));
config.kellyFraction = Number(argFlag('kelly', config.kellyFraction));
config.maxPositionPct = Number(argFlag('maxpos', config.maxPositionPct));
config.maxPortfolioExposurePct = Number(argFlag('exposure', config.maxPortfolioExposurePct));
config.marketUniverse = Number(argFlag('universe', 500)); // smaller = faster CLI

// A simple advancing clock; the provider reads time via nowFn.
let t = Date.now();
const clock = { get: () => t, advance: (ms) => { t += ms; } };
const provider = new SimProvider(config, { nowFn: () => t, t0: t });

console.log(`\n  Backtest — ${steps} steps × ${stepMs / 3_600_000}h, universe ${config.marketUniverse}`);
console.log(`  edge>=${(config.edgeThreshold * 100).toFixed(0)}%  kelly=${config.kellyFraction}  ` +
            `maxpos=${(config.maxPositionPct * 100).toFixed(0)}%  exposure<=${(config.maxPortfolioExposurePct * 100).toFixed(0)}%\n`);

const bar = (i, n) => {
  const w = 30, f = Math.round((i / n) * w);
  process.stdout.write(`\r  [${'#'.repeat(f)}${'-'.repeat(w - f)}] ${i}/${n}`);
};

const res = await runBacktest(config, {
  provider, clock, steps, stepMs,
  onProgress: (i, n) => bar(i, n),
});

process.stdout.write('\n\n');
const m = res.metrics;
const row = (k, v) => console.log('  ' + k.padEnd(22) + v);
console.log('  ── Performance ─────────────────────────────');
row('Start equity', '$' + m.startEquity.toLocaleString());
row('End equity', '$' + m.endEquity.toLocaleString());
row('Total return', pct(m.totalReturnPct));
row('CAGR', pct(m.cagrPct));
row('Max drawdown', pct(m.maxDrawdownPct));
row('Sharpe (ann.)', m.sharpe);
row('Sortino (ann.)', m.sortino);
console.log('  ── Trades ──────────────────────────────────');
row('Win rate', pct(m.winRatePct) + `  (${m.wins}W / ${m.losses}L)`);
row('Profit factor', m.profitFactor === null ? '∞' : m.profitFactor);
row('Trades opened', m.tradesOpened);
row('Trades closed', m.tradesClosed);
row('Avg win / loss', '$' + m.avgWinUsd + ' / $' + m.avgLossUsd);
row('Expectancy/trade', '$' + m.expectancyUsd);
console.log('  ────────────────────────────────────────────\n');

function pct(x) {
  const s = (x >= 0 ? '+' : '') + x.toFixed(2) + '%';
  return s;
}
