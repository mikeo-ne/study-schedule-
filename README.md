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
| ✅ **DECIDE** | Keeps only markets with **edge ≥ 8%**, enough liquidity, and edge that survives the spread |
| 📐 **SIZE** | **Fractional Kelly** sizing, hard-capped at **6% of equity per bet** so one bad call can't wipe the bankroll |
| ⚡ **EXECUTE** | Places a **paper fill** against the book (or a guarded live order) |

The dashboard shows equity/P&L, a live phase pipeline, a scrolling terminal, a
mispricing radar, open positions, and a trade blotter — updating every 2s.

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

## Going live (real Polymarket data)

Copy `.env.example` → `.env` and set:

```ini
DATA_SOURCE=live            # use the real Polymarket Gamma/CLOB APIs
X_BEARER_TOKEN=...          # optional: real X sentiment (v2 recent search)
```

This pulls real markets and (if a token is set) real X sentiment, while still
**paper trading** the results — a completely safe way to backtest the strategy
against live prices.

> Requires outbound network access to `*.polymarket.com` and `api.twitter.com`.

---

## Going live (real orders) — read this

Real trading is **intentionally gated** behind two things:

1. `TRADE_MODE=live` **and** complete CLOB credentials in `.env`
   (`POLY_API_KEY`, `POLY_API_SECRET`, `POLY_API_PASSPHRASE`, `POLY_PRIVATE_KEY`).
   If any are missing the app **forces paper mode** on boot.
2. Implementing EIP-712 CLOB order signing in
   `server/providers/polymarketProvider.js` (`submitOrder`), which currently
   **throws on purpose** so the bot cannot move funds by accident.

Prediction markets are real money and can go to zero. Only you can flip these
switches — do so at your own risk, ideally with tiny size first.

---

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

## Architecture

```
server/
  index.js                     Express app + API + boot/safety wiring
  config.js                    Env + .env loader
  agent.js                     The research loop + activity log ("terminal")
  strategy.js                  Fair value, edge detection, Kelly sizing
  portfolio.js                 Paper-trading engine, P&L, persistence
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

---

## Disclaimer

This is educational software. It is **not** financial advice. Prediction-market
trading carries real risk of total loss. The default configuration never touches
real funds; enabling live trading is entirely your responsibility.
