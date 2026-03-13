import { ethers } from 'ethers';
import { CONFIG } from './config';
import { SwapLeg } from './types';

// ArbBot contract ABI (only what the bot needs)
const ARB_BOT_ABI = [
  'function startArbitrage(address tokenOut, uint256 flashAmount, (address router, uint8 dexType, uint24 fee, bool stable, address factory) leg1, (address router, uint8 dexType, uint24 fee, bool stable, address factory) leg2, uint256 minProfitUsdc) external',
  'function withdrawToken(address token) external',
  'function withdrawEth() external',
  'function owner() view returns (address)',
  'event ArbitrageExecuted(address tokenOut, uint256 profit, address router1, address router2)',
];

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];

export class WalletManager {
  public provider: ethers.WebSocketProvider;
  private httpProvider: ethers.JsonRpcProvider;
  public signer: ethers.Wallet;
  public contract: ethers.Contract;

  constructor() {
    // Only initialize the HTTP provider (lazy-ish)
    this.httpProvider = new ethers.JsonRpcProvider(CONFIG.chain.rpcHttp, 8453, { staticNetwork: true });
    this.signer = new ethers.Wallet(CONFIG.wallet.privateKey, this.httpProvider);
    this.contract = new ethers.Contract(CONFIG.wallet.contractAddress, ARB_BOT_ABI, this.signer);

    // Initialize provider as null; it will be set in validateAndSwitchRpc after verification
    this.provider = null as any;
  }

  const PUBLIC_HTTP_FALLBACKS = [
    'https://mainnet.base.org',
    'https://base.publicnode.com',
    'https://1rpc.io/base'
  ];

  const PUBLIC_WS_FALLBACKS = [
    'wss://base.publicnode.com',
    'wss://mainnet.base.org/ws',
    'wss://base.drpc.org'
  ];

export class WalletManager {
  public provider: ethers.WebSocketProvider;
  private httpProvider: ethers.JsonRpcProvider;
  public signer: ethers.Wallet;
  public contract: ethers.Contract;
  private workingWs: string = CONFIG.chain.rpcWs;
  private workingHttp: string = CONFIG.chain.rpcHttp;

  constructor() {
    this.httpProvider = new ethers.JsonRpcProvider(CONFIG.chain.rpcHttp, 8453, { staticNetwork: true });
    this.signer = new ethers.Wallet(CONFIG.wallet.privateKey, this.httpProvider);
    this.contract = new ethers.Contract(CONFIG.wallet.contractAddress, ARB_BOT_ABI, this.signer);
    this.provider = null as any;
  }

  async validateAndSwitchRpc(): Promise<void> {
    const tryConnect = async (http: string, ws: string): Promise<boolean> => {
      let tempWs: ethers.WebSocketProvider | null = null;
      try {
        const hostHttp = http.split('//')[1]?.split('/')[0] || 'RPC';
        console.log(`[Wallet] Probing HTTP RPC: ${hostHttp}...`);
        const tempHttp = new ethers.JsonRpcProvider(http, 8453, { staticNetwork: true });

        await Promise.race([
          tempHttp.getBlockNumber(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('HTTP Probe Timeout')), 5000))
        ]);

        const hostWs = ws.split('//')[1]?.split('/')[0] || 'WS';
        console.log(`[Wallet] Probing WebSocket RPC: ${hostWs}...`);
        tempWs = new ethers.WebSocketProvider(ws, 8453, { staticNetwork: true });
        tempWs.on('error', () => { });

        await Promise.race([
          tempWs.getBlockNumber(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('WS Probe Timeout')), 5000))
        ]);

        this.httpProvider = tempHttp;
        this.provider = tempWs;
        this.workingHttp = http;
        this.workingWs = ws;
        return true;
      } catch (err: any) {
        console.warn(`[Wallet] Probe failed for ${http.split('//')[1]?.split('/')[0]}: ${err.message?.slice(0, 50)}`);
        if (tempWs) try { tempWs.destroy(); } catch { }
        return false;
      }
    };

    // 1. Try primary
    if (await tryConnect(CONFIG.chain.rpcHttp, CONFIG.chain.rpcWs)) {
      console.log(`[Wallet] Primary RPC connected ✓`);
    } else {
      // 2. Cycle through fallbacks
      console.warn(`[Wallet] Primary failed. Cycling through public fallbacks...`);
      let found = false;
      for (let i = 0; i < PUBLIC_HTTP_FALLBACKS.length; i++) {
        if (await tryConnect(PUBLIC_HTTP_FALLBACKS[i], PUBLIC_WS_FALLBACKS[i])) {
          found = true;
          break;
        }
      }
      if (!found) {
        throw new Error('All RPC providers exhausted');
      }
    }

    this.signer = new ethers.Wallet(CONFIG.wallet.privateKey, this.httpProvider);
    this.contract = new ethers.Contract(CONFIG.wallet.contractAddress, ARB_BOT_ABI, this.signer);
    console.log(`[Wallet] RPC initialization complete ✓`);
  }

  async getUsdcBalance(): Promise<number> {
    const usdc = new ethers.Contract(CONFIG.tokens.USDC, ERC20_ABI, this.httpProvider);
    const bal = await usdc.balanceOf(this.signer.address);
    return Number(ethers.formatUnits(bal, 6));
  }

  async getEthBalance(): Promise<number> {
    const bal = await this.httpProvider.getBalance(this.signer.address);
    return Number(ethers.formatEther(bal));
  }

  async getGasPrice(): Promise<number> {
    const fee = await this.httpProvider.getFeeData();
    return Number(ethers.formatUnits(fee.gasPrice || 0n, 'gwei'));
  }

  async executeArbitrage(
    tokenOut: string,
    flashAmount: number,
    leg1: SwapLeg,
    leg2: SwapLeg,
    minProfitUsdc: number
  ): Promise<{ txHash: string; gasUsed: number }> {
    const flashAmountWei = ethers.parseUnits(flashAmount.toString(), 6);
    const minProfitWei = ethers.parseUnits(minProfitUsdc.toString(), 6);

    const data = this.contract.interface.encodeFunctionData('startArbitrage', [
      tokenOut, flashAmountWei, leg1, leg2, minProfitWei
    ]);

    const tx = await this.signer.sendTransaction({
      to: CONFIG.wallet.contractAddress,
      data: data,
      gasLimit: 2_000_000,
    });

    const receipt = await tx.wait();
    return {
      txHash: receipt!.hash,
      gasUsed: Number(receipt!.gasUsed),
    };
  }

  getERC20Contract(address: string): ethers.Contract {
    return new ethers.Contract(address, ERC20_ABI, this.httpProvider);
  }

  reconnectWs(): void {
    if (this.provider) try { this.provider.destroy(); } catch { }
    this.provider = new ethers.WebSocketProvider(this.workingWs, 8453, { staticNetwork: true });
    console.log(`[Wallet] Reconnecting WS to: ${this.workingWs.split('//')[1]?.split('/')[0]}`);
  }
}
