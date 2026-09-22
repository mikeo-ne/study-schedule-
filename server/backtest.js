// Backtest / replay engine.
//
// Runs the EXACT same decision logic as the live agent (evaluateMarket +
// fractional-Kelly sizing + the 6%/60% risk caps + take-profit/stop-loss/
// resolve/edge-gone exits) over a replayed price series, then reports honest
// performance metrics: total return, CAGR, win rate, profit factor, Sharpe,
// Sortino, and max drawdown.
//
// The price series comes from a provider that supports a `_now()`-style clock
// and `resolveOutcome()`. The built-in SimProvider does; a historical loader
// can implement the same interface to backtest against real Polymarket data.

import { evaluateMarket, kellySize } from './strategy.js';

export async function runBacktest(config, {
  provider,          // clock-aware provider (e.g. SimProvider with nowFn)
  clock,             // { get(), advance(ms) } controlling simulated time
  steps = 200,       // number of scan iterations
  stepMs = 3_600_000, // simulated time between scans (default 1h)
  maxResearch = 300, // markets to deep-research per step
  onProgress,        // optional (i, steps, equity) => void
} = {}) {
  const startEquity = config.bankrollUsd;

  // Lightweight in-memory portfolio (mirrors portfolio.js accounting).
  let cash = startEquity;
  const positions = new Map(); // marketId -> { side, shares, avgPrice, cost }
  const closedTrades = [];     // { pnl, reason, holdMs }
  const equityCurve = [];      // { t, equity }
  let realized = 0, wins = 0, losses = 0, opened = 0;

  const exitPrice = (pos, mkt) => (pos.side === 'BUY_YES' ? mkt.bestBid : (1 - mkt.bestAsk));
  const markValue = (marketsById) => {
    let exp = 0;
    for (const pos of positions.values()) {
      const mkt = marketsById.get(pos.marketId);
      if (mkt) exp += pos.shares * exitPrice(pos, mkt);
    }
    return exp;
  };

  for (let i = 0; i < steps; i++) {
    const now = clock.get();
    const markets = await provider.fetchMarkets();
    const marketsById = new Map(markets.map((m) => [m.id, m]));

    // --- Resolve any positions whose market has expired.
    for (const pos of [...positions.values()]) {
      const outcome = provider.resolveOutcome
        ? provider.resolveOutcome(pos.marketId, now)
        : null;
      if (outcome === null) continue;
      // Payout: YES pays $1 if outcome=1; NO pays $1 if outcome=0.
      const won = (pos.side === 'BUY_YES' && outcome === 1) ||
                  (pos.side === 'BUY_NO' && outcome === 0);
      const proceeds = won ? pos.shares * 1 : 0;
      const pnl = proceeds - pos.cost;
      cash += proceeds;
      realized += pnl;
      if (pnl >= 0) wins++; else losses++;
      closedTrades.push({ pnl, reason: 'RESOLVED', holdMs: now - pos.openedAt });
      positions.delete(pos.marketId);
    }

    const equityNow = cash + markValue(marketsById);

    // --- MANAGE: take-profit / stop-loss / edge-gone exits (pre-resolution).
    for (const pos of [...positions.values()]) {
      const mkt = marketsById.get(pos.marketId);
      if (!mkt) continue;
      const mark = exitPrice(pos, mkt);
      const ret = (mark - pos.avgPrice) / pos.avgPrice;
      const sentiment = await provider.fetchSentiment(mkt);
      const sig = evaluateMarket(mkt, sentiment, config, equityNow);
      const edgeNow = sig.side === pos.side ? sig.edge : -sig.edge;

      let reason = null;
      if (mark >= config.resolveThreshold) reason = 'RESOLVED';
      else if (ret >= config.takeProfitPct) reason = 'TAKE_PROFIT';
      else if (ret <= -config.stopLossPct) reason = 'STOP_LOSS';
      else if (edgeNow < config.exitEdgeFloor) reason = 'EDGE_GONE';
      if (!reason) continue;

      const proceeds = pos.shares * mark;
      const pnl = proceeds - pos.cost;
      cash += proceeds;
      realized += pnl;
      if (pnl >= 0) wins++; else losses++;
      closedTrades.push({ pnl, reason, holdMs: now - pos.openedAt });
      positions.delete(pos.marketId);
    }

    // --- Research + rank opportunities (same screen as the live agent).
    const equityAfterExits = cash + markValue(marketsById);
    const liquid = markets
      .filter((m) => m.liquidityUsd >= config.minLiquidityUsd)
      .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
      .slice(0, maxResearch);

    const signals = [];
    for (const m of liquid) {
      if (positions.has(m.id)) continue;
      const sentiment = await provider.fetchSentiment(m);
      const sig = evaluateMarket(m, sentiment, config, equityAfterExits);
      if (sig.tradable) signals.push(sig);
    }
    signals.sort((a, b) => b.netEdge - a.netEdge);

    // --- SIZE + EXECUTE with the exposure cap and per-step trade cap.
    const exposureCapUsd = config.maxPortfolioExposurePct * equityAfterExits;
    let executed = 0;
    for (const sig of signals) {
      const deployed = [...positions.values()].reduce((s, p) => s + p.cost, 0);
      if (deployed + sig.sizeUsd > exposureCapUsd) continue;
      if (cash < sig.sizeUsd) continue;
      const mkt = marketsById.get(sig.marketId);
      const fill = await provider.submitOrder({ market: mkt, side: sig.side, sizeUsd: sig.sizeUsd });
      const shares = Math.floor(sig.sizeUsd / fill.avgPrice);
      if (shares <= 0) continue;
      const cost = shares * fill.avgPrice;
      if (cost > cash) continue;
      cash -= cost;
      positions.set(sig.marketId, {
        marketId: sig.marketId, side: sig.side, shares,
        avgPrice: fill.avgPrice, cost, openedAt: now,
      });
      opened++;
      if (++executed >= 5) break;
    }

    const equity = cash + markValue(marketsById);
    equityCurve.push({ t: now, equity: round2(equity) });
    if (onProgress) onProgress(i + 1, steps, equity);

    clock.advance(stepMs);
  }

  const endEquity = equityCurve.length ? equityCurve[equityCurve.length - 1].equity : startEquity;
  return {
    params: { steps, stepMs, startEquity, ...pickParams(config) },
    equityCurve,
    metrics: computeMetrics({ equityCurve, startEquity, endEquity, closedTrades, wins, losses, opened, stepMs }),
    trades: { opened, closed: closedTrades.length, wins, losses },
  };
}

function computeMetrics({ equityCurve, startEquity, endEquity, closedTrades, wins, losses, opened, stepMs }) {
  const totalReturn = (endEquity - startEquity) / startEquity;

  // Per-step returns for Sharpe/Sortino.
  const rets = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1].equity;
    const cur = equityCurve[i].equity;
    if (prev > 0) rets.push((cur - prev) / prev);
  }
  const mean = avg(rets);
  const sd = std(rets, mean);
  const downside = std(rets.filter((r) => r < 0), 0);
  // Annualize by number of steps per year.
  const stepsPerYear = (365 * 24 * 3600 * 1000) / stepMs;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(stepsPerYear) : 0;
  const sortino = downside > 0 ? (mean / downside) * Math.sqrt(stepsPerYear) : 0;

  // Max drawdown from the equity curve.
  let peak = -Infinity, maxDd = 0;
  for (const p of equityCurve) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - p.equity) / peak);
  }

  // Trade stats.
  const grossWin = closedTrades.filter((t) => t.pnl > 0).reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -closedTrades.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0);
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const closed = wins + losses;
  const winRate = closed > 0 ? wins / closed : 0;
  const avgWin = wins > 0 ? grossWin / wins : 0;
  const avgLoss = losses > 0 ? grossLoss / losses : 0;
  const expectancy = closed > 0 ? (grossWin - grossLoss) / closed : 0;

  // CAGR over the simulated horizon.
  const years = (equityCurve.length * stepMs) / (365 * 24 * 3600 * 1000);
  const cagr = years > 0 && endEquity > 0 && startEquity > 0
    ? Math.pow(endEquity / startEquity, 1 / years) - 1 : 0;

  return {
    startEquity: round2(startEquity),
    endEquity: round2(endEquity),
    totalReturnPct: round4(totalReturn * 100),
    cagrPct: round4(cagr * 100),
    maxDrawdownPct: round4(maxDd * 100),
    sharpe: round2(sharpe),
    sortino: round2(sortino),
    winRatePct: round4(winRate * 100),
    profitFactor: profitFactor === Infinity ? null : round2(profitFactor),
    tradesOpened: opened,
    tradesClosed: closed,
    wins, losses,
    avgWinUsd: round2(avgWin),
    avgLossUsd: round2(avgLoss),
    expectancyUsd: round2(expectancy),
  };
}

function pickParams(c) {
  return {
    edgeThreshold: c.edgeThreshold,
    kellyFraction: c.kellyFraction,
    maxPositionPct: c.maxPositionPct,
    maxPortfolioExposurePct: c.maxPortfolioExposurePct,
    takeProfitPct: c.takeProfitPct,
    stopLossPct: c.stopLossPct,
  };
}

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
const std = (a, m) => (a.length ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length) : 0);
const round2 = (x) => Math.round(x * 100) / 100;
const round4 = (x) => Math.round(x * 10000) / 10000;
