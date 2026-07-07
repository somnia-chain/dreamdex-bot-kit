/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { createPublicClient, createWalletClient, http, parseUnits, formatEther, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.env') });

const RPC_URL = process.env.RPC_URL || 'https://dream-rpc.somnia.network';
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '50312', 10);
const OLD_PK = process.env.DREAMDEX_PRIVATE_KEY;
const BOT_ADDRESS = process.env.BOT_ADDRESS;

const USDso_ADDRESS = '0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171';
const WETH_ADDRESS = '0x4d8E02BBfCf205828A8352Af4376b165E123D7b0';
const GAS_LIMIT = 8000000n;

const ERC20_ABI = [
  { inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
  { inputs: [{ name: 'recipient', type: 'address' }, { name: 'amount', type: 'uint256' }], name: 'transfer', outputs: [{ type: 'bool' }], stateMutability: 'nonpayable', type: 'function' },
  { inputs: [], name: 'decimals', outputs: [{ type: 'uint8' }], stateMutability: 'view', type: 'function' },
];

const somniaTestnet = {
  id: CHAIN_ID,
  name: 'Somnia Testnet',
  network: 'somnia-testnet',
  nativeCurrency: { decimals: 18, name: 'Somnia Token', symbol: 'STT' },
  rpcUrls: { default: { http: [RPC_URL] }, public: { http: [RPC_URL] } },
};

const publicClient = createPublicClient({ chain: somniaTestnet, transport: http() });
const oldAccount = privateKeyToAccount(OLD_PK);
const walletClient = createWalletClient({ account: oldAccount, chain: somniaTestnet, transport: http() });

async function checkBalance(label, address) {
  const native = await publicClient.getBalance({ address });
  const usdsoBal = await publicClient.readContract({ address: USDso_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] });
  const usdsoDecimals = await publicClient.readContract({ address: USDso_ADDRESS, abi: ERC20_ABI, functionName: 'decimals' });
  console.log(`${label} (${address}):`);
  console.log('  SOMI:', formatEther(native));
  console.log('  USDso:', formatUnits(usdsoBal, usdsoDecimals));
}

async function main() {
  console.log('=== Transferring to Bot Wallet ===\n');
  console.log('Old wallet:', oldAccount.address);
  console.log('Bot wallet:', BOT_ADDRESS);
  console.log('Gas limit:', Number(GAS_LIMIT).toLocaleString());
  console.log('');

  // Check balances before
  await checkBalance('Old', oldAccount.address);
  await checkBalance('Bot', BOT_ADDRESS);
  console.log('');

  // 1. Transfer 10 SOMI (native)
  console.log('Sending 10 SOMI...');
  const nativeHash = await walletClient.sendTransaction({
    to: BOT_ADDRESS,
    value: parseUnits('10', 18),
    gas: GAS_LIMIT,
  });
  console.log('  Tx:', nativeHash);
  const receipt1 = await publicClient.waitForTransactionReceipt({ hash: nativeHash, timeout: 120000 });
  console.log('  Status:', receipt1.status, '| Block:', receipt1.blockNumber.toString());

  // 2. Transfer 50 USDso
  console.log('\nSending 50 USDso...');
  const usdsoDecimals = await publicClient.readContract({ address: USDso_ADDRESS, abi: ERC20_ABI, functionName: 'decimals' });
  const usdsoAmount = parseUnits('50', usdsoDecimals);
  const tokenHash = await walletClient.writeContract({
    address: USDso_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [BOT_ADDRESS, usdsoAmount],
    gas: GAS_LIMIT,
  });
  console.log('  Tx:', tokenHash);
  const receipt2 = await publicClient.waitForTransactionReceipt({ hash: tokenHash, timeout: 120000 });
  console.log('  Status:', receipt2.status, '| Block:', receipt2.blockNumber.toString());

  // Check balances after
  console.log('\n=== After Transfer ===');
  await checkBalance('Old', oldAccount.address);
  await checkBalance('Bot', BOT_ADDRESS);
  console.log('\nDone!');
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
