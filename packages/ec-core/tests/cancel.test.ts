/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Cancel paths: a filled or pulled order is gone, anything else may still be
// resting. The revert names are the ones the pools return on both networks
// (issues #33 and #40); the errors are the SDK's own ContractRevertError.
import { describe, expect, it, vi } from "vitest";
import { ContractRevertError } from "@somnia-chain/markets-sdk";
import { cancelTracked, cancelVenueOrders, isOrderGone, placeLimit, tryCancel } from "../src/orders.js";
import type { EcContext } from "../src/exchange.js";

const revert = (errorName: string) => new ContractRevertError({ errorName, functionName: "cancelOrder" });
const FILLED = () => revert("IncorrectSender");
const SLOT_REUSED = () => revert("IncorrectOrder");
const CLOSE_LOCK = () => revert("CloseNotCaptured");
const LOW_GAS = () => revert("InsufficientGasForPayout");

describe("isOrderGone", () => {
  it("treats IncorrectSender and IncorrectOrder as already off the book", () => {
    expect(isOrderGone(FILLED())).toBe(true);
    expect(isOrderGone(SLOT_REUSED())).toBe(true);
  });

  it("treats the close lock, a gas shortfall and plain errors as possibly resting", () => {
    expect(isOrderGone(CLOSE_LOCK())).toBe(false);
    expect(isOrderGone(LOW_GAS())).toBe(false);
    expect(isOrderGone(new Error("fetch failed"))).toBe(false);
    expect(isOrderGone(null)).toBe(false);
  });
});

function unifiedCtx(cancel: (id: string) => Promise<unknown>, openIds: string[] = []): EcContext {
  return {
    config: {},
    exchange: {
      cancelOrder: vi.fn(cancel),
      fetchOpenOrders: async () => openIds.map((id) => ({ id })),
      loadMarkets: async () => ({
        m: { symbol: "BTC/tUSDC", type: "binary", active: true, info: { marketType: "BINARY" } },
      }),
    },
  } as unknown as EcContext;
}

describe("tryCancel", () => {
  it("reports cancelled, gone and failed", async () => {
    expect(await tryCancel(unifiedCtx(async () => ({})), "1", "S")).toBe("cancelled");
    expect(await tryCancel(unifiedCtx(async () => Promise.reject(FILLED())), "1", "S")).toBe("gone");
    expect(await tryCancel(unifiedCtx(async () => Promise.reject(CLOSE_LOCK())), "1", "S")).toBe("failed");
  });
});

describe("cancelVenueOrders", () => {
  it("keeps going after a failed cancel and counts only real cancels", async () => {
    const outcomes: Record<string, () => Promise<unknown>> = {
      a: async () => ({}),
      b: async () => Promise.reject(FILLED()),
      c: async () => Promise.reject(CLOSE_LOCK()),
      d: async () => ({}),
    };
    const ctx = unifiedCtx((id) => outcomes[id]!(), ["a", "b", "c", "d"]);
    expect(await cancelVenueOrders(ctx)).toBe(2);
    expect(ctx.exchange.cancelOrder).toHaveBeenCalledTimes(4);
  });
});

describe("cancelTracked", () => {
  it("drops cancelled and gone orders, keeps and reports one that may still rest", async () => {
    let nextId = 1n;
    const cancels: Record<string, () => Promise<unknown>> = {
      "1": async () => ({}),
      "2": async () => Promise.reject(FILLED()),
      "3": async () => Promise.reject(CLOSE_LOCK()),
    };
    const ctx = {
      config: { decimals: 6, lot: 1000n, tick: 1000n, network: "testnet" },
      exchange: {
        walletAddress: "0x0000000000000000000000000000000000000001",
        client: {
          getViemClient: () => ({ getBalance: async () => 1n }),
          getErc20Balance: async () => 10n ** 12n,
          getVaultBalance: async () => 0n,
        },
        trader: {
          placeOrder: async () => ({ orderId: nextId++, fills: [], hash: "0x", receipt: { status: "success" } }),
          cancelOrder: async ({ orderId }: { orderId: bigint | string }) => cancels[String(orderId)]!(),
        },
      },
    } as unknown as EcContext;
    const onchain = {
      pool: "0x0000000000000000000000000000000000000002",
      outcomeToken: "0x0000000000000000000000000000000000000003",
      collateral: "0x0000000000000000000000000000000000000004",
      yesId: 1n,
      noId: 2n,
      expiry: BigInt(Math.floor(Date.now() / 1000) + 3600),
    };
    for (let i = 0; i < 3; i++) {
      const placed = await placeLimit(ctx, {
        market: { symbol: "BTC/tUSDC#YES" } as never,
        onchain: onchain as never,
        outcome: "YES",
        side: "buy",
        price: 0.4,
        size: 1,
      });
      expect(placed.rested).toBe(true);
    }

    expect(await cancelTracked(ctx)).toEqual({ cancelled: 1, tracked: 3, failed: 1 });

    // The close lock lifted: the order that stayed tracked cancels on the next pass.
    cancels["3"] = async () => ({});
    expect(await cancelTracked(ctx)).toEqual({ cancelled: 1, tracked: 1, failed: 0 });
    expect(await cancelTracked(ctx)).toEqual({ cancelled: 0, tracked: 0, failed: 0 });
  });
});
