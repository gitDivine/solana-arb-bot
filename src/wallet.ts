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

// Public fallbacks (will be refined per chain in a future update or kept generic)
const PUBLIC_HTTP_FALLBACKS: Record<number, string[]> = {
  8453: ['https://mainnet.base.org', 'https://base.publicnode.com', 'https://1rpc.io/base'],
  42161: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum.public-rpc.com', 'https://1rpc.io/arbitrum']
};

const PUBLIC_WS_FALLBACKS: Record<number, string[]> = {
  8453: ['wss://base.publicnode.com', 'wss://mainnet.base.org/ws'],
  42161: ['wss://arb1.arbitrum.io/feed', 'wss://arbitrum.publicnode.com']
};

export class WalletManager {
  public provider: ethers.WebSocketProvider;
  private httpProvider: ethers.JsonRpcProvider;
  public signer: ethers.Wallet;
  public contract: ethers.Contract;
  private workingWs: string = CONFIG.chain.rpcWs;
  private workingHttp: string = CONFIG.chain.rpcHttp;

  constructor() {
    this.httpProvider = new ethers.JsonRpcProvider(CONFIG.chain.rpcHttp, CONFIG.chain.chainId, { staticNetwork: true });
    this.signer = new ethers.Wallet(CONFIG.wallet.privateKey, this.httpProvider);
    this.contract = new ethers.Contract(CONFIG.wallet.contractAddress || ethers.ZeroAddress, ARB_BOT_ABI, this.signer);
    this.provider = null as any;
  }

  async validateAndSwitchRpc(): Promise<void> {
    const tryConnect = async (http: string, ws: string): Promise<boolean> => {
      let tempWs: ethers.WebSocketProvider | null = null;
      try {
        const hostHttp = http.split('//')[1]?.split('/')[0] || 'RPC';
        console.log(`[Wallet] Probing ${CONFIG.chain.name} HTTP RPC: ${hostHttp}...`);
        const tempHttp = new ethers.JsonRpcProvider(http, CONFIG.chain.chainId, { staticNetwork: true });

        await Promise.race([
          tempHttp.getBlockNumber(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('HTTP Probe Timeout')), 5000))
        ]);

        const hostWs = ws.split('//')[1]?.split('/')[0] || 'WS';
        console.log(`[Wallet] Probing ${CONFIG.chain.name} WebSocket RPC: ${hostWs}...`);
        tempWs = new ethers.WebSocketProvider(ws, CONFIG.chain.chainId, { staticNetwork: true });
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
      const httpFallbacks = PUBLIC_HTTP_FALLBACKS[CONFIG.chain.chainId] || [];
      const wsFallbacks = PUBLIC_WS_FALLBACKS[CONFIG.chain.chainId] || [];
      
      for (let i = 0; i < httpFallbacks.length; i++) {
        if (await tryConnect(httpFallbacks[i], wsFallbacks[i] || wsFallbacks[0])) {
          found = true;
          break;
        }
      }
      if (!found) {
        throw new Error('All RPC providers exhausted');
      }
    }

    // Re-init signer and contract
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
    this.provider = new ethers.WebSocketProvider(this.workingWs, CONFIG.chain.chainId, { staticNetwork: true });
    console.log(`[Wallet] Reconnecting WS to: ${this.workingWs.split('//')[1]?.split('/')[0]}`);
  }
}
