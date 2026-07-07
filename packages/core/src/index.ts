/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// @dreamdex-bot-kit/core — shared DreamDEX client.
//
// Typical usage from a strategy:
//   import { createChainContext, DreamDexRest, Pool, DreamDexWs, ORDER_TYPE } from "@dreamdex-bot-kit/core";
//   const ctx = createChainContext();
//   const pool = await Pool.load(ctx, "SOMI:USDso");
//   const { bestBid, bestAsk } = await pool.topOfBook();
//   await pool.place({ isBid: true, price: bestAsk! * 1.0005, qty: 1, orderType: ORDER_TYPE.ImmediateOrCancel });

export * from "./env.js";
export * from "./config/networks.js";
export * from "./config/tokens.js";
export * from "./client.js";
export * from "./rest.js";
export * from "./ws.js";
export * from "./contract.js";
export * from "./execute.js";
export * from "./operator.js";
export * from "./pool.js";
export * from "./nonce.js";
export * from "./gotchas.js";
export * from "./quant.js";
