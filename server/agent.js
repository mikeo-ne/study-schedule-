// The autonomous agent. Runs a research loop every SCAN_INTERVAL_MS:
//   1. BROWSER  — fetch the full market universe (~2000 markets)
//   2. RESEARCH — for each candidate, read X sentiment
//   3. ANALYZE  — estimate fair value, compute mispricing (edge)
//   4. DECIDE   — filter for edge >= threshold + liquidity + spread survival
//   5. SIZE     — fractional Kelly, capped
//   6. EXECUTE  — paper fill (or guarded live order)
// Emits a structured activity log (the "terminal") consumed by the dashboard.

import { evaluateMarket } from './strategy.js';

export class Agent {
  constructor({ config, provider, portfolio }) {
    this.config = config;
    this.provider = provider;
    this.portfolio = portfolio;

    this.running = false;
    this.timer = null;
    this.scanCount = 0;
    this.lastScanAt = null;
    this.nextScanAt = null;
    this.busy = false;

    this.markets = [];
    this.marketsById = new Map();
    this.opportunities = [];   // latest ranked tradable signals
    this.log = [];             // terminal feed
    this.status = 'idle';
    this.error = null;
  }

  emit(level, phase, message, extra = {}) {
    const entry = { ts: Date.now(), level, phase, message, ...extra };
    this.log.unshift(entry);
    this.log = this.log.slice(0, 500);
    const tag = `[${phase}]`.padEnd(10);
    console.log(`${new Date(entry.ts).toISOString()} ${tag} ${message}`);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.emit('info', 'SYSTEM', `Agent online — data:${this.provider.name()} mode:${this.config.tradeMode} edge>=${(this.config.edgeThreshold * 100).toFixed(0)}%`);
    // Kick off immediately, then on interval.
    this.runScan().catch((e) => this.emit('error', 'SYSTEM', 'scan crashed: ' + e.message));
    this.timer = setInterval(() => {
      this.runScan().catch((e) => this.emit('error', 'SYSTEM', 'scan crashed: ' + e.message));
    }, this.config.scanIntervalMs);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.emit('warn', 'SYSTEM', 'Agent stopped');
  }

  async runScan() {
    if (this.busy) return;
    this.busy = true;
    this.status = 'scanning';
    this.error = null;
    const startedAt = Date.now();
    this.scanCount += 1;
    const scanId = this.scanCount;

    try {
      // 1. BROWSER — pull the universe.
      this.emit('info', 'BROWSER', `Opening Polymarket — loading market universe (target ${this.config.marketUniverse})`);
      const markets = await this.provider.fetchMarkets();
      this.markets = markets;
      this.marketsById = new Map(markets.map((m) => [m.id, m]));
      this.emit('info', 'BROWSER', `Loaded ${markets.length} active markets`, { count: markets.length });

      // 2. Pre-filter by liquidity to focus research on tradable depth.
      const liquid = markets.filter((m) => m.liquidityUsd >= this.config.minLiquidityUsd);
      this.emit('info', 'RESEARCH', `${liquid.length} markets pass liquidity screen (>= $${fmt(this.config.minLiquidityUsd)})`);

      // Rank by raw price dislocation vs 0.5 as a cheap first-pass to cap X calls.
      const summ = this.portfolio.summary(this.marketsById);
      const bankroll = summ.equity;

      const signals = [];
      let researched = 0;
      // Research the most active/liquid subset deeply (sentiment is "expensive").
      const researchPool = liquid
        .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
        .slice(0, Math.min(liquid.length, 400));

      for (const m of researchPool) {
        const sentiment = await this.provider.fetchSentiment(m);
        researched++;
        const sig = evaluateMarket(m, sentiment, this.config, bankroll);
        if (sig.tradable) signals.push(sig);
      }
      this.emit('info', 'RESEARCH', `Read X sentiment on ${researched} markets`);

      // 3/4. ANALYZE + DECIDE — rank opportunities by net edge.
      signals.sort((a, b) => b.netEdge - a.netEdge);
      this.opportunities = signals.slice(0, 50);
      this.emit(
        signals.length ? 'signal' : 'info',
        'ANALYZE',
        `${signals.length} mispriced markets found (edge >= ${(this.config.edgeThreshold * 100).toFixed(0)}%)`,
        { count: signals.length }
      );

      // 5/6. SIZE + EXECUTE — act on the best, skipping ones we already hold.
      let executed = 0;
      for (const sig of signals) {
        if (this.portfolio.hasPosition(sig.marketId)) continue;
        if (this.portfolio.state.cash < sig.entryPrice * 1) break; // out of cash
        const market = this.marketsById.get(sig.marketId);

        this.emit('signal', 'DECIDE',
          `${sig.side} "${truncate(sig.question)}" — fair ${(sig.fairEstimate * 100).toFixed(0)}c vs mkt ${(sig.mid * 100).toFixed(0)}c, edge ${(sig.edge * 100).toFixed(1)}%`,
          { marketId: sig.marketId, edge: sig.edge });

        let fill;
        if (this.config.tradeMode === 'live') {
          try {
            fill = await this.provider.submitOrder({ market, side: sig.side, sizeUsd: sig.sizeUsd });
          } catch (e) {
            this.emit('error', 'EXECUTE', `Live order rejected: ${e.message}`);
            continue;
          }
        } else {
          // Paper fill via provider's simulated book (or synthesize for live data).
          fill = market && this.provider.submitOrder && this.provider.name() === 'simulator'
            ? await this.provider.submitOrder({ market, side: sig.side, sizeUsd: sig.sizeUsd })
            : { accepted: true, avgPrice: sig.entryPrice, slippage: 0, ts: Date.now() };
        }

        const pos = this.portfolio.open({ signal: sig, fill, mode: this.config.tradeMode });
        if (pos) {
          executed++;
          this.emit('trade', 'EXECUTE',
            `FILLED ${pos.side} ${pos.shares} sh @ ${(pos.avgPrice * 100).toFixed(1)}c ($${fmt(pos.cost)}) on "${truncate(pos.question)}"`,
            { marketId: pos.marketId, cost: pos.cost });
        }
        if (executed >= 5) break; // per-scan trade cap
      }

      // Mark book + report equity.
      const after = this.portfolio.summary(this.marketsById);
      this.emit('info', 'PORTFOLIO',
        `Equity $${fmt(after.equity)} | cash $${fmt(after.cash)} | ${after.openPositions} open | P&L $${fmt(after.totalPnl)} (${after.returnPct}%)`);

      this.status = 'idle';
      this.lastScanAt = Date.now();
      this.nextScanAt = this.lastScanAt + this.config.scanIntervalMs;
      const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
      this.emit('info', 'SYSTEM', `Scan #${scanId} complete in ${secs}s — next in ${(this.config.scanIntervalMs / 60000).toFixed(0)}m`);
    } catch (e) {
      this.status = 'error';
      this.error = e.message;
      this.emit('error', 'SYSTEM', 'Scan failed: ' + e.message);
    } finally {
      this.busy = false;
    }
  }

  snapshot() {
    const summ = this.portfolio.summary(this.marketsById);
    return {
      status: this.status,
      running: this.running,
      error: this.error,
      dataSource: this.provider.name(),
      tradeMode: this.config.tradeMode,
      config: {
        edgeThreshold: this.config.edgeThreshold,
        minLiquidityUsd: this.config.minLiquidityUsd,
        maxPositionUsd: this.config.maxPositionUsd,
        scanIntervalMs: this.config.scanIntervalMs,
        marketUniverse: this.config.marketUniverse,
        kellyFraction: this.config.kellyFraction,
      },
      scanCount: this.scanCount,
      lastScanAt: this.lastScanAt,
      nextScanAt: this.nextScanAt,
      universeSize: this.markets.length,
      portfolio: summ,
      positions: Object.values(this.portfolio.state.positions).sort((a, b) => (b.unrealizedPnl || 0) - (a.unrealizedPnl || 0)),
      opportunities: this.opportunities,
      trades: this.portfolio.state.trades.slice(0, 40),
      log: this.log.slice(0, 120),
    };
  }
}

const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const truncate = (s, n = 52) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
