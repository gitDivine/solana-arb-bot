import {
  Connection,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import { CONFIG, EXECUTION_CONFIG, TOKENS } from './config';
import { Opportunity, ExecutionResult, LegResult, BotState } from './types';
import { loadKeypair, getPublicKey, getSolBalance, getUsdcBalance, getTokenBalance } from './wallet';
import { logError, sendTelegramAlert } from './logger';
import * as fs from 'fs';
import * as path from 'path';

const JUPITER_QUOTE_URL = `${CONFIG.jupiterApiBase}/quote`;
const JUPITER_SWAP_URL = `${CONFIG.jupiterApiBase}/swap`;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Bot State ---

const state: BotState = {
  isExecuting: false,
  tradesThisHour: 0,
  lastTradeTimestamp: 0,
  hourWindowStart: Date.now(),
  stuckToken: null,
  consecutiveFailures: 0,
  totalTrades: 0,
  totalProfitUsd: 0,
};

export function getBotState(): Readonly<BotState> {
  return { ...state };
}

function resetHourWindowIfNeeded(): void {
  if (Date.now() - state.hourWindowStart > 3_600_000) {
    state.tradesThisHour = 0;
    state.hourWindowStart = Date.now();
  }
}

// --- Execution log ---

function logExecToFile(data: Record<string, unknown>): void {
  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(CONFIG.logDir, `exec-${today}.json`);
  const line = JSON.stringify({ ...data, _ts: new Date().toISOString() }) + '\n';
  fs.appendFileSync(logPath, line);
}

// --- Jupiter API ---

interface JupiterQuote {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: Array<{
    swapInfo: {
      ammKey: string;
      label: string;
      inputMint: string;
      outputMint: string;
      inAmount: string;
      outAmount: string;
    };
    percent: number;
  }>;
}

interface SwapResponse {
  swapTransaction: string;
  lastValidBlockHeight: number;
}

async function fetchQuote(
  inputMint: string,
  outputMint: string,
  amount: number,
  dex: string,
  slippageBps: number = CONFIG.slippageBps,
): Promise<JupiterQuote | null> {
  const params = new URLSearchParams({
    inputMint,
    outputMint,
    amount: amount.toString(),
    slippageBps: slippageBps.toString(),
  });
  if (dex) {
    params.set('onlyDirectRoutes', 'true');
    params.set('dexes', dex);
  }
  try {
    const res = await fetch(`${JUPITER_QUOTE_URL}?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return (await res.json()) as JupiterQuote;
  } catch {
    return null;
  }
}

async function fetchSwapTx(quote: JupiterQuote): Promise<SwapResponse | null> {
  try {
    const res = await fetch(JUPITER_SWAP_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userPublicKey: getPublicKey().toBase58(),
        quoteResponse: quote,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: EXECUTION_CONFIG.priorityFeeLamports,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      logError(`/swap failed (${res.status}): ${text}`);
      return null;
    }
    return (await res.json()) as SwapResponse;
  } catch (err) {
    logError(`/swap error: ${err}`);
    return null;
  }
}

async function signAndSend(
  connection: Connection,
  swap: SwapResponse,
): Promise<{ signature: string; confirmed: boolean; error?: string }> {
  try {
    const keypair = loadKeypair();
    const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
    tx.sign([keypair]);

    const signature = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: true,
      maxRetries: 2,
    });

    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
      const confirmation = await connection.confirmTransaction(
        { signature, blockhash, lastValidBlockHeight: swap.lastValidBlockHeight || lastValidBlockHeight },
        'confirmed',
      );
      if (confirmation.value.err) {
        return { signature, confirmed: false, error: `Reverted: ${JSON.stringify(confirmation.value.err)}` };
      }
      return { signature, confirmed: true };
    } catch (err) {
      return { signature, confirmed: false, error: `Confirm error: ${err}` };
    }
  } catch (err) {
    return { signature: '', confirmed: false, error: `Send error: ${err}` };
  }
}

// --- Preflight ---

async function preflightChecks(
  connection: Connection,
  opp: Opportunity,
): Promise<{ canExecute: boolean; reason?: string; usdcBalance: number; solBalance: number }> {
  if (state.isExecuting) return { canExecute: false, reason: 'Already executing', usdcBalance: 0, solBalance: 0 };
  if (EXECUTION_CONFIG.dryRun) return { canExecute: false, reason: 'DRY_RUN', usdcBalance: 0, solBalance: 0 };
  if (state.consecutiveFailures >= EXECUTION_CONFIG.maxConsecutiveFailures)
    return { canExecute: false, reason: `Paused: ${state.consecutiveFailures} failures`, usdcBalance: 0, solBalance: 0 };

  resetHourWindowIfNeeded();
  if (state.tradesThisHour >= EXECUTION_CONFIG.maxTradesPerHour)
    return { canExecute: false, reason: 'Hourly limit reached', usdcBalance: 0, solBalance: 0 };

  const cooldownMs = state.consecutiveFailures > 0 ? EXECUTION_CONFIG.cooldownAfterFailMs : EXECUTION_CONFIG.cooldownAfterTradeMs;
  const elapsed = Date.now() - state.lastTradeTimestamp;
  if (state.lastTradeTimestamp > 0 && elapsed < cooldownMs)
    return { canExecute: false, reason: `Cooldown: ${Math.ceil((cooldownMs - elapsed) / 1000)}s`, usdcBalance: 0, solBalance: 0 };

  if (state.stuckToken)
    return { canExecute: false, reason: `Stuck holding ${state.stuckToken.symbol}`, usdcBalance: 0, solBalance: 0 };

  if (opp.profitBps < EXECUTION_CONFIG.minExecutionBps)
    return { canExecute: false, reason: `${opp.profitBps} bps < min ${EXECUTION_CONFIG.minExecutionBps}`, usdcBalance: 0, solBalance: 0 };

  const [solBalance, usdcBalance] = await Promise.all([
    getSolBalance(connection),
    getUsdcBalance(connection),
  ]);

  // Auto-refuel SOL if below threshold
  if (solBalance < EXECUTION_CONFIG.refuelSolThreshold && usdcBalance > EXECUTION_CONFIG.refuelUsdcAmount + 1_000_000) {
    console.log(`  [!] SOL low (${(solBalance / LAMPORTS_PER_SOL).toFixed(4)}) — auto-refueling...`);
    const refueled = await refuelSol(connection);
    if (refueled) {
      const newSolBalance = await getSolBalance(connection);
      const newUsdcBalance = await getUsdcBalance(connection);
      if (newSolBalance < EXECUTION_CONFIG.minSolBalance)
        return { canExecute: false, reason: `SOL still too low after refuel`, usdcBalance: newUsdcBalance, solBalance: newSolBalance };
      if (newUsdcBalance < 1_000_000)
        return { canExecute: false, reason: `USDC too low after refuel: ${(newUsdcBalance / 1e6).toFixed(2)}`, usdcBalance: newUsdcBalance, solBalance: newSolBalance };
      return { canExecute: true, usdcBalance: newUsdcBalance, solBalance: newSolBalance };
    }
  }

  if (solBalance < EXECUTION_CONFIG.minSolBalance)
    return { canExecute: false, reason: `SOL too low: ${(solBalance / LAMPORTS_PER_SOL).toFixed(4)}`, usdcBalance, solBalance };
  if (usdcBalance < 1_000_000)
    return { canExecute: false, reason: `USDC too low: ${(usdcBalance / 1e6).toFixed(2)}`, usdcBalance, solBalance };

  return { canExecute: true, usdcBalance, solBalance };
}

// --- Re-quote ---

async function reQuoteAndValidate(opp: Opportunity, usdcBalance: number): Promise<{
  valid: boolean;
  reason?: string;
  profitBps: number;
  tradeAmount: number;
  buyQuote: JupiterQuote | null;
  sellAmount: number;
}> {
  const reserve = EXECUTION_CONFIG.refuelUsdcAmount; // keep $1 for SOL refuel
  const tradeAmount = Math.floor(Math.max(0, usdcBalance - reserve) * EXECUTION_CONFIG.tradePercentage);
  const usdcMint = TOKENS.USDC.mint;
  const tokenMint = opp.pair.tokenB.mint;

  // Quote buy leg (USDC → Token)
  const buyQuote = await fetchQuote(usdcMint, tokenMint, tradeAmount, opp.buyDex);
  if (!buyQuote) return { valid: false, reason: 'Buy re-quote failed', profitBps: 0, tradeAmount, buyQuote: null, sellAmount: 0 };

  const tokenOut = Number(buyQuote.outAmount); // post-fee amount

  // Quote sell leg (Token → USDC) using expected buy output
  const sellQuote = await fetchQuote(tokenMint, usdcMint, tokenOut, opp.sellDex);
  if (!sellQuote) return { valid: false, reason: 'Sell re-quote failed', profitBps: 0, tradeAmount, buyQuote, sellAmount: tokenOut };

  // Compute profitability using POST-FEE amounts (what user actually receives)
  const usdcIn = Number(buyQuote.inAmount);
  const usdcOut = Number(sellQuote.outAmount);
  const profitBps = Math.round((usdcOut / usdcIn - 1) * 10_000);

  if (profitBps < EXECUTION_CONFIG.reQuoteMinBps) {
    return { valid: false, reason: `Re-quote: ${profitBps} bps < ${EXECUTION_CONFIG.reQuoteMinBps}`, profitBps, tradeAmount, buyQuote, sellAmount: tokenOut };
  }

  // Check price impact
  const impact = Math.abs(parseFloat(buyQuote.priceImpactPct || '0'));
  if (impact > EXECUTION_CONFIG.maxPriceImpactPct) {
    return { valid: false, reason: `Price impact ${impact.toFixed(2)}% > max`, profitBps, tradeAmount, buyQuote, sellAmount: tokenOut };
  }

  return { valid: true, profitBps, tradeAmount, buyQuote, sellAmount: tokenOut };
}

// --- Execute a single leg ---

async function executeLeg(
  connection: Connection,
  legNum: 1 | 2,
  inputMint: string,
  outputMint: string,
  amount: number,
  dex: string,
  slippageBps?: number,
): Promise<LegResult> {
  const start = Date.now();
  const result: LegResult = {
    leg: legNum, dex, inputMint, outputMint, inputAmount: amount,
    expectedOutput: 0, signature: '', status: 'pending', durationMs: 0,
  };

  try {
    const quote = await fetchQuote(inputMint, outputMint, amount, dex, slippageBps);
    if (!quote) {
      result.status = 'failed';
      result.error = 'Quote failed';
      result.durationMs = Date.now() - start;
      return result;
    }
    result.expectedOutput = Number(quote.outAmount);

    const swap = await fetchSwapTx(quote);
    if (!swap) {
      result.status = 'failed';
      result.error = 'Swap tx build failed';
      result.durationMs = Date.now() - start;
      return result;
    }

    result.status = 'sent';
    const { signature, confirmed, error } = await signAndSend(connection, swap);
    result.signature = signature;

    if (!confirmed) {
      result.status = 'failed';
      result.error = error || 'Not confirmed';
    } else {
      result.status = 'confirmed';
    }
  } catch (err) {
    result.status = 'failed';
    result.error = `Unexpected: ${err}`;
  }
  result.durationMs = Date.now() - start;
  return result;
}

// --- Stuck token recovery ---

async function recoverStuckToken(connection: Connection): Promise<boolean> {
  if (!state.stuckToken) return false;

  const { mint, symbol, amount } = state.stuckToken;
  console.log(`  [Recovery] Selling ${symbol} back to USDC...`);

  const leg = await executeLeg(
    connection, 2, mint, TOKENS.USDC.mint, amount, '',
    EXECUTION_CONFIG.stuckRecoverySlippageBps,
  );

  logExecToFile({ type: 'recovery', token: symbol, amount, status: leg.status, signature: leg.signature, error: leg.error });

  if (leg.status === 'confirmed') {
    console.log(`  [Recovery] Success: ${leg.signature.slice(0, 8)}...`);
    state.stuckToken = null;
    return true;
  }
  console.log(`  [Recovery] Failed: ${leg.error}`);
  return false;
}

// --- SOL auto-refuel ---

async function refuelSol(connection: Connection): Promise<boolean> {
  try {
    const usdcBalance = await getUsdcBalance(connection);
    if (usdcBalance < EXECUTION_CONFIG.refuelUsdcAmount + 1_000_000) {
      logError(`Not enough USDC to refuel. Have: $${(usdcBalance / 1e6).toFixed(2)}, need: $${(EXECUTION_CONFIG.refuelUsdcAmount / 1e6).toFixed(2)} + $1 reserve`);
      return false;
    }

    console.log(`  [Refuel] Swapping $${(EXECUTION_CONFIG.refuelUsdcAmount / 1e6).toFixed(2)} USDC → SOL for gas...`);

    const leg = await executeLeg(
      connection, 1, TOKENS.USDC.mint, TOKENS.SOL.mint, EXECUTION_CONFIG.refuelUsdcAmount, '',
    );

    logExecToFile({ type: 'refuel', usdcAmount: EXECUTION_CONFIG.refuelUsdcAmount / 1e6, status: leg.status, signature: leg.signature, error: leg.error });

    if (leg.status === 'confirmed') {
      await sleep(2000);
      const solBalance = await getSolBalance(connection);
      console.log(`  [Refuel] Success! SOL balance: ${(solBalance / LAMPORTS_PER_SOL).toFixed(4)}`);
      await sendTelegramAlert(`*SOL Refuel*\nSwapped $${(EXECUTION_CONFIG.refuelUsdcAmount / 1e6).toFixed(2)} USDC → SOL\nSOL balance: ${(solBalance / LAMPORTS_PER_SOL).toFixed(4)}`).catch(() => {});
      return true;
    }

    logError(`Refuel failed: ${leg.error}`);
    return false;
  } catch (err) {
    logError(`Refuel error: ${err}`);
    return false;
  }
}

// --- USDC bootstrap ---

export async function bootstrapUsdc(connection: Connection): Promise<boolean> {
  try {
    const solBalance = await getSolBalance(connection);
    const keepLamports = Math.round(0.05 * LAMPORTS_PER_SOL); // keep 0.05 SOL for gas
    const swapLamports = Math.round(EXECUTION_CONFIG.bootstrapSolAmount * LAMPORTS_PER_SOL);

    if (solBalance < keepLamports + swapLamports) {
      logError(`Not enough SOL for bootstrap. Have: ${(solBalance / LAMPORTS_PER_SOL).toFixed(4)}, need: ${((keepLamports + swapLamports) / LAMPORTS_PER_SOL).toFixed(4)}`);
      return false;
    }

    // Try up to 2 times
    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log(`  [Bootstrap] Swapping ${EXECUTION_CONFIG.bootstrapSolAmount} SOL → USDC (attempt ${attempt})...`);

      const leg = await executeLeg(
        connection, 1, TOKENS.SOL.mint, TOKENS.USDC.mint, swapLamports, '',
      );

      logExecToFile({ type: 'bootstrap', attempt, solAmount: EXECUTION_CONFIG.bootstrapSolAmount, status: leg.status, signature: leg.signature, error: leg.error });

      if (leg.status === 'confirmed') {
        await sleep(2000);
        const usdcBalance = await getUsdcBalance(connection);
        console.log(`  [Bootstrap] Success! USDC balance: ${(usdcBalance / 1e6).toFixed(2)}`);
        await sendTelegramAlert(`*USDC Bootstrap*\nSwapped ${EXECUTION_CONFIG.bootstrapSolAmount} SOL to USDC\nBalance: $${(usdcBalance / 1e6).toFixed(2)}\nTx: ${leg.signature.slice(0, 8)}...`).catch(() => {});
        return true;
      }

      logError(`Bootstrap attempt ${attempt} failed: ${leg.error}`);
      if (attempt < 2) {
        console.log('  [Bootstrap] Retrying in 5 seconds...');
        await sleep(5000);
      }
    }

    return false;
  } catch (err) {
    logError(`Bootstrap error: ${err}`);
    return false;
  }
}

// --- Main execution ---

export async function executeOpportunity(
  connection: Connection,
  opp: Opportunity,
): Promise<ExecutionResult | null> {
  const start = Date.now();

  const preflight = await preflightChecks(connection, opp);
  if (!preflight.canExecute) {
    if (preflight.reason === 'DRY_RUN' && opp.profitBps >= EXECUTION_CONFIG.minExecutionBps) {
      console.log(`  [DRY RUN] Would execute: ${opp.pair.label} ${opp.buyDex}->${opp.sellDex} (${opp.profitBps} bps)`);
      logExecToFile({ type: 'dry_run', pair: opp.pair.label, buyDex: opp.buyDex, sellDex: opp.sellDex, profitBps: opp.profitBps });
    }
    return null;
  }

  // Recovery first
  if (state.stuckToken) {
    await recoverStuckToken(connection);
    if (state.stuckToken) return null;
  }

  // Re-quote
  const rq = await reQuoteAndValidate(opp, preflight.usdcBalance);
  if (!rq.valid) {
    console.log(`  [Skip] ${opp.pair.label}: ${rq.reason}`);
    logExecToFile({ type: 'skip', pair: opp.pair.label, reason: rq.reason, originalBps: opp.profitBps, reQuoteBps: rq.profitBps });
    return null;
  }

  // Execute
  state.isExecuting = true;
  console.log(`  [EXECUTE] ${opp.pair.label} | ${opp.buyDex} -> ${opp.sellDex} | ${rq.profitBps} bps | ${(rq.tradeAmount / 1e6).toFixed(2)} USDC`);

  const usdcMint = TOKENS.USDC.mint;
  const tokenMint = opp.pair.tokenB.mint;

  try {
    // Leg 1: Buy token
    const leg1 = await executeLeg(connection, 1, usdcMint, tokenMint, rq.tradeAmount, opp.buyDex);

    if (leg1.status !== 'confirmed') {
      state.consecutiveFailures++;
      state.lastTradeTimestamp = Date.now();
      state.tradesThisHour++;
      state.totalTrades++;
      state.isExecuting = false;

      const result: ExecutionResult = {
        opportunity: opp, status: 'failed', leg1, leg2: null,
        inputAmountUsd: rq.tradeAmount / 1e6, outputAmountUsd: 0,
        netProfitUsd: -(EXECUTION_CONFIG.priorityFeeLamports / LAMPORTS_PER_SOL * 200), // rough gas cost
        totalDurationMs: Date.now() - start, timestamp: new Date(),
      };
      logResult(result);
      return result;
    }

    // Verify token received
    await sleep(2000);
    const tokenBal = await getTokenBalance(connection, tokenMint);
    const actualTokenAmount = tokenBal.amount;

    if (actualTokenAmount === 0) {
      logError(`Leg 1 confirmed but 0 token balance for ${opp.pair.tokenB.symbol}`);
      state.isExecuting = false;
      state.consecutiveFailures++;
      return null;
    }

    // Leg 2: Sell token
    const leg2 = await executeLeg(connection, 2, tokenMint, usdcMint, actualTokenAmount, opp.sellDex);

    if (leg2.status !== 'confirmed') {
      // STUCK — holding token
      state.stuckToken = { mint: tokenMint, symbol: opp.pair.tokenB.symbol, amount: actualTokenAmount };
      state.consecutiveFailures++;
      state.lastTradeTimestamp = Date.now();
      state.tradesThisHour++;
      state.totalTrades++;
      state.isExecuting = false;

      const result: ExecutionResult = {
        opportunity: opp, status: 'partial', leg1, leg2,
        inputAmountUsd: rq.tradeAmount / 1e6, outputAmountUsd: 0,
        netProfitUsd: 0, totalDurationMs: Date.now() - start, timestamp: new Date(),
      };
      logResult(result);

      // Immediate recovery
      console.log(`  [!] Leg 2 failed — attempting recovery...`);
      await sleep(3000);
      await recoverStuckToken(connection);
      return result;
    }

    // Both legs succeeded
    await sleep(2000);
    const finalUsdc = await getUsdcBalance(connection);
    const realizedProfit = (finalUsdc - preflight.usdcBalance) / 1e6;

    state.consecutiveFailures = 0;
    state.lastTradeTimestamp = Date.now();
    state.tradesThisHour++;
    state.totalTrades++;
    state.totalProfitUsd += realizedProfit;
    state.isExecuting = false;

    const result: ExecutionResult = {
      opportunity: opp, status: 'success', leg1, leg2,
      inputAmountUsd: rq.tradeAmount / 1e6, outputAmountUsd: finalUsdc / 1e6,
      netProfitUsd: realizedProfit, totalDurationMs: Date.now() - start, timestamp: new Date(),
    };
    logResult(result);
    return result;

  } catch (err) {
    state.isExecuting = false;
    state.consecutiveFailures++;
    logError(`Execution error: ${err}`);
    return null;
  }
}

// --- Logging ---

function logResult(result: ExecutionResult): void {
  const icon = result.status === 'success' ? '+' : result.status === 'partial' ? '!' : 'X';
  console.log(
    `  [${icon}] ${result.opportunity.pair.label} | ${result.status.toUpperCase()}`
    + ` | P&L: $${result.netProfitUsd.toFixed(4)}`
    + ` | ${(result.totalDurationMs / 1000).toFixed(1)}s`
    + (result.leg1.signature ? ` | L1: ${result.leg1.signature.slice(0, 8)}...` : '')
    + (result.leg2?.signature ? ` | L2: ${result.leg2.signature.slice(0, 8)}...` : ''),
  );

  logExecToFile({
    type: 'execution', status: result.status,
    pair: result.opportunity.pair.label,
    buyDex: result.opportunity.buyDex, sellDex: result.opportunity.sellDex,
    inputUsd: result.inputAmountUsd, outputUsd: result.outputAmountUsd,
    profitUsd: result.netProfitUsd, expectedBps: result.opportunity.profitBps,
    leg1Sig: result.leg1.signature, leg1Status: result.leg1.status, leg1Error: result.leg1.error,
    leg2Sig: result.leg2?.signature, leg2Status: result.leg2?.status, leg2Error: result.leg2?.error,
    durationMs: result.totalDurationMs,
  });

  const statusLabel = result.status === 'success' ? 'SUCCESS'
    : result.status === 'partial' ? 'PARTIAL (Stuck!)' : 'FAILED';

  const lines = [
    `*Trade ${statusLabel}*`,
    `Pair: \`${result.opportunity.pair.label}\``,
    `Route: \`${result.opportunity.buyDex}\` -> \`${result.opportunity.sellDex}\``,
    `Amount: $${result.inputAmountUsd.toFixed(2)} USDC`,
    `P&L: \`${result.netProfitUsd >= 0 ? '+' : ''}$${result.netProfitUsd.toFixed(4)}\``,
    `Duration: ${(result.totalDurationMs / 1000).toFixed(1)}s`,
  ];
  if (result.leg1.signature) lines.push(`Leg1: ${result.leg1.signature.slice(0, 12)}...`);
  if (result.leg2?.signature) lines.push(`Leg2: ${result.leg2.signature.slice(0, 12)}...`);
  if (result.status === 'partial') lines.push(`\nHolding ${state.stuckToken?.symbol ?? '?'} -- recovery attempted`);

  sendTelegramAlert(lines.join('\n')).catch(() => {});
}

// --- Initialize ---

export async function initializeExecutor(connection: Connection): Promise<boolean> {
  console.log('  Initializing execution engine...');

  const wallet = await (await import('./wallet')).validateWallet(connection);
  if (!wallet.valid) {
    for (const err of wallet.errors) logError(`Wallet: ${err}`);
    return false;
  }

  console.log(`  Wallet: ${wallet.publicKey.slice(0, 8)}...${wallet.publicKey.slice(-4)}`);
  console.log(`  SOL: ${(wallet.solBalance / LAMPORTS_PER_SOL).toFixed(4)} | USDC: ${(wallet.usdcBalance / 1e6).toFixed(2)}`);
  console.log(`  Mode: ${EXECUTION_CONFIG.dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`  Min: ${EXECUTION_CONFIG.minExecutionBps} bps | Size: ${(EXECUTION_CONFIG.tradePercentage * 100).toFixed(0)}% of balance | ${EXECUTION_CONFIG.maxTradesPerHour} trades/hr\n`);

  // Auto-bootstrap USDC if needed
  if (wallet.usdcBalance < 1_000_000 && !EXECUTION_CONFIG.dryRun) {
    console.log('  No USDC detected — bootstrapping from SOL...\n');
    const ok = await bootstrapUsdc(connection);
    if (!ok) {
      logError('USDC bootstrap failed — running in scan-only mode');
      return false;
    }
  }

  return true;
}
