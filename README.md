# Solana Cross-DEX Arbitrage Bot

Automated arbitrage bot that scans for price differences across Solana DEXes and executes profitable trades. Uses the Jupiter Quote API to compare prices on the same token across different DEXes, then executes round-trip swaps when the spread exceeds fees.

**Zero-cost infrastructure** — runs on free APIs with no paid RPC or VPS required.

## How It Works

```
                    ┌─────────────────────────────────────┐
                    │         Token Discovery              │
                    │   Jupiter token list + DexScreener   │
                    │   → finds tokens on 2+ DEXes         │
                    │   → filters by volume & liquidity    │
                    │   → refreshes every 10 minutes       │
                    └──────────────┬──────────────────────┘
                                   │
                    ┌──────────────▼──────────────────────┐
                    │          Price Scanner                │
                    │   For each token on the watchlist:    │
                    │   → quote USDC→Token on DEX A        │
                    │   → quote Token→USDC on DEX B        │
                    │   → calculate round-trip profit       │
                    │   → every 60 seconds                  │
                    └──────────────┬──────────────────────┘
                                   │ gap ≥ 50 bps?
                    ┌──────────────▼──────────────────────┐
                    │         Trade Execution               │
                    │   1. Re-quote at full trade size      │
                    │   2. Verify still profitable (≥50bps) │
                    │   3. Check price impact (<1%)         │
                    │   4. Execute buy swap (USDC→Token)    │
                    │   5. Execute sell swap (Token→USDC)   │
                    │   6. Send Telegram notification       │
                    └─────────────────────────────────────┘
```

### DEXes Monitored
- Raydium / Raydium CLMM
- Orca Whirlpool
- Meteora DLMM
- Phoenix
- Lifinity V2

### Safety Mechanisms
- **Re-quote validation** — re-checks price at actual trade size before executing. Rejects if profit drops below 50 bps.
- **Price impact check** — rejects any quote with >1% price impact.
- **Slippage tolerance** — 0.5% slippage tolerance on all swaps.
- **Direct routes only** — uses `onlyDirectRoutes` to prevent multi-hop routing artifacts.
- **Stuck token recovery** — if a buy succeeds but sell fails, automatically recovers the token back to USDC.
- **Auto-refuel** — swaps $1 USDC → SOL when SOL balance drops below 0.02, keeping the bot self-sustaining.
- **Dry run mode** — set `DRY_RUN=true` to scan without executing any trades.

### Profitability Math
Each Jupiter swap has a ~20 bps platform fee. A round-trip (buy + sell) costs ~40 bps in fees. The bot only executes when the price gap is ≥50 bps, ensuring at least 10 bps net profit per trade after fees.

## Prerequisites

- **Node.js** v18 or higher
- **Solana wallet** with SOL (for gas) and USDC (for trading)
- **Helius RPC** — free tier at [helius.dev](https://helius.dev) (1M credits/month)
- **Telegram bot** (optional) — for real-time trade alerts

## Quick Start

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/solana-arb-bot.git
cd solana-arb-bot
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
# REQUIRED
SOLANA_PRIVATE_KEY=your_base58_private_key_here
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY_HERE

# OPTIONAL
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id
DRY_RUN=false
```

**Getting your private key:** In Phantom wallet, go to Settings > Security & Privacy > Export Private Key. Copy the base58-encoded string.

**Getting a Helius key:** Sign up at [helius.dev](https://helius.dev), create a project, and copy your mainnet RPC URL.

### 3. Fund your wallet

The bot needs:
- **SOL** — at least 0.05 SOL for gas fees (~$10 at current prices)
- **USDC** — the trading capital. The bot trades with 100% of USDC balance minus a $1 reserve for auto-refuel.

On first startup, if you only have SOL, the bot will automatically bootstrap by swapping a small amount of SOL → USDC.

### 4. Run the bot

```bash
# Development (uses ts-node, no compile step)
npm start

# Production (compile first, then run)
npm run build
node dist/index.js
```

### 5. Run 24/7 (recommended)

Use tmux to keep the bot running after closing your terminal:

```bash
tmux new -s arb
cd /path/to/solana-arb-bot && npm start
# Press Ctrl+B then D to detach
# Reconnect later: tmux attach -t arb
```

## Configuration

All settings are in `src/config.ts`. Key parameters:

### Execution Settings (`EXECUTION_CONFIG`)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `minExecutionBps` | 50 | Minimum basis points to trigger a trade |
| `maxPriceImpactPct` | 1.0 | Maximum price impact allowed (%) |
| `tradePercentage` | 1.00 | Fraction of USDC balance to trade (1.0 = 100%) |
| `refuelSolThreshold` | 0.02 SOL | SOL balance that triggers auto-refuel |
| `refuelUsdcAmount` | $1 | USDC swapped to SOL when refueling |
| `cooldownAfterTradeMs` | 10,000 | Milliseconds to wait between trades |
| `priorityFeeLamports` | 50,000 | Priority fee for transaction inclusion |
| `dryRun` | false | Set to true to scan without executing |

### Discovery Settings (`DISCOVERY_CONFIG`)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `minDailyVolume` | $10,000 | Minimum 24h trading volume |
| `maxDailyVolume` | $5,000,000 | Maximum 24h volume (above = too competitive) |
| `minDexCount` | 2 | Token must be on at least N DEXes |
| `minLiquidityUsd` | $2,000 | Minimum liquidity per pool |
| `scanIntervalMs` | 60,000 | Milliseconds between scan cycles |
| `discoveryIntervalMs` | 600,000 | Milliseconds between discovery cycles |

## Architecture

```
src/
  index.ts          Main entry — starts discovery loop + scan loop
  config.ts         All configuration (tokens, DEXes, thresholds)
  types.ts          TypeScript interfaces
  scanner.ts        Jupiter Quote API price scanning
  discovery.ts      Token discovery via Jupiter + DexScreener
  executor.ts       Trade execution engine (wallet, swaps, safety checks)
  wallet.ts         Solana wallet management (balances, signing)
  logger.ts         Console output, file logging, Telegram alerts
  rate-limiter.ts   Token-bucket rate limiter for API calls
```

### Data Flow

1. **Discovery** (every 10 min): Downloads Jupiter token list → filters by tags → checks DexScreener for multi-DEX presence → adds qualifying tokens to watchlist
2. **Scanning** (every 60s): For each watchlist token, fetches quotes on each DEX via Jupiter → calculates round-trip profit → flags opportunities ≥50 bps
3. **Execution**: Re-quotes at full trade size → validates profit still exists → executes buy swap → executes sell swap → sends Telegram alert

### APIs Used (all free)

| API | Purpose | Rate Limit |
|-----|---------|------------|
| [Jupiter Quote API](https://public.jupiterapi.com) | Price quotes & swap transactions | ~600 req/min |
| [Jupiter Token List](https://cache.jup.ag/tokens) | Token candidate discovery | Cached 24h |
| [DexScreener](https://api.dexscreener.com) | Multi-DEX validation & volume data | ~3 req/sec |
| [Helius RPC](https://helius.dev) | Transaction submission & balance checks | 1M credits/month (free) |

## Telegram Alerts

When configured, the bot sends real-time alerts for:
- Arbitrage opportunities detected
- Trades executed (with profit/loss and Solscan link)
- Auto-refuel events (USDC → SOL)
- Bootstrap events (initial SOL → USDC swap)
- Errors and stuck token recovery

## Important Notes

- **`onlyDirectRoutes` must stay enabled.** Disabling it causes phantom arbitrage signals from multi-hop routing differences (tested: showed $912K fake profit that doesn't actually exist).
- **Jupiter platform fee is ~20 bps per swap.** Round-trip costs ~40 bps. Only gaps ≥50 bps are profitable.
- **Market is competitive.** Professional MEV bots close gaps in milliseconds. This bot scans every 60s, so opportunities at the 50 bps threshold are rare. It works best on long-tail tokens with lower competition.
- **Free-tier RPC can be flaky.** Helius free tier occasionally drops connections. The bot handles this gracefully and recovers on the next cycle.

## License

MIT
