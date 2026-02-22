import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bs58 = require('bs58');
import { TOKENS } from './config';

let _keypair: Keypair | null = null;

export function loadKeypair(): Keypair {
  if (_keypair) return _keypair;
  const key = process.env.SOLANA_PRIVATE_KEY;
  if (!key) throw new Error('SOLANA_PRIVATE_KEY not set in .env');
  _keypair = Keypair.fromSecretKey(bs58.decode(key));
  return _keypair;
}

export function getPublicKey(): PublicKey {
  return loadKeypair().publicKey;
}

export async function getSolBalance(connection: Connection): Promise<number> {
  return connection.getBalance(getPublicKey());
}

export async function getTokenBalance(
  connection: Connection,
  mintAddress: string,
): Promise<{ amount: number; exists: boolean }> {
  try {
    const mint = new PublicKey(mintAddress);
    const ata = await getAssociatedTokenAddress(mint, getPublicKey());
    const account = await getAccount(connection, ata);
    return { amount: Number(account.amount), exists: true };
  } catch {
    return { amount: 0, exists: false };
  }
}

export async function getUsdcBalance(connection: Connection): Promise<number> {
  const result = await getTokenBalance(connection, TOKENS.USDC.mint);
  return result.amount;
}

export async function validateWallet(connection: Connection): Promise<{
  valid: boolean;
  solBalance: number;
  usdcBalance: number;
  publicKey: string;
  errors: string[];
}> {
  const errors: string[] = [];
  try {
    const keypair = loadKeypair();
    const [solBalance, usdcBalance] = await Promise.all([
      getSolBalance(connection),
      getUsdcBalance(connection),
    ]);
    if (solBalance < 5_000_000) {
      errors.push(`SOL balance too low: ${(solBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    }
    return {
      valid: errors.length === 0,
      solBalance,
      usdcBalance,
      publicKey: keypair.publicKey.toBase58(),
      errors,
    };
  } catch (err) {
    return { valid: false, solBalance: 0, usdcBalance: 0, publicKey: '', errors: [`${err}`] };
  }
}
