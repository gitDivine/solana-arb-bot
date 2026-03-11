// index.ts — Main entry point (updated for Base)
import * as dotenv from 'dotenv';
dotenv.config();
import { CONFIG } from './config';
import { WalletManager } from './wallet';
import { Scanner } from './scanner';
import { Executor } from './executor';
import { Discovery } from './discovery';
import { Logger } from './logger';
import { RateLimiter } from './rate-limiter';
import { execSync } from 'child_process';

function autoUpdate(): void {
  try {
    console.log('[Update] Checking for updates...');
    const pullResult = execSync('git pull', { encoding: 'utf8', timeout: 15000 }).trim();
    console.log(`[Update] ${pullResult}`);
    if (pullResult !== 'Already up to date.' && pullResult !== 'Already up-to-date.') {
      console.log('[Update] New code pulled — installing dependencies...');
      execSync('npm install --omit=dev', { encoding: 'utf8', timeout: 30000 });
      console.log('[Update] Dependencies updated ✓');
    }
  } catch (err: any) {
    console.warn('[Update] Auto-update skipped:', err.message);
  }
}

async function main() {
  autoUpdate();
  const logger = new Logger();
  const rateLimiter = new RateLimiter(30, 1000);
  const wallet = new WalletManager();
  const scanner = new Scanner(wallet, logger, rateLimiter);
  const executor = new Executor(wallet, logger);
  const discovery = new Discovery(logger, rateLimiter);

  console.log('\n  ╔══════════════════════════════════════╗');
  console.log('  ║   Base Flash Loan Arbitrage Bot v1   ║');
  console.log('  ║   Chain: Base Mainnet                ║');
  console.log('  ║   DEXes: Uniswap V3 + Aerodrome      ║');
  console.log('  ║   Loans: Aave V3 (zero capital)      ║');
  console.log('  ╚══════════════════════════════════════╝\n');

  // Validate config
  if (!CONFIG.wallet.privateKey) throw new Error('Missing PRIVATE_KEY in .env');
  if (!CONFIG.wallet.contractAddress) throw new Error('Missing CONTRACT_ADDRESS in .env');
  if (!CONFIG.chain.rpcWs) throw new Error('Missing BASE_WS_URL in .env');
  if (!CONFIG.chain.rpcHttp) throw new Error('Missing BASE_HTTP_URL in .env');

  // Show wallet info
  const ethBal = await wallet.getEthBalance();
  const usdcBal = await wallet.getUsdcBalance();
  logger.info('Wallet', `Address: ${wallet.signer.address.slice(0, 10)}...`);
  logger.info('Wallet', `ETH: ${ethBal.toFixed(4)} | USDC: ${usdcBal.toFixed(2)} | Mode: ${CONFIG.dryRun ? 'DRY RUN' : 'LIVE'}`);
  logger.info('Config', `Min gap: ${CONFIG.arb.minProfitBps}bps | Flash loan: $${CONFIG.arb.flashLoanAmount.toLocaleString()} | Min profit: $${CONFIG.arb.minProfitUsdc}`);

  // Warn if ETH is low
  if (ethBal < 0.001 && !CONFIG.dryRun) {
    logger.warn('Wallet', 'ETH balance is very low — top up to cover gas fees');
  }

  // ── Immediate Telegram startup ping ──
  await logger.sendTelegram(
    `🟢 Arb Bot Started\n` +
    `⛓ Chain: Base Mainnet\n` +
    `📋 Contract: ${CONFIG.wallet.contractAddress.slice(0, 10)}...\n` +
    `🔋 ETH: ${ethBal.toFixed(4)}\n` +
    `${CONFIG.dryRun ? '🧪 Mode: DRY RUN' : '🔴 Mode: LIVE'}\n` +
    `⏳ Connecting to pools...`
  );

  // Discovery run
  await discovery.run();

  // Wire scanner → executor
  scanner.onOpportunity(async (opp) => {
    await executor.execute(opp);
  });

  // Start WebSocket scanner
  await scanner.start();

  logger.success('Bot', `Live on Base. Listening for price gaps >= ${CONFIG.arb.minProfitBps}bps across Uniswap V3 + Aerodrome`);

  // ── Telegram ready notification ──
  await logger.sendTelegram(
    `✅ Arb Bot Ready\n` +
    `⚙️ Min gap: ${CONFIG.arb.minProfitBps}bps | Flash: $${CONFIG.arb.flashLoanAmount.toLocaleString()}\n` +
    `🔄 Scanning live`
  );

  // Stats every 60 seconds + hourly Telegram heartbeat
  let heartbeatTick = 0;
  setInterval(async () => {
    heartbeatTick++;
    const stats = executor.getStats();
    logger.info('Stats',
      `Trades: ${stats.tradesExecuted} executed / ${stats.tradesFailed} reverted | ` +
      `Success rate: ${stats.successRate} | Total profit: $${stats.totalProfit.toFixed(2)}`
    );

    // 60 ticks × 60s = 1 hour
    if (heartbeatTick % 60 === 0) {
      const currentEth = await wallet.getEthBalance();
      await logger.sendTelegram(
        `💓 Arb Bot Alive\n` +
        `⏱ Uptime: ${Math.floor(heartbeatTick / 60)}h\n` +
        `📊 Trades: ${stats.tradesExecuted} executed / ${stats.tradesFailed} reverted\n` +
        `💰 Profit: $${stats.totalProfit.toFixed(2)}\n` +
        `🔋 ETH: ${currentEth.toFixed(4)}`
      );
    }
  }, 60_000);

  // Rediscover tokens every 10 minutes
  setInterval(() => discovery.run(), CONFIG.discovery.refreshIntervalMs);

  // Keep process alive
  process.on('SIGINT', () => {
    const stats = executor.getStats();
    logger.info('Bot', `Shutting down. Final profit: $${stats.totalProfit.toFixed(2)}`);
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
