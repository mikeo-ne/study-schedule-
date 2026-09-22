// Optional live X (Twitter) sentiment client. Uses recent-search on the v2 API
// and a lightweight lexicon scorer. Requires X_BEARER_TOKEN. When absent, the
// strategy falls back to the provider's own sentiment signal.

const POS = ['win', 'wins', 'winning', 'bullish', 'yes', 'likely', 'confirmed', 'strong', 'up', 'surge', 'beat', 'lead', 'ahead', 'gain', 'rally', 'lock'];
const NEG = ['lose', 'loses', 'losing', 'bearish', 'no', 'unlikely', 'denied', 'weak', 'down', 'crash', 'miss', 'behind', 'drop', 'fade', 'doubt', 'fail'];

export class XClient {
  constructor(bearerToken) {
    this.token = bearerToken;
  }

  async sentimentFor(query) {
    const q = encodeURIComponent(`${trimQuery(query)} -is:retweet lang:en`);
    const url = `https://api.twitter.com/2/tweets/search/recent?query=${q}&max_results=100&tweet.fields=public_metrics`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!res.ok) throw new Error(`X API HTTP ${res.status}`);
    const data = await res.json();
    const tweets = data.data || [];
    let bullish = 0, bearish = 0;
    for (const t of tweets) {
      const s = scoreText(t.text);
      if (s > 0) bullish++;
      else if (s < 0) bearish++;
    }
    const posts = tweets.length;
    const score = posts ? (bullish - bearish) / posts : 0;
    return { score: round4(score), posts, bullish, bearish };
  }
}

function trimQuery(q) {
  // Reduce a market question to a few salient keywords for search.
  return q.replace(/[?"']/g, '').split(/\s+/).filter((w) => w.length > 3).slice(0, 5).join(' ');
}

function scoreText(text) {
  const t = text.toLowerCase();
  let s = 0;
  for (const w of POS) if (t.includes(w)) s++;
  for (const w of NEG) if (t.includes(w)) s--;
  return s;
}

const round4 = (x) => Math.round(x * 10000) / 10000;
