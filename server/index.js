import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, credentialsPresentForLiveTrading } from './config.js';
import { SimProvider } from './providers/simProvider.js';
import { PolymarketProvider } from './providers/polymarketProvider.js';
import { XClient } from './providers/xClient.js';
import { Portfolio } from './portfolio.js';
import { Agent } from './agent.js';

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

// --- Static dashboard ---
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(config.port, '0.0.0.0', () => {
  console.log(`\n  polymkt-alpha dashboard  ->  http://0.0.0.0:${config.port}\n`);
  agent.start();
});
