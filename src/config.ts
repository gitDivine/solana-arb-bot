import { Token, TradingPair } from './types';
import * as dotenv from 'dotenv';

dotenv.config();

// --- Verified Solana mainnet token mints ---
export const TOKENS: Record<string, Token> = {
  USDC:    { symbol: 'USDC',    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
  USDT:    { symbol: 'USDT',    mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6 },
  PYUSD:   { symbol: 'PYUSD',   mint: '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', decimals: 6 },
  SOL:     { symbol: 'SOL',     mint: 'So11111111111111111111111111111111111111112', decimals: 9 },
  mSOL:    { symbol: 'mSOL',    mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So', decimals: 9 },
  jitoSOL: { symbol: 'jitoSOL', mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn', decimals: 9 },
  bSOL:    { symbol: 'bSOL',    mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', decimals: 9 },
};

// --- DEX labels as Jupiter API expects them ---
export const DEXES = [
  'Raydium',
  'Raydium CLMM',
  'Whirlpool',
  'Meteora DLMM',
  'Phoenix',
  'Lifinity V2',
];

// --- Trading pairs ---
export const PAIRS: TradingPair[] = [
  // Stablecoins (safest, slowest-closing gaps)
  { tokenA: TOKENS.USDC, tokenB: TOKENS.USDT,  label: 'USDC/USDT' },
  { tokenA: TOKENS.USDC, tokenB: TOKENS.PYUSD, label: 'USDC/PYUSD' },
  { tokenA: TOKENS.USDT, tokenB: TOKENS.PYUSD, label: 'USDT/PYUSD' },
  // LSTs (moderate gaps)
  { tokenA: TOKENS.SOL,  tokenB: TOKENS.mSOL,    label: 'SOL/mSOL' },
  { tokenA: TOKENS.SOL,  tokenB: TOKENS.jitoSOL, label: 'SOL/jitoSOL' },
  { tokenA: TOKENS.SOL,  tokenB: TOKENS.bSOL,    label: 'SOL/bSOL' },
  { tokenA: TOKENS.mSOL, tokenB: TOKENS.jitoSOL, label: 'mSOL/jitoSOL' },
];

// --- Scan amounts per token (in smallest unit) ---
// ~$10 equivalent per token for realistic quote sizes
export const SCAN_AMOUNTS: Record<string, number> = {
  USDC:    10_000_000,   // 10 USDC
  USDT:    10_000_000,   // 10 USDT
  PYUSD:   10_000_000,   // 10 PYUSD
  SOL:     50_000_000,   // 0.05 SOL (~$10 at ~$200/SOL)
  mSOL:    50_000_000,   // 0.05 mSOL
  jitoSOL: 50_000_000,   // 0.05 jitoSOL
  bSOL:    50_000_000,   // 0.05 bSOL
};

// --- DexScreener DEX ID → Jupiter DEX label mapping ---
export const DEX_NAME_MAP: Record<string, string> = {
  'raydium': 'Raydium',
  'orca': 'Whirlpool',
  'meteora': 'Meteora DLMM',
  'phoenix': 'Phoenix',
  'lifinity': 'Lifinity V2',
};

// --- Long-tail discovery configuration ---
export const DISCOVERY_CONFIG = {
  jupiterTokenListUrl: 'https://cache.jup.ag/tokens',
  dexScreenerBaseUrl: 'https://api.dexscreener.com',
  minDailyVolume: 10_000,        // $10K minimum 24h volume (lower = wider gaps)
  maxDailyVolume: 5_000_000,     // $5M maximum (above this = too competitive)
  minDexCount: 2,                // must have pools on 2+ DEXes
  minLiquidityUsd: 2_000,        // $2K min liquidity per pool
  discoveryIntervalMs: 600_000,  // re-discover every 10 minutes
  dexScreenerDelayMs: 300,       // 300ms between DexScreener calls
  scanBatchSize: 15,             // tokens per scan batch
  scanIntervalMs: 60_000,        // 60s between scan cycles
  minProfitBps: 1,               // any positive gap gets flagged
  minAlertProfitBps: 1,          // any positive gap triggers Telegram alert
};

// --- Bot configuration ---
export const CONFIG = {
  // Jupiter API (free public endpoint — no key required)
  jupiterApiBase: 'https://public.jupiterapi.com',

  // Scan timing
  scanIntervalMs: 30_000,     // 30s between full scan cycles
  requestDelayMs: 150,        // 150ms between Jupiter API calls (rate limit safety)
  slippageBps: 50,            // 0.5% slippage tolerance for quotes

  // Profitability thresholds
  solTxCostUsd: 0.003,        // ~$0.003 for 2 Solana transactions
  minProfitBps: 3,            // minimum 0.03% to flag as opportunity
  minAlertProfitBps: 10,      // minimum 0.10% to trigger Telegram alert

  // Telegram (optional)
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID || '',

  // Logging
  logDir: './logs',
};

// --- Execution configuration ---
export const EXECUTION_CONFIG = {
  rpcUrl: process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com',
  minExecutionBps: 50,            // 50 bps minimum to execute (covers ~40bps Jupiter platform fees)
  maxPriceImpactPct: 1.0,        // reject quotes with >1% price impact
  reQuoteMinBps: 50,             // re-quote must still show ≥50 bps
  tradePercentage: 1.00,         // use 100% of USDC balance per trade (minus refuel reserve)
  minSolBalance: 10_000_000,     // 0.01 SOL reserved for gas
  refuelSolThreshold: 20_000_000, // 0.02 SOL — trigger USDC→SOL refuel
  refuelUsdcAmount: 1_000_000,   // $1 USDC → SOL when gas is low
  bootstrapSolAmount: 0.05,      // SOL to swap to USDC on first run
  maxTradesPerHour: Infinity,   // no limit — trade every opportunity
  cooldownAfterTradeMs: 10_000,  // 10s cooldown between trades
  cooldownAfterFailMs: 300_000,  // 5 min after failure
  maxConsecutiveFailures: 2,
  priorityFeeLamports: 50_000,   // ~$0.01 priority fee
  confirmTimeoutMs: 60_000,
  stuckRecoverySlippageBps: 100, // 1% slippage for stuck token recovery
  dryRun: process.env.DRY_RUN === 'true',
};
