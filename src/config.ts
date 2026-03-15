// config.ts — Multi-Chain Support
const CHAIN_ID = process.env.CHAIN || 'base';

const CONFIG_BY_CHAIN: any = {
  base: {
    name: 'Base Mainnet',
    chainId: 8453,
    rpcHttp: process.env.BASE_HTTP_URL || 'https://mainnet.base.org',
    rpcWs: process.env.BASE_WS_URL || 'wss://base.publicnode.com',
    contractAddress: '0xbbFc8Bf808A0D1b964048B87c0787e03c97Cc341',
    tokens: {
      USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      AERO: '0x940181a94A35A4569E4529A3CDfB74e38FD98631',
      DAI: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
      WELL: '0xA88594D404727625A9437C3f886C7643872296AE',
    },
    dexes: {
      uniswapV3Router: '0x2626664c2603336E57B271c5C0b26F421741e481',
      uniswapV3Factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD',
      uniswapV3QuoterV2: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',
      aerodromeRouter: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
      aerodromeFactory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
    },
    aave: {
      pool: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
      flashFee: 0.0005,
    },
    watchPairs: [
      { tokenOut: '0x940181a94A35A4569E4529A3CDfB74e38FD98631', fee: 3000, name: 'AERO' },
      { tokenOut: '0xA88594D404727625A9437C3f886C7643872296AE', fee: 3000, name: 'WELL' },
    ],
    surfaces: [
      { name: 'UniV3_Aero', dex1: 'uniswapV3', dex2: 'aerodrome' },
    ]
  },
  arbitrum: {
    name: 'Arbitrum One',
    chainId: 42161,
    rpcHttp: process.env.ARB_HTTP_URL || 'https://arb1.arbitrum.io/rpc',
    rpcWs: process.env.ARB_WS_URL || 'wss://arb1.arbitrum.io/feed', 
    contractAddress: '', // To be deployed
    tokens: {
      USDC: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      ARB: '0x912CE59144191C1204E6455938cc2412b3f71f85',
      GMX: '0xfc5A1A57C311F15fe4341621Ec448c1f1967280A',
      RDNT: '0x3082CCd61395b7F5052047E24c3218559D06D7A5',
    },
    dexes: {
      uniswapV3Router: '0xE592427A0AEce92De3Edee1F18E0157C05861564',
      uniswapV3Factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984',
      uniswapV3QuoterV2: '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
      camelotV3Router: '0x1F721E64571A24194602120BCec23E6db1426442',
      camelotV3Factory: '0x1a3c1bdCc53784789C13374464c53E5B19d6Cba4',
      ramsesRouter: '0xAAA87963EFe74394b91747FA733E3917d68180E7',
      ramsesFactory: '0xFf7CC3Ca8ed1286591BE82f56EC347083D617721',
    },
    aave: {
      pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
      flashFee: 0.0005,
    },
    watchPairs: [
      { tokenOut: '0x912CE59144191C1204E6455938cc2412b3f71f85', fee: 3000, name: 'ARB' },
      { tokenOut: '0xfc5A1A57C311F15fe4341621Ec448c1f1967280A', fee: 3000, name: 'GMX' },
    ],
    surfaces: [
      { name: 'UniV3_Camelot', dex1: 'uniswapV3', dex2: 'camelotV3' },
      { name: 'UniV3_Ramses', dex1: 'uniswapV3', dex2: 'ramses' },
    ]
  }
};

const ACTIVE_CONFIG = CONFIG_BY_CHAIN[CHAIN_ID] || CONFIG_BY_CHAIN.base;

export const CONFIG = {
  chain: {
    name: ACTIVE_CONFIG.name,
    chainId: ACTIVE_CONFIG.chainId,
    rpcHttp: ACTIVE_CONFIG.rpcHttp,
    rpcWs: ACTIVE_CONFIG.rpcWs,
  },
  wallet: {
    privateKey: process.env.PRIVATE_KEY || '',
    contractAddress: ACTIVE_CONFIG.contractAddress,
  },
  tokens: ACTIVE_CONFIG.tokens,
  dexes: ACTIVE_CONFIG.dexes,
  aave: ACTIVE_CONFIG.aave,
  arb: {
    minProfitBps: 20,
    minProfitUsdc: 2,
    flashLoanAmount: 30000,
    slippageBps: 15,
    maxGasGwei: 10,
    cooldownMs: 2000,
  },
  scanner: {
    uniFeeTiers: [100, 500, 3000, 10000] as const,
    watchPairs: ACTIVE_CONFIG.watchPairs,
    surfaces: ACTIVE_CONFIG.surfaces,
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
