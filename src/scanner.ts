import { DexQuote, TradingPair, Opportunity, WatchlistToken } from './types';
import { CONFIG, DEXES, SCAN_AMOUNTS, TOKENS } from './config';
import { RateLimiter } from './rate-limiter';

const JUPITER_QUOTE_URL = `${CONFIG.jupiterApiBase}/quote`;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch a quote from Jupiter restricted to a single DEX.
 * Returns null if the DEX has no pool for this pair or request fails.
 */
export async function fetchDexQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  dex: string,
): Promise<DexQuote | null> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: CONFIG.slippageBps.toString(),
    onlyDirectRoutes: 'true',
    dexes: dex,
  });

  try {
    const res = await fetch(`${JUPITER_QUOTE_URL}?${params}`, {
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 429) {
      // Rate limited — back off briefly
      await new Promise(r => setTimeout(r, 2000));
      return null;
    }

    if (!res.ok) return null;

    const data = (await res.json()) as {
      inAmount: string;
      outAmount: string;
      priceImpactPct?: string;
      routePlan?: Array<{ swapInfo: { outAmount: string; label: string } }>;
    };

    if (!data.outAmount) return null;

    // Use the actual DEX swap output (pre-platform-fee) from routePlan
    // The top-level outAmount includes a ~20bps platform fee that would
    // mask real arb opportunities in our scanner
    const actualOut = data.routePlan?.[0]?.swapInfo?.outAmount;
    const outAmount = actualOut ? Number(actualOut) : Number(data.outAmount);
    const actualLabel = data.routePlan?.[0]?.swapInfo?.label ?? dex;

    return {
      dex: actualLabel,
      inputMint,
      outputMint,
      inAmount: Number(data.inAmount),
      outAmount,
      priceImpactPct: parseFloat(data.priceImpactPct || '0'),
    };
  } catch {
    return null; // Network error, timeout, or no route — skip silently
  }
}

/**
 * Scan a single pair across all DEXes.
 * Returns forward (A->B) and reverse (B->A) quotes per DEX.
 */
export async function scanPair(pair: TradingPair): Promise<{
  forward: DexQuote[];
  reverse: DexQuote[];
}> {
  const forward: DexQuote[] = [];
  const reverse: DexQuote[] = [];

  const fwdAmount = SCAN_AMOUNTS[pair.tokenA.symbol];
  const revAmount = SCAN_AMOUNTS[pair.tokenB.symbol];

  for (const dex of DEXES) {
    // Fire both directions in parallel per DEX
    const [fwd, rev] = await Promise.all([
      fetchDexQuote(pair.tokenA.mint, pair.tokenB.mint, fwdAmount, dex),
      fetchDexQuote(pair.tokenB.mint, pair.tokenA.mint, revAmount, dex),
    ]);

    if (fwd) forward.push(fwd);
    if (rev) reverse.push(rev);

    // Rate limit between DEXes
    await sleep(CONFIG.requestDelayMs);
  }

  return { forward, reverse };
}

/**
 * Detect arbitrage opportunities from forward/reverse quotes.
 *
 * For each (DEX_i, DEX_j) combo where i != j:
 *   - Buy tokenB on DEX_i:  buyRate  = outAmount_B / inAmount_A
 *   - Sell tokenB on DEX_j: sellRate = outAmount_A / inAmount_B
 *   - roundTrip = buyRate * sellRate  (>1 means profit)
 */
export interface DetectionResult {
  opportunities: Opportunity[];
  closestGapBps: number;       // best round-trip gap in bps (even if negative)
  closestGapPair: string;      // e.g. "Raydium CLMM->Whirlpool"
}

/**
 * Scan a watchlist token vs a base token (USDC) across its known DEXes.
 * Only queries DEXes where the token actually has pools.
 */
export async function scanWatchlistToken(
  wt: WatchlistToken,
  baseToken: { mint: string; decimals: number; symbol: string },
  scanAmount: number,
  rateLimiter: RateLimiter,
): Promise<{ forward: DexQuote[]; reverse: DexQuote[] }> {
  const forward: DexQuote[] = [];
  const reverse: DexQuote[] = [];

  // Compute reverse amount: ~$10 worth of the token using DexScreener price
  const avgPrice = Object.values(wt.dexPrices)[0] || 1;
  const tokenUnitsPerDollar = (1 / avgPrice) * Math.pow(10, wt.token.decimals);
  const revAmount = Math.round(tokenUnitsPerDollar * 10); // ~$10 worth

  for (const dex of wt.dexes) {
    await rateLimiter.acquire();

    const [fwd, rev] = await Promise.all([
      fetchDexQuote(baseToken.mint, wt.token.mint, scanAmount, dex),
      fetchDexQuote(wt.token.mint, baseToken.mint, revAmount, dex),
    ]);

    if (fwd) forward.push(fwd);
    if (rev) reverse.push(rev);
  }

  return { forward, reverse };
}

export function detectOpportunities(
  pair: TradingPair,
  forward: DexQuote[],
  reverse: DexQuote[],
): DetectionResult {
  const opportunities: Opportunity[] = [];
  let closestGapBps = -Infinity;
  let closestGapPair = '';

  for (const buyQ of forward) {
    for (const sellQ of reverse) {
      if (buyQ.dex === sellQ.dex) continue;

      const buyRate = buyQ.outAmount / buyQ.inAmount;
      const sellRate = sellQ.outAmount / sellQ.inAmount;
      const roundTrip = buyRate * sellRate;
      const gapBps = Math.round((roundTrip - 1) * 10_000);

      // Track the closest-to-profitable gap across all combos
      if (gapBps > closestGapBps) {
        closestGapBps = gapBps;
        closestGapPair = `${buyQ.dex}->${sellQ.dex}`;
      }

      if (roundTrip <= 1) continue;

      const decimalsA = pair.tokenA.decimals;
      const scanAmountUsd = buyQ.inAmount / Math.pow(10, decimalsA);
      const grossProfitUsd = scanAmountUsd * (roundTrip - 1);
      const netProfitUsd = grossProfitUsd - CONFIG.solTxCostUsd;

      if (netProfitUsd > 0) {
        opportunities.push({
          pair,
          buyDex: buyQ.dex,
          sellDex: sellQ.dex,
          scanAmountUsd,
          grossProfitUsd,
          netProfitUsd,
          profitBps: gapBps,
          timestamp: new Date(),
        });
      }
    }
  }

  return {
    opportunities: opportunities.sort((a, b) => b.netProfitUsd - a.netProfitUsd),
    closestGapBps,
    closestGapPair,
  };
}
