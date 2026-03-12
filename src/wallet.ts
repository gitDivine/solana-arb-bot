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

  async validateAndSwitchRpc(): Promise<void> {
    const fallbackHttp = 'https://mainnet.base.org';
    const fallbackWs = 'wss://mainnet.base.org/ws';

    const tryConnect = async (http: string, ws: string): Promise<boolean> => {
      let tempWs: ethers.WebSocketProvider | null = null;
      try {
        console.log(`[Wallet] Probing HTTP RPC: ${http.split('//')[1].split('/')[0]}...`);
        const tempHttp = new ethers.JsonRpcProvider(http, 8453, { staticNetwork: true });

        // HTTP Timeout race
        await Promise.race([
          tempHttp.getBlockNumber(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('HTTP Probe Timeout')), 5000))
        ]);

        console.log(`[Wallet] Probing WebSocket RPC: ${ws.split('//')[1].split('/')[0]}...`);
        tempWs = new ethers.WebSocketProvider(ws, 8453, { staticNetwork: true });

        // WS Timeout race
        await Promise.race([
          tempWs.getBlockNumber(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('WS Probe Timeout')), 5000))
        ]);

        this.httpProvider = tempHttp;
        this.provider = tempWs;
        return true;
      } catch (err: any) {
        const msg = err.message || String(err);
        console.warn(`[Wallet] RPC Probe failed: ${msg.slice(0, 100)}`);
        if (tempWs) try { tempWs.destroy(); } catch { }
        return false;
      }
    };

    // 1. Try configured RPC first
    const primaryOk = await tryConnect(CONFIG.chain.rpcHttp, CONFIG.chain.rpcWs);

    // 2. If failed, switch to fallback
    if (!primaryOk) {
      console.warn(`[Wallet] Switching to public fallbacks due to primary failure...`);
      const fallbackOk = await tryConnect(fallbackHttp, fallbackWs);

      if (!fallbackOk) {
        console.error(`[Wallet] CRITICAL: Even public fallback RPC failed. Check your internet connection.`);
        throw new Error('No working RPC found');
      }
    }

    // 3. Re-init signer and contract with whichever provider is now active
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
    this.provider = new ethers.WebSocketProvider(CONFIG.chain.rpcWs, 8453, { staticNetwork: true });
  }
}
