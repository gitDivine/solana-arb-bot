import * as fs from 'fs';
import * as path from 'path';
import { Token, WatchlistToken } from './types';
import { DISCOVERY_CONFIG, DEX_NAME_MAP, TOKENS, CONFIG } from './config';
import { RateLimiter } from './rate-limiter';
import { logError } from './logger';

const dexScreenerLimiter = new RateLimiter(180, 60_000);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Types ---

interface JupiterToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  tags?: string[];
}

interface DexScreenerPair {
  chainId: string;
  dexId: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  volume?: { h24?: number };
  liquidity?: { usd?: number };
}

interface DexScreenerResponse {
  pairs?: DexScreenerPair[] | null;
}

// --- Candidate cache (avoid re-downloading 287K tokens every 10 min) ---

const CACHE_PATH = path.join(CONFIG.logDir, 'candidates-cache.json');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CandidateCache {
  timestamp: string;
  candidates: Array<{ address: string; symbol: string; decimals: number }>;
}

function loadCachedCandidates(): Array<{ address: string; symbol: string; decimals: number }> | null {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const raw = fs.readFileSync(CACHE_PATH, 'utf-8');
    const cache: CandidateCache = JSON.parse(raw);
    const age = Date.now() - new Date(cache.timestamp).getTime();
    if (age > CACHE_MAX_AGE_MS) return null;
    return cache.candidates;
  } catch {
    return null;
  }
}

function saveCandidateCache(candidates: Array<{ address: string; symbol: string; decimals: number }>): void {
  try {
    if (!fs.existsSync(CONFIG.logDir)) fs.mkdirSync(CONFIG.logDir, { recursive: true });
    const cache: CandidateCache = { timestamp: new Date().toISOString(), candidates };
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache));
  } catch {
    // Non-critical
  }
}

/**
 * Get candidate tokens — from cache or by downloading Jupiter's full list.
 * Filters to community/old-registry/solana-fm tagged tokens.
 */
async function getCandidates(): Promise<Array<{ address: string; symbol: string; decimals: number }>> {
  // Try cache first
  const cached = loadCachedCandidates();
  if (cached) return cached;

  // Download full Jupiter token list
  try {
    const res = await fetch(DISCOVERY_CONFIG.jupiterTokenListUrl, {
      signal: AbortSignal.timeout(90_000), // Large payload needs time
    });
    if (!res.ok) {
      logError(`Jupiter token list returned ${res.status}`);
      return [];
    }

    const tokens = (await res.json()) as JupiterToken[];
    if (!Array.isArray(tokens)) return [];

    const knownMints = new Set(Object.values(TOKENS).map(t => t.mint));
    const targetTags = new Set(['community', 'old-registry', 'solana-fm']);

    const candidates = tokens
      .filter(t =>
        t.decimals > 0 &&
        !knownMints.has(t.address) &&
        t.tags?.some(tag => targetTags.has(tag))
      )
      .map(t => ({ address: t.address, symbol: t.symbol, decimals: t.decimals }));

    // Cache to disk
    saveCandidateCache(candidates);

    return candidates;
  } catch (err) {
    logError(`Failed fetching Jupiter token list: ${err}`);
    return [];
  }
}

/**
 * Query DexScreener for a single token's Solana pairs.
 */
async function fetchDexScreenerPairs(mint: string): Promise<DexScreenerPair[]> {
  await dexScreenerLimiter.acquire();

  try {
    const url = `${DISCOVERY_CONFIG.dexScreenerBaseUrl}/latest/dex/tokens/${mint}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return [];

    const data = (await res.json()) as DexScreenerResponse;
    return (data.pairs ?? []).filter(p => p.chainId === 'solana');
  } catch {
    return [];
  }
}

/**
 * Map DexScreener dexId to Jupiter label.
 */
function mapDexName(dexId: string): string | null {
  if (DEX_NAME_MAP[dexId]) return DEX_NAME_MAP[dexId];
  for (const [key, label] of Object.entries(DEX_NAME_MAP)) {
    if (dexId.startsWith(key)) return label;
  }
  return null;
}

/**
 * Analyze DexScreener pairs: find Jupiter-compatible DEXes, prices, volume.
 */
function analyzePairs(pairs: DexScreenerPair[]): {
  dexes: string[];
  dexPrices: Record<string, number>;
  totalLiquidity: number;
  totalVolume24h: number;
} {
  const dexPrices: Record<string, number> = {};
  const dexLiquidity: Record<string, number> = {};
  let totalLiquidity = 0;
  let totalVolume24h = 0;

  for (const pair of pairs) {
    const jupiterLabel = mapDexName(pair.dexId);
    if (!jupiterLabel) continue;

    const liq = pair.liquidity?.usd ?? 0;
    if (liq < DISCOVERY_CONFIG.minLiquidityUsd) continue;

    const price = parseFloat(pair.priceUsd || '0');
    if (price <= 0) continue;

    totalVolume24h += pair.volume?.h24 ?? 0;
    totalLiquidity += liq;

    if (!dexLiquidity[jupiterLabel] || liq > dexLiquidity[jupiterLabel]) {
      dexPrices[jupiterLabel] = price;
      dexLiquidity[jupiterLabel] = liq;
    }
  }

  return { dexes: Object.keys(dexPrices), dexPrices, totalLiquidity, totalVolume24h };
}

// Track which page of candidates we're on across discovery cycles
let discoveryPage = 0;
const CANDIDATES_PER_CYCLE = 200;

/**
 * Main discovery function.
 * Checks a batch of ~200 candidates per cycle, rotating through the full list.
 * Accumulates results into an existing watchlist (merging new + existing).
 */
export async function discoverTokens(
  existingWatchlist: WatchlistToken[] = [],
  onProgress?: (checked: number, total: number) => void,
): Promise<WatchlistToken[]> {
  const allCandidates = await getCandidates();
  if (allCandidates.length === 0) return existingWatchlist;

  // Pick the current page of candidates to check
  const start = (discoveryPage * CANDIDATES_PER_CYCLE) % allCandidates.length;
  const end = Math.min(start + CANDIDATES_PER_CYCLE, allCandidates.length);
  const batch = allCandidates.slice(start, end);
  discoveryPage++;

  const newFinds: WatchlistToken[] = [];

  for (let i = 0; i < batch.length; i++) {
    const candidate = batch[i];
    if (onProgress && i % 25 === 0) onProgress(i, batch.length);

    const pairs = await fetchDexScreenerPairs(candidate.address);
    if (pairs.length === 0) continue;

    const { dexes, dexPrices, totalLiquidity, totalVolume24h } = analyzePairs(pairs);

    if (dexes.length < DISCOVERY_CONFIG.minDexCount) continue;
    if (totalVolume24h < DISCOVERY_CONFIG.minDailyVolume) continue;
    if (totalVolume24h > DISCOVERY_CONFIG.maxDailyVolume) continue;

    newFinds.push({
      token: { symbol: candidate.symbol, mint: candidate.address, decimals: candidate.decimals },
      dexes,
      dexPrices,
      dailyVolume: totalVolume24h,
      liquidity: totalLiquidity,
      lastDiscovery: new Date(),
    });

    await sleep(DISCOVERY_CONFIG.dexScreenerDelayMs);
  }

  // Merge: update existing tokens if re-discovered, add new ones, keep old ones
  const resultMap = new Map<string, WatchlistToken>();
  for (const wt of existingWatchlist) resultMap.set(wt.token.mint, wt);
  for (const wt of newFinds) resultMap.set(wt.token.mint, wt);

  const merged = Array.from(resultMap.values());
  merged.sort((a, b) => b.dailyVolume - a.dailyVolume);
  return merged;
}
