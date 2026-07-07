/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { createPublicClient, http, formatEther, formatUnits } from 'viem';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.env') });

const RPC_URL = process.env.RPC_URL || 'https://dream-rpc.somnia.network';
const CHAIN_ID = parseInt(process.env.CHAIN_ID || '50312', 10);
const BOT_ADDRESS = process.env.BOT_ADDRESS;
const OLD_ADDRESS = process.env.DREAMDEX_WALLET_ADDRESS;

const USDso_ADDRESS = '0x9c32F3827A1a99f0cf9B213de8b53eC3d57bb171';
const WETH_ADDRESS = '0x4d8E02BBfCf205828A8352Af4376b165E123D7b0';

const ERC20_ABI = [
  { inputs: [{ name: 'account', type: 'address' }], name: 'balanceOf', outputs: [{ type: 'uint256' }], stateMutability: 'view', type: 'function' },
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

async function checkBalance(label, address) {
  const native = await publicClient.getBalance({ address });
  const usdsoBal = await publicClient.readContract({ address: USDso_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] });
  const wethBal = await publicClient.readContract({ address: WETH_ADDRESS, abi: ERC20_ABI, functionName: 'balanceOf', args: [address] });
  const usdsoDecimals = await publicClient.readContract({ address: USDso_ADDRESS, abi: ERC20_ABI, functionName: 'decimals' });

  console.log(`\n=== ${label} (${address}) ===`);
  console.log('  Native (SOMI):', formatEther(native));
  console.log('  USDso:', formatUnits(usdsoBal, usdsoDecimals));
  console.log('  WETH:', formatUnits(wethBal, 18));
}

async function checkTx(hash, label) {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash });
    console.log(`\nTx ${label} (${hash}):`);
    console.log('  Status:', receipt.status);
    console.log('  Block:', receipt.blockNumber.toString());
  } catch {
    console.log(`\nTx ${label} (${hash}): not found or pending`);
  }
}

async function main() {
  console.log('=== Checking Wallet Balances ===');

  await checkBalance('Old Wallet', OLD_ADDRESS);
  await checkBalance('New Bot Wallet', BOT_ADDRESS);

  // Check previous transfer transactions
  console.log('\n=== Checking Previous Transfers ===');
  await checkTx('0x9cc065cc2145a2c8a2a9831074af71cadfd63a63f181de6317260170dcba0be5', 'Native Transfer (10 SOMI)');
  await checkTx('0x1c41287d0224d482acf5f006c3b010a82306cc4975e8509f0f4cc68bfcfb2a49', 'USDso Transfer (50 USDso)');
}

main().catch(console.error);
