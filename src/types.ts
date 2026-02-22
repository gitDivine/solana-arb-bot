export interface Token {
  symbol: string;
  mint: string;
  decimals: number;
}

export interface TradingPair {
  tokenA: Token;
  tokenB: Token;
  label: string;
}

export interface DexQuote {
  dex: string;
  inputMint: string;
  outputMint: string;
  inAmount: number;
  outAmount: number;
  priceImpactPct: number;
}

export interface Opportunity {
  pair: TradingPair;
  buyDex: string;
  sellDex: string;
  scanAmountUsd: number;
  grossProfitUsd: number;
  netProfitUsd: number;
  profitBps: number;
  timestamp: Date;
}

export interface ScanCycleResult {
  cycleNumber: number;
  timestamp: Date;
  pairsScanned: number;
  quotesCollected: number;
  opportunitiesFound: number;
  bestOpportunity: Opportunity | null;
  durationMs: number;
}

// --- Long-tail discovery types ---

export interface WatchlistToken {
  token: Token;
  dexes: string[];                    // Jupiter DEX labels where this token has pools
  dexPrices: Record<string, number>;  // priceUsd per DEX (from DexScreener)
  dailyVolume: number;                // 24h volume in USD
  liquidity: number;                  // total liquidity in USD
  lastDiscovery: Date;
}

export interface DiscoveryCycleResult {
  tokensScanned: number;
  watchlistSize: number;
  newTokens: number;
  removedTokens: number;
  durationMs: number;
  timestamp: Date;
}

// --- Execution types ---

export type LegStatus = 'pending' | 'sent' | 'confirmed' | 'failed';

export interface LegResult {
  leg: 1 | 2;
  dex: string;
  inputMint: string;
  outputMint: string;
  inputAmount: number;
  expectedOutput: number;
  signature: string;
  status: LegStatus;
  error?: string;
  durationMs: number;
}

export interface ExecutionResult {
  opportunity: Opportunity;
  status: 'success' | 'partial' | 'failed' | 'skipped';
  leg1: LegResult;
  leg2: LegResult | null;
  inputAmountUsd: number;
  outputAmountUsd: number;
  netProfitUsd: number;
  totalDurationMs: number;
  timestamp: Date;
}

export interface BotState {
  isExecuting: boolean;
  tradesThisHour: number;
  lastTradeTimestamp: number;
  hourWindowStart: number;
  stuckToken: { mint: string; symbol: string; amount: number } | null;
  consecutiveFailures: number;
  totalTrades: number;
  totalProfitUsd: number;
}
