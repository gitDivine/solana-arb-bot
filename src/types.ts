// types.ts — updated for EVM/Base (was Solana)
export interface WatchPair {
  tokenOut: string;
  fee: number;
  name: string;
}

export enum DexType { UNISWAP_V2, UNISWAP_V3, SOLIDLY, ALGEBRA }

export interface SwapLeg {
  router: string;
  dexType: DexType;
  fee: number;
  stable: boolean;
  factory: string;
}

export interface ArbOpportunity {
  tokenOut: string;
  tokenName: string;
  leg1: SwapLeg;
  leg2: SwapLeg;
  gapBps: number;
  flashAmount: number;
  estimatedProfit: number;
  timestamp: number;
}

export interface TradeResult {
  success: boolean;
  txHash?: string;
  profit?: number;
  error?: string;
  gasUsed?: number;
}

export interface PriceQuote {
  dex: 'uniswap' | 'aerodrome';
  tokenOut: string;
  tokenName: string;
  uniPoolFee: number;
  priceUsdc: number;   // how many tokenOut per 1 USDC
  timestamp: number;
}

export interface TokenInfo {
  address: string;
  symbol: string;
  dailyVolumeUsd: number;
  liquidityUsd: number;
  uniPoolFee: number;
}
