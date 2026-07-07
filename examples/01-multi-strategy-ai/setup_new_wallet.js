/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, http, parseUnits, formatUnits, formatEther } from 'viem';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '.env') });

const CONFIG = {
  PRIVATE_KEY: process.env.DREAMDEX_PRIVATE_KEY || '',
  RPC_URL: process.env.RPC_URL || 'https://dream-rpc.somnia.network',
  CHAIN_ID: parseInt(process.env.CHAIN_ID || '50312', 10),
  POOL_ADDRESS: '0xD180195da5459C7a0DEA188ed61216ec43682b50', // known from logs
};

const ERC20_ABI = [
  { inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ name: 'recipient', type: 'address' }, { name: 'amount', type: 'uint256' }], name: 'transfer', outputs: [{ type: 'bool' }], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [], name: 'decimals', outputs: [{ type: 'uint8' }], stateMutability: 'view', type: 'function' },
];

const SPOT_POOL_ABI = [
  { inputs: [], name: 'getPoolParams', outputs: [{ name: 'baseToken_', type: 'address' }, { name: 'quoteToken_', type: 'address' }], stateMutability: 'view', type: 'function' },
];

const somniaTestnet = {
  id: CONFIG.CHAIN_ID,
  name: 'Somnia Testnet',
  network: 'somnia-testnet',
  nativeCurrency: { decimals: 18, name: 'Somnia Token', symbol: 'STT' },
  rpcUrls: { default: { http: [CONFIG.RPC_URL] }, public: { http: [CONFIG.RPC_URL] } },
};

async function main() {
  console.log('=== Setting up new wallet ===\n');

  // 1. Use existing BOT_PK if available, otherwise generate
  const envPath = path.resolve(__dirname, '.env');
  let envContent = fs.readFileSync(envPath, 'utf8');
  let newPk, newAccount;
  
  if (envContent.includes('BOT_PK=') && envContent.match(/BOT_PK=0x[a-fA-F0-9]{64}/)) {
    newPk = envContent.match(/BOT_PK=(0x[a-fA-F0-9]{64})/)[1];
    newAccount = privateKeyToAccount(newPk);
    console.log('Using existing bot wallet from .env:');
  } else {
    newPk = generatePrivateKey();
    newAccount = privateKeyToAccount(newPk);
    console.log('New wallet generated:');
    if (envContent.includes('BOT_PK=')) {
      envContent = envContent.replace(/BOT_PK=.*/g, `BOT_PK=${newPk}`);
      envContent = envContent.replace(/BOT_ADDRESS=.*/g, `BOT_ADDRESS=${newAccount.address}`);
    } else {
      envContent += `\n# Bot Wallet\nBOT_PK=${newPk}\nBOT_ADDRESS=${newAccount.address}\n`;
    }
    fs.writeFileSync(envPath, envContent);
    console.log('Saved BOT_PK and BOT_ADDRESS to .env');
  }
  console.log('  Address:', newAccount.address);
  console.log('  PK:', newPk);
  console.log('');

  // 3. Setup clients
  const publicClient = createPublicClient({ chain: somniaTestnet, transport: http() });
  const oldAccount = privateKeyToAccount(CONFIG.PRIVATE_KEY);
  const walletClient = createWalletClient({ account: oldAccount, chain: somniaTestnet, transport: http() });

  console.log('Old wallet:', oldAccount.address);
  console.log('New wallet:', newAccount.address);
  console.log('');

  // 4. Get token addresses from DreamDex API
  const apiUrl = process.env.API_URL || 'https://stg.api.dreamdex.io';
  const marketsRes = await fetch(`${apiUrl}/v0/markets`);
  const marketsData = await marketsRes.json();
  const market = (marketsData.markets || []).find(m => m.symbol === 'WETH:USDso');
  if (!market) throw new Error('WETH:USDso market not found from API');
  const quoteToken = market.quote;
  const baseToken = market.base;
  console.log('Quote token (USDso):', quoteToken);
  console.log('Base token (WETH):', baseToken);
  console.log('');

  // 5. Check balances of old wallet
  const oldNative = await publicClient.getBalance({ address: oldAccount.address });
  const oldUsdso = await publicClient.readContract({ address: quoteToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [oldAccount.address] });
  const decimals = await publicClient.readContract({ address: quoteToken, abi: ERC20_ABI, functionName: 'decimals' });

  console.log('Old wallet balances:');
  console.log('  Native (SOMI):', formatEther(oldNative));
  console.log('  USDso:', formatUnits(oldUsdso, decimals));
  console.log('');

  // 6. Transfer 10 SOMI (native)
  console.log('Transferring 10 SOMI to new wallet...');
  const nativeHash = await walletClient.sendTransaction({
    to: newAccount.address,
    value: parseUnits('10', 18),
    gas: 21000n,
  });
  console.log('  Native tx:', nativeHash);
  await publicClient.waitForTransactionReceipt({ hash: nativeHash, timeout: 60000 });
  console.log('  ✓ 10 SOMI sent\n');

  // 7. Transfer 50 USDso (ERC20)
  console.log('Transferring 50 USDso to new wallet...');
  const usdsoAmount = parseUnits('50', decimals);
  const tokenHash = await walletClient.writeContract({
    address: quoteToken,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [newAccount.address, usdsoAmount],
    gas: 100000n,
  });
  console.log('  Token tx:', tokenHash);
  await publicClient.waitForTransactionReceipt({ hash: tokenHash, timeout: 60000 });
  console.log('  ✓ 50 USDso sent\n');

  // 8. Verify new wallet balances
  const newNative = await publicClient.getBalance({ address: newAccount.address });
  const newUsdso = await publicClient.readContract({ address: quoteToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [newAccount.address] });
  console.log('New wallet balances:');
  console.log('  Native (SOMI):', formatEther(newNative));
  console.log('  USDso:', formatUnits(newUsdso, decimals));
  console.log('\nDone!');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
