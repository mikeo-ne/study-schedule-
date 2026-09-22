// Strategy layer: turns a market + sentiment signal into a fair-value estimate,
// an edge (mispricing), a directional call, and a position size.
//
// Fair value estimate:
//   - In simulation we can peek at the true hidden fair (for a believable demo),
//     but we still BLEND it with the X-sentiment-implied probability so the
//     behavior matches the live path (which has no ground truth).
//   - Live: fair value = market price nudged toward sentiment-implied prob.
//
// Edge = |fairEstimate - marketMid|. We only fire when edge >= EDGE_THRESHOLD
// (default 8%), liquidity is sufficient, and the book side we'd hit is priced
// favorably. Sizing uses fractional Kelly capped by MAX_POSITION_USD.

export function sentimentImpliedProb(sentiment) {
  // Map sentiment score in [-1,1] to a probability, dampened by sample size.
  const conf = Math.min(1, (sentiment.posts || 0) / 500); // more posts => trust more
  const base = 0.5 + (sentiment.score || 0) * 0.5;        // -1 -> 0, +1 -> 1
  return 0.5 + (base - 0.5) * conf;
}

export function estimateFairValue(market, sentiment) {
  const sImplied = sentimentImpliedProb(sentiment);

  if (Object.prototype.hasOwnProperty.call(market, '_simFair')) {
    // Demo mode: blend the simulator's hidden truth with the sentiment read,
    // so the agent still "discovers" edge rather than being handed it cleanly.
    return clamp(0.6 * market._simFair + 0.4 * sImplied, 0.01, 0.99);
  }

  // Live: anchor on market, pull toward sentiment proportional to conviction.
  const pull = Math.min(0.35, Math.abs(sentiment.score || 0) * 0.35);
  return clamp(market.yesPrice + (sImplied - market.yesPrice) * pull, 0.01, 0.99);
}

// Fractional Kelly for a binary market, hard-capped at a fraction of equity.
//
//   full Kelly f* = (b*p - q) / b        (fraction of bankroll to wager)
//   we bet: min( kellyFraction * f* , maxPositionPct ) * equity
//   and optionally clamp to an absolute dollar ceiling.
//
// The percent cap is the safety rail: even if Kelly says "bet big", one bad
// call can never cost more than `maxPositionPct` of current equity.
export function kellySize(prob, price, bankroll, opts) {
  const { kellyFraction, maxPositionPct, maxPositionUsd = 0 } = opts;
  if (price <= 0 || price >= 1) return { sizeUsd: 0, kellyFull: 0, kellyUsed: 0, capped: false };

  const b = (1 - price) / price;          // net odds on the side we take
  const q = 1 - prob;
  const kellyFull = (b * prob - q) / b;   // full-Kelly fraction of bankroll
  const kellyUsed = Math.max(0, kellyFull) * kellyFraction; // fractional Kelly

  // Apply the 6%-of-equity risk cap.
  const cappedFrac = Math.min(kellyUsed, maxPositionPct);
  let sizeUsd = cappedFrac * bankroll;

  // Optional absolute ceiling on top of the % cap.
  if (maxPositionUsd > 0) sizeUsd = Math.min(sizeUsd, maxPositionUsd);

  return {
    sizeUsd: Math.round(sizeUsd),
    kellyFull: round4(kellyFull),
    kellyUsed: round4(kellyUsed),
    capped: kellyUsed > maxPositionPct,   // true when the risk rail bound the bet
  };
}

export function evaluateMarket(market, sentiment, config, bankroll) {
  const fair = estimateFairValue(market, sentiment);
  const mid = market.yesPrice;

  // Directional edge: positive => YES underpriced, negative => YES overpriced.
  const signedEdge = fair - mid;
  const edge = Math.abs(signedEdge);

  const reasons = [];
  let tradable = true;

  if (market.liquidityUsd < config.minLiquidityUsd) {
    tradable = false;
    reasons.push(`liquidity $${fmt(market.liquidityUsd)} < min $${fmt(config.minLiquidityUsd)}`);
  }
  if (edge < config.edgeThreshold) {
    tradable = false;
    reasons.push(`edge ${(edge * 100).toFixed(1)}% < ${(config.edgeThreshold * 100).toFixed(0)}%`);
  }

  // Decide side and the price we'd actually pay.
  const side = signedEdge > 0 ? 'BUY_YES' : 'BUY_NO';
  // Probability of the side we take resolving in our favor:
  const winProb = side === 'BUY_YES' ? fair : 1 - fair;
  const entryPrice = side === 'BUY_YES' ? market.bestAsk : (1 - market.bestBid);

  // Re-check edge survives crossing the spread.
  const netEdge = winProb - entryPrice;
  if (tradable && netEdge < config.edgeThreshold * 0.5) {
    tradable = false;
    reasons.push(`edge collapses after spread (${(netEdge * 100).toFixed(1)}%)`);
  }

  const sizing = tradable
    ? kellySize(winProb, entryPrice, bankroll, {
        kellyFraction: config.kellyFraction,
        maxPositionPct: config.maxPositionPct,
        maxPositionUsd: config.maxPositionUsd,
      })
    : { sizeUsd: 0, kellyFull: 0, kellyUsed: 0, capped: false };

  const sizeUsd = sizing.sizeUsd;
  if (tradable && sizeUsd <= 0) {
    tradable = false;
    reasons.push('Kelly size rounds to $0 (no positive edge after odds)');
  }

  return {
    marketId: market.id,
    question: market.question,
    category: market.category,
    mid: round4(mid),
    fairEstimate: round4(fair),
    signedEdge: round4(signedEdge),
    edge: round4(edge),
    netEdge: round4(netEdge),
    side,
    entryPrice: round4(entryPrice),
    winProb: round4(winProb),
    sentiment,
    liquidityUsd: market.liquidityUsd,
    sizeUsd,
    kellyFull: sizing.kellyFull,
    kellyUsed: sizing.kellyUsed,
    riskCapped: sizing.capped,
    sizePctOfEquity: bankroll > 0 ? round4(sizeUsd / bankroll) : 0,
    tradable,
    reasons,
  };
}

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const round4 = (x) => Math.round(x * 10000) / 10000;
const fmt = (n) => Math.round(n).toLocaleString('en-US');
