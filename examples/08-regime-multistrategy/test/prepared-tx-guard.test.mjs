// npm run test:guard, or node --test 'test/*.test.mjs'  (Node 24 loads the .ts import directly; no dependencies needed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SELECTORS,
  PreparedTxRejected,
  checkPreparedTx,
  registryPoolCheck,
  requireOfficialPool,
} from '../src/prepared-tx-guard.ts';

const POOL = '0xa936da11B57b50A344e1293AAaE5232885ea2bDE';
const OTHER = '0x1111111111111111111111111111111111111111';
const pad = (hex) => hex.replace(/^0x/, '').padStart(64, '0');
const orderWith = (builder, fee) => SELECTORS.placeOrder + pad('0x1').repeat(7) + pad(builder) + pad(fee);
const order = orderWith('0x0', '0x0');
const cancel = SELECTORS.cancelOrder + pad('0x2a');
const opts = { allow: [SELECTORS.placeOrder, SELECTORS.cancelOrder], chainId: 5031, isKnownPool: async (a) => a === POOL };

test('accepts an expected order call', async () => {
  assert.deepEqual(await checkPreparedTx({ to: POOL, data: order, value: '0', chainId: 5031 }, opts), { to: POOL, data: order, value: 0n });
});

test('refuses a token transfer, an approval and a plain coin transfer', async () => {
  await assert.rejects(checkPreparedTx({ to: POOL, data: '0xa9059cbb' + pad(OTHER) + pad('0x1') }, opts), PreparedTxRejected);
  await assert.rejects(checkPreparedTx({ to: POOL, data: '0x095ea7b3' + pad(OTHER) + pad('0x1') }, opts), PreparedTxRejected);
  await assert.rejects(checkPreparedTx({ to: OTHER, data: '0x', value: '1' }, opts), PreparedTxRejected);
});

test('lets a native-coin order through only on an official pool', async () => {
  assert.equal((await checkPreparedTx({ to: POOL, data: order, value: '5' }, opts)).value, 5n);
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

test('registryPoolCheck and requireOfficialPool ask the registry once per pool', async () => {
  const calls = [];
  const yes = async (tx) => (calls.push(tx), '0x' + pad('0x1'));
  const no = async () => '0x' + pad('0x0');
  assert.equal(await registryPoolCheck(yes, 50312)(POOL), true);
  assert.equal(await registryPoolCheck(yes, 50312)(POOL), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, '0x07A29A0A086Bc8262a9320db93E603eE13D57962');
  assert.equal(await registryPoolCheck(yes, 999)(POOL), false);
  assert.equal(await requireOfficialPool(yes, 5031, POOL), POOL);
  await assert.rejects(requireOfficialPool(no, 5031, OTHER), PreparedTxRejected);
});
