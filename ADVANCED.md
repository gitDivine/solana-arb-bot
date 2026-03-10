# Advanced Deployment Guide

## Manual Contract Deployment (Remix IDE)

If you prefer to deploy manually instead of using `npm run deploy`:

### 1. Open Remix
- Go to [remix.ethereum.org](https://remix.ethereum.org)
- Create a new file and paste the contents of `contracts/ArbBot.sol`

### 2. Compile
- Solidity version: `0.8.20` or higher
- Enable optimization (200 runs)
- Enable **Via IR**
- Click **Compile ArbBot.sol**

### 3. Deploy
- Environment: **Injected Provider - MetaMask** (on Base Mainnet)
- Click **Deploy** and confirm in MetaMask
- Copy the deployed contract address
- Paste it into `CONTRACT_ADDRESS` in your `.env`

---

## Deploy to an Ubuntu VPS (DigitalOcean / AWS)

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
Paste your environment variables. Press `Ctrl+O` to save, `Ctrl+X` to exit.

**5. Deploy the contract**
```bash
npm run deploy
```

**6. Run 24/7 with PM2**
```bash
sudo npm install -g pm2
pm2 start npm --name "base-bot" -- start
pm2 logs base-bot     # watch live output
pm2 save              # persist across reboots
```

---

## Deploy to Railway.app

1. Go to [Railway.app](https://railway.app/) → **New Project** → **Deploy from GitHub repo**
2. Select your `base-arb-bot` repository
3. Add environment variables in the **Variables** tab
4. Railway auto-builds and deploys — view logs in the **Deployments** tab
