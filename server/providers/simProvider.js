// Built-in market simulator. Produces a stable universe of prediction markets
// that behave like Polymarket binary markets: each has a hidden "fair value"
// that drifts, a displayed mid price that lags/overshoots (creating exploitable
// mispricing), an order book with depth, liquidity, and an X-sentiment signal.
//
// This lets the whole agent run — research loop, edge detection, sizing, paper
// fills — with zero network access, and mirrors the exact shape the live
// Polymarket provider returns so the rest of the code is provider-agnostic.

import { mulberry32, hashStr, gauss, clamp, pick } from '../lib/rng.js';

const CATEGORIES = [
  'Politics', 'Elections', 'Crypto', 'Economics', 'Sports', 'Tech',
  'Culture', 'Science', 'Geopolitics', 'Business', 'Climate', 'AI',
];

const SUBJECTS = {
  Politics: ['the incumbent', 'the challenger', 'a government shutdown', 'the new bill', 'the cabinet pick', 'the veto'],
  Elections: ['the Democratic nominee', 'the Republican nominee', 'a third-party candidate', 'the incumbent party', 'a swing state'],
  Crypto: ['Bitcoin', 'Ethereum', 'Solana', 'a spot ETF', 'a major exchange', 'stablecoin supply'],
  Economics: ['the Fed', 'CPI inflation', 'unemployment', 'GDP growth', 'a rate cut', 'the S&P 500'],
  Sports: ['the home team', 'the underdog', 'the reigning champion', 'the rookie', 'the playoff seed'],
  Tech: ['the product launch', 'the IPO', 'the antitrust case', 'the chip maker', 'the data breach'],
  Culture: ['the box office', 'the album', 'the awards show', 'the streaming release', 'the finale'],
  Science: ['the mission', 'the trial', 'the discovery', 'the launch window', 'the peer review'],
  Geopolitics: ['the ceasefire', 'the summit', 'the sanctions', 'the border deal', 'the election abroad'],
  Business: ['the merger', 'the earnings beat', 'the layoffs', 'the guidance', 'the buyback'],
  Climate: ['the temperature record', 'the hurricane', 'the emissions target', 'the treaty', 'the drought'],
  AI: ['the model release', 'the benchmark', 'the funding round', 'the regulation', 'the open-source drop'],
};

const TIMEFRAMES = ['by end of month', 'this quarter', 'by year end', 'before the deadline', 'this week', 'in the next 30 days'];

function titleFor(rand, category) {
  const subj = pick(rand, SUBJECTS[category]);
  const tf = pick(rand, TIMEFRAMES);
  const templates = [
    `Will ${subj} succeed ${tf}?`,
    `Will ${subj} beat expectations ${tf}?`,
    `${cap(subj)} to reach the target ${tf}?`,
    `Will ${subj} be resolved YES ${tf}?`,
    `Is ${subj} favored ${tf}?`,
  ];
  return pick(rand, templates);
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export class SimProvider {
  constructor(config) {
    this.config = config;
    this.count = config.marketUniverse;
    this.t0 = Date.now();
    this.markets = this._buildUniverse();
  }

  name() {
    return 'simulator';
  }

  _buildUniverse() {
    const out = [];
    for (let i = 0; i < this.count; i++) {
      const seed = hashStr('mkt-' + i);
      const rand = mulberry32(seed);
      const category = CATEGORIES[Math.floor(rand() * CATEGORIES.length)];
      const fair0 = clamp(0.5 + gauss(rand) * 0.22, 0.03, 0.97);
      const liquidity = Math.round(1000 + Math.pow(rand(), 2) * 240000);
      const volume24h = Math.round(liquidity * (0.2 + rand() * 3));
      const spreadBps = Math.round(30 + rand() * 320); // 0.3% - 3.5%
      const daysToResolve = Math.round(2 + rand() * 120);
      out.push({
        id: 'sim-' + i,
        slug: 'market-' + i,
        question: titleFor(rand, category),
        category,
        seed,
        fair0,
        driftVol: 0.004 + rand() * 0.02,
        liquidity,
        volume24h,
        spreadBps,
        endDate: new Date(this.t0 + daysToResolve * 86400_000).toISOString(),
        sentimentBias: gauss(rand) * 0.35, // structural X lean
      });
    }
    return out;
  }

  // Time-evolving hidden fair value (mean-reverting random walk).
  _fairValue(m, now) {
    const mins = (now - this.t0) / 60000;
    const rand = mulberry32(m.seed ^ Math.floor(mins / 3)); // shifts every ~3 min
    const wander = Math.sin(mins / 90 + (m.seed % 100)) * 0.06;
    const noise = gauss(rand) * m.driftVol * 6;
    return clamp(m.fair0 + wander + noise, 0.02, 0.98);
  }

  // Displayed market mid lags the fair value + adds crowd bias => mispricing.
  _marketMid(m, fair, now) {
    const mins = (now - this.t0) / 60000;
    const rand = mulberry32((m.seed ^ 0x9e37) + Math.floor(mins / 2));
    const lag = Math.sin(mins / 40 + m.seed) * 0.05;      // slow crowd lag
    const overshoot = m.sentimentBias * 0.08;             // narrative bias
    const micro = gauss(rand) * 0.012;
    return clamp(fair + lag + overshoot + micro, 0.01, 0.99);
  }

  async fetchMarkets() {
    const now = Date.now();
    return this.markets.map((m) => {
      const fair = this._fairValue(m, now);
      const mid = this._marketMid(m, fair, now);
      const half = (m.spreadBps / 10000) / 2;
      const bestBid = clamp(mid - half, 0.01, 0.99);
      const bestAsk = clamp(mid + half, 0.01, 0.99);
      return {
        id: m.id,
        slug: m.slug,
        question: m.question,
        category: m.category,
        yesPrice: round4(mid),
        bestBid: round4(bestBid),
        bestAsk: round4(bestAsk),
        spread: round4(bestAsk - bestBid),
        liquidityUsd: m.liquidity,
        volume24hUsd: m.volume24h,
        endDate: m.endDate,
        // The simulator "knows" fair value; live provider estimates it instead.
        _simFair: round4(fair),
      };
    });
  }

  // X sentiment signal for a market: fraction bullish on YES in [-1, 1],
  // plus a post volume. Correlated with hidden fair value + structural bias.
  async fetchSentiment(market) {
    const m = this.markets.find((x) => x.id === market.id);
    if (!m) return { score: 0, posts: 0, bullish: 0, bearish: 0 };
    const now = Date.now();
    const fair = this._fairValue(m, now);
    const rand = mulberry32((m.seed ^ 0x5151) + Math.floor(now / 300000));
    // Sentiment leans toward fair value (informed crowd) + noise + bias.
    const raw = clamp((fair - 0.5) * 1.6 + m.sentimentBias + gauss(rand) * 0.3, -1, 1);
    const posts = Math.round(20 + Math.pow(rand(), 1.5) * 4000);
    const bullish = Math.round((posts * (raw + 1)) / 2);
    return {
      score: round4(raw),
      posts,
      bullish,
      bearish: posts - bullish,
    };
  }

  // Simulated fill: walk the book, apply slippage proportional to size/liquidity.
  async submitOrder({ market, side, sizeUsd }) {
    const price = side === 'BUY_YES' ? market.bestAsk : market.bestBid;
    const impact = clamp(sizeUsd / Math.max(market.liquidityUsd, 1), 0, 0.05);
    const fill = side === 'BUY_YES'
      ? clamp(price + impact, 0.01, 0.99)
      : clamp(price - impact, 0.01, 0.99);
    return {
      accepted: true,
      avgPrice: round4(fill),
      slippage: round4(Math.abs(fill - price)),
      ts: Date.now(),
    };
  }
}

const round4 = (x) => Math.round(x * 10000) / 10000;
