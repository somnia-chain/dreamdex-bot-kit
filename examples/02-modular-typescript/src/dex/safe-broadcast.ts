/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { ethers } from "ethers";
import { logger } from "../utils/logger.js";
import {
  assertExpireNs,
  assertPriceRawNonZero,
  assertBuilderDisabled,
  assertOrderPlacedEvent,
  GotchaError,
} from "../utils/gotchas.js";
import type { PoolHandle } from "./contracts.js";

export interface PlaceOrderArgs {
  isBid: boolean;
  userData: bigint;
  priceRaw: bigint;
  quantityRaw: bigint;
  expireTimestampNs: bigint;
  orderType: number;
  selfMatchingOption: number;
  builder?: string;
  builderFeeBpsTimes1k?: bigint;
}

// Empirically verified on Somnia mainnet 2026-05-27 via tx receipt logs
// (e.g. tx 0x79d4b340ad448571a5b7ea461d33ebff81128c67e124700cff636bfd08157dcf).
// The exact field layout for the non-indexed `placedOrder` data is undocumented
// but the topic[0] and topic[1]=orderId positions are stable. See Obs-006.
const ORDER_PLACED_TOPIC =
  "0xd90f62f61ee2f606b132cfdfd883ddd079228b6fd6bffd9d7cf848daf824639d";

export function extractOrderIdFromReceipt(
  receipt: ethers.TransactionReceipt,
): bigint | undefined {
  for (const log of receipt.logs) {
    if (log.topics[0] === ORDER_PLACED_TOPIC && log.topics[1]) {
      return BigInt(log.topics[1]);
    }
  }
  return undefined;
}

export async function safePlaceOrder(
  handle: PoolHandle,
  args: PlaceOrderArgs,
): Promise<{ orderId: bigint; txHash: string }> {
  if (!handle.contract.runner || !("sendTransaction" in handle.contract.runner)) {
    throw new Error("safePlaceOrder requires a signer-bound contract (run with PRIVATE_KEY set)");
  }

  const builder = args.builder ?? ethers.ZeroAddress;
  const builderFee = args.builderFeeBpsTimes1k ?? 0n;

  assertExpireNs(args.expireTimestampNs);
  assertPriceRawNonZero(args.priceRaw);
  assertBuilderDisabled(builder, builderFee);

  const callArgs: [boolean, bigint, bigint, bigint, bigint, number, number, string, bigint] = [
    args.isBid,
    args.userData,
    args.priceRaw,
    args.quantityRaw,
    args.expireTimestampNs,
    args.orderType,
    args.selfMatchingOption,
    builder,
    builderFee,
  ];

  logger.debug({ pool: handle.pool.symbol, args: callArgs }, "Simulating placeOrder");

  let simSuccess: boolean;
  let simOrderId: bigint;
  try {
    const [s, id] = await handle.contract.placeOrder.staticCall(...callArgs);
    simSuccess = s;
    simOrderId = id;
  } catch (err) {
    throw new GotchaError(
      "SIM_REVERT",
      `placeOrder simulation reverted: ${(err as Error).message}`,
    );
  }

  if (!simSuccess) {
    throw new GotchaError(
      "SIM_FAIL",
      `placeOrder simulation returned success=false orderId=${simOrderId}`,
    );
  }

  logger.debug({ simOrderId: simOrderId.toString() }, "Simulation passed, broadcasting");

  const tx = await handle.contract.placeOrder(...callArgs);
  const receipt = await tx.wait();
  if (!receipt) {
    throw new GotchaError("NO_RECEIPT", `tx ${tx.hash} returned null receipt`);
  }

  assertOrderPlacedEvent(receipt, ORDER_PLACED_TOPIC);

  // CRITICAL: orderId from receipt, not from sim. OrderIds are
  // sequential — sim returns the orderId at sim time, but by the time
  // broadcast happens, other orders may have been placed, so the actual
  // assigned orderId can differ. Always trust the receipt's emitted event.
  const realOrderId = extractOrderIdFromReceipt(receipt) ?? simOrderId;

  if (realOrderId !== simOrderId) {
    logger.warn(
      { simOrderId: simOrderId.toString(), realOrderId: realOrderId.toString() },
      "OrderId drifted between sim and broadcast — using receipt value",
    );
  }

  logger.info(
    { txHash: receipt.hash, orderId: realOrderId.toString() },
    `placeOrder confirmed on ${handle.pool.symbol}`,
  );

  return { orderId: realOrderId, txHash: receipt.hash };
}

export async function safeCancelOrder(
  handle: PoolHandle,
  orderId: bigint,
): Promise<string> {
  try {
    await handle.contract.cancelOrder.staticCall(orderId);
  } catch (err) {
    throw new GotchaError(
      "CANCEL_SIM_REVERT",
      `cancelOrder(${orderId}) simulation reverted: ${(err as Error).message}`,
    );
  }
  const tx = await handle.contract.cancelOrder(orderId);
  const receipt = await tx.wait();
  if (!receipt) {
    throw new GotchaError("NO_RECEIPT", `cancel tx ${tx.hash} returned null receipt`);
  }
  logger.info({ txHash: receipt.hash, orderId: orderId.toString() }, "Order cancelled");
  return receipt.hash;
}

export { ORDER_PLACED_TOPIC };
