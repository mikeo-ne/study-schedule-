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
    this.emit('info', 'SYSTEM', `Agent online — data:${this.provider.name()} mode:${this.config.tradeMode} | edge>=${(this.config.edgeThreshold * 100).toFixed(0)}% | ${(this.config.kellyFraction * 100).toFixed(0)}% Kelly, capped ${(this.config.maxPositionPct * 100).toFixed(0)}% equity/bet`);
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

      // 5. MANAGE — exit positions that hit take-profit / stop-loss / resolved
      //    / edge-gone, BEFORE deploying fresh capital.
      await this.manageExits();

      // 6/7. SIZE + EXECUTE — act on the best, respecting the exposure cap.
      const equityNow = this.portfolio.summary(this.marketsById).equity;
      const exposureCapUsd = this.config.maxPortfolioExposurePct * equityNow;
      let executed = 0;
      let skippedExposure = false;

      for (const sig of signals) {
        if (this.portfolio.hasPosition(sig.marketId)) continue;

        // Portfolio-level exposure cap: never deploy past the ceiling.
        const deployed = this.portfolio.deployedCost();
        if (deployed + sig.sizeUsd > exposureCapUsd) {
          skippedExposure = true;
          continue;
        }
        if (this.portfolio.state.cash < sig.sizeUsd) continue; // not enough cash
        const market = this.marketsById.get(sig.marketId);

        const kellyNote = sig.riskCapped
          ? `Kelly ${(sig.kellyUsed * 100).toFixed(1)}% capped to ${(this.config.maxPositionPct * 100).toFixed(0)}% risk rail`
          : `Kelly ${(sig.kellyUsed * 100).toFixed(1)}% of equity`;
        this.emit('signal', 'DECIDE',
          `${sig.side} "${truncate(sig.question)}" — fair ${(sig.fairEstimate * 100).toFixed(0)}c vs mkt ${(sig.mid * 100).toFixed(0)}c, edge ${(sig.edge * 100).toFixed(1)}% | ${kellyNote} = $${fmt(sig.sizeUsd)}`,
          { marketId: sig.marketId, edge: sig.edge });

        let fill;
        try {
          fill = await this._fill({ market, side: sig.side, sizeUsd: sig.sizeUsd, entryPrice: sig.entryPrice });
        } catch (e) {
          this.emit('error', 'EXECUTE', `Order rejected: ${e.message}`);
          continue;
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

      if (skippedExposure) {
        this.emit('info', 'EXECUTE',
          `Exposure cap reached (${(this.config.maxPortfolioExposurePct * 100).toFixed(0)}% of equity) — holding dry powder`);
      }

      // Mark book, record equity point, report.
      const after = this.portfolio.summary(this.marketsById);
      this.portfolio.recordEquity(after.equity);
      this.portfolio.save();
      this.emit('info', 'PORTFOLIO',
        `Equity $${fmt(after.equity)} | cash $${fmt(after.cash)} | ${after.openPositions} open (${(after.exposurePct * 100).toFixed(0)}% exp) | W/L ${after.wins}/${after.losses} | P&L $${fmt(after.totalPnl)} (${after.returnPct}%)`);

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

  // Obtain a fill for an order, from the live provider or a paper simulation.
  async _fill({ market, side, sizeUsd, entryPrice }) {
    if (this.config.tradeMode === 'live') {
      return this.provider.submitOrder({ market, side, sizeUsd });
    }
    if (market && this.provider.name() === 'simulator') {
      return this.provider.submitOrder({ market, side, sizeUsd });
    }
    return { accepted: true, avgPrice: entryPrice, slippage: 0, ts: Date.now() };
  }

  // Exit price for an open position (what we'd receive selling out now).
  _exitPrice(pos, market) {
    return pos.side === 'BUY_YES' ? market.bestBid : (1 - market.bestAsk);
  }

  // MANAGE phase: check every open position for take-profit, stop-loss,
  // near-resolution, or edge-gone, and close the ones that trigger.
  async manageExits() {
    const positions = Object.values(this.portfolio.state.positions);
    if (positions.length === 0) return 0;
    let closed = 0;

    for (const pos of positions) {
      const market = this.marketsById.get(pos.marketId);
      if (!market) continue;

      const markPrice = this._exitPrice(pos, market);
      const retPct = (markPrice - pos.avgPrice) / pos.avgPrice;

      // Re-derive current edge to know if our thesis still holds.
      const sentiment = await this.provider.fetchSentiment(market);
      const sig = evaluateMarket(market, sentiment, this.config, this.portfolio.summary(this.marketsById).equity);
      const stillOurSide = sig.side === pos.side;
      const edgeNow = stillOurSide ? sig.edge : -sig.edge;

      let reason = null;
      if (markPrice >= this.config.resolveThreshold) reason = 'RESOLVED';
      else if (retPct >= this.config.takeProfitPct) reason = 'TAKE_PROFIT';
      else if (retPct <= -this.config.stopLossPct) reason = 'STOP_LOSS';
      else if (edgeNow < this.config.exitEdgeFloor) reason = 'EDGE_GONE';

      if (!reason) continue;

      const fill = await this._fill({
        market, side: pos.side === 'BUY_YES' ? 'SELL_YES' : 'SELL_NO',
        sizeUsd: pos.value || pos.cost, entryPrice: markPrice,
      });
      const res = this.portfolio.close({ marketId: pos.marketId, fill, reason, mode: this.config.tradeMode });
      if (res) {
        closed++;
        const lvl = res.pnl >= 0 ? 'trade' : 'warn';
        this.emit(lvl, 'MANAGE',
          `CLOSE (${reason}) ${pos.side} "${truncate(pos.question)}" @ ${(fill.avgPrice * 100).toFixed(1)}c — P&L ${res.pnl >= 0 ? '+' : ''}$${fmt(res.pnl)}`,
          { marketId: pos.marketId, pnl: res.pnl });
      }
    }
    if (closed) this.emit('info', 'MANAGE', `Closed ${closed} position(s) this scan`);
    return closed;
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
        maxPositionPct: this.config.maxPositionPct,
        maxPositionUsd: this.config.maxPositionUsd,
        maxPortfolioExposurePct: this.config.maxPortfolioExposurePct,
        takeProfitPct: this.config.takeProfitPct,
        stopLossPct: this.config.stopLossPct,
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
      equityCurve: this.portfolio.equityCurve(),
      log: this.log.slice(0, 120),
    };
  }
}

const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const truncate = (s, n = 52) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
