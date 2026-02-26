# Solana Cross-DEX Arbitrage Bot

An automated bot that finds price differences for the same token across different Solana decentralized exchanges (DEXes) and profits from them. For example, if JUP costs $1.00 on Raydium but $1.01 on Whirlpool, the bot buys low on Raydium and sells high on Whirlpool, pocketing the difference.

**Zero-cost infrastructure** — runs entirely on free APIs. No paid servers or subscriptions needed.

---

## What Is Arbitrage?

When the same token has different prices on different exchanges, that's an "arbitrage opportunity." This bot:
1. **Discovers** tokens that trade on multiple Solana DEXes
2. **Scans** prices across those DEXes every 60 seconds
3. **Executes** buy-low-sell-high trades when the price gap is large enough to profit after fees

```
  ┌─────────────────────────────────────────────┐
  │  1. TOKEN DISCOVERY (every 10 minutes)       │
  │     Finds tokens listed on 2+ DEXes          │
  │     Filters by trading volume & liquidity     │
  └──────────────────┬──────────────────────────┘
                     │
  ┌──────────────────▼──────────────────────────┐
  │  2. PRICE SCANNING (every 60 seconds)        │
  │     For each token:                           │
  │       "How much JUP do I get for $10 on       │
  │        Raydium vs Whirlpool vs Meteora?"      │
  │     Compares all prices, finds gaps            │
  └──────────────────┬──────────────────────────┘
                     │ price gap > 0.5%?
  ┌──────────────────▼──────────────────────────┐
  │  3. TRADE EXECUTION                          │
  │     Double-checks the price is still good     │
  │     Buys token on the cheap DEX               │
  │     Sells token on the expensive DEX          │
  │     Sends you a Telegram notification          │
  └─────────────────────────────────────────────┘
```

### Which DEXes Does It Monitor?
- **Raydium** (+ Raydium CLMM) — largest Solana DEX
- **Orca Whirlpool** — concentrated liquidity DEX
- **Meteora DLMM** — dynamic liquidity market maker
- **Phoenix** — order book DEX
- **Lifinity V2** — proactive market maker

### How Does It Avoid Losing Money?

The bot has multiple safety layers that prevent bad trades:

| Safety Check | What It Does |
|-------------|-------------|
| **Re-quote validation** | Before trading, re-checks the price at your actual trade size. If the gap shrunk, it cancels. |
| **Price impact limit** | Rejects any trade that would move the price more than 1% (your trade is too big for the pool). |
| **Slippage protection** | Sets a 0.5% maximum slippage so you won't get a worse price than expected. |
| **Minimum profit threshold** | Only trades when the gap is ≥0.5% (50 basis points), which covers the ~0.4% in Jupiter fees. |
| **Stuck token recovery** | If the buy succeeds but the sell fails, automatically sells the token back to USDC so you're not stuck holding it. |
| **Auto-refuel** | When SOL (needed for gas/transaction fees) gets low, automatically converts $1 USDC → SOL. |
| **Dry run mode** | Test the bot without real money by setting `DRY_RUN=true`. |

### Fee Math (Why 0.65%?)

Every trade has three layers of costs. The bot accounts for all of them:

| Cost | Per Trade | Explanation |
|------|-----------|-------------|
| Jupiter platform fee | ~0.40% | 0.20% × 2 swaps — automatically deducted from the quotes |
| Priority fee (gas tip) | ~0.10% | 50,000 lamports × 2 swaps to get fast inclusion (~$0.02 total) |
| Solana base fee | ~0.015% | Fixed ~$0.003 regardless of trade size |
| **Total costs** | **~0.515%** | |

The bot sets the minimum gap to **0.65%** (65 basis points), giving a safety buffer of ~0.13% net profit per trade after all fees.

---

## What You Need Before Starting

1. **Node.js** (version 18 or higher)
   - Download from [nodejs.org](https://nodejs.org) — pick the LTS version
   - To check if you have it: open a terminal and type `node --version`

2. **A Solana wallet** with some funds
   - Install [Phantom](https://phantom.app) browser extension if you don't have one
   - You need **SOL** (at least 0.05 SOL, ~$10) for transaction fees
   - You need **USDC** for trading capital — this is the money the bot trades with

3. **A free Helius API key** (for sending transactions to Solana)
   - Go to [helius.dev](https://helius.dev) and sign up (free)
   - Create a project and copy your **mainnet RPC URL**
   - It looks like: `https://mainnet.helius-rpc.com/?api-key=abc123...`

4. **A Telegram bot** (optional, but recommended — sends you alerts when trades happen)
   - Open Telegram, search for `@BotFather`, send `/newbot`
   - Follow the prompts, copy the **bot token** it gives you
   - Send any message to your new bot, then visit: `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates`
   - Look for `"chat":{"id":123456}` — that number is your **chat ID**

---

## Setup (Step by Step)

### Step 1: Download the bot

Open a terminal (Command Prompt, PowerShell, or Terminal on Mac) and run:

```bash
git clone https://github.com/gitDivine/solana-arb-bot.git
cd solana-arb-bot
```

### Step 2: Install dependencies

```bash
npm install
```

This downloads all the libraries the bot needs. Takes about 30 seconds.

### Step 3: Set up your secret keys

Copy the example config file:

```bash
# On Mac/Linux:
cp .env.example .env

# On Windows (Command Prompt):
copy .env.example .env
```

Now open the `.env` file in any text editor (VS Code, Notepad, etc.) and fill in your values:

```env
# REQUIRED — the bot won't start without these

# Your Solana wallet private key (base58 encoded)
# How to get it: Open Phantom → Settings → Security & Privacy → Export Private Key
# ⚠️  NEVER share this with anyone. NEVER commit this file to GitHub.
SOLANA_PRIVATE_KEY=paste_your_private_key_here

# Your Helius RPC URL
# How to get it: Sign up at helius.dev → Create project → Copy mainnet RPC URL
HELIUS_RPC_URL=https://mainnet.helius-rpc.com/?api-key=paste_your_key_here

# OPTIONAL — for Telegram trade alerts

# Your Telegram bot token (from @BotFather)
TELEGRAM_BOT_TOKEN=
# Your Telegram chat ID (from the getUpdates URL above)
TELEGRAM_CHAT_ID=

# Set to true to scan without actually trading (safe testing mode)
DRY_RUN=false
```

### Step 4: Build and run the bot

```bash
# Compile the TypeScript code (required on first run)
npm run build

# Start the bot
node dist/index.js
```

> **Note:** `npm run build` compiles the code into the `dist/` folder. You only need to re-run it when the code changes. After that, `node dist/index.js` starts the bot.
>
> Alternatively, `npm start` runs the bot directly without a separate build step (using ts-node), but it's slower to start.

You should see output like:

```
  Solana Arbitrage Scanner v2.0
  Long-Tail Token Mode

  Starting initial token discovery...

[12:00:00] Discovery | 24 candidates scanned | 24 tokens on watchlist
  Initializing execution engine...
  Wallet: 35GhfeRK...LvZD
  SOL: 0.0500 | USDC: 50.00
  Mode: LIVE

[12:01:00] Cycle #1 | 24 pairs | 50 quotes | 0 opportunities | closest: -3bps
```

If you see `USDC: 0.00` on the first try, just stop (`Ctrl+C`) and restart — it's a temporary connection issue.

### Step 5: Keep it running 24/7 (Linux/Mac/WSL)

The bot needs to run continuously to catch opportunities. Use `tmux` to keep it alive:

```bash
# Start a background session
tmux new -s arb

# Run the bot
cd /path/to/solana-arb-bot && npm start

# Detach (bot keeps running): press Ctrl+B, then D

# Later, to check on it:
tmux attach -t arb
```

On Windows without WSL, you can just leave the terminal window open.

---

## Configuration Guide

All settings are in `src/config.ts`. You can adjust these to change the bot's behavior.

### Trade Settings

| Setting | Default | What It Means |
|---------|---------|---------------|
| `minExecutionBps` | 50 | Only trade if the price gap is ≥0.5%. Higher = safer but fewer trades. |
| `maxPriceImpactPct` | 1.0 | Cancel trade if it would move the pool price by >1%. |
| `tradePercentage` | 1.00 | Use 100% of your USDC balance per trade. Set to 0.5 for 50%, etc. |
| `dryRun` | false | Set to `true` to scan without executing real trades. Good for testing. |
| `cooldownAfterTradeMs` | 10,000 | Wait 10 seconds between trades. |

### Token Discovery Settings

| Setting | Default | What It Means |
|---------|---------|---------------|
| `minDailyVolume` | $10,000 | Only watch tokens with at least $10K daily trading volume. |
| `maxDailyVolume` | $5,000,000 | Skip tokens over $5M volume (too many competing bots). |
| `minLiquidityUsd` | $2,000 | Skip pools with less than $2K liquidity (too thin). |
| `scanIntervalMs` | 60,000 | Scan prices every 60 seconds. |

### Auto-Refuel Settings

| Setting | Default | What It Means |
|---------|---------|---------------|
| `refuelSolThreshold` | 0.02 SOL | When SOL drops below this, auto-buy more SOL. |
| `refuelUsdcAmount` | $1 | Swap $1 USDC → SOL when refueling. |

---

## Project Structure

```
solana-arb-bot/
├── .env.example      ← Template for your secret keys
├── .env              ← Your actual secrets (never committed to git)
├── package.json      ← Dependencies and scripts
├── tsconfig.json     ← TypeScript configuration
├── README.md         ← This file
└── src/
    ├── index.ts       ← Main entry point — starts everything
    ├── config.ts      ← All bot settings (thresholds, DEXes, tokens)
    ├── types.ts       ← TypeScript type definitions
    ├── discovery.ts   ← Finds new tokens via Jupiter + DexScreener
    ├── scanner.ts     ← Compares prices across DEXes
    ├── executor.ts    ← Executes trades with safety checks
    ├── wallet.ts      ← Wallet management (balances, signing)
    ├── logger.ts      ← Logging + Telegram alerts
    └── rate-limiter.ts ← Prevents API rate limit errors
```

---

## Free APIs Used

| Service | What For | Cost |
|---------|----------|------|
| [Jupiter](https://public.jupiterapi.com) | Price quotes and swap transactions | Free, no key needed |
| [DexScreener](https://api.dexscreener.com) | Finding which tokens are on which DEXes | Free, no key needed |
| [Helius](https://helius.dev) | Sending transactions to Solana blockchain | Free tier (1M requests/month) |

---

## Telegram Alerts

If configured, the bot sends you real-time messages for:
- New arbitrage opportunities detected
- Trades executed (with profit amount and Solscan transaction link)
- Auto-refuel events (bought more SOL for gas)
- Errors or stuck token recovery

---

## FAQ / Troubleshooting

**Q: The bot shows `USDC: 0.00` on startup**
A: This is a temporary RPC connection issue. Stop the bot (`Ctrl+C`) and restart it. Usually works on the second try.

**Q: The bot runs but shows "0 opportunities" every cycle**
A: This is normal. The Solana arbitrage market is very competitive — professional bots close most gaps in milliseconds. This bot scans every 60 seconds, so it catches opportunities that others miss on less popular tokens. Be patient, or lower `minExecutionBps` (at your own risk).

**Q: What does "scan-only mode" mean?**
A: The bot couldn't connect to your wallet on startup (usually an RPC error). Restart it.

**Q: Can I lose money?**
A: The safety checks make it very unlikely per trade. The main risks are:
1. Price moves between the buy and sell swaps (rare, checked by re-quote)
2. SOL gas fees on failed transactions (~$0.003 per attempt)
3. If a token gets stuck, the recovery swap may have some slippage

**Q: How much USDC should I start with?**
A: Any amount works. The bot trades with whatever USDC you have (minus $1 reserve for gas refueling). More capital = more profit per trade, but opportunities are the same regardless of size.

**Q: Can I run this on a VPS/cloud server?**
A: Yes. Any Linux server with Node.js 18+ works. Use `tmux` or `pm2` to keep it running.

---

## Important Warnings

- **Never share your `.env` file or private key with anyone.**
- **`onlyDirectRoutes` must stay enabled** in the code. Disabling it creates fake arbitrage signals that look profitable but aren't real.
- **The bot uses real money in LIVE mode.** Start with `DRY_RUN=true` to test safely first.
- **Market competition is fierce.** Don't expect guaranteed profits. This works best on long-tail tokens with lower competition.

---

## License

MIT — free to use, modify, and distribute.
