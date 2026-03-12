// logger.ts — KEPT (structure unchanged, updated labels for Base)
import axios from 'axios';
import { CONFIG } from './config';
import { ArbOpportunity, DexType } from './types';

type Level = 'INFO' | 'WARN' | 'ERROR' | 'SUCCESS' | 'DEBUG';

export class Logger {
  private tgEnabled: boolean;

  constructor() {
    this.tgEnabled = !!(CONFIG.telegram.botToken && CONFIG.telegram.chatId);
  }

  info(tag: string, msg: string) { this.log('INFO', tag, msg); }
  warn(tag: string, msg: string) { this.log('WARN', tag, msg); }
  error(tag: string, msg: string) { this.log('ERROR', tag, msg); }
  success(tag: string, msg: string) { this.log('SUCCESS', tag, msg); this.sendTelegram(`✅ ${tag}: ${msg}`); }
  debug(tag: string, msg: string) { if (process.env.DEBUG) this.log('DEBUG', tag, msg); }

  opportunity(opp: ArbOpportunity): void {
    const route = `${this.getDexName(opp.leg1.dexType)} ↔ ${this.getDexName(opp.leg2.dexType)}`;
    const msg = `🎯 ARB FOUND | ${opp.tokenName} | ${opp.gapBps}bps | ~$${opp.estimatedProfit.toFixed(2)} profit | ${route}`;
    this.log('SUCCESS', 'Opportunity', msg);
    this.sendTelegram(msg);
  }

  private getDexName(type: DexType): string {
    switch (type) {
      case DexType.UNISWAP_V3: return 'UniV3';
      case DexType.AERODROME: return 'Aero';
      case DexType.UNISWAP_V2: return 'V2';
      default: return 'DEX';
    }
  }

  private log(level: Level, tag: string, msg: string): void {
    const time = new Date().toTimeString().slice(0, 8);
    const icons: Record<Level, string> = { INFO: '·', WARN: '⚠', ERROR: '✗', SUCCESS: '✓', DEBUG: '…' };
    console.log(`[${time}] ${icons[level]} ${tag.padEnd(12)} | ${msg}`);
  }

  async sendTelegram(msg: string): Promise<void> {
    if (!this.tgEnabled) return;
    try {
      await axios.post(`https://api.telegram.org/bot${CONFIG.telegram.botToken}/sendMessage`, {
        chat_id: CONFIG.telegram.chatId,
        text: `🤖 Base Arb Bot\n${msg}`,
        parse_mode: 'HTML',
      });
    } catch { /* silent fail */ }
  }
}
