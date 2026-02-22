import { Connection } from '@solana/web3.js';
import { ScanCycleResult, Opportunity, WatchlistToken, TradingPair, DiscoveryCycleResult } from './types';
import { CONFIG, TOKENS, DISCOVERY_CONFIG, EXECUTION_CONFIG } from './config';
import { scanWatchlistToken, detectOpportunities, DetectionResult } from './scanner';
import { discoverTokens } from './discovery';
import { RateLimiter } from './rate-limiter';
import { initializeExecutor, executeOpportunity, getBotState } from './executor';
import { getUsdcBalance } from './wallet';
import {
  logBanner,
  logCycleStart,
  logCycleResult,
  logOpportunity,
  logError,
  logOpportunityToFile,
  logCycleToFile,
  logDiscoveryStart,
  logDiscoveryResult,
  logDiscoveryToFile,
  logWatchlistSample,
  sendTelegramAlert,
  formatOpportunityAlert,
} from './logger';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- State ---
let watchlist: WatchlistToken[] = [];
const jupiterLimiter = new RateLimiter(50, 60_000);

// --- Discovery ---

async function runDiscovery(onProgress?: (checked: number, total: number) => void): Promise<DiscoveryCycleResult> {
  const start = Date.now();
  const oldMints = new Set(watchlist.map(w => w.token.mint));

  const newWatchlist = await discoverTokens(watchlist, onProgress);
  const newMints = new Set(newWatchlist.map(w => w.token.mint));

  const added = newWatchlist.filter(w => !oldMints.has(w.token.mint)).length;
  const removed = watchlist.filter(w => !newMints.has(w.token.mint)).length;

  watchlist = newWatchlist;

  return {
    tokensScanned: newWatchlist.length + removed,
    watchlistSize: watchlist.length,
    newTokens: added,
    removedTokens: removed,
    durationMs: Date.now() - start,
    timestamp: new Date(),
  };
}

// --- Scanning ---

const USDC = TOKENS.USDC;
const SCAN_AMOUNT_USDC_FALLBACK = 10_000_000; // 10 USDC fallback
const PARALLEL_SCAN_COUNT = 3; // scan 3 tokens concurrently

/** Get scan amount based on actual USDC balance (matches trade size) */
async function getScanAmount(connection: Connection | null): Promise<number> {
  if (!connection) return SCAN_AMOUNT_USDC_FALLBACK;
  try {
    const balance = await getUsdcBalance(connection);
    const reserve = EXECUTION_CONFIG.refuelUsdcAmount;
    const tradeSize = Math.floor(Math.max(0, balance - reserve) * EXECUTION_CONFIG.tradePercentage);
    // Use actual trade size if we have enough, otherwise fallback to $10
    return tradeSize > 1_000_000 ? tradeSize : SCAN_AMOUNT_USDC_FALLBACK;
  } catch {
    return SCAN_AMOUNT_USDC_FALLBACK;
  }
}

async function runScanCycle(
  cycleNumber: number,
  connection: Connection | null,
  executorReady: boolean,
  onExecuted: () => void,
): Promise<{
  result: ScanCycleResult;
  opportunities: Opportunity[];
  closestGapBps: number;
  closestGapInfo: string;
}> {
  const start = Date.now();
  const allOpportunities: Opportunity[] = [];
  let totalQuotes = 0;
  let bestGapBps = -Infinity;
  let bestGapInfo = '';
  let pairsScanned = 0;
  let tradedThisCycle = false;

  // Scan at actual trade size to eliminate false positives
  const scanAmount = await getScanAmount(connection);
  const scanAmountUsd = (scanAmount / 1e6).toFixed(2);

  // Process tokens in parallel batches of PARALLEL_SCAN_COUNT
  for (let i = 0; i < watchlist.length; i += PARALLEL_SCAN_COUNT) {
    if (tradedThisCycle) break; // stop scanning if we already traded

    const batch = watchlist.slice(i, i + PARALLEL_SCAN_COUNT);
    const results = await Promise.all(batch.map(async (wt) => {
      try {
        const pair: TradingPair = {
          tokenA: USDC,
          tokenB: wt.token,
          label: `USDC/${wt.token.symbol}`,
        };

        const { forward, reverse } = await scanWatchlistToken(
          wt, USDC, scanAmount, jupiterLimiter,
        );

        return { pair, forward, reverse, quotes: forward.length + reverse.length };
      } catch (err) {
        logError(`Failed scanning ${wt.token.symbol}: ${err}`);
        return null;
      }
    }));

    for (const r of results) {
      if (!r) continue;
      totalQuotes += r.quotes;
      pairsScanned++;

      if (r.forward.length >= 2 || r.reverse.length >= 2) {
        const det: DetectionResult = detectOpportunities(r.pair, r.forward, r.reverse);

        if (det.closestGapBps > bestGapBps) {
          bestGapBps = det.closestGapBps;
          bestGapInfo = `${r.pair.label} ${det.closestGapPair}`;
        }

        // Immediate execution: try to trade the moment we find a good opportunity
        for (const opp of det.opportunities) {
          allOpportunities.push(opp);
          logOpportunity(opp);
          logOpportunityToFile(opp);

          if (opp.profitBps >= DISCOVERY_CONFIG.minAlertProfitBps) {
            sendTelegramAlert(formatOpportunityAlert(opp)).catch(() => {});
          }

          if (!tradedThisCycle && executorReady && connection && opp.profitBps >= EXECUTION_CONFIG.minExecutionBps) {
            const execResult = await executeOpportunity(connection, opp);
            if (execResult) {
              tradedThisCycle = true;
              onExecuted();
              break; // one trade per cycle
            }
          }
        }
      }
    }
  }

  allOpportunities.sort((a, b) => b.netProfitUsd - a.netProfitUsd);

  return {
    opportunities: allOpportunities,
    closestGapBps: bestGapBps,
    closestGapInfo: bestGapInfo,
    result: {
      cycleNumber,
      timestamp: new Date(),
      pairsScanned,
      quotesCollected: totalQuotes,
      opportunitiesFound: allOpportunities.length,
      bestOpportunity: allOpportunities[0] ?? null,
      durationMs: Date.now() - start,
    },
  };
}

// --- Main ---

async function main(): Promise<void> {
  logBanner();

  let cycleNumber = 0;
  let totalOpportunities = 0;

  process.on('SIGINT', () => {
    console.log('\n\nShutting down scanner...');
    console.log(`Total opportunities detected across ${cycleNumber} cycles: ${totalOpportunities}`);
    console.log(`Watchlist size: ${watchlist.length} tokens`);
    process.exit(0);
  });

  // --- Initial discovery ---
  console.log('  Starting initial token discovery...');
  console.log('  (First run downloads token list — may take 1-2 minutes)\n');

  logDiscoveryStart();
  const discoveryResult = await runDiscovery((checked, total) => {
    process.stdout.write(`\r  Checking tokens: ${checked}/${total}...`);
  });
  logDiscoveryResult(discoveryResult);
  logDiscoveryToFile(discoveryResult);
  logWatchlistSample(watchlist.map(w => ({
    symbol: w.token.symbol,
    dexes: w.dexes,
    dailyVolume: w.dailyVolume,
  })));

  if (watchlist.length === 0) {
    console.log('\n  No tokens found matching criteria. Will retry in 10 minutes...\n');
  }

  const tgStatus = CONFIG.telegramBotToken && CONFIG.telegramChatId
    ? 'configured' : 'not configured';
  console.log(`\n  Watchlist: ${watchlist.length} tokens | Scan interval: ${DISCOVERY_CONFIG.scanIntervalMs / 1000}s | Telegram: ${tgStatus}\n`);

  // --- Initialize execution engine ---
  const connection = new Connection(EXECUTION_CONFIG.rpcUrl, 'confirmed');
  let executorReady = false;
  try {
    executorReady = await initializeExecutor(connection);
  } catch (err) {
    logError(`Executor init failed: ${err}`);
  }
  if (!executorReady) {
    console.log('  [!] Execution engine unavailable — running in scan-only mode\n');
  }

  // --- Periodic re-discovery (every 10 min) ---
  setInterval(async () => {
    try {
      logDiscoveryStart();
      const result = await runDiscovery();
      logDiscoveryResult(result);
      logDiscoveryToFile(result);
    } catch (err) {
      logError(`Discovery failed: ${err}`);
    }
  }, DISCOVERY_CONFIG.discoveryIntervalMs);

  // --- Scan loop ---
  while (true) {
    if (watchlist.length === 0) {
      await sleep(DISCOVERY_CONFIG.scanIntervalMs);
      continue;
    }

    cycleNumber++;
    logCycleStart(cycleNumber);

    const { result, closestGapBps, closestGapInfo } = await runScanCycle(
      cycleNumber, connection, executorReady, () => { /* onExecuted callback */ },
    );
    totalOpportunities += result.opportunitiesFound;

    logCycleResult(result, closestGapBps, closestGapInfo);
    logCycleToFile(result);

    // If 0 quotes, Jupiter is likely throttling — back off 3 min instead of hammering
    if (result.quotesCollected === 0) {
      console.log('  [!] No quotes received — backing off 3 minutes...');
      await sleep(180_000);
    } else {
      const sleepTime = Math.max(5000, DISCOVERY_CONFIG.scanIntervalMs - result.durationMs);
      await sleep(sleepTime);
    }
  }
}

main().catch((err) => {
  logError(`Fatal: ${err}`);
  process.exit(1);
});
