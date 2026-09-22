# polymkt-alpha 🤖◎

> An autonomous AI trading agent for [Polymarket](https://polymarket.com) — inspired by the bot in [this TikTok](https://www.tiktok.com/@agilesingh/video/7685446237377580309).

It runs its own **research loop** on a timer: it "opens a browser" onto the
Polymarket universe (~2,000 prediction markets), **reads X/Twitter sentiment**,
estimates each market's **fair value**, hunts for **mispricing over 8%**, then
**sizes and executes** positions — all streamed to a live trading-terminal
dashboard.

**Paper trading by default. No real money moves unless you deliberately wire up
live keys.**

---

## What it does (the loop)

Every `SCAN_INTERVAL_MS` (default **10 minutes**) the agent runs six phases:

| Phase | What happens |
|-------|--------------|
| 🌐 **BROWSER** | Loads the full active-market universe (target ~2,000) |
| 🔎 **RESEARCH** | Screens by liquidity, then reads X sentiment on the most active markets |
| 📊 **ANALYZE** | Blends sentiment + book microstructure into a **fair-value estimate**; computes edge = \|fair − market\| |
| 🛡 **MANAGE** | Reviews open positions and closes on **take-profit, stop-loss, resolution, or edge-gone** before deploying new capital |
| ✅ **DECIDE** | Keeps only markets with **edge ≥ 8%**, enough liquidity, and edge that survives the spread |
| 📐 **SIZE** | **Fractional Kelly** sizing, hard-capped at **6% of equity per bet**; also respects a **60%-of-equity portfolio exposure cap** |
| ⚡ **EXECUTE** | Places a **paper fill** against the book (or a real CLOB order in live mode) |

The dashboard shows equity/P&L, an **equity curve**, a live phase pipeline, a
scrolling terminal, a mispricing radar, open positions, and a trade blotter —
updating every 2s.

---

## Quick start

```bash
npm install
npm start            # -> http://localhost:3000
```

That's it. With no configuration it runs a **built-in market simulator** (2,000
synthetic-but-realistic markets with drifting fair values, order books,
liquidity, and X-sentiment signals) so you can watch the whole system work with
**zero network access or API keys**.

To watch the loop cycle faster during a demo:

```bash
SCAN_INTERVAL_MS=45000 npm start
```

---

## 🔌 Connecting it — step by step (to actually trade / make money)

There are **three levels**. Go through them in order; do not skip to Level 3.

### Level 0 — Watch it work (no accounts, no network) ✅ you are here
```bash
npm install && npm start        # http://localhost:3000
```
Runs the simulator + paper trading. Learn the dashboard, tune the risk knobs,
convince yourself the strategy behaves. **Nothing here can lose money.**

---

### Level 1 — Paper-trade against REAL live prices (still no money at risk)
This is the honest way to see if the edge is real before risking a cent.

1. **Get an X (Twitter) API bearer token** *(optional but recommended for real
   sentiment).* Go to <https://developer.x.com> → create a project/app → copy the
   **Bearer Token**. The free tier is enough for recent-search.
2. Copy the env file and edit it:
   ```bash
   cp .env.example .env
   ```
   ```ini
   DATA_SOURCE=live          # pull the real ~2,000 Polymarket markets
   TRADE_MODE=paper          # keep fills simulated — no real orders
   X_BEARER_TOKEN=xxxxx      # optional real sentiment; leave blank to skip
   ```
3. Run it from **a machine with normal internet** (the bot needs to reach
   `gamma-api.polymarket.com` and `api.twitter.com`):
   ```bash
   npm start
   ```
4. Let it run for days/weeks. Watch the **equity curve** and **win rate**. If it
   is not profitable on paper against live prices, it will not be profitable with
   real money. Tune `EDGE_THRESHOLD`, `KELLY_FRACTION`, and the exit rules here.

> ⚠️ This sandbox/preview cannot reach Polymarket (its DNS is IPv6-only with no
> IPv6 route), so Level 1+ must be run on your own machine or a normal VPS.

---

### Level 2 — Live trading with REAL money (do this last, start tiny)

Polymarket settles on **Polygon** in **USDC**. You need a funded wallet and CLOB
API credentials.

1. **Create/fund your Polymarket account**
   - Sign up at <https://polymarket.com>, complete access requirements for your
     region, and deposit **USDC on Polygon** into your Polymarket wallet.
   - Export the **private key** of the wallet that holds the funds. Treat it like
     cash — anyone with it can drain the wallet.
2. **Generate CLOB API credentials** (key / secret / passphrase) — from the
   Polymarket CLOB (`https://clob.polymarket.com`) using their
   [API-key derivation](https://docs.polymarket.com/) flow (the official client
   below can derive them from your wallet).
3. **Install the official trading client** (kept optional so paper mode needs no
   extra deps):
   ```bash
   npm install @polymarket/clob-client ethers@6
   ```
4. **Fill in `.env`** (never commit this file — it's git-ignored):
   ```ini
   DATA_SOURCE=live
   TRADE_MODE=live
   POLY_API_KEY=...
   POLY_API_SECRET=...
   POLY_API_PASSPHRASE=...
   POLY_PRIVATE_KEY=0x....        # wallet that holds your USDC — KEEP SECRET
   POLY_FUNDER_ADDRESS=0x....     # your Polymarket funding address
   # Start tiny while you gain trust:
   BANKROLL_USD=50
   MAX_POSITION_PCT=0.02          # 2% per bet
   MAX_PORTFOLIO_EXPOSURE_PCT=0.20
   ```
5. **Start it:**
   ```bash
   npm start
   ```
   On boot the bot verifies every credential is present — **if anything is
   missing it automatically forces paper mode** and tells you. When live, the
   `EXECUTE` phase signs real EIP-712 orders and posts them to the CLOB via the
   official client (`server/providers/polymarketProvider.js`).

**Where the "connect" happens in code:** `server/providers/polymarketProvider.js`
→ `fetchMarkets()` (Gamma API), `fetchSentiment()` (X), and `submitOrder()`
(CLOB order signing). That one file is the entire bridge to the outside world.

---

### 💸 Realistic expectations

- Paper-profitable ≠ live-profitable: real fills have **slippage, fees, and
  thinner books** than the model assumes.
- Edge on prediction markets is **competitive and decays** — treat this as a
  research framework you must keep improving, not a money printer.
- **Only risk what you can afford to lose.** Prediction-market positions can go
  to **zero**. Start with `BANKROLL_USD=50` and scale only after weeks of proof.

---

## 🔬 Backtest / replay mode

Before risking anything, replay the **exact same** strategy + risk logic over
simulated history and read honest performance metrics.

**From the dashboard:** use the *"backtest / replay"* panel — set steps, step
size, edge threshold and Kelly fraction, hit **Run backtest**, and you get an
equity curve plus total return, CAGR, max drawdown, Sharpe/Sortino, win rate,
profit factor, and per-trade expectancy.

**From the CLI:**
```bash
node server/backtest-cli.js --steps 300 --stepHours 6 --edge 0.08 --kelly 0.25
```
Flags: `--steps`, `--stepHours`, `--edge`, `--kelly`, `--maxpos`, `--exposure`,
`--universe`. Great for parameter sweeps (e.g. compare `--edge 0.05` vs `0.10`).

The engine (`server/backtest.js`) drives a clock-injectable provider, resolves
each market to YES/NO at its end date, and runs the identical
`evaluateMarket` → Kelly → 6%/60% caps → take-profit/stop-loss/resolve/edge-gone
pipeline the live agent uses — so a backtest reflects the real strategy, not a
separate toy. Point it at a historical-data provider implementing the same
interface (`fetchMarkets` / `fetchSentiment` / `submitOrder` / `resolveOutcome`)
to backtest against real Polymarket history.

> ⚠️ Backtest results here run on the **simulator**, which by construction
> contains a persistent, exploitable edge. Real markets may not — a good
> simulated Sharpe is a sanity check on the *mechanics*, not a promise of
> profit. Always validate on live-data paper trading (Level 1) before Level 2.

## Configuration

All settings live in `.env` (see `.env.example`):

| Key | Default | Meaning |
|-----|---------|---------|
| `DATA_SOURCE` | `sim` | `sim` (simulator) or `live` (real Polymarket) |
| `TRADE_MODE` | `paper` | `paper` or `live` |
| `SCAN_INTERVAL_MS` | `600000` | Time between full scans (10 min) |
| `MARKET_UNIVERSE` | `2000` | How many markets to track |
| `EDGE_THRESHOLD` | `0.08` | Minimum mispricing to trade (8%) |
| `MIN_LIQUIDITY_USD` | `5000` | Skip thinner markets |
| `KELLY_FRACTION` | `0.25` | Fractional Kelly multiplier on full Kelly |
| `MAX_POSITION_PCT` | `0.06` | **Risk rail: max 6% of equity per bet** |
| `MAX_POSITION_USD` | `0` | Optional absolute $ ceiling (0 = off) |
| `MAX_PORTFOLIO_EXPOSURE_PCT` | `0.60` | Max total equity deployed at once |
| `TAKE_PROFIT_PCT` | `0.40` | Close a winner at +40% on cost |
| `STOP_LOSS_PCT` | `0.25` | Close a loser at −25% on cost |
| `EXIT_EDGE_FLOOR` | `0.02` | Close when modeled edge falls below 2% |
| `RESOLVE_THRESHOLD` | `0.97` | Treat ≥97c positions as resolved |
| `BANKROLL_USD` | `10000` | Starting paper bankroll |

---

## How position sizing works

Every bet is sized with the **Kelly criterion**, then bounded by a hard risk cap:

```
full Kelly   f*      = (b·p − q) / b          # b = net odds, p = win prob, q = 1−p
fractional          = KELLY_FRACTION · f*     # quarter-Kelly by default (smoother)
bet fraction        = min(fractional, MAX_POSITION_PCT)   # ← the 6% risk rail
bet size ($)        = bet fraction · current equity       # scales with the bankroll
```

The **6%-of-equity cap** is the safety rail: even when Kelly says "bet big" on a
huge edge, no single position can risk more than 6% of the current bankroll — so
one bad call can't wipe it out. Because the cap is a *percentage of live equity*,
bets shrink automatically after drawdowns and grow as the bankroll compounds.
When the rail binds a bet, it's flagged 🛡 in the mispricing radar and noted in
the terminal log.

### Portfolio exposure cap

On top of per-bet sizing, total capital deployed across **all** open positions
can never exceed `MAX_PORTFOLIO_EXPOSURE_PCT` of equity (default **60%**). This
keeps dry powder for fresh edges and bounds correlated blow-ups. When the cap is
hit the agent logs *"Exposure cap reached — holding dry powder"* and stops
opening new positions until something closes.

### Position exits (the MANAGE phase)

Every scan, before deploying new capital, the agent reviews open positions and
closes any that trigger a rule:

| Rule | Default | Meaning |
|------|---------|---------|
| **Take-profit** | `+40%` on cost | lock in winners |
| **Stop-loss** | `−25%` on cost | cut losers before they compound |
| **Resolved** | mark ≥ `97c` | market effectively decided — realize it |
| **Edge-gone** | edge < `2%` | thesis played out; free the capital |

Closes are realized into cash + `realizedPnl`, update the win/loss record, and
appear in the blotter tagged `CLOSE·TP / SL / RES / EDGE`.

## Architecture

```
server/
  index.js                     Express app + API + boot/safety wiring
  config.js                    Env + .env loader
  agent.js                     The research loop + activity log ("terminal")
  strategy.js                  Fair value, edge detection, Kelly sizing
  portfolio.js                 Paper-trading engine, P&L, persistence
  backtest.js                  Replay engine + performance metrics
  backtest-cli.js              Command-line backtest runner
  providers/
    simProvider.js             Built-in market + sentiment simulator
    polymarketProvider.js      Live Gamma/CLOB provider (order signing stubbed)
    xClient.js                 Live X/Twitter sentiment client
  lib/rng.js                   Deterministic PRNG for the simulator
public/                        Trading-terminal dashboard (vanilla JS)
```

The `sim` and `live` providers return the **same shape**, so the agent,
strategy, and portfolio are completely provider-agnostic — flipping to real data
is one env var.

### API

- `GET  /api/state` — full snapshot (portfolio, positions, opportunities, log)
- `GET  /api/opportunities` — current ranked mispricings
- `POST /api/scan` — force a scan now
- `POST /api/control` `{ "action": "start" | "stop" }` — pause/resume the loop
- `POST /api/backtest` `{ steps, stepHours, universe, edgeThreshold, kellyFraction, ... }` — run a replay, returns equity curve + metrics

---

## Disclaimer

This is educational software. It is **not** financial advice. Prediction-market
trading carries real risk of total loss. The default configuration never touches
real funds; enabling live trading is entirely your responsibility.
