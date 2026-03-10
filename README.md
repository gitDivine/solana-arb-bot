# ⚡ Base Flash Loan Arbitrage Bot

Zero-capital arbitrage on **Base** using Aave V3 flash loans across **Uniswap V3** and **Aerodrome**.

## Quick Start

### 1. Clone & Install

```bash
git clone https://github.com/gitDivine/base-arb-bot.git
cd base-arb-bot
npm install
```

### 2. Configure

```bash
cp .env.example .env
```

Open `.env` and fill in:

| Variable | Where to get it |
|---|---|
| `PRIVATE_KEY` | MetaMask → Account Details → Export Private Key |
| `BASE_HTTP_URL` | [Alchemy](https://alchemy.com) → Create App → Base Mainnet → HTTPS URL |
| `BASE_WS_URL` | Same Alchemy app → WebSocket URL |

> Your wallet needs a small amount of ETH on Base for gas (~$5–10).

### 3. Deploy the Contract

```bash
npm run deploy
```

This compiles `contracts/ArbBot.sol`, deploys it to Base, and **auto-updates** your `.env` with the new contract address. No Remix needed.

### 4. Run

```bash
npm start
```

The bot will start scanning for price gaps between Uniswap V3 and Aerodrome in real-time via WebSocket.

## Configuration

Edit `src/config.ts` to tune the bot:

| Setting | Default | Description |
|---|---|---|
| `minProfitBps` | `60` | Minimum net gap after fees to fire |
| `flashLoanAmount` | `30000` | USDC flash loan size |
| `cooldownMs` | `2000` | Minimum time between trades |

## How It Works

```
Swap event detected → Compare prices on Uni vs Aero
→ Subtract fees (Uni 30bps + Aero 20bps + Aave 5bps)
→ If net gap >= 60bps → Borrow $30k USDC via flash loan
→ Buy on cheap DEX, sell on expensive DEX
→ Repay loan + keep profit — all in one transaction
```

## Safety Features

- **Net profit math** — only fires when profitable after all fees
- **Price cross-validation** — rejects broken price feeds (>2x mismatch)
- **Gap sanity check** — blocks insane gaps >500bps
- **Dry run mode** — set `DRY_RUN=true` in `.env` to simulate without spending gas
- **Volatile/stable fallback** — contract auto-routes through correct Aerodrome pool

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PRIVATE_KEY` | ✅ | Wallet private key |
| `CONTRACT_ADDRESS` | Auto | Filled by `npm run deploy` |
| `BASE_HTTP_URL` | ✅ | Alchemy HTTP RPC |
| `BASE_WS_URL` | ✅ | Alchemy WebSocket RPC |
| `DRY_RUN` | No | `true` to simulate (default: `false`) |
| `TELEGRAM_BOT_TOKEN` | No | Telegram alerts |
| `TELEGRAM_CHAT_ID` | No | Telegram alerts |

## Advanced Deployment

See [ADVANCED.md](ADVANCED.md) for manual Remix deployment, VPS hosting with PM2, and Railway.app cloud deployment.

## License

MIT
