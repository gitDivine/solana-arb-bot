// discovery.ts — EDITED: Solana/DexScreener Solana → Base/DexScreener Base
// Logic kept identical — only the chain filter and token source changes

import axios from 'axios';
import { CONFIG } from './config';
import { TokenInfo } from './types';
import { Logger } from './logger';
import { RateLimiter } from './rate-limiter';

// Well-known tokens to always watch
const SEED_TOKENS = CONFIG.scanner.watchPairs.map(p => p.tokenOut);

export class Discovery {
  private logger: Logger;
  private rateLimiter: RateLimiter;
  private watchlist: Map<string, TokenInfo> = new Map();

  constructor(logger: Logger, rateLimiter: RateLimiter) {
    this.logger = logger;
    this.rateLimiter = rateLimiter;
  }

  async run(): Promise<TokenInfo[]> {
    this.logger.info('Discovery', `Scanning ${CONFIG.chain.name} tokens via DexScreener...`);
    let added = 0;

    for (const address of SEED_TOKENS) {
      try {
        await this.rateLimiter.throttle();
        const res = await axios.get(`${CONFIG.discovery.dexScreenerUrl}${address}`, { timeout: 5000 });
        const chainName = CONFIG.chain.chainId === 42161 ? 'arbitrum' : 'base';
        
        const pairs = (res.data?.pairs || []).filter((p: any) =>
          p.chainId === chainName &&
          (p.dexId === 'uniswap' || p.dexId === 'aerodrome' || p.dexId === 'camelot-v3' || p.dexId === 'ramses-v2') &&
          parseFloat(p.volume?.h24 || 0) >= CONFIG.discovery.minDailyVolumeUsd &&
          parseFloat(p.liquidity?.usd || 0) >= CONFIG.discovery.minLiquidityUsd
        );

        if (pairs.length >= 2) { // needs to exist on at least 2 DEXes
          const uniPair = pairs.find((p: any) => p.dexId === 'uniswap');
          const aeroPair = pairs.find((p: any) => p.dexId === 'aerodrome');

          if (uniPair && aeroPair) {
            const info: TokenInfo = {
              address,
              symbol: uniPair.baseToken?.symbol || address.slice(0, 6),
              dailyVolumeUsd: parseFloat(uniPair.volume?.h24 || 0),
              liquidityUsd: parseFloat(uniPair.liquidity?.usd || 0),
              uniPoolFee: this.inferPoolFee(uniPair),
            };
            this.watchlist.set(address, info);
            added++;
          }
        }
      } catch (err: any) {
        this.logger.warn('Discovery', `Failed to fetch ${address.slice(0, 10)}: ${err.message}`);
      }
    }

    const tokens = Array.from(this.watchlist.values())
      .sort((a, b) => b.dailyVolumeUsd - a.dailyVolumeUsd);

    this.logger.info('Discovery',
      `${tokens.length} tokens on watchlist | +${added} new | ` +
      `Top: ${tokens.slice(0, 3).map(t => t.symbol).join(', ')}`
    );

    return tokens;
  }

  private inferPoolFee(pair: any): number {
    // DexScreener sometimes includes fee in pairAddress or labels
    // Default to 500 (0.05%) for stables, 3000 (0.3%) for others
    const symbol = pair.baseToken?.symbol?.toUpperCase() || '';
    if (['DAI', 'USDT', 'FRAX'].includes(symbol)) return 100;
    if (['WETH', 'CBETH', 'CBBTC', 'WBTC'].includes(symbol)) return 500;
    return 3000;
  }

  getWatchlist(): TokenInfo[] {
    return Array.from(this.watchlist.values());
  }
}
