// scripts/deploy.ts — Compile & deploy ArbBot.sol to Base Mainnet
import { ethers } from 'ethers';
import * as fs from 'fs';
import * as path from 'path';

// Load .env
require('dotenv').config();

const PRIVATE_KEY = process.env.PRIVATE_KEY || '';
const RPC_URL = process.env.BASE_HTTP_URL || '';

if (!PRIVATE_KEY || PRIVATE_KEY === 'your_private_key_here') {
    console.error('❌ Set PRIVATE_KEY in your .env file first');
    process.exit(1);
}
if (!RPC_URL || RPC_URL.includes('YOUR_KEY')) {
    console.error('❌ Set BASE_HTTP_URL in your .env file first');
    process.exit(1);
}

async function main() {
    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log('  ║   ArbBot.sol — Deploy to Base        ║');
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');

    // ── 1. Compile ArbBot.sol using solc ──────────────────────────
    console.log('⏳ Compiling ArbBot.sol...');

    const solcModule = require('solc');
    const contractPath = path.resolve(__dirname, '..', 'contracts', 'ArbBot.sol');
    const source = fs.readFileSync(contractPath, 'utf8');

    const input = {
        language: 'Solidity',
        sources: { 'ArbBot.sol': { content: source } },
        settings: {
            optimizer: { enabled: true, runs: 200 },
            viaIR: true,
            outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
        },
    };

    function findImports(importPath: string) {
        if (importPath.startsWith('@openzeppelin/')) {
            const absolutePath = path.resolve(__dirname, '..', 'node_modules', importPath);
            return { contents: fs.readFileSync(absolutePath, 'utf8') };
        }
        return { error: 'File not found' };
    }

    const output = JSON.parse(solcModule.compile(JSON.stringify(input), { import: findImports }));

    // Check for errors
    if (output.errors) {
        const fatal = output.errors.filter((e: any) => e.severity === 'error');
        if (fatal.length > 0) {
            console.error('❌ Compilation failed:');
            fatal.forEach((e: any) => console.error(e.formattedMessage));
            process.exit(1);
        }
        // Print warnings but continue
        output.errors
            .filter((e: any) => e.severity === 'warning')
            .forEach((e: any) => console.warn('⚠️', e.message));
    }

    const compiled = output.contracts['ArbBot.sol']['ArbBot'];
    const abi = compiled.abi;
    const bytecode = '0x' + compiled.evm.bytecode.object;

    if (!bytecode || bytecode === '0x') {
        console.error('❌ Compilation produced empty bytecode. Check ArbBot.sol for errors.');
        process.exit(1);
    }

    console.log('✅ Compiled successfully');

    // ── 2. Deploy to Base ─────────────────────────────────────────
    const provider = new ethers.JsonRpcProvider(RPC_URL, 8453, { staticNetwork: true });
    const signer = new ethers.Wallet(PRIVATE_KEY, provider);

    const balance = await provider.getBalance(signer.address);
    const ethBalance = Number(ethers.formatEther(balance));

    console.log(`📍 Deployer: ${signer.address}`);
    console.log(`💰 ETH Balance: ${ethBalance.toFixed(4)} ETH`);

    if (ethBalance < 0.001) {
        console.error('❌ Not enough ETH for deployment gas. Need at least 0.001 ETH on Base.');
        process.exit(1);
    }

    console.log('⏳ Deploying ArbBot to Base Mainnet...');

    const factory = new ethers.ContractFactory(abi, bytecode, signer);
    const contract = await factory.deploy();
    await contract.waitForDeployment();

    const contractAddress = await contract.getAddress();

    console.log('');
    console.log('  ╔══════════════════════════════════════╗');
    console.log(`  ║ ✅ Deployed: ${contractAddress}  ║`);
    console.log('  ╚══════════════════════════════════════╝');
    console.log('');

    // ── 3. Auto-update .env ───────────────────────────────────────
    const envPath = path.resolve(__dirname, '..', '.env');
    let envContent = fs.readFileSync(envPath, 'utf8');

    if (envContent.includes('CONTRACT_ADDRESS=')) {
        envContent = envContent.replace(
            /CONTRACT_ADDRESS=.*/,
            `CONTRACT_ADDRESS=${contractAddress}`
        );
    } else {
        envContent += `\nCONTRACT_ADDRESS=${contractAddress}\n`;
    }

    fs.writeFileSync(envPath, envContent);
    console.log('✅ CONTRACT_ADDRESS updated in .env');
    console.log('');
    console.log('🚀 Run the bot with: npm start');
    console.log('');
}

main().catch((err) => {
    console.error('❌ Deploy failed:', err.message);
    process.exit(1);
});
