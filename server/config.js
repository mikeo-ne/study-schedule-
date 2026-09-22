// Loads configuration from environment + optional .env file (no dependency).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();

const num = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const str = (v, d) => (v === undefined || v === '' ? d : v);

export const config = {
  root: ROOT,
  port: num(process.env.PORT, 3000),

  dataSource: str(process.env.DATA_SOURCE, 'sim'),   // sim | live
  tradeMode: str(process.env.TRADE_MODE, 'paper'),   // paper | live

  scanIntervalMs: num(process.env.SCAN_INTERVAL_MS, 600_000),
  marketUniverse: num(process.env.MARKET_UNIVERSE, 2000),
  edgeThreshold: num(process.env.EDGE_THRESHOLD, 0.08),
  minLiquidityUsd: num(process.env.MIN_LIQUIDITY_USD, 5000),
  maxPositionUsd: num(process.env.MAX_POSITION_USD, 250),
  bankrollUsd: num(process.env.BANKROLL_USD, 10_000),
  kellyFraction: num(process.env.KELLY_FRACTION, 0.25),

  polymarket: {
    gammaUrl: str(process.env.POLYMARKET_GAMMA_URL, 'https://gamma-api.polymarket.com'),
    clobUrl: str(process.env.POLYMARKET_CLOB_URL, 'https://clob.polymarket.com'),
    apiKey: str(process.env.POLY_API_KEY, ''),
    apiSecret: str(process.env.POLY_API_SECRET, ''),
    apiPassphrase: str(process.env.POLY_API_PASSPHRASE, ''),
    privateKey: str(process.env.POLY_PRIVATE_KEY, ''),
    funder: str(process.env.POLY_FUNDER_ADDRESS, ''),
  },

  xBearerToken: str(process.env.X_BEARER_TOKEN, ''),
};

export function credentialsPresentForLiveTrading() {
  const p = config.polymarket;
  return Boolean(p.apiKey && p.apiSecret && p.apiPassphrase && p.privateKey);
}
