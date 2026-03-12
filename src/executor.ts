// executor.ts — EDITED: Jupiter swaps → Flash loan contract calls
// BEFORE: two separate Jupiter transactions (buy then sell), real capital at risk
// AFTER:  one atomic flash loan transaction, zero capital at risk

import { CONFIG } from './config';
import { ArbOpportunity, TradeResult } from './types';
import { Logger } from './logger';
import { WalletManager } from './wallet';

export class Executor {
  private wallet: WalletManager;
  private logger: Logger;
  private lastTrade: number = 0;
  private isTrading: boolean = false;
  private totalProfit: number = 0;
  private tradesExecuted: number = 0;
  private tradesFailed: number = 0;

  constructor(wallet: WalletManager, logger: Logger) {
    this.wallet = wallet;
    this.logger = logger;
  }

  async execute(opp: ArbOpportunity): Promise<TradeResult> {
    console.log(`Execute called | isTrading: ${this.isTrading} | timeSinceLast: ${Date.now() - this.lastTrade}ms`);

    // Guard: prevent concurrent trades synchronously before ANY await
    if (this.isTrading) {
      return { success: false, error: 'Trade already in progress' };
    }

    // Guard: cooldown check must use the OLD lastTrade value before we lock and overwrite it
    if (Date.now() - this.lastTrade < CONFIG.arb.cooldownMs) {
      return { success: false, error: `Cooldown: ${CONFIG.arb.cooldownMs - (Date.now() - this.lastTrade)}ms remaining` };
    }

    // Now we can safely lock the true execution
    this.isTrading = true;
    this.lastTrade = Date.now();

    // Guard: gas price check
    const gasGwei = await this.wallet.getGasPrice();
    if (gasGwei > CONFIG.arb.maxGasGwei) {
      this.isTrading = false;
      return { success: false, error: `Gas too high: ${gasGwei.toFixed(2)} gwei (max: ${CONFIG.arb.maxGasGwei})` };
    }

    try {
      this.logger.info('Executor',
        `Firing flash loan: ${opp.tokenName} | ${opp.gapBps}bps | $${opp.flashAmount.toLocaleString()} | ` +
        `leg1: ${opp.leg1.router.slice(0, 8)}... → leg2: ${opp.leg2.router.slice(0, 8)}...`
      );

      if (CONFIG.dryRun) {
        this.logger.info('Executor', '[DRY RUN] Skipped real transaction');
        return { success: true, profit: opp.estimatedProfit };
      }

      // ONE atomic transaction — flash loan + buy + sell + repay
      const { txHash, gasUsed } = await this.wallet.executeArbitrage(
        opp.tokenOut,
        opp.flashAmount,
        opp.leg1,
        opp.leg2,
        CONFIG.arb.minProfitUsdc
      );

      this.tradesExecuted++;
      this.totalProfit += opp.estimatedProfit;

      this.logger.success('Executor',
        `Trade confirmed | tx: ${txHash.slice(0, 12)}... | ` +
        `estimated profit: $${opp.estimatedProfit.toFixed(2)} | ` +
        `gas used: ${gasUsed.toLocaleString()} | ` +
        `total profit: $${this.totalProfit.toFixed(2)}`
      );

      return { success: true, txHash, profit: opp.estimatedProfit, gasUsed };

    } catch (err: any) {
      this.tradesFailed++;
      this.logger.error('Executor', `Revert reason: ${err.message}`);
      return { success: false, error: err.message };

    } finally {
      this.isTrading = false;
    }
  }

  getStats() {
    return {
      tradesExecuted: this.tradesExecuted,
      tradesFailed: this.tradesFailed,
      totalProfit: this.totalProfit,
      successRate: this.tradesExecuted > 0
        ? ((this.tradesExecuted / (this.tradesExecuted + this.tradesFailed)) * 100).toFixed(1) + '%'
        : 'N/A',
    };
  }
}
