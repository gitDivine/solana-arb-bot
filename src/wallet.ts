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
    let httpUrl = CONFIG.chain.rpcHttp;
    let wsUrl = CONFIG.chain.rpcWs;

    try {
      // Test the configured HTTP RPC first
      await this.httpProvider.getNetwork();

      // If HTTP works, attempt to connect WebSocket (this will throw if limited)
      this.provider = new ethers.WebSocketProvider(wsUrl, 8453, { staticNetwork: true });

      console.log(`[Wallet] Primary RPC connection verified ✓`);
    } catch (err: any) {
      if (err.message.includes('429') || err.message.includes('limit exceeded') || err.message.includes('network')) {
        const fallback = 'https://mainnet.base.org';
        const fallbackWs = 'wss://mainnet.base.org/ws';
        console.warn(`[Wallet] Primary RPC failed or limited. Switching to public fallbacks...`);

        this.httpProvider = new ethers.JsonRpcProvider(fallback, 8453, { staticNetwork: true });
        this.provider = new ethers.WebSocketProvider(fallbackWs, 8453, { staticNetwork: true });

        this.signer = new ethers.Wallet(CONFIG.wallet.privateKey, this.httpProvider);
        this.contract = new ethers.Contract(CONFIG.wallet.contractAddress, ARB_BOT_ABI, this.signer);
      } else {
        throw err;
      }
    }
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
