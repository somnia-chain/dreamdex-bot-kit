/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defineChain } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadConfig } from "../src/config.js";
import { createTradingKey, linkProblem, type TradingKey } from "../src/operator.js";
import { sizeOrder } from "../src/orders.js";
import type { PerpMarket } from "../src/markets.js";

const ENV_KEYS = ["NETWORK", "OWNER_ADDRESS", "PRIVATE_KEY", "CHAIN_ID", "RPC_URL", "WS_RPC_URL", "INDEXER_URL"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const chain = defineChain({
  id: 50383,
  name: "hideki",
  nativeCurrency: { name: "STT", symbol: "STT", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:1"] } },
});

describe("network", () => {
  it("defaults to the Hideki testnet, where Perps Arena runs", () => {
    const cfg = loadConfig();
    expect(cfg.network).toBe("hideki");
    expect(cfg.chainId).toBe(50383);
    expect(cfg.rpcUrl).toBe("https://api.hideki2.infra.testnet.somnia.network");
    expect(cfg.indexerUrl).toBe("https://hideki-dev.smk.somnia.host/v1/graphql");
    expect(cfg.operatorRegistry).toBe("0x6B2FbfeD328FF5F20C0BE7D3C3437613aFFE8D3a");
  });

  it("still reaches Shannon with NETWORK=testnet", () => {
    process.env.NETWORK = "testnet";
    const cfg = loadConfig();
    expect(cfg.chainId).toBe(50312);
    expect(cfg.operatorRegistry).toBe("0x15C7e8CE38F021c5b45d098AaD788f63090bF20A");
  });

  it("refuses mainnet and anything that is not a perp network", () => {
    process.env.NETWORK = "mainnet";
    expect(() => loadConfig()).toThrow(/no perp markets on Somnia mainnet/);
    process.env.NETWORK = "tokyo";
    expect(() => loadConfig()).toThrow(/not a perp network/);
  });
});

describe("OWNER_ADDRESS", () => {
  it("is off when blank, so the key trades its own account", () => {
    expect(loadConfig().owner).toBeUndefined();
  });

  it("is checksummed when set", () => {
    const owner = privateKeyToAccount(generatePrivateKey()).address;
    process.env.OWNER_ADDRESS = owner.toLowerCase();
    expect(loadConfig().owner).toBe(owner);
  });

  it("rejects something that is not an address, rather than trading the wrong account", () => {
    process.env.OWNER_ADDRESS = "0x1234";
    expect(() => loadConfig()).toThrow(/not an address/);
  });
});

describe("createTradingKey", () => {
  it("refuses an OWNER_ADDRESS that is the key's own address", () => {
    const pk = generatePrivateKey();
    const self = privateKeyToAccount(pk).address;
    expect(() => createTradingKey({ owner: self, privateKey: pk, chain, rpcUrl: "http://127.0.0.1:1" })).toThrow(
      /this key's own address/,
    );
  });

  it("keeps the owner and the operator apart", () => {
    const pk = generatePrivateKey();
    const owner = privateKeyToAccount(generatePrivateKey()).address;
    const key = createTradingKey({ owner, privateKey: pk, chain, rpcUrl: "http://127.0.0.1:1" });
    expect(key.owner).toBe(owner);
    expect(key.operator).toBe(privateKeyToAccount(pk).address);
  });
});

describe("linkProblem", () => {
  const key = { owner: "0x00000000000000000000000000000000000000aa", operator: "0x00000000000000000000000000000000000000bb" } as TradingKey;

  it("is silent when the key can place and cancel", () => {
    expect(linkProblem(key, { place: true, cancel: true, reduce: true }, "BTC-PERP")).toBeUndefined();
  });

  it("names what is missing and how to link the key in the app", () => {
    const msg = linkProblem(key, { place: false, cancel: false, reduce: false }, "BTC-PERP");
    expect(msg).toContain("cannot place/cancel/reduce orders");
    expect(msg).toContain("Link a bot");
    expect(msg).toContain(key.operator);
  });
});

describe("sizeOrder", () => {
  const market = {
    info: { poolAddress: "0x01", marginBank: "0x02", lotSize: "1", minQuantity: "1" },
  } as unknown as PerpMarket;

  function exchangeCapturing(seen: { autoPull?: boolean }) {
    return {
      client: {
        getMaxPerpOrderSize: async (args: { autoPull: boolean }) => {
          seen.autoPull = args.autoPull;
          return { priceable: true, placeable: true, maxQuantity: 10n, limitedBy: "margin" };
        },
      },
    } as never;
  }

  it("keeps auto-pull for the owner's own orders", async () => {
    const seen: { autoPull?: boolean } = {};
    await sizeOrder(exchangeCapturing(seen), { market, account: "0x03", side: "long", price: 1n, wanted: 5n, autoPull: true });
    expect(seen.autoPull).toBe(true);
  });

  it("turns auto-pull off for a trading key, which can never pull from the account's wallet", async () => {
    const seen: { autoPull?: boolean } = {};
    await sizeOrder(exchangeCapturing(seen), {
      market,
      account: "0x03",
      side: "long",
      price: 1n,
      wanted: 5n,
      autoPull: true,
      tradingKey: {} as TradingKey,
    });
    expect(seen.autoPull).toBe(false);
  });
});
