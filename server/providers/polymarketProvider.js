// Live Polymarket provider. Talks to the public Gamma API for the market
// universe and the CLOB for order books. Fair-value here is *estimated* from
// book microstructure + X sentiment (the real world does not hand you truth).
//
// NOTE: This path requires outbound network access to *.polymarket.com and,
// for live order submission, valid CLOB API credentials + a signing wallet.
// Order signing (EIP-712) is intentionally left as a guarded stub so the bot
// cannot accidentally move real funds without a deliberate implementation.

export class PolymarketProvider {
  constructor(config, { xClient } = {}) {
    this.config = config;
    this.xClient = xClient;
    this.gamma = config.polymarket.gammaUrl.replace(/\/$/, '');
    this.clob = config.polymarket.clobUrl.replace(/\/$/, '');
  }

  name() {
    return 'polymarket-live';
  }

  async _json(url, opts = {}) {
    const res = await fetch(url, { ...opts, headers: { 'User-Agent': 'polymkt-alpha/1.0', ...(opts.headers || {}) } });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return res.json();
  }

  async fetchMarkets() {
    const limit = 500;
    const want = this.config.marketUniverse;
    const out = [];
    let offset = 0;
    while (out.length < want) {
      const url = `${this.gamma}/markets?active=true&closed=false&archived=false&limit=${limit}&offset=${offset}&order=volume24hr&ascending=false`;
      const batch = await this._json(url);
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const m of batch) {
        const norm = this._normalize(m);
        if (norm) out.push(norm);
      }
      offset += limit;
      if (batch.length < limit) break;
    }
    return out.slice(0, want);
  }

  _normalize(m) {
    // Gamma returns outcomePrices/outcomes as JSON-encoded strings.
    let prices, outcomes;
    try {
      prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
    } catch {
      return null;
    }
    if (!prices || prices.length < 2) return null;
    const yesIdx = (outcomes || []).findIndex((o) => String(o).toLowerCase() === 'yes');
    const yes = Number(prices[yesIdx === -1 ? 0 : yesIdx]);
    if (!Number.isFinite(yes)) return null;
    const spread = Number(m.spread) || 0.01;
    return {
      id: String(m.id ?? m.conditionId ?? m.slug),
      slug: m.slug,
      question: m.question || m.title || m.slug,
      category: m.category || (Array.isArray(m.tags) && m.tags[0]?.label) || 'Other',
      yesPrice: yes,
      bestBid: clamp(yes - spread / 2, 0.01, 0.99),
      bestAsk: clamp(yes + spread / 2, 0.01, 0.99),
      spread,
      liquidityUsd: Number(m.liquidityNum ?? m.liquidity ?? 0),
      volume24hUsd: Number(m.volume24hr ?? m.volume24hrClob ?? 0),
      endDate: m.endDate || m.endDateIso || null,
      _clobTokenIds: safeParse(m.clobTokenIds),
    };
  }

  // Fair value estimate from live sentiment: without a private model we lean on
  // the crowd on X, blended toward the market. The strategy layer decides edge.
  async fetchSentiment(market) {
    if (!this.xClient) return { score: 0, posts: 0, bullish: 0, bearish: 0, note: 'no X client' };
    return this.xClient.sentimentFor(market.question);
  }

  async submitOrder({ market, side, sizeUsd }) {
    if (this.config.tradeMode !== 'live') {
      throw new Error('submitOrder called but TRADE_MODE is not live');
    }
    // Guard rail: real order signing is not implemented on purpose.
    throw new Error(
      'Live order submission is not implemented. Implement EIP-712 CLOB order ' +
      'signing here with POLY_PRIVATE_KEY before enabling real trading.'
    );
  }
}

function safeParse(v) {
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; }
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
