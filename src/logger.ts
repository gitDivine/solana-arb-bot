import * as fs from 'fs';
import * as path from 'path';
import { Opportunity, ScanCycleResult, DiscoveryCycleResult } from './types';
import { CONFIG } from './config';

// --- ANSI colors for terminal output ---
const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
  magenta: '\x1b[35m',
};

function timestamp(): string {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function ensureLogDir(): void {
  if (!fs.existsSync(CONFIG.logDir)) {
    fs.mkdirSync(CONFIG.logDir, { recursive: true });
  }
}

function getLogFilePath(): string {
  const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  return path.join(CONFIG.logDir, `scan-${date}.json`);
}

// --- Console output ---

export function logBanner(): void {
  console.log('');
  console.log(`${c.bold}${c.cyan}  Solana Arbitrage Scanner v2.0${c.reset}`);
  console.log(`${c.dim}  Long-Tail Token Mode${c.reset}`);
  console.log('');
}

export function logConfig(pairCount: number, dexCount: number): void {
  const tgStatus = CONFIG.telegramBotToken && CONFIG.telegramChatId
    ? `${c.green}configured${c.reset}`
    : `${c.dim}not configured${c.reset}`;

  console.log(`  Pairs: ${c.bold}${pairCount}${c.reset} | DEXes: ${c.bold}${dexCount}${c.reset} | Interval: ${c.bold}${CONFIG.scanIntervalMs / 1000}s${c.reset}`);
  console.log(`  Telegram: ${tgStatus}`);
  console.log('');
}

export function logCycleStart(cycle: number): void {
  process.stdout.write(`${c.dim}[${timestamp()}]${c.reset} Cycle #${cycle} scanning...`);
}

export function logCycleResult(result: ScanCycleResult, closestGapBps?: number, closestGapInfo?: string): void {
  // Clear the "scanning..." line
  process.stdout.write('\r');

  const oppColor = result.opportunitiesFound > 0 ? c.green : c.dim;
  let line = `${c.dim}[${timestamp()}]${c.reset} Cycle #${result.cycleNumber}`;
  line += ` | ${result.pairsScanned} pairs`;
  line += ` | ${result.quotesCollected} quotes`;
  line += ` | ${oppColor}${result.opportunitiesFound} opportunities${c.reset}`;
  line += ` | ${c.dim}${(result.durationMs / 1000).toFixed(1)}s${c.reset}`;

  if (result.bestOpportunity) {
    const opp = result.bestOpportunity;
    line += ` | best: ${c.green}+$${opp.netProfitUsd.toFixed(4)}${c.reset}`;
    line += ` (${opp.profitBps}bps ${opp.pair.label} ${opp.buyDex}${c.dim}->${c.reset}${opp.sellDex})`;
  } else if (closestGapBps !== undefined && closestGapInfo) {
    // Show closest gap even when no profitable opportunity
    const gapColor = closestGapBps >= 0 ? c.yellow : c.dim;
    line += ` | closest: ${gapColor}${closestGapBps}bps${c.reset} ${c.dim}${closestGapInfo}${c.reset}`;
  }

  console.log(line);
}

export function logOpportunity(opp: Opportunity): void {
  const line = `  ${c.green}+${c.reset} ${c.bold}${opp.pair.label}${c.reset}`
    + ` | ${c.green}+$${opp.netProfitUsd.toFixed(4)}${c.reset} net`
    + ` (${opp.profitBps} bps)`
    + ` | Buy: ${c.cyan}${opp.buyDex}${c.reset} -> Sell: ${c.magenta}${opp.sellDex}${c.reset}`
    + ` | scan: $${opp.scanAmountUsd.toFixed(2)}`;
  console.log(line);
}

export function logError(msg: string): void {
  console.error(`${c.dim}[${timestamp()}]${c.reset} ${c.red}ERROR:${c.reset} ${msg}`);
}

// --- File logging (JSON lines) ---

export function logToFile(data: Record<string, unknown>): void {
  ensureLogDir();
  const entry = JSON.stringify({ ...data, _ts: new Date().toISOString() }) + '\n';
  fs.appendFileSync(getLogFilePath(), entry);
}

export function logOpportunityToFile(opp: Opportunity): void {
  logToFile({
    type: 'opportunity',
    pair: opp.pair.label,
    buyDex: opp.buyDex,
    sellDex: opp.sellDex,
    scanAmountUsd: opp.scanAmountUsd,
    grossProfitUsd: opp.grossProfitUsd,
    netProfitUsd: opp.netProfitUsd,
    profitBps: opp.profitBps,
  });
}

export function logCycleToFile(result: ScanCycleResult): void {
  logToFile({
    type: 'cycle',
    cycle: result.cycleNumber,
    pairsScanned: result.pairsScanned,
    quotes: result.quotesCollected,
    opportunities: result.opportunitiesFound,
    durationMs: result.durationMs,
    bestProfitBps: result.bestOpportunity?.profitBps ?? 0,
  });
}

// --- Discovery logging ---

export function logDiscoveryStart(): void {
  process.stdout.write(`${c.dim}[${timestamp()}]${c.reset} ${c.cyan}Running token discovery...${c.reset}`);
}

export function logDiscoveryResult(result: DiscoveryCycleResult): void {
  process.stdout.write('\r');
  let line = `${c.dim}[${timestamp()}]${c.reset} ${c.cyan}Discovery${c.reset}`;
  line += ` | ${result.tokensScanned} candidates scanned`;
  line += ` | ${c.bold}${result.watchlistSize} tokens${c.reset} on watchlist`;
  if (result.newTokens > 0) {
    line += ` | ${c.green}+${result.newTokens} new${c.reset}`;
  }
  if (result.removedTokens > 0) {
    line += ` | ${c.red}-${result.removedTokens} removed${c.reset}`;
  }
  line += ` | ${c.dim}${(result.durationMs / 1000).toFixed(1)}s${c.reset}`;
  console.log(line);
}

export function logDiscoveryToFile(result: DiscoveryCycleResult): void {
  logToFile({
    type: 'discovery',
    tokensScanned: result.tokensScanned,
    watchlistSize: result.watchlistSize,
    newTokens: result.newTokens,
    removedTokens: result.removedTokens,
    durationMs: result.durationMs,
  });
}

export function logWatchlistSample(tokens: { symbol: string; dexes: string[]; dailyVolume: number }[]): void {
  if (tokens.length === 0) return;
  console.log(`${c.dim}  Top watchlist tokens:${c.reset}`);
  for (const t of tokens.slice(0, 5)) {
    console.log(`${c.dim}    ${c.reset}${c.bold}${t.symbol}${c.reset} | ${t.dexes.length} DEXes (${t.dexes.join(', ')}) | vol: $${(t.dailyVolume / 1000).toFixed(0)}K`);
  }
}

// --- Telegram alerts ---

export async function sendTelegramAlert(message: string): Promise<void> {
  if (!CONFIG.telegramBotToken || !CONFIG.telegramChatId) return;

  const url = `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`;
  const body = JSON.stringify({
    chat_id: CONFIG.telegramChatId,
    text: message,
    parse_mode: 'Markdown',
  });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return;
      console.error(`  [Telegram] Send failed (${res.status}), attempt ${attempt + 1}`);
    } catch (err) {
      console.error(`  [Telegram] Error: ${err}, attempt ${attempt + 1}`);
    }
    if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
  }
}

export function formatOpportunityAlert(opp: Opportunity): string {
  return [
    `*Arb Opportunity Detected*`,
    `Pair: \`${opp.pair.label}\``,
    `Buy: \`${opp.buyDex}\` -> Sell: \`${opp.sellDex}\``,
    `Profit: \`+$${opp.netProfitUsd.toFixed(4)}\` (${opp.profitBps} bps)`,
    `Scan amount: $${opp.scanAmountUsd.toFixed(2)}`,
    `Time: ${opp.timestamp.toISOString()}`,
  ].join('\n');
}
