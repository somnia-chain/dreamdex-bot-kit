/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Market-wide order + fill history for a time window, straight from the
// markets indexer (the same Envio/Hasura backend that
// @somnia-chain/markets-sdk reads from). Read-only — no wallet, no signer.
//
// Why this exists: the pool contract only keeps LIVE orders (getOrder reverts
// on terminal ids — slots are reused), and the REST API (GET /v0/orders) only
// exposes the caller's own orders. The indexer's Order/Fill tables keep every
// order ever placed, with full lifecycle (status, cancelReason, fill progress,
// amend links) — so this is the only market-wide source of past orders.
//
//   npx tsx scripts/order-history.ts                     # all spot markets, yesterday UTC
//   SYMBOL=USDC.e:USDso npx tsx scripts/order-history.ts
//   FROM=2026-10-02T12:00:00Z UNTIL=2026-10-02T13:00:00Z npx tsx scripts/order-history.ts
//   OUT=/tmp/orders.json npx tsx scripts/order-history.ts
//   CHAIN=1 npx tsx scripts/order-history.ts             # cross-check via eth_getLogs instead
//
// Env: NETWORK (mainnet|testnet, default mainnet), SYMBOL, FROM, UNTIL, OUT, CHAIN.
// FROM/UNTIL accept ISO timestamps or epoch seconds; default window is yesterday UTC.
//
// Verified against mainnet (2026-10-03): USDC.e:USDso full day 2026-10-02 →
// 45,569 orders via the indexer vs 45,560 via the CHAIN=1 log scan (the delta
// is boundary-block placement timing + amended orders, which the indexer keeps
// as separate rows). All 65 fills matched 1:1 between the two sources, and a
// 1-hour window matched exactly (1,900 = 1,900).

import { config as dotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
dotenv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

const NETWORK = (process.env.NETWORK ?? "mainnet") as "mainnet" | "testnet";
const INDEXER_URL =
  NETWORK === "testnet"
    ? "https://dev.smk.somnia.host/v1/graphql"
    : "https://prd.smk.somnia.host/v1/graphql";
const API_URL =
  NETWORK === "testnet" ? "https://stg.api.dreamdex.io/v0" : "https://api.dreamdex.io/v0";
const RPC_URL =
  NETWORK === "testnet"
    ? "https://api.infra.testnet.somnia.network"
    : "https://api.infra.mainnet.somnia.network";

// --- event topics (from the dreamDEX docs, Events page) -------------------
const TOPICS = {
  OrderPlaced: "0xd90f62f61ee2f606b132cfdfd883ddd079228b6fd6bffd9d7cf848daf824639d",
  OrderFilled: "0xc87f4223e9e7c4e4f39f9b34fc9d64d78cdb95d9035b3748cbde59521261a399",
  OrderCancelled: "0x06ff08ed6b6987bb7df963009d8b54dc03988f4e465c009924929bb010fe03e7",
  OrderExpired: "0x6003d149bc2c6baa0780d4302ad5f925fef5715780d3b6f7d2da5476548da101",
  OrderReduced: "0xf6871493c13434b4a7fa02b5540fb6188e8db3f63e6b7013db073e9535b5a860",
  OrderAmended: "0x55bc401cf5a2a5a9291c8ec209b7a004016d780b1bdf933cb240e6e8556bba1b",
  OrderCancelledSelfMatch: "0x06338cfffed6cc456515196256e4c180e4639f134af550d7fca7a4995aa6b4e7",
} as const;
const ALL_TOPICS = Object.values(TOPICS);

// --- window ----------------------------------------------------------------
function parseTime(v: string | undefined, fallback: bigint): bigint {
  if (!v) return fallback;
  if (/^\d+$/.test(v)) return BigInt(v); // epoch seconds
  const t = BigInt(Math.floor(Date.parse(v) / 1000));
  if (Number.isNaN(Number(t))) throw new Error(`bad time: ${v}`);
  return t;
}

const now = Math.floor(Date.now() / 1000);
const todayStart = BigInt(Math.floor(now / 86400) * 86400);
const FROM = parseTime(process.env.FROM, todayStart - 86400n);
const UNTIL = parseTime(process.env.UNTIL, todayStart);
const SYMBOL = process.env.SYMBOL ?? null;
const OUT = process.env.OUT ?? null;
const CHAIN_MODE = process.env.CHAIN === "1" || process.env.CHAIN === "true";

// --- indexer (GraphQL) -------------------------------------------------------
async function gql(query: string, variables?: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(INDEXER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`indexer HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { data?: unknown; errors?: { message: string }[] };
  if (j.errors?.length) throw new Error(`indexer: ${j.errors[0].message}`);
  return j.data;
}

const ORDER_FIELDS = `orderId owner isBid price fullQuantity filledQuantity quantityRemaining
  cancelReason status userData expireTimestampNs placedAtTimestamp placedAtBlock placedTxHash
  amendedFromOrderId amendedToOrderId`;

async function fetchMarkets(): Promise<{ symbol: string; pool: string; marketId: string }[]> {
  const res = await fetch(`${API_URL}/markets`);
  if (!res.ok) throw new Error(`markets HTTP ${res.status}`);
  const { markets } = (await res.json()) as { markets: { symbol: string; contract: string; kind: string }[] };
  let pools = markets.filter((m) => m.kind === "spot");
  if (SYMBOL) pools = pools.filter((m) => m.symbol === SYMBOL);
  if (pools.length === 0) throw new Error(`no spot markets found${SYMBOL ? ` for ${SYMBOL}` : ""}`);
  // The indexer keys spot orders on market_id (= the pool address); the Market
  // table maps poolAddress → id. Perp orders key on `pool` instead.
  const out: { symbol: string; pool: string; marketId: string }[] = [];
  for (const m of pools) {
    const pool = m.contract.toLowerCase();
    const data = await gql(
      `query($addr: String!) { Market(limit: 1, where: { poolAddress: { _eq: $addr } }) { id } }`,
      { addr: pool },
    ) as { Market: { id: string }[] };
    if (data.Market.length === 0) throw new Error(`pool ${pool} not found in indexer`);
    out.push({ symbol: m.symbol, pool, marketId: data.Market[0].id });
  }
  return out;
}

async function fetchAll<T>(
  table: "Order" | "Fill",
  fields: string,
  where: Record<string, unknown>,
  orderBy: Record<string, string>,
): Promise<T[]> {
  const rows: T[] = [];
  const LIMIT = 1000;
  for (let offset = 0; ; offset += LIMIT) {
    const data = await gql(
      `query($w: ${table}_bool_exp!, $o: [${table}_order_by!], $off: Int!) {
        ${table}(limit: ${LIMIT}, offset: $off, order_by: $o, where: $w) { ${fields} }
      }`,
      { w: where, o: [orderBy], off: offset },
    ) as { [k: string]: T[] };
    const page = data[table];
    rows.push(...page);
    if (page.length < LIMIT) break;
  }
  return rows;
}

async function viaIndexer(): Promise<{ orders: unknown[]; fills: unknown[]; pools: { symbol: string; pool: string }[] }> {
  const pools = await fetchMarkets();
  const orders: unknown[] = [];
  const fills: unknown[] = [];
  for (const { symbol, pool, marketId } of pools) {
    const where = {
      placedAtTimestamp: { _gte: FROM.toString(), _lt: UNTIL.toString() },
      market_id: { _eq: marketId },
    };
    const o = await fetchAll("Order", ORDER_FIELDS, where, { placedAtTimestamp: "asc" });
    const f = await fetchAll(
      "Fill",
      `takerOrderId makerOrderId quantity fillPrice takerIsBid taker maker makerRemainingQuantity
        takerRemainingQuantity timestamp blockNumber txHash`,
      { timestamp: { _gte: FROM.toString(), _lt: UNTIL.toString() }, market_id: { _eq: marketId } },
      { timestamp: "asc" },
    );
    for (const row of o) (row as Record<string, unknown>).symbol = symbol;
    for (const row of f) (row as Record<string, unknown>).symbol = symbol;
    console.error(`  ${symbol}: ${o.length} orders, ${f.length} fills`);
    orders.push(...o);
    fills.push(...f);
  }
  return { orders, fills, pools: pools.map((p) => ({ symbol: p.symbol, pool: p.pool })) };
}

// --- chain fallback (eth_getLogs) --------------------------------------------
let rpcId = 0;
async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message}`);
  return j.result;
}

const hex = (n: bigint) => "0x" + n.toString(16);
const word = (data: string, i: number) => "0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64);

async function blockAtTime(ts: bigint): Promise<bigint> {
  const latest = BigInt((await rpc("eth_blockNumber")) as string);
  let lo = 1n, hi = latest;
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    const b = (await rpc("eth_getBlockByNumber", [hex(mid), false])) as { timestamp: string };
    if (BigInt(b.timestamp) <= ts) lo = mid;
    else hi = mid - 1n;
  }
  return lo;
}

type Log = { topics: string[]; data: string; blockNumber: string; transactionHash: string };
type LogMeta = { block: string; tx: string };
type ChainFill = {
  takerOrderId: string; makerOrderId: string; quantity: string; fillPrice: string;
  takerIsBid: boolean | null; taker: string | null; maker: string | null;
  takerRemainingQuantity: string; makerRemainingQuantity: string;
  blockNumber: string; txHash: string; symbol: string; timestamp?: string;
};
type ChainOrder = {
  orderId: string; isBid: boolean; owner: string; userData: string; price: string;
  fullQuantity: string; quantityRemaining: string; expireTimestampNs: string;
  pool: string; symbol: string; placedBlock: string; placedTx: string;
  fills: { quantityFilled: string; fillPrice: string; block: string; tx: string; remaining: string; counterpartyOrderId: string }[];
  reductions: { newQuantity: string; block: string; tx: string }[];
  cancelled?: LogMeta; expired?: LogMeta; selfMatchCancelled?: LogMeta; amendedTo?: string;
  status?: string;
};

function handlePlaced(log: Log, orders: Map<string, ChainOrder>, pool: string, symbol: string): void {
  const id = BigInt(log.topics[1] ?? "0x0").toString();
  orders.set(`${pool}:${id}`, {
    orderId: id,
    isBid: word(log.data, 1) !== "0x" + "0".repeat(63) + "0",
    owner: "0x" + word(log.data, 2).slice(-40),
    userData: BigInt(word(log.data, 3)).toString(),
    price: BigInt(word(log.data, 4)).toString(),
    fullQuantity: BigInt(word(log.data, 5)).toString(),
    quantityRemaining: BigInt(word(log.data, 6)).toString(),
    expireTimestampNs: BigInt(word(log.data, 7)).toString(),
    pool,
    symbol,
    placedBlock: log.blockNumber,
    placedTx: log.transactionHash,
    fills: [],
    reductions: [],
  });
}

function handleLog(log: Log, orders: Map<string, ChainOrder>, pool: string, symbol: string, fills: ChainFill[]): void {
  const topic = log.topics[0];
  const id = BigInt(log.topics[1] ?? "0x0").toString();
  const meta = { block: log.blockNumber, tx: log.transactionHash };
  if (topic === TOPICS.OrderFilled) {
    const takerId = BigInt(log.topics[1]).toString();
    const makerId = BigInt(log.topics[2]).toString();
    const base = {
      quantityFilled: BigInt(word(log.data, 0)).toString(),
      fillPrice: BigInt(word(log.data, 3)).toString(),
      ...meta,
    };
    const t = orders.get(`${pool}:${takerId}`);
    if (t) t.fills.push({ ...base, remaining: BigInt(word(log.data, 1)).toString(), counterpartyOrderId: makerId });
    const m = orders.get(`${pool}:${makerId}`);
    if (m) m.fills.push({ ...base, remaining: BigInt(word(log.data, 2)).toString(), counterpartyOrderId: takerId });
    fills.push({
      takerOrderId: takerId,
      makerOrderId: makerId,
      quantity: base.quantityFilled,
      fillPrice: base.fillPrice,
      takerIsBid: t ? t.isBid : null,
      taker: t ? t.owner : null,
      maker: m ? m.owner : null,
      takerRemainingQuantity: BigInt(word(log.data, 1)).toString(),
      makerRemainingQuantity: BigInt(word(log.data, 2)).toString(),
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      symbol,
    });
  } else if (topic === TOPICS.OrderCancelled) {
    const o = orders.get(`${pool}:${id}`);
    if (o) o.cancelled = meta;
  } else if (topic === TOPICS.OrderExpired) {
    const o = orders.get(`${pool}:${id}`);
    if (o) o.expired = meta;
  } else if (topic === TOPICS.OrderCancelledSelfMatch) {
    const o = orders.get(`${pool}:${id}`);
    if (o) o.selfMatchCancelled = meta;
  } else if (topic === TOPICS.OrderReduced) {
    const o = orders.get(`${pool}:${id}`);
    if (o) o.reductions.push({ newQuantity: BigInt(word(log.data, 0)).toString(), ...meta });
  } else if (topic === TOPICS.OrderAmended) {
    const o = orders.get(`${pool}:${id}`);
    if (o) o.amendedTo = BigInt(log.topics[2]).toString();
  }
}

async function fetchChunk(pool: string, from: bigint, to: bigint, chunk: number): Promise<Log[]> {
  try {
    return (await rpc("eth_getLogs", [
      { address: pool, topics: [ALL_TOPICS], fromBlock: hex(from), toBlock: hex(to) },
    ])) as Log[];
  } catch (e) {
    if (from === to || chunk <= 10) throw e;
    console.error(`  chunk ${from}..${to} failed (${(e as Error).message}) — halving`);
    const mid = (from + to) / 2n;
    const a = await fetchChunk(pool, from, mid, Math.floor(chunk / 2));
    const b = await fetchChunk(pool, mid + 1n, to, Math.floor(chunk / 2));
    return [...a, ...b];
  }
}

async function scanRange(
  pool: string, from: bigint, to: bigint, orders: Map<string, ChainOrder>,
  symbol: string, chunk: number, fills: ChainFill[],
): Promise<number> {
  const ranges: [bigint, bigint][] = [];
  for (let cur = from; cur <= to; cur += BigInt(chunk)) {
    const end = cur + BigInt(chunk - 1) < to ? cur + BigInt(chunk - 1) : to;
    ranges.push([cur, end]);
  }
  // fetch chunks with bounded concurrency (the I/O bottleneck), decode afterwards
  const fetched: Log[][] = new Array(ranges.length);
  let idx = 0;
  const CONCURRENCY = 6;
  async function worker(): Promise<void> {
    while (idx < ranges.length) {
      const i = idx++;
      const [a, b] = ranges[i];
      fetched[i] = await fetchChunk(pool, a, b, chunk);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ranges.length) }, worker));
  const logs = fetched.flat();
  // two global passes: a taker's OrderPlaced can land after its OrderFilled in
  // the same tx, and a maker's can sit in an earlier chunk — so register every
  // order first, then resolve fills and lifecycle events against them
  for (const log of logs) if (log.topics[0] === TOPICS.OrderPlaced) handlePlaced(log, orders, pool, symbol);
  for (const log of logs) if (log.topics[0] !== TOPICS.OrderPlaced) handleLog(log, orders, pool, symbol, fills);
  return logs.length;
}

async function viaChain(): Promise<{ orders: ChainOrder[]; fills: ChainFill[]; pools: { symbol: string; pool: string }[] }> {
  const pools = await fetchMarkets();
  const fromBlock = await blockAtTime(FROM);
  const toBlock = await blockAtTime(UNTIL);
  console.error(`  blocks ${fromBlock}..${toBlock}`);
  const orders = new Map<string, ChainOrder>();
  const fills: ChainFill[] = [];
  for (const { symbol, pool } of pools) {
    const scanned = await scanRange(pool, fromBlock, toBlock, orders, symbol, 1000, fills);
    console.error(`  ${symbol}: ${scanned} events`);
  }
  // fills carry no timestamp in the event — resolve from block, batched
  const tsCache = new Map<string, string>();
  const blockTs = async (block: string): Promise<string> => {
    if (!tsCache.has(block)) {
      const b = (await rpc("eth_getBlockByNumber", [block, false])) as { timestamp: string };
      tsCache.set(block, b.timestamp);
    }
    return tsCache.get(block)!;
  };
  for (let i = 0; i < fills.length; i += 10) {
    const batch = fills.slice(i, i + 10);
    const ts = await Promise.all(batch.map((f) => blockTs(f.blockNumber)));
    for (let k = 0; k < batch.length; k++) batch[k].timestamp = ts[k];
  }
  const list = [...orders.values()].map((o) => {
    if (o.cancelled) o.status = "cancelled";
    else if (o.expired) o.status = "expired";
    else if (o.selfMatchCancelled) o.status = "cancelled_self_match";
    else if (o.amendedTo) o.status = "amended";
    else if (o.fills.length > 0) {
      const last = o.fills[o.fills.length - 1];
      o.status = last.remaining === "0" ? "filled" : "partially_filled";
    } else o.status = o.reductions.length ? "reduced" : "open_or_terminal_outside_window";
    delete o.cancelled; delete o.expired; delete o.selfMatchCancelled;
    return o;
  });
  return { orders: list, fills, pools: pools.map((p) => ({ symbol: p.symbol, pool: p.pool })) };
}

// --- main --------------------------------------------------------------------
async function main(): Promise<void> {
  console.error(
    `window: ${new Date(Number(FROM) * 1000).toISOString()} .. ${new Date(Number(UNTIL) * 1000).toISOString()}` +
      `  network: ${NETWORK}  source: ${CHAIN_MODE ? "chain (eth_getLogs)" : "indexer (GraphQL)"}`,
  );
  const { orders, fills, pools } = CHAIN_MODE ? await viaChain() : await viaIndexer();
  const byStatus: Record<string, number> = {};
  for (const o of orders as { status?: string }[]) {
    const s = o.status ?? "unknown";
    byStatus[s] = (byStatus[s] ?? 0) + 1;
  }
  const out = {
    window: { from: FROM.toString(), until: UNTIL.toString() },
    network: NETWORK,
    source: CHAIN_MODE ? "chain" : "indexer",
    pools,
    count: orders.length,
    fillCount: fills.length,
    byStatus,
    orders,
    fills,
  };
  const json = JSON.stringify(out, null, 2);
  if (OUT) {
    writeFileSync(OUT, json);
    console.error(`wrote ${OUT} (${orders.length} orders, ${fills.length} fills)`);
  } else {
    console.log(json);
  }
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
