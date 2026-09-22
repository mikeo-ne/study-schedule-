import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, credentialsPresentForLiveTrading } from './config.js';
import { SimProvider } from './providers/simProvider.js';
import { PolymarketProvider } from './providers/polymarketProvider.js';
import { XClient } from './providers/xClient.js';
import { Portfolio } from './portfolio.js';
import { Agent } from './agent.js';
import { runBacktest } from './backtest.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- Safety: never allow live trading without explicit, complete credentials.
if (config.tradeMode === 'live' && !credentialsPresentForLiveTrading()) {
  console.warn('[SAFETY] TRADE_MODE=live but CLOB credentials are incomplete — forcing paper mode.');
  config.tradeMode = 'paper';
}

// --- Wire up the data provider.
let provider;
if (config.dataSource === 'live') {
  const xClient = config.xBearerToken ? new XClient(config.xBearerToken) : null;
  provider = new PolymarketProvider(config, { xClient });
  console.log('[boot] LIVE Polymarket data provider' + (xClient ? ' + X sentiment' : ' (no X token)'));
} else {
  provider = new SimProvider(config);
  console.log('[boot] Simulation provider (' + config.marketUniverse + ' synthetic markets)');
}

const portfolio = new Portfolio(config);
const agent = new Agent({ config, provider, portfolio });

const app = express();
app.use(express.json());

// --- API ---
app.get('/api/state', (req, res) => {
  res.json(agent.snapshot());
});

app.get('/api/opportunities', (req, res) => {
  res.json(agent.opportunities);
});

app.post('/api/scan', async (req, res) => {
  if (agent.busy) return res.status(409).json({ error: 'scan already in progress' });
  agent.runScan().catch(() => {});
  res.json({ ok: true, message: 'scan triggered' });
});

app.post('/api/control', (req, res) => {
  const { action } = req.body || {};
  if (action === 'start') agent.start();
  else if (action === 'stop') agent.stop();
  else return res.status(400).json({ error: 'action must be start or stop' });
  res.json({ ok: true, running: agent.running });
});

// --- Backtest / replay ---
let backtestRunning = false;
app.post('/api/backtest', async (req, res) => {
  if (backtestRunning) return res.status(409).json({ error: 'backtest already running' });
  const b = req.body || {};
  const steps = clampInt(b.steps, 20, 400, 200);
  const stepMs = clampInt(b.stepHours, 1, 168, 12) * 3_600_000;
  const universe = clampInt(b.universe, 100, 2000, 600);

  // Backtest against a fresh, clock-driven simulator, with optional overrides
  // for the strategy knobs so users can compare configurations.
  const btConfig = {
    ...config,
    marketUniverse: universe,
    edgeThreshold: numOr(b.edgeThreshold, config.edgeThreshold),
    kellyFraction: numOr(b.kellyFraction, config.kellyFraction),
    maxPositionPct: numOr(b.maxPositionPct, config.maxPositionPct),
    maxPortfolioExposurePct: numOr(b.maxPortfolioExposurePct, config.maxPortfolioExposurePct),
    takeProfitPct: numOr(b.takeProfitPct, config.takeProfitPct),
    stopLossPct: numOr(b.stopLossPct, config.stopLossPct),
  };

  let t = Date.now();
  const clock = { get: () => t, advance: (ms) => { t += ms; } };
  const btProvider = new SimProvider(btConfig, { nowFn: () => t, t0: t });

  backtestRunning = true;
  try {
    const result = await runBacktest(btConfig, { provider: btProvider, clock, steps, stepMs });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    backtestRunning = false;
  }
});

function clampInt(v, lo, hi, def) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
}
function numOr(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// --- Static dashboard ---
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(config.port, '0.0.0.0', () => {
  console.log(`\n  polymkt-alpha dashboard  ->  http://0.0.0.0:${config.port}\n`);
  agent.start();
});
