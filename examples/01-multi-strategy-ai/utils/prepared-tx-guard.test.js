// npm test, or node --test utils/*.test.js (no dependencies needed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SELECTORS, PreparedTxRejected, checkPreparedTx, registryPoolCheck, requireOfficialPool, sendPreparedTx } from './prepared-tx-guard.js';

const POOL = '0xa936da11B57b50A344e1293AAaE5232885ea2bDE';
const OTHER = '0x1111111111111111111111111111111111111111';
const pad = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
const orderWith = (builder, fee) => SELECTORS.placeOrder + pad('0x1').repeat(7) + pad(builder) + pad(fee);
const order = orderWith('0x0', '0x0');
// A fake viem client: the registry knows POOL, everything else returns empty data.
const registryKnowsPool = (args) => args.data.startsWith('0xc3c5a547') && args.data.endsWith(POOL.slice(2).toLowerCase());
const cancel = SELECTORS.cancelOrder + pad('0x2a');
const opts = { allow: [SELECTORS.placeOrder, SELECTORS.cancelOrder], chainId: 5031, isKnownPool: async (a) => a === POOL };

test('accepts an expected order call with no value', async () => {
  const out = await checkPreparedTx({ to: POOL, data: order, value: '0', chainId: 5031 }, opts);
  assert.deepEqual(out, { to: POOL, data: order, value: 0n });
});

test('refuses a token transfer dressed as an order', async () => {
  const transfer = '0xa9059cbb' + pad(OTHER) + pad('0xffff');
  await assert.rejects(checkPreparedTx({ to: POOL, data: transfer }, opts), PreparedTxRejected);
});

test('refuses an approval', async () => {
  const approve = '0x095ea7b3' + pad(OTHER) + pad('0xffff');
  await assert.rejects(checkPreparedTx({ to: POOL, data: approve }, opts), PreparedTxRejected);
});

test('refuses a plain coin transfer', async () => {
  await assert.rejects(checkPreparedTx({ to: OTHER, data: '0x', value: '1000' }, opts), PreparedTxRejected);
});

test('refuses coin sent with a call that takes none', async () => {
  await assert.rejects(checkPreparedTx({ to: POOL, data: cancel, value: '1' }, opts), PreparedTxRejected);
});

test('lets a native-coin order through only on an official pool', async () => {
  const ok = await checkPreparedTx({ to: POOL, data: order, value: '5' }, opts);
  assert.equal(ok.value, 5n);
  await assert.rejects(checkPreparedTx({ to: OTHER, data: order, value: '5' }, opts), PreparedTxRejected);
});

test('refuses an expected call aimed at a contract that is not an official pool', async () => {
  await assert.rejects(checkPreparedTx({ to: OTHER, data: order }, opts), PreparedTxRejected);
  await assert.rejects(checkPreparedTx({ to: OTHER, data: cancel }, opts), PreparedTxRejected);
});

test('refuses an order that names a builder or a builder fee', async () => {
  await assert.rejects(checkPreparedTx({ to: POOL, data: orderWith(OTHER, '0x0') }, opts), PreparedTxRejected);
  await assert.rejects(checkPreparedTx({ to: POOL, data: orderWith('0x0', '0x64') }, opts), PreparedTxRejected);
  await assert.rejects(checkPreparedTx({ to: POOL, data: order.slice(0, 200) }, opts), PreparedTxRejected);
});

test('refuses a transaction for another chain', async () => {
  await assert.rejects(checkPreparedTx({ to: POOL, data: order, chainId: 1 }, opts), PreparedTxRejected);
});

test('refuses a malformed target or calldata', async () => {
  await assert.rejects(checkPreparedTx({ to: 'pool', data: order }, opts), PreparedTxRejected);
  await assert.rejects(checkPreparedTx({ to: POOL, data: '0x4e97' }, opts), PreparedTxRejected);
});

test('registryPoolCheck asks the registry once per pool and knows no pool on an unknown chain', async () => {
  const fresh = '0x2222222222222222222222222222222222222222';
  const calls = [];
  const client = { call: async (args) => (calls.push(args), { data: '0x' + pad('0x1') }) };
  assert.equal(await registryPoolCheck(client, 5031)(fresh), true);
  assert.equal(await registryPoolCheck(client, 5031)(fresh), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, '0xB601bc1099B040E4882089D94690F7C38AF4CCD2');
  assert.equal(calls[0].data, '0xc3c5a547' + pad(fresh));
  assert.equal(await registryPoolCheck(client, 999)(fresh), false);
});

test('sendPreparedTx signs nothing when the simulation reverts or the check fails', async () => {
  let sent = 0;
  const walletClient = { account: { address: OTHER }, sendTransaction: async () => (sent++, '0xhash') };
  const reverting = { getChainId: async () => 5031, call: async (a) => { if (registryKnowsPool(a)) return { data: '0x' + pad('0x1') }; throw new Error('execution reverted'); } };
  await assert.rejects(sendPreparedTx({ walletClient, publicClient: reverting, tx: { to: POOL, data: order }, allow: [SELECTORS.placeOrder] }));
  const fine = { getChainId: async () => 5031, call: async (a) => ({ data: registryKnowsPool(a) ? '0x' + pad('0x1') : '0x' }) };
  await assert.rejects(sendPreparedTx({ walletClient, publicClient: fine, tx: { to: POOL, data: cancel }, allow: [SELECTORS.placeOrder] }), PreparedTxRejected);
  assert.equal(sent, 0);
  assert.equal(await sendPreparedTx({ walletClient, publicClient: fine, tx: { to: POOL, data: order }, allow: [SELECTORS.placeOrder] }), '0xhash');
  assert.equal(sent, 1);
});

test('requireOfficialPool passes a registered pool and stops on anything else', async () => {
  const registered = { getChainId: async () => 5031, call: async () => ({ data: '0x' + pad('0x1') }) };
  const unregistered = { getChainId: async () => 5031, call: async () => ({ data: '0x' + pad('0x0') }) };
  assert.equal(await requireOfficialPool(registered, POOL), POOL);
  await assert.rejects(requireOfficialPool(unregistered, OTHER), PreparedTxRejected);
  await assert.rejects(requireOfficialPool(registered, 'not-an-address'), PreparedTxRejected);
});
