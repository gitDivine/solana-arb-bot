// config.ts — Base Mainnet (edited from Solana)
export const CONFIG = {
  chain: {
    name: 'Base Mainnet',
    chainId: 8453,
    rpcHttp: process.env.BASE_HTTP_URL || '',
    rpcWs: process.env.BASE_WS_URL || '',
  },
  wallet: {
    privateKey: process.env.PRIVATE_KEY || '',
    contractAddress: process.env.CONTRACT_ADDRESS || '',
  },
  tokens: {
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    AERO: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
    WELL: '0xA88594D404727625A9437C3f886C7643872296AE',
  },
  dexes: {
    uniswapV3Router: '0x2626664c2603336E57B271c5C0b26F421741e481',
    uniswapV3Factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
    uniswapV3Quoter: '0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a',
    aerodromeRouter: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
    aerodromeFactory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
    baseSwapRouter: '0x327Df1E4de513830d23d8C929fbEB8175739663a',
    baseSwapFactory: '0xFDa619b6d20975be80210204239812CB6e29Bb92',
    swapBasedRouter: '0xaaee23930cb94e339665bc839d50b4e057173e6b',
    swapBasedFactory: '0x04C9F118A4f7ab04fc9976779610127C15022848',
    pancakeV3Router: '0x1b8134a47b27486Ab467822a2732152667184f39',
    pancakeV3Factory: '0x02a84c1b3BBD7401a5f7fa98a384EBC703595199',
    pancakeV3Quoter: '0xB048A066779883907794595ec5142E941bb74cB4',
  },
  aave: {
    pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
    flashFee: 0.0005,
  },
  arb: {
    minProfitBps: 60,
    minProfitUsdc: 2,
    flashLoanAmount: 30000,
    slippageBps: 15,
    maxGasGwei: 10,
    cooldownMs: 2000,
  },
  scanner: {
    uniFeeTiers: [100, 500, 3000, 10000] as const,
    watchPairs: [
      { tokenOut: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', fee: 3000, name: 'AERO' },
      { tokenOut: '0xA88594D404727625A9437C3f886C7643872296AE', fee: 3000, name: 'WELL' },
    ],
    surfaces: [
      { name: 'UniV3_Aero', dex1: 'uniswapV3', dex2: 'aerodrome' },
      { name: 'UniV3_BaseSwap', dex1: 'uniswapV3', dex2: 'baseSwap' },
      { name: 'UniV3_SwapBased', dex1: 'uniswapV3', dex2: 'swapBased' },
      { name: 'UniV3_Pancake', dex1: 'uniswapV3', dex2: 'pancakeV3' },
      { name: 'Aero_BaseSwap', dex1: 'aerodrome', dex2: 'baseSwap' },
      { name: 'Aero_Pancake', dex1: 'aerodrome', dex2: 'pancakeV3' },
    ],
    wsReconnectMs: 30000,
  },
  discovery: {
    dexScreenerUrl: 'https://api.dexscreener.com/latest/dex/tokens/',
    minDailyVolumeUsd: 50000,
    maxDailyVolumeUsd: 5000000,
    minLiquidityUsd: 10000,
    refreshIntervalMs: 600000,
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
  dryRun: process.env.DRY_RUN === 'true',
};
