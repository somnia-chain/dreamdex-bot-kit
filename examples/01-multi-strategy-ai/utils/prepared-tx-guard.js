/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Check a transaction the dreamDEX HTTP API prepared before the bot signs it.
//
// The API answers with `to`, `data` and `value` for the client to sign. Signing
// them unchecked means signing whatever arrives, including a token transfer or a
// plain coin transfer out of the bot's wallet. So a prepared transaction is only
// signed when it calls one of the order or vault functions this bot expects on an
// official pool, carries no native coin unless it is a native-coin order or
// deposit, names no builder fee on an order, is for the chain the bot is on, and
// simulates without reverting.

/** Function selectors of the calls the API prepares for spot trading. */
export const SELECTORS = {
  placeOrder: '0x4e978373',
  cancelOrder: '0xdbc91396',
  reduceOrders: '0x58b91c42',
  deposit: '0x47e7ef24',
  withdraw: '0xf3fef3a3',
  depositNative: '0xdb6b5246',
};

// Only a sell on a pool whose base is the native coin, and a native vault
// deposit, send coin with the call. Everything else must carry value 0.
const PAYABLE = new Set([SELECTORS.placeOrder, SELECTORS.depositNative]);

/** The protocol's SpotPoolRegistry per chain: the list of official spot pools. */
export const POOL_REGISTRY = {
  5031: '0xB601bc1099B040E4882089D94690F7C38AF4CCD2',
  50312: '0x07A29A0A086Bc8262a9320db93E603eE13D57962',
};
const IS_REGISTERED = '0xc3c5a547'; // isRegistered(address)
// Pools the registry has confirmed in this process, so each one costs a single lookup.
const confirmedPools = new Set();

// placeOrder(bool,uint64,uint256,uint256,uint64,uint8,uint8,address builder,uint96 builderFeeBpsTimes1k):
// nine static words, the builder in the 8th and its fee in the 9th.
const ORDER_CALLDATA_LENGTH = 10 + 9 * 64;

export class PreparedTxRejected extends Error {}

/**
 * Validate a prepared transaction against the calls this bot expects.
 *
 * @param {{to?: string, data?: string, value?: string|number|bigint, chainId?: string|number}} tx
 * @param {{allow: string[], chainId: number, isKnownPool: (address: string) => Promise<boolean>}} opts
 * @returns {Promise<{to: `0x${string}`, data: `0x${string}`, value: bigint}>}
 */
export async function checkPreparedTx(tx, { allow, chainId, isKnownPool }) {
  const to = String(tx?.to ?? '');
  const data = String(tx?.data ?? '');
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
    throw new PreparedTxRejected(`prepared transaction has no valid target: "${to}"`);
  }
  if (!/^0x([0-9a-fA-F]{2}){4,}$/.test(data)) {
    throw new PreparedTxRejected('prepared transaction does not call a function');
  }
  const selector = data.slice(0, 10).toLowerCase();
  if (!allow.includes(selector)) {
    throw new PreparedTxRejected(`prepared transaction calls ${selector}, expected one of ${allow.join(', ')}`);
  }
  if (tx.chainId !== undefined && tx.chainId !== null && Number(tx.chainId) !== chainId) {
    throw new PreparedTxRejected(`prepared transaction is for chain ${tx.chainId}, the bot is on chain ${chainId}`);
  }
  const value = BigInt(tx.value ?? 0);
  if (value < 0n) {
    throw new PreparedTxRejected('prepared transaction has a negative value');
  }
  if (value > 0n && !PAYABLE.has(selector)) {
    throw new PreparedTxRejected(`prepared transaction sends ${value} wei with ${selector}, which takes no coin`);
  }
  if (selector === SELECTORS.placeOrder) {
    // These examples trade without a builder code, so an order must not route a fee to one.
    if (data.length < ORDER_CALLDATA_LENGTH) {
      throw new PreparedTxRejected('prepared order is too short to be a placeOrder call');
    }
    const builder = '0x' + data.slice(482, 522);
    const builderFee = BigInt('0x' + data.slice(522, 586));
    if (BigInt(builder) !== 0n || builderFee !== 0n) {
      throw new PreparedTxRejected(`prepared order names builder ${builder} with fee ${builderFee}, expected none`);
    }
  }
  if (!(await isKnownPool(to))) {
    throw new PreparedTxRejected(`prepared transaction calls ${to}, which is not an official pool`);
  }
  return { to, data, value };
}

/**
 * An `isKnownPool` that asks the chain's SpotPoolRegistry. On a chain with no
 * known registry every address is unknown, so nothing is signed there.
 *
 * @param {{call: (args: {to: string, data: string}) => Promise<{data?: string}>}} publicClient viem public client
 * @param {number} chainId
 */
export function registryPoolCheck(publicClient, chainId) {
  const registry = POOL_REGISTRY[chainId];
  return async (address) => {
    if (!registry) return false;
    const key = `${chainId}:${address.toLowerCase()}`;
    if (confirmedPools.has(key)) return true;
    const call = IS_REGISTERED + address.slice(2).toLowerCase().padStart(64, '0');
    const { data } = await publicClient.call({ to: registry, data: call });
    const known = BigInt(data && data !== '0x' ? data : '0x0') === 1n;
    if (known) confirmedPools.add(key);
    return known;
  };
}

/**
 * The pool address the API reported, once the chain's registry confirms it is an
 * official pool. Approvals are granted to this address, so an address the API
 * made up would otherwise collect them.
 *
 * @param {any} publicClient viem public client
 * @param {string} address
 */
export async function requireOfficialPool(publicClient, address) {
  const chainId = await publicClient.getChainId();
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address)) || !(await registryPoolCheck(publicClient, chainId)(address))) {
    throw new PreparedTxRejected(`${address} is not an official pool on chain ${chainId}`);
  }
  return address;
}

/**
 * Check, simulate and only then sign and send a prepared transaction.
 * Throws `PreparedTxRejected` for a transaction it refuses, and the simulation's
 * own error for one that would revert; nothing is signed in either case.
 *
 * @param {{walletClient: any, publicClient: any, tx: any, allow: string[], gas?: bigint}} args viem clients
 */
export async function sendPreparedTx({ walletClient, publicClient, tx, allow, gas }) {
  const chainId = await publicClient.getChainId();
  const checked = await checkPreparedTx(tx, {
    allow,
    chainId,
    isKnownPool: registryPoolCheck(publicClient, chainId),
  });
  await publicClient.call({ account: walletClient.account, ...checked, ...(gas ? { gas } : {}) });
  return walletClient.sendTransaction({ ...checked, ...(gas ? { gas } : {}) });
}
