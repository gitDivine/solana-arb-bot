# ⚡ Base Flash Loan Arbitrage Bot

Zero-capital arbitrage bot on **Base Mainnet** using **Aave V3 flash loans** to exploit price gaps between **Uniswap V3** and **Aerodrome**.

> Upgraded from: [solana-arb-bot](https://github.com/gitDivine/solana-arb-bot) (Solana) → Base Mainnet

## How It Works

```
1. WebSocket detects a swap event on Uniswap V3 or Aerodrome
2. Scanner compares prices across both DEXes
3. Net gap is calculated (raw gap - Uni fee - Aero fee - Aave fee)
4. If net gap >= 60bps, flash loan is triggered
5. Contract borrows USDC from Aave, swaps on both DEXes atomically
6. Profit stays in the contract, loan is repaid in the same transaction
```

## What Changed (vs Solana Bot)

| | Solana Bot | This Bot |
|---|---|---|
| Chain | Solana | Base Mainnet |
| Scan method | 60s HTTP polling | WebSocket real-time events |
| Capital model | Real USDC required | Flash loans (zero capital) |
| Minimum gap | 65bps gross | 60bps **net** (after all fees) |
| DEXes | Raydium, Orca, Meteora | Uniswap V3, Aerodrome |
| Trade execution | 2 separate transactions | 1 atomic transaction |
| Failure cost | Real money at risk | ~$0.15 gas only |

## Safety Features

- **Net profit math** — subtracts Uniswap fee (30bps), Aerodrome fee (20bps), and Aave fee (5bps) before firing
- **Price cross-validation** — rejects pairs where Uni/Aero prices differ by >2x (decode errors)
- **Sanity check** — blocks any raw gap >500bps (likely broken price feed)
- **Synchronous trade locking** — prevents concurrent flash loan execution
- **Aerodrome pool routing** — try/catch volatile→stable fallback in the smart contract
- **WebSocket watchdog** — logs block numbers every 15s to detect silent disconnects
- **Dry run mode** — simulate everything without spending gas

## Setup

### Prerequisites
- Node.js 18+
- An Alchemy account (for Base RPC — HTTP + WebSocket)
- MetaMask wallet with ETH on Base (for gas)
- Remix IDE (for contract deployment)

### 1. Deploy the Smart Contract

1. Open [Remix IDE](https://remix.ethereum.org)
2. Create a new file and paste the contents of `contracts/ArbBot.sol`
3. **Compiler settings:**
   - Solidity version: `0.8.20` or higher
   - Enable optimization (200 runs)
   - Enable **Via IR**
4. **Deploy:**
   - Environment: Injected Provider (MetaMask on Base Mainnet)
   - Click Deploy and confirm in MetaMask
5. Copy the deployed contract address

### 2. Configure Environment

```bash
cp .env.example .env
```

Fill in your `.env`:
```env
PRIVATE_KEY=your_metamask_private_key
CONTRACT_ADDRESS=0x_your_deployed_contract_address
BASE_HTTP_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
BASE_WS_URL=wss://base-mainnet.g.alchemy.com/v2/YOUR_KEY

# Optional
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
DRY_RUN=true
```

> ⚠️ **Start with `DRY_RUN=true`** to verify the bot detects gaps correctly before going live.

### 3. Install & Run

```bash
npm install
npm run build
npm start
```

## Configuration

All settings are in `src/config.ts`:

| Setting | Default | Description |
|---|---|---|
| `minProfitBps` | `60` | Minimum **net** gap (after fees) to trigger a trade |
| `minProfitUsdc` | `2` | Minimum USD profit from Quoter simulation |
| `flashLoanAmount` | `30000` | USDC flash loan size |
| `cooldownMs` | `2000` | Minimum time between trades |
| `maxGasGwei` | `10` | Maximum gas price to execute |

### Fee Breakdown

For a trade using a Uniswap `fee=3000` pool:
```
Uniswap V3 fee:    30bps (fee/100)
Aerodrome fee:     20bps (volatile pool)
Aave flash fee:     5bps (0.05%)
─────────────────────────
Total costs:       55bps
+ Profit buffer:    5bps
─────────────────────────
Min raw gap:      115bps needed → 60bps net profit
```

## Files

| File | Description |
|---|---|
| `contracts/ArbBot.sol` | Flash loan arbitrage smart contract (Aave + Uni + Aero) |
| `src/config.ts` | All configuration and token addresses |
| `src/scanner.ts` | WebSocket price gap detector with net profit math |
| `src/executor.ts` | Flash loan trade executor with synchronous locking |
| `src/wallet.ts` | EVM wallet manager with manual calldata encoding |
| `src/discovery.ts` | Token discovery via DexScreener API |
| `src/logger.ts` | Logging + Telegram alerts |
| `src/index.ts` | Entry point |

## Smart Contract

The `ArbBot.sol` contract handles the atomic arbitrage:

- **`startArbitrage()`** — initiates the Aave flash loan
- **`executeOperation()`** — callback that performs the two swaps
- **`_buyUniSellAero()`** — buy on Uniswap, sell on Aerodrome
- **`_buyAeroSellUni()`** — buy on Aerodrome, sell on Uniswap
- **`_aeroSwap()`** — Aerodrome swap with volatile→stable fallback
- **`withdrawToken()`** / **`withdrawEth()`** — withdraw profits

## Understanding the Logs

```
AERO | Uni: 3.01 | Aero: 3.00 | raw gap: 32.6bps | net gap: -22.4bps
```
- **raw gap**: pure price difference between DEXes
- **net gap**: after subtracting all fees (what actually matters)
- Negative net gap = guaranteed loss, bot correctly skips

```
BRETT | price mismatch (2408.5x) — Uni: 0.055 vs Aero: 134.07 — skipping
```
- Cross-validation caught a broken Aerodrome price decode

```
AERO | gap 24071822bps rejected — likely price decode error
```
- Sanity check blocked an insane gap from firing

---

## Deploy to an Ubuntu VPS

**1. Log into your server**
```bash
ssh root@YOUR_SERVER_IP
```

**2. Install Node.js**
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**3. Clone & install**
```bash
git clone https://github.com/gitDivine/base-arb-bot.git
cd base-arb-bot
npm install
```

**4. Create `.env`**
```bash
nano .env
```
Paste your environment variables (same as your local `.env`). Press `Ctrl+O` to save, `Ctrl+X` to exit.

**5. Run 24/7 with PM2**
```bash
sudo npm install -g pm2
pm2 start npm --name "base-bot" -- start
pm2 logs base-bot    # watch live output
pm2 save             # persist across reboots
```

---

## Deploy to Railway.app

1. Go to [Railway.app](https://railway.app/) → **New Project** → **Deploy from GitHub repo**
2. Select your `base-arb-bot` repository
3. Add environment variables in the **Variables** tab
4. Railway auto-builds and deploys — view logs in the **Deployments** tab

---

## License

MIT
