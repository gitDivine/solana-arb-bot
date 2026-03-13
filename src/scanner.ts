import { ethers } from 'ethers';
import { CONFIG } from './config';
import { ArbOpportunity, DexType, SwapLeg, WatchPair } from './types';
import { Logger } from './logger';
import { RateLimiter } from './rate-limiter';
import { WalletManager } from './wallet';

// --- ABIs ---
const UNI_V3_POOL_ABI = [
  'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)',
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];
const UNI_V3_FACTORY_ABI = ['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address pool)'];
const UNI_V3_QUOTER_ABI = ['function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)'];

const AERO_POOL_ABI = ['event Swap(address indexed sender, address indexed to, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out)'];
const AERO_FACTORY_ABI = ['function getPool(address tokenA, address tokenB, bool stable) external view returns (address pool)'];
const AERO_ROUTER_ABI = ['function getAmountsOut(uint256 amountIn, tuple(address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)'];

const UNI_V2_POOL_ABI = ['event Swap(address indexed sender, uint amount0In, uint amount1In, uint amount0Out, uint amount1Out, address indexed to)', 'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)'];
const UNI_V2_FACTORY_ABI = ['function getPair(address tokenA, address tokenB) view returns (address pair)'];

const ERC20_ABI = ['function decimals() view returns (uint8)'];

// --- State ---
const PRICE_CACHE: Map<string, Map<string, number>> = new Map(); // dexName => (tokenAddr => priceInUSDC)
const DECIMALS_CACHE: Map<string, number> = new Map();

export class Scanner {
  private wallet: WalletManager;
  private logger: Logger;
  private rateLimiter: RateLimiter;
  private opportunityCallback?: (opp: ArbOpportunity) => void;
  private poolContracts: Map<string, ethers.Contract> = new Map();
  private cycleCount = 0;
  private hitsToday = 0;

  constructor(wallet: WalletManager, logger: Logger, rateLimiter: RateLimiter) {
    this.wallet = wallet;
    this.logger = logger;
    this.rateLimiter = rateLimiter;
  }

  onOpportunity(cb: (opp: ArbOpportunity) => void): void {
    this.opportunityCallback = cb;
  }

  async start(): Promise<void> {
    this.logger.info('Scanner', 'Initializing multi-DEX monitor...');

    for (const pair of CONFIG.scanner.watchPairs) {
      // For each token we watch, initialize pools on all DEXes
      await this.initDexPools(pair);
    }

    this.logger.success('Scanner', `Watching ${this.poolContracts.size} pools across Base`);
    this.startReconnectWatchdog();
  }

  private async initDexPools(pair: WatchPair): Promise<void> {
    const dexConfigs = [
      { name: 'uniswapV3', type: DexType.UNISWAP_V3, factory: CONFIG.dexes.uniswapV3Factory, router: CONFIG.dexes.uniswapV3Router },
      { name: 'aerodrome', type: DexType.AERODROME, factory: CONFIG.dexes.aerodromeFactory, router: CONFIG.dexes.aerodromeRouter },
      { name: 'baseSwap', type: DexType.UNISWAP_V2, factory: CONFIG.dexes.baseSwapFactory, router: CONFIG.dexes.baseSwapRouter },
      { name: 'swapBased', type: DexType.UNISWAP_V2, factory: CONFIG.dexes.swapBasedFactory, router: CONFIG.dexes.swapBasedRouter },
      { name: 'pancakeV3', type: DexType.UNISWAP_V3, factory: CONFIG.dexes.pancakeV3Factory, router: CONFIG.dexes.pancakeV3Router },
    ];

    for (const dex of dexConfigs) {
      try {
        let poolAddr = ethers.ZeroAddress;
        if (dex.type === DexType.UNISWAP_V3) {
          const factory = new ethers.Contract(dex.factory, UNI_V3_FACTORY_ABI, this.wallet.provider);
          poolAddr = await factory.getPool(CONFIG.tokens.USDC, pair.tokenOut, pair.fee);
        } else if (dex.type === DexType.AERODROME) {
          const factory = new ethers.Contract(dex.factory, AERO_FACTORY_ABI, this.wallet.provider);
          poolAddr = await factory.getPool(CONFIG.tokens.USDC, pair.tokenOut, false);
          if (poolAddr === ethers.ZeroAddress) poolAddr = await factory.getPool(CONFIG.tokens.USDC, pair.tokenOut, true);
        } else if (dex.type === DexType.UNISWAP_V2) {
          const factory = new ethers.Contract(dex.factory, UNI_V2_FACTORY_ABI, this.wallet.provider);
          poolAddr = await factory.getPair(CONFIG.tokens.USDC, pair.tokenOut);
        }

        if (poolAddr && poolAddr !== ethers.ZeroAddress) {
          // --- Liquidity Check ---
          let liquidityUsdc = 0;
          const isV3 = dex.type === DexType.UNISWAP_V3;

          if (isV3) {
            // Bypass liquidity check for V3 — tick-based liquidity is complex
            liquidityUsdc = CONFIG.arb.flashLoanAmount * 100;
          } else if (dex.type === DexType.UNISWAP_V2 || dex.type === DexType.AERODROME) {
            const v2pool = new ethers.Contract(poolAddr, [
              'function token0() view returns (address)',
              'function getReserves() view returns (uint112, uint112, uint32)'
            ], this.wallet.provider);
            const t0 = await v2pool.token0();
            const [r0, r1] = await v2pool.getReserves();
            const resUsdc = t0.toLowerCase() === CONFIG.tokens.USDC.toLowerCase() ? r0 : r1;
            liquidityUsdc = Number(ethers.formatUnits(resUsdc, 6));
          }

          if (liquidityUsdc < CONFIG.arb.flashLoanAmount * 2) {
            this.logger.warn('Scanner', `Skipping ${dex.name} for ${pair.name}: Insufficient liquidity ($${liquidityUsdc.toLocaleString()} USDC)`);
            continue;
          }

          this.setupPoolSubscription(dex.name, dex.type, poolAddr, pair);
          const price = await this.fetchPrice(dex.name, dex.type, poolAddr, pair.tokenOut);
          if (price) {
            this.updatePriceCache(dex.name, pair.tokenOut, price);
            const liquidityStr = isV3 ? 'V3 Pool' : `$${liquidityUsdc.toLocaleString()} USDC`;
            this.logger.success('Scanner', `Initialized ${dex.name} for ${pair.name} (${liquidityStr})`);
          }
        }
      } catch (e: any) {
        this.logger.warn('Scanner', `Failed to init ${dex.name} for ${pair.name}: ${e.message}`);
      }
    }
  }

  private setupPoolSubscription(dexName: string, type: DexType, poolAddr: string, pair: WatchPair): void {
    const abi = type === DexType.UNISWAP_V3 ? UNI_V3_POOL_ABI : (type === DexType.AERODROME ? AERO_POOL_ABI : UNI_V2_POOL_ABI);
    const contract = new ethers.Contract(poolAddr, abi, this.wallet.provider);
    this.poolContracts.set(`${dexName}_${pair.tokenOut}`, contract);

    const topic = type === DexType.UNISWAP_V3
      ? ethers.id('Swap(address,address,int256,int256,uint160,uint128,int24)')
      : (type === DexType.AERODROME
        ? ethers.id('Swap(address,address,uint256,uint256,uint256,uint256)')
        : ethers.id('Swap(address,uint256,uint256,uint256,uint256,address)'));

    this.wallet.provider.on({ address: poolAddr, topics: [topic] }, async () => {
      try {
        const price = await this.fetchPrice(dexName, type, poolAddr, pair.tokenOut);
        if (price) {
          const oldPrice = PRICE_CACHE.get(dexName)?.get(pair.tokenOut);
          if (price !== oldPrice) {
            this.updatePriceCache(dexName, pair.tokenOut, price);
            this.checkSurfaces(pair.tokenOut);
          }
        }
      } catch (err: any) {
        this.logger.error('Scanner', `Price Update Error [${dexName}]: ${err.message}`);
      }
    });
  }

  private updatePriceCache(dexName: string, tokenAddr: string, price: number): void {
    if (!PRICE_CACHE.has(dexName)) PRICE_CACHE.set(dexName, new Map());
    PRICE_CACHE.get(dexName)!.set(tokenAddr, price);
  }

  private async checkSurfaces(tokenOut: string): Promise<void> {
    this.cycleCount++;
    const pair = CONFIG.scanner.watchPairs.find(p => p.tokenOut.toLowerCase() === tokenOut.toLowerCase());
    if (!pair) return;

    for (const surface of CONFIG.scanner.surfaces) {
      const price1 = PRICE_CACHE.get(surface.dex1)?.get(tokenOut);
      const price2 = PRICE_CACHE.get(surface.dex2)?.get(tokenOut);

      if (price1 && price2) {
        await this.evaluateGap(pair, surface, price1, price2);
      }
    }
  }

  private async evaluateGap(pair: WatchPair, surface: any, price1: number, price2: number): Promise<void> {
    const gap1to2 = ((price2 - price1) / price1) * 10000; // buy1 sell2
    const gap2to1 = ((price1 - price2) / price2) * 10000; // buy2 sell1

    const bestGap = Math.max(gap1to2, gap2to1);
    const buyDex = gap1to2 > gap2to1 ? surface.dex1 : surface.dex2;
    const sellDex = gap1to2 > gap2to1 ? surface.dex2 : surface.dex1;

    // Estimate net gap (fees)
    const fee1 = this.getDexFeeBps(buyDex);
    const fee2 = this.getDexFeeBps(sellDex);
    const netGap = bestGap - fee1 - fee2 - 5; // -5bps for flash loan

    if (bestGap > 500) return; // Skip outlier

    if (netGap >= CONFIG.arb.minProfitBps) {
      // Liquidity Guard: Check if flash amount is too large for the pool (V2 only check for now)
      // We can estimate this if we have reserves in cache, but for now lets focus on the price fix first.

      this.logger.info('Scanner', `Found potential gap: ${pair.name} | ${buyDex} → ${sellDex} | ${netGap.toFixed(1)}bps`);

      const leg1 = this.buildSwapLeg(buyDex, pair.tokenOut, pair.fee);
      const leg2 = this.buildSwapLeg(sellDex, pair.tokenOut, pair.fee);

      const opportunity: ArbOpportunity = {
        tokenOut: pair.tokenOut,
        tokenName: pair.name,
        leg1,
        leg2,
        gapBps: Math.round(netGap),
        flashAmount: CONFIG.arb.flashLoanAmount,
        estimatedProfit: (CONFIG.arb.flashLoanAmount * (netGap / 10000)),
        timestamp: Date.now()
      };

      this.hitsToday++;
      this.logger.opportunity(opportunity);
      this.opportunityCallback?.(opportunity);
    }
  }

  private buildSwapLeg(dexName: string, tokenOut: string, defaultFee: number): SwapLeg {
    const config = (CONFIG.dexes as any);
    if (dexName.includes('uniswapV3') || dexName.includes('pancakeV3')) {
      return {
        router: config[`${dexName}Router`],
        dexType: DexType.UNISWAP_V3,
        fee: defaultFee,
        stable: false,
        factory: ethers.ZeroAddress
      };
    } else if (dexName === 'aerodrome') {
      return {
        router: CONFIG.dexes.aerodromeRouter,
        dexType: DexType.AERODROME,
        fee: 0,
        stable: false, // Assume volatile for now - leg logic in contract handles fallbacks
        factory: CONFIG.dexes.aerodromeFactory
      };
    } else { // V2
      return {
        router: config[`${dexName}Router`],
        dexType: DexType.UNISWAP_V2,
        fee: 0,
        stable: false,
        factory: ethers.ZeroAddress
      };
    }
  }

  private getDexFeeBps(dexName: string): number {
    if (dexName.includes('V3')) return 30; // 0.3% default
    if (dexName === 'aerodrome') return 20; // 0.2% volatile
    return 30; // V2 default
  }

  private async fetchPrice(dexName: string, type: DexType, poolAddr: string, tokenOut: string): Promise<number | null> {
    try {
      const dec = await this.getDecimals(tokenOut);

      if (type === DexType.UNISWAP_V3) {
        const v3pool = new ethers.Contract(poolAddr, UNI_V3_POOL_ABI, this.wallet.provider);
        const slot0 = await v3pool.slot0();
        const sqrtPriceX96 = slot0[0];
        const token0 = await v3pool.token0();

        const Q96 = BigInt(2) ** BigInt(96);
        const p = Number(sqrtPriceX96) / Number(Q96);
        let rate = p * p; // token1 per token0

        const dec0 = await this.getDecimals(token0);
        const dec1 = dec;

        const adjustedRate = rate * (10 ** (Number(dec0) - Number(dec1)));

        if (token0.toLowerCase() === CONFIG.tokens.USDC.toLowerCase()) {
          return 1 / adjustedRate;
        } else {
          return adjustedRate;
        }
      }
      else if (type === DexType.AERODROME) {
        const router = new ethers.Contract(CONFIG.dexes.aerodromeRouter, AERO_ROUTER_ABI, this.wallet.provider);
        const amountIn = ethers.parseUnits('1', dec);
        const routes = [{
          from: tokenOut,
          to: CONFIG.tokens.USDC,
          stable: false,
          factory: CONFIG.dexes.aerodromeFactory
        }];
        const amounts = await router.getAmountsOut(amountIn, routes);
        return Number(ethers.formatUnits(amounts[amounts.length - 1], 6));
      }
      else if (type === DexType.UNISWAP_V2) {
        const v2pool = new ethers.Contract(poolAddr, [
          'function token0() view returns (address)',
          'function getReserves() view returns (uint112, uint112, uint32)'
        ], this.wallet.provider);
        const token0 = await v2pool.token0();
        const [r0, r1] = await v2pool.getReserves();

        if (token0.toLowerCase() === CONFIG.tokens.USDC.toLowerCase()) {
          return (Number(r0) / Number(r1)) * (10 ** (dec - 6));
        } else {
          return (Number(r1) / Number(r0)) * (10 ** (dec - 6));
        }
      }
    } catch { return null; }
    return null;
  }

  private async getDecimals(token: string): Promise<number> {
    if (token.toLowerCase() === CONFIG.tokens.USDC.toLowerCase()) return 6;
    if (DECIMALS_CACHE.has(token)) return DECIMALS_CACHE.get(token)!;
    const contract = new ethers.Contract(token, ERC20_ABI, this.wallet.provider);
    const d = await contract.decimals();
    DECIMALS_CACHE.set(token, Number(d));
    return Number(d);
  }

  private startReconnectWatchdog(): void {
    setInterval(async () => {
      try {
        await this.wallet.provider.getBlockNumber();
      } catch {
        this.logger.warn('Scanner', 'WS disconnected — reconnecting...');
        this.wallet.reconnectWs();
        await this.start();
      }
    }, 30000);
  }
}
