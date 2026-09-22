// Paper-trading portfolio. Tracks cash, open positions, realized/unrealized P&L,
// and a trade blotter. Persists to data/state.json so restarts keep history.
// Live trading would swap `open()` to call the provider's submitOrder and record
// the on-chain fill instead of a simulated one — the accounting is identical.

import fs from 'node:fs';
import path from 'node:path';

export class Portfolio {
  constructor(config) {
    this.config = config;
    this.file = path.join(config.root, 'data', 'state.json');
    this.state = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const s = JSON.parse(raw);
      if (s && typeof s.cash === 'number') return s;
    } catch { /* fresh */ }
    return {
      cash: this.config.bankrollUsd,
      startBankroll: this.config.bankrollUsd,
      positions: {},   // marketId -> position
      trades: [],      // blotter
      realizedPnl: 0,
      createdAt: Date.now(),
    };
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2));
    } catch (e) {
      // Non-fatal: keep trading in memory.
      console.error('[portfolio] save failed:', e.message);
    }
  }

  hasPosition(marketId) {
    return Boolean(this.state.positions[marketId]);
  }

  // Record an opened position from a fill.
  open({ signal, fill, mode }) {
    const shares = Math.floor(signal.sizeUsd / fill.avgPrice);
    if (shares <= 0) return null;
    const cost = round2(shares * fill.avgPrice);
    if (cost > this.state.cash) return null;

    this.state.cash = round2(this.state.cash - cost);
    const pos = {
      marketId: signal.marketId,
      question: signal.question,
      category: signal.category,
      side: signal.side,
      shares,
      avgPrice: fill.avgPrice,
      cost,
      openedAt: Date.now(),
      winProbAtEntry: signal.winProb,
      edgeAtEntry: signal.edge,
    };
    this.state.positions[signal.marketId] = pos;
    this.state.trades.unshift({
      type: 'OPEN',
      mode,
      marketId: signal.marketId,
      question: signal.question,
      side: signal.side,
      shares,
      price: fill.avgPrice,
      cost,
      edge: signal.edge,
      slippage: fill.slippage,
      ts: fill.ts,
    });
    this.state.trades = this.state.trades.slice(0, 300);
    this.save();
    return pos;
  }

  // Mark open positions to current market prices; returns unrealized P&L.
  markToMarket(marketsById) {
    let unrealized = 0;
    let exposure = 0;
    for (const pos of Object.values(this.state.positions)) {
      const m = marketsById.get(pos.marketId);
      if (!m) continue;
      // Value of the side we hold.
      const markPrice = pos.side === 'BUY_YES' ? m.bestBid : (1 - m.bestAsk);
      const value = pos.shares * markPrice;
      const costBasis = pos.shares * pos.avgPrice;
      pos.markPrice = round4(markPrice);
      pos.value = round2(value);
      pos.unrealizedPnl = round2(value - costBasis);
      unrealized += pos.unrealizedPnl;
      exposure += pos.value;
    }
    return { unrealized: round2(unrealized), exposure: round2(exposure) };
  }

  summary(marketsById) {
    const { unrealized, exposure } = this.markToMarket(marketsById);
    const equity = round2(this.state.cash + exposure);
    const totalPnl = round2(equity - this.state.startBankroll);
    return {
      cash: round2(this.state.cash),
      exposure,
      equity,
      startBankroll: this.state.startBankroll,
      realizedPnl: round2(this.state.realizedPnl),
      unrealizedPnl: unrealized,
      totalPnl,
      returnPct: round4((totalPnl / this.state.startBankroll) * 100),
      openPositions: Object.keys(this.state.positions).length,
      totalTrades: this.state.trades.length,
    };
  }
}

const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
