/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Pure-unit coverage for the conversions and guards. Nothing here touches the
// chain: every case below is one that cost real money or a real debugging hour
// on testnet first.

import { describe, expect, it } from "vitest";
import {
  alignPrice,
  alignQuantity,
  displayName,
  markAgeSec,
  sizeForNotional,
  toRaw,
  type PerpInfo,
} from "../src/markets.js";
import { healthRatio, type MarginSnapshot } from "../src/margin.js";
import { fundingApr, fundingSide } from "../src/funding.js";
import { isRealStopFailure } from "../src/stops.js";

/** BTC-PERP as the live testnet market reports it. */
const btc = {
  baseDecimals: 8,
  quoteDecimals: 18,
  tickSize: "100000000000000000", // 0.1
  lotSize: "1000", // 0.00001
  minQuantity: "13000", // 0.00013
  markPrice: "75000000000000000000000", // 75,000
  indexPrice: "75000000000000000000000",
  fundingRate: "0",
  fundingWindowSec: 28800,
  fundingIntervalSec: 3600,
  baseSymbol: "BTC",
} as unknown as PerpInfo;

/** NEAR-PERP, the 24-decimal market that breaks a hardcoded 18. */
const near = { ...btc, baseDecimals: 24, lotSize: "100000000000000000000000", minQuantity: "5100000000000000000000000" } as PerpInfo;

describe("unit conversion", () => {
  it("builds raw values that sit exactly on the grid", () => {
    // parseUnits(price.toFixed(18), 18) yields …004 here and the pool rejects it.
    expect(toRaw(0.0888, 18)).toBe(88800000000000000n);
    expect(toRaw(75000, 18)).toBe(75000000000000000000000n);
  });

  it("uses the market's own base decimals, not 18", () => {
    expect(toRaw(1, 8)).toBe(100000000n);
    expect(toRaw(1, 24)).toBe(1000000000000000000000000n);
  });

  it("keeps the sign", () => {
    expect(toRaw(-2.5, 8)).toBe(-250000000n);
  });
});

describe("grids", () => {
  it("aligns a price down to the tick", () => {
    expect(alignPrice(75000123456789012345678n, btc)).toBe(75000100000000000000000n);
  });

  it("returns zero for a size below the market minimum", () => {
    // 0.00005 is above the lot grid but below minQuantity, so it is no order.
    expect(alignQuantity(5000n, btc)).toBe(0n);
    expect(alignQuantity(13000n, btc)).toBe(13000n);
  });

  it("aligns down rather than rounding up", () => {
    expect(alignQuantity(19999n, btc)).toBe(19000n);
  });
});

describe("sizing", () => {
  it("treats the notional as position value", () => {
    // 75 USDso at a mark of 75,000 is 0.001 BTC.
    expect(sizeForNotional(75, btc)).toBe(100000n);
  });

  it("prefers a live mark over the row's", () => {
    expect(sizeForNotional(75, btc, 37500)).toBe(200000n);
  });

  it("returns zero when the notional cannot reach one minimum", () => {
    expect(sizeForNotional(1, btc)).toBe(0n);
  });

  it("works on a 24-decimal market", () => {
    expect(sizeForNotional(750000, near)).toBe(10000000000000000000000000n);
  });
});

describe("health", () => {
  const snapshot = (equity: bigint, mmReq: bigint) =>
    ({ equity, mmReq, unlocked: 0n, locked: 0n, withdrawable: 0n, imReq: 0n, cmReq: 0n, status: "Healthy", activePools: [] }) as MarginSnapshot;

  it("is infinite when nothing is open", () => {
    expect(healthRatio(snapshot(100n, 0n))).toBe(Number.POSITIVE_INFINITY);
  });

  it("is 1 at the maintenance line", () => {
    expect(healthRatio(snapshot(50n, 50n))).toBe(1);
  });
});

describe("funding", () => {
  it("pays shorts when the rate is positive", () => {
    const view = fundingApr({ ...btc, fundingRate: "1000000000000000" } as PerpInfo);
    expect(view.paidSide).toBe("short");
    expect(view.positive).toBe(true);
  });

  it("pays longs when the rate is negative", () => {
    expect(fundingApr({ ...btc, fundingRate: "-1000000000000000" } as PerpInfo).paidSide).toBe("long");
  });

  it("compares the threshold against the absolute rate", () => {
    // A large negative rate pays longs exactly as a large positive one pays shorts.
    const negative = { ...btc, fundingRate: "-100000000000000000" } as PerpInfo;
    expect(fundingSide(negative, 0.5)).toBe("long");
    expect(fundingSide({ ...btc, fundingRate: "0" } as PerpInfo, 0.5)).toBeUndefined();
  });
});

describe("staleness and drop reasons", () => {
  it("reports an unwritten mark as infinitely old", () => {
    expect(markAgeSec(btc)).toBe(Number.POSITIVE_INFINITY);
  });

  it("separates a routine reduce-only drop from a real rejection", () => {
    expect(isRealStopFailure("ReduceOnlyNoPosition")).toBe(false);
    expect(isRealStopFailure("ReduceOnlyWrongSide")).toBe(false);
    expect(isRealStopFailure("PlacementFailed")).toBe(true);
    expect(isRealStopFailure("NoFill")).toBe(true);
    expect(isRealStopFailure(null)).toBe(false);
  });
});

describe("symbols", () => {
  it("renders the app-canonical name", () => {
    expect(displayName("BTC/USDso:USDso")).toBe("BTC-PERP");
  });
});
