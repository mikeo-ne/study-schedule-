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
  constructor(config, opts = {}) {
    this.config = config;
    this.count = config.marketUniverse;
    // Clock is injectable so the backtester can replay simulated time.
    this._nowFn = opts.nowFn || (() => Date.now());
    this.t0 = opts.t0 ?? this._nowFn();
    this.markets = this._buildUniverse();
  }

  name() {
    return 'simulator';
  }

  _now() {
    return this._nowFn();
  }

  _buildUniverse() {
    const out = [];
    for (let i = 0; i < this.count; i++) {
      const seed = hashStr('mkt-' + i);
      const rand = mulberry32(seed);
      const category = CATEGORIES[Math.floor(rand() * CATEGORIES.length)];
      // pTrue is the PERSISTENT true probability the market resolves YES.
      // Resolution is drawn from it, and the observable signal tracks it — so a
      // bot with signal has a genuine (noisy) edge, as in the real world.
      const pTrue = clamp(0.5 + gauss(rand) * 0.22, 0.03, 0.97);
      // Persistent structural mispricing: the crowd misprices YES by this much
      // (fixed sign per market), slowly decaying as the market matures. This is
      // the exploitable edge; ~N(0,0.09) so a meaningful fraction exceed 8%.
      const mispricing = gauss(rand) * 0.09;
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
        pTrue,
        mispricing,
        obsVol: 0.015 + rand() * 0.02,  // how noisy the observable signal is
        liquidity,
        volume24h,
        spreadBps,
        endDate: new Date(this.t0 + daysToResolve * 86400_000).toISOString(),
        sentimentBias: gauss(rand) * 0.12, // small extra X lean
      });
    }
    return out;
  }

  // Observable fair-value estimate: tracks pTrue with small mean-reverting noise.
  // (What an informed observer / the bot's model can perceive right now.)
  _fairValue(m, now) {
    const mins = (now - this.t0) / 60000;
    const rand = mulberry32((m.seed ^ 0x00f5) + Math.floor(mins / 60)); // shifts hourly
    const noise = gauss(rand) * m.obsVol;
    return clamp(m.pTrue + noise, 0.02, 0.98);
  }

  // Displayed market mid = pTrue + persistent mispricing that decays toward
  // resolution + small microstructure noise. The gap vs pTrue is the edge.
  _marketMid(m, now) {
    const mins = (now - this.t0) / 60000;
    const endMins = (new Date(m.endDate).getTime() - this.t0) / 60000;
    const life = endMins > 0 ? clamp(mins / endMins, 0, 1) : 0;
    const decay = 1 - 0.6 * life;                    // mispricing shrinks over life
    const rand = mulberry32((m.seed ^ 0x9e37) + Math.floor(mins / 30));
    const micro = gauss(rand) * 0.01;
    return clamp(m.pTrue + m.mispricing * decay + m.sentimentBias * 0.15 + micro, 0.01, 0.99);
  }

  async fetchMarkets() {
    const now = this._now();
    return this.markets.map((m) => {
      const fair = this._fairValue(m, now);
      const mid = this._marketMid(m, now);
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
    const now = this._now();
    const fair = this._fairValue(m, now);
    const rand = mulberry32((m.seed ^ 0x5151) + Math.floor(now / 300000));
    // Sentiment is an informed-but-noisy read of the observable fair value.
    const raw = clamp((fair - 0.5) * 1.7 + m.sentimentBias + gauss(rand) * 0.22, -1, 1);
    const posts = Math.round(20 + Math.pow(rand(), 1.5) * 4000);
    const bullish = Math.round((posts * (raw + 1)) / 2);
    return {
      score: round4(raw),
      posts,
      bullish,
      bearish: posts - bullish,
    };
  }

  // Simulated fill for any of the four sides, priced in the traded side's own
  // units (a share pays $1 if that side wins). Buys cross to the ask and pay
  // slippage up; sells cross to the bid and receive slippage down.
  //   BUY_YES  -> pay YES ask   = bestAsk
  //   SELL_YES -> get YES bid   = bestBid
  //   BUY_NO   -> pay NO ask    = 1 - bestBid
  //   SELL_NO  -> get NO bid    = 1 - bestAsk
  async submitOrder({ market, side, sizeUsd }) {
    const isBuy = side.startsWith('BUY');
    let price;
    if (side === 'BUY_YES') price = market.bestAsk;
    else if (side === 'SELL_YES') price = market.bestBid;
    else if (side === 'BUY_NO') price = 1 - market.bestBid;
    else /* SELL_NO */ price = 1 - market.bestAsk;

    const impact = clamp(sizeUsd / Math.max(market.liquidityUsd, 1), 0, 0.05);
    const fill = isBuy
      ? clamp(price + impact, 0.01, 0.99)   // buyers pay up
      : clamp(price - impact, 0.01, 0.99);  // sellers receive less
    return {
      accepted: true,
      avgPrice: round4(fill),
      slippage: round4(Math.abs(fill - price)),
      ts: this._now(),
    };
  }

  // Backtest helper: settle a market to YES(1)/NO(0) once its end date passes.
  // Outcome is drawn from the hidden fair value at resolution time — an informed
  // market resolves in the direction the fair value pointed, with noise.
  resolveOutcome(marketId, now = this._now()) {
    const m = this.markets.find((x) => x.id === marketId);
    if (!m) return null;
    if (now < new Date(m.endDate).getTime()) return null; // not resolved yet
    // Outcome is drawn from the PERSISTENT true probability — the same quantity
    // the observable signal tracks — so signal confers a real edge.
    const rand = mulberry32((m.seed ^ 0x0d1e) >>> 0);
    return rand() < m.pTrue ? 1 : 0; // 1 = YES resolves true
  }
}

const round4 = (x) => Math.round(x * 10000) / 10000;
