/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// EIP-7702 atomic round-trip: buy AND sell in a single transaction.
//
// EIP-7702 lets an EOA adopt contract code. The delegation is NOT scoped to one
// transaction: it stays on the account until it is replaced or cleared, and
// while it is there the account answers calls from anyone. So we delegate the
// wallet to the DreamDexVolumeBatch7702 implementation, call atomicRoundTrip on
// our own address — inside one type-4 transaction the wallet IOC-buys, then
// IOC-sells exactly what it bought (measured by balance delta) — and then clear
// the delegation again, whether or not the round-trip succeeded.
//
// This script compiles the contract (solc), deploys it once if needed, then runs
// the delegated round-trip. ERC-20 pair only (use a pegged pair).

import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { encodeFunctionData } from "viem";
import { createChainContext, Pool, buildExpireNs, toRaw, alignToTick, alignToLot } from "@dreamdex-bot-kit/core";
import { clearDelegation } from "./clear-delegation.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const IMPL_ABI = [
  {
    type: "function",
    name: "atomicRoundTrip",
    stateMutability: "nonpayable",
    inputs: [
      { name: "pool", type: "address" },
      { name: "quoteToken", type: "address" },
      { name: "baseToken", type: "address" },
      { name: "buyPrice", type: "uint256" },
      { name: "sellPrice", type: "uint256" },
      { name: "quantity", type: "uint256" },
      { name: "expireTimestampNs", type: "uint64" },
    ],
    outputs: [],
  },
] as const;

function num(key: string, fallback: number): number {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : Number(v);
}

function compile(): { abi: unknown[]; bytecode: `0x${string}`; runtime: `0x${string}` } {
  const solc = require("solc");
  const file = "DreamDexVolumeBatch7702.sol";
  const source = readFileSync(path.resolve(__dirname, "../contracts", file), "utf8");
  const input = {
    language: "Solidity",
    sources: { [file]: { content: source } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
    },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === "error");
  if (errors.length) throw new Error("solc errors:\n" + errors.map((e: { formattedMessage: string }) => e.formattedMessage).join("\n"));
  const c = out.contracts[file]["DreamDexVolumeBatch7702"];
  return {
    abi: c.abi,
    bytecode: ("0x" + c.evm.bytecode.object) as `0x${string}`,
    runtime: ("0x" + c.evm.deployedBytecode.object) as `0x${string}`,
  };
}

/**
 * Drops the trailing CBOR metadata, whose last two bytes hold its own length.
 * Two compiles of the same source differ there (paths, compiler build), so the
 * comparison below only looks at the code itself.
 */
function withoutMetadata(code: string): string {
  const hex = code.startsWith("0x") ? code.slice(2) : code;
  if (hex.length < 4) return hex;
  const tail = (parseInt(hex.slice(-4), 16) + 2) * 2;
  return tail < hex.length ? hex.slice(0, hex.length - tail) : hex;
}

async function main(): Promise<void> {
  const ctx = createChainContext();
  const symbol = process.env.BATCH_SYMBOL ?? "USDC.e:USDso";
  const sizeUsdso = num("BATCH_SIZE_USDSO", 12);
  const crossBps = num("BATCH_CROSS_BPS", 5);
  const gasLimit = BigInt(num("BATCH_GAS_LIMIT", 6_000_000));

  const { abi, bytecode, runtime } = compile();
  console.log(`[7702] contract compiled OK (bytecode ${bytecode.length} chars)`);

  // Deploy the implementation once (or reuse IMPL_ADDRESS).
  let impl = process.env.IMPL_ADDRESS as `0x${string}` | undefined;
  if (impl) {
    // A pinned address can hold an older build of the contract, and the wallet
    // would then be delegated to that. Only reuse it when the code there is the
    // code we just compiled.
    const onChain = (await ctx.publicClient.getCode({ address: impl })) ?? "0x";
    if (withoutMetadata(onChain) !== withoutMetadata(runtime)) {
      console.log(`[7702] IMPL_ADDRESS ${impl} does not hold this build, deploying a fresh one`);
      impl = undefined;
    }
  }
  if (!impl) {
    console.log("[7702] deploying implementation…");
    const hash = await ctx.walletClient.deployContract({ abi, bytecode, account: ctx.account, chain: ctx.walletClient.chain });
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
    impl = receipt.contractAddress!;
    console.log(`[7702] deployed at ${impl} (tx ${hash})`);
  }

  const pool = await Pool.load(ctx, symbol);
  if (pool.baseIsNative) throw new Error("This example targets an ERC-20 pair (e.g. USDC.e:USDso).");
  const { bestBid, bestAsk } = await pool.topOfBook();
  if (bestBid === undefined || bestAsk === undefined) throw new Error("empty book");

  const buyPriceRaw = alignToTick(toRaw(bestAsk * (1 + crossBps / 10_000), pool.quoteDecimals), pool.params.tickSize, "ask");
  const sellPriceRaw = alignToTick(toRaw(bestBid * (1 - crossBps / 10_000), pool.quoteDecimals), pool.params.tickSize, "bid");
  const qtyRaw = alignToLot(toRaw(sizeUsdso / bestAsk, pool.baseDecimals), pool.params.lotSize);

  const data = encodeFunctionData({
    abi: IMPL_ABI,
    functionName: "atomicRoundTrip",
    args: [pool.address, pool.params.quoteToken, pool.params.baseToken, buyPriceRaw, sellPriceRaw, qtyRaw, buildExpireNs(60 * 60_000)],
  });

  console.log(`[7702] delegating ${ctx.account.address} -> ${impl} and running atomicRoundTrip on ${symbol}`);
  // `executor: "self"` is REQUIRED when the authorizing account also sends the tx:
  // the tx consumes the account's current nonce, so the authorization must be
  // signed at nonce+1. Without it the delegation is invalid and the call is a
  // silent no-op (tx succeeds but the contract code never runs).
  const authorization = await ctx.walletClient.signAuthorization({ account: ctx.account, contractAddress: impl, executor: "self" });
  try {
    const hash = await ctx.walletClient.sendTransaction({
      account: ctx.account,
      chain: ctx.walletClient.chain,
      to: ctx.account.address,
      data,
      authorizationList: [authorization],
      gas: gasLimit,
    });
    console.log(`[7702] tx ${hash} — waiting for receipt…`);
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
    console.log(`[7702] status=${receipt.status} gasUsed=${receipt.gasUsed} logs=${receipt.logs.length}`);
  } finally {
    // The authorization is applied before the call runs, so the delegation is on
    // the account even when the round-trip reverts. Always take it back off.
    await clearDelegation(ctx);
  }
  if (!process.env.IMPL_ADDRESS) console.log(`[7702] tip: set IMPL_ADDRESS=${impl} to reuse this deployment.`);
}

main().catch((err) => {
  console.error("[7702] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
