// Live Polymarket provider. Talks to the public Gamma API for the market
// universe and the CLOB for order books. Fair-value here is *estimated* from
// book microstructure + X sentiment (the real world does not hand you truth).
//
// NOTE: This path requires outbound network access to *.polymarket.com and,
// for live order submission, valid CLOB API credentials + a signing wallet.
//
// Real order submission uses Polymarket's official CLOB client, loaded lazily
// so the app runs without it in paper/sim mode. To enable live trading:
//     npm install @polymarket/clob-client ethers@6
// and set TRADE_MODE=live plus the POLY_* credentials in .env. Until BOTH the
// package is installed AND TRADE_MODE=live, submitOrder refuses to place orders.

export class PolymarketProvider {
  constructor(config, { xClient } = {}) {
    this.config = config;
    this.xClient = xClient;
    this.gamma = config.polymarket.gammaUrl.replace(/\/$/, '');
    this.clob = config.polymarket.clobUrl.replace(/\/$/, '');
    this._clobClient = null; // memoized official client
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

  // Lazily construct the official Polymarket CLOB client. Requires the optional
  // dependency and a signing wallet; throws a clear message if either is missing.
  async _getClobClient() {
    if (this._clobClient) return this._clobClient;

    let ClobPkg, ethers;
    try {
      ClobPkg = await import('@polymarket/clob-client');
      ethers = await import('ethers');
    } catch {
      throw new Error(
        'Live trading needs the official client: run `npm install @polymarket/clob-client ethers@6`'
      );
    }

    const { ClobClient } = ClobPkg;
    const p = this.config.polymarket;
    if (!p.privateKey) throw new Error('POLY_PRIVATE_KEY is required for live trading');

    const signer = new ethers.Wallet(p.privateKey);
    const creds = {
      key: p.apiKey,
      secret: p.apiSecret,
      passphrase: p.apiPassphrase,
    };
    // chainId 137 = Polygon mainnet, where Polymarket settles.
    this._clobClient = new ClobClient(this.clob, 137, signer, creds, undefined, p.funder || undefined);
    return this._clobClient;
  }

  // Resolve the CLOB token id for the side we want to trade.
  _tokenIdFor(market, side) {
    const ids = market._clobTokenIds;
    if (!Array.isArray(ids) || ids.length < 2) {
      throw new Error(`market ${market.id} is missing clobTokenIds`);
    }
    // Convention: index 0 = YES, index 1 = NO.
    return side === 'BUY_YES' || side === 'SELL_YES' ? ids[0] : ids[1];
  }

  async submitOrder({ market, side, sizeUsd }) {
    if (this.config.tradeMode !== 'live') {
      throw new Error('submitOrder called but TRADE_MODE is not live');
    }

    const client = await this._getClobClient();
    const ClobPkg = await import('@polymarket/clob-client');
    const { Side, OrderType } = ClobPkg;

    const tokenId = this._tokenIdFor(market, side);
    const isBuy = side.startsWith('BUY');
    // Cross the spread to fill: buy at ask, sell at bid.
    const price = isBuy ? market.bestAsk : market.bestBid;
    const size = Math.max(1, Math.floor(sizeUsd / price)); // number of shares

    const signedOrder = await client.createOrder({
      tokenID: tokenId,
      price,
      side: isBuy ? Side.BUY : Side.SELL,
      size,
      feeRateBps: 0,
    });

    // FOK/GTC: use marketable limit to take liquidity now.
    const resp = await client.postOrder(signedOrder, OrderType.GTC);
    if (!resp || resp.success === false) {
      throw new Error('CLOB rejected order: ' + JSON.stringify(resp));
    }

    return {
      accepted: true,
      avgPrice: Number(resp.price ?? price),
      slippage: Math.abs(Number(resp.price ?? price) - price),
      orderId: resp.orderID ?? resp.orderId ?? null,
      ts: Date.now(),
    };
  }
}

function safeParse(v) {
  try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return null; }
}
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
