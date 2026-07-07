/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
loadEnv({ path: fileURLToPath(new URL("../.env", import.meta.url)) }); // .env from the bot's folder, not cwd
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { ExchangeClient, DreamDexClient, MockClient, Fill, OrderBook, Balances } from "./exchange.js";
import { Strategy, StratCtx, DesiredOrder, CapitalGrowthMaker, VolumeBooster, PickOff, GridMaker } from "./strategy.js";
import { RiskManager } from "./risk.js";
import { RegimeManager } from "./regime.js";
import { Stats, PairRow } from "./stats.js";

type Config = {
  pairs: string[];
  makerPairs?: string[];
  liquidatePairs?: string[];
  gasReserveSOMI?: number;
  capitalUSDso: number;
  perPairClipUSDso: number;
  requoteMs: number;
  maxInventoryUSDso: number;
  maxDrawdownPct: number;
  gasFloorSOMI: number;
  modules: { growth: boolean; volume: boolean; pickoff: boolean; grid: boolean };
  gridLevels: number;
  gridStepBps: number;
  growthSpreadBps: number;
  growthImproveFrac?: number;
  inventorySkewBps: number;
  pickoffEdgeBps: number;
  regime: { cautionDrawdownPct: number; defensiveDrawdownPct: number; cautionClipMult: number; defensiveClipMult: number };
  pegTolerancePct: number;
  programDays: number;
  dynamicAllocation: boolean;
  dashboardPort: number;
  requoteMoveBps?: number;
  vaultDepositUSDso?: number;
  minQuoteUSDso?: number;
  oscillator?: boolean;          // ratchet: taker while there's headroom above the floor, at the floor → maker accumulates
  equityFloorUSDso?: number;     // equity floor — capital protection
  floorHysteresisUSDso?: number; // how far above the floor to rise before re-enabling the taker
  flattenFirst?: boolean;
  flattenTargetUSDso?: number;
  tokens?: Record<string, string>;
  // --- HarvestMaker / market-making at the touch ---
  leadTicks?: number;            // how many ticks to step inside the spread (0=join the best, 1=become the best)
  makerSpreadBps?: number;       // min offset of the quote from the mid (anti-adverse-selection; 0=at the touch, >0=wider/less bleed)
  minEdgeBps?: number;           // min edge vs a fresh external fair (0/+ profit guard)
  softInventoryUSDso?: number;   // above this inventory we DON'T buy more (only sell) → pull toward zero
  hardInventoryUSDso?: number;   // above this — forced taker flatten (unwind stuck inventory)
  takerFlattenThrottleSec?: number; // at most once per N sec per pair
  maxIdleSec?: number;           // watchdog: no successful tx longer than this → exit(1), pm2 restarts (anti-DQ)
  quoteHeartbeatSec?: number;    // re-quote a pair at least once per N sec even with no price move (on-chain activity = anti-DQ)
  volumePaceSec?: number;        // taker RATE LIMIT: volume orders at most once per N sec per pair (0=off). For a final volume boost.
  takerMaxSpreadBps?: number;    // taker crosses ONLY when the spread ≤ this (0=always) → cheap volume (cost=spread/2)
};

const cfg: Config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8"));
const DRY = process.env.DRY_RUN === "1";
const READONLY = process.env.READ_ONLY === "1"; // live dreamDEX, but WITHOUT orders (only reads prices/balances)
const log = (s: string) => console.log(`[${new Date().toISOString()}] ${s}`);

// 24/7 SURVIVABILITY: a network glitch (dropped API/RPC connection) must NOT kill the process.
// A single background `write ECONNABORTED` from an ethers/fetch request used to crash the bot. Now we log and live
// on: the next tick reconnects. Real money is protected by the risk stop, not by the process crashing.
process.on("unhandledRejection", (e: any) => log(`unhandledRejection (survived, continuing): ${e?.message ?? e}`));
process.on("uncaughtException", (e: any) => log(`uncaughtException (survived, continuing): ${e?.message ?? e}`));

const client: ExchangeClient = DRY
  ? new MockClient(cfg.pairs, cfg.capitalUSDso)
  : new DreamDexClient({
      restUrl: process.env.DREAMDEX_REST_URL ?? "",
      wsUrl: process.env.DREAMDEX_WS_URL ?? "",
      rpc: process.env.DREAMDEX_CHAIN_RPC ?? "",
      privateKey: process.env.DREAMDEX_PRIVATE_KEY2 || process.env.DREAMDEX_PRIVATE_KEY || "",
      orderbookContract: process.env.DREAMDEX_ORDERBOOK_CONTRACT,
      tokens: cfg.tokens,
      vaultDepositUSDso: cfg.vaultDepositUSDso,
      gasReserveSOMI: cfg.gasReserveSOMI,
    });

const risk = new RiskManager({
  maxDrawdownPct: cfg.maxDrawdownPct,
  maxInventoryUSDso: cfg.maxInventoryUSDso,
  gasFloorSOMI: cfg.gasFloorSOMI,
});

const regimeMgr = new RegimeManager(cfg.regime);

const strategies: Strategy[] = [
  new CapitalGrowthMaker(cfg.modules.growth, cfg.leadTicks ?? 1, cfg.minEdgeBps ?? 2, cfg.softInventoryUSDso ?? 30, cfg.makerSpreadBps ?? 0, cfg.inventorySkewBps ?? 0),
  new VolumeBooster(cfg.modules.volume, cfg.takerMaxSpreadBps ?? 0),
  new PickOff(cfg.modules.pickoff, cfg.pickoffEdgeBps, 2),
  new GridMaker(cfg.modules.grid, cfg.gridLevels, cfg.gridStepBps, cfg.maxInventoryUSDso),
].filter(s => s.enabled);

let cumVolume = 0;
const startTime = Date.now();
let startGas = 0;
const lastMid: Record<string, number> = {};   // for re-quoting only on a price move
const lastQuoteMs: Record<string, number> = {}; // when we last quoted a pair (for the heartbeat re-quote)
const lastQuote: Record<string, { bid?: number; ask?: number }> = {}; // last PLACED prices (to avoid burning gas on the same price)
const lastInvSnap: Record<string, number> = {}; // inventory at the last quote (fill detection)
const lastFlatten: Record<string, number> = {}; // taker-flatten throttle per pair
const lastVolMs: Record<string, number> = {};   // taker rate limiter (volume module) per pair
const lastSweepMs: Record<string, number> = {}; // anti-deadlock sweep throttle for stuck orders per pair
const flattened: Record<string, boolean> = {}; // one-time inventory sell-off at start done?
let takerMode = !!cfg.oscillator;              // OSCILLATOR: start in taker (headroom above the floor); at the floor → maker
let switching = false;                         // a regime switch is in progress (don't trigger it again)
let belowFloorState = false;                   // below the floor? (log only the state change, no spam)
let stopped = false;                           // SHUTDOWN: flattened everything to USDso and stopped trading (dashboard button)
const stopFile = fileURLToPath(new URL("../STOPPED", import.meta.url)); // shutdown flag file: survives a pm2 restart
const equityBuf: number[] = [];                // window of equity reads for the MEDIAN (kills ±1-clip glitches BOTH ways)
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };

// EXTERNAL price FEED (Binance) for the pickoff arbitrage: the dreamDEX book vs the real market.
const BINANCE: Record<string, string> = { "WETH/USDso": "ETHUSDT", "WBTC/USDso": "BTCUSDT", "SOMI/USDso": "SOMIUSDT" };
const fairPrice: Record<string, number> = {};
const fairTs: Record<string, number> = {};             // when the fair was updated (for the freshness check)
const basisEMA: Record<string, number> = {};           // slow EMA of the basis (dreamDEX mid − Binance) for centering the quotes
const FAIR_FRESH_MS = 20000;                            // fair is fresh if < 20s (otherwise the profit-guard/pickoff won't use it)
async function refreshFair() {
  if (DRY) return;   // in the mock we don't need an external feed (prices are fake)
  for (const sym of cfg.pairs) {
    const bsym = BINANCE[sym]; if (!bsym) continue;
    try {
      const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 8000);  // TIMEOUT: Binance can hang → the tick would stall
      const r: any = await (await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${bsym}`, { signal: ac.signal })).json().finally(() => clearTimeout(t));
      if (r?.price) { fairPrice[sym] = parseFloat(r.price); fairTs[sym] = Date.now(); }
    } catch { /* no feed/timeout → pickoff/profit-guard on this pair won't use the fair (safe) */ }
  }
}

const stats = new Stats();
stats.dry = DRY;
client.onFill((f: Fill) => {
  cumVolume += f.size * f.price;
  stats.recordFill({ ts: f.ts, symbol: f.symbol, side: f.side, size: f.size, price: f.price });
  log(`FILL[${f.symbol}] ${f.side} ${f.size.toFixed(4)} @ ${f.price.toFixed(2)} | volume=$${cumVolume.toFixed(0)} | ~reward=$${(cumVolume / 500000 * 25).toFixed(2)}`);
});

// SINGLE execution: all orders/cancels through one chain (a one-nonce model).
let execChain: Promise<unknown> = Promise.resolve();
function exec(fn: () => Promise<void>): Promise<unknown> {
  execChain = execChain.then(fn).catch(e => log(`exec error: ${(e as Error).message}`));
  return execChain;
}

// Snapshot from balances/books ALREADY read this tick (one read → the numbers don't diverge).
function computeSnapshot(bals: Record<string, Balances>, books: Record<string, OrderBook>) {
  let invUSDso = 0, quote = 0, gas = 0;
  for (const sym of cfg.pairs) {
    // quoteUSDso = (wallet+vault — SHARED across the wallet, same for every pair) + reserved in THIS pair's orders.
    // Take the MAX, NOT the last pair: otherwise the reserved of the pair with orders (WETH-buy ~$36) was lost when
    // the last pair (WBTC, sell-only) has no buy orders → equity falsely dropped by a clip → false floor/sell-only/"phantom $96".
    quote = Math.max(quote, bals[sym].quoteUSDso); gas = bals[sym].gasSOMI;
    invUSDso += bals[sym].baseToken * books[sym].mid;        // net across all pairs
  }
  return { inv: invUSDso, equity: quote + invUSDso, gas, quote };
}

async function cancelAllPairs() { for (const sym of cfg.pairs) await client.cancelAll(sym); }

// SHUTDOWN (dashboard button / organizer says "Stop your bots and convert your balance to USDso"):
// stop trading and flatten ALL inventory to USDso — WETH/WBTC with a taker + SOMI (except 2 for gas). Flag to a file (survives a restart).
async function flattenAndStop() {
  if (stopped) { log("SHUTDOWN: already stopped"); return; }
  stopped = true; stats.halted = true;
  try { writeFileSync(stopFile, new Date().toISOString()); } catch { /* flag not written — no matter, stopped is already in memory */ }
  log("🛑 SHUTDOWN: stop trading + flatten all inventory to USDso…");
  await exec(async () => {
    await cancelAllPairs();                                       // pull resting orders → free the inventory
    if (client.recoverVaults) await client.recoverVaults([]);     // everything from vault → wallet
  });
  // sell the base (WETH/WBTC) to USDso with a taker, several passes (IOC can partial on a thin book)
  for (let pass = 0; pass < 6; pass++) {
    let anySold = false;
    for (const sym of cfg.pairs) {
      try {
        const [bal, ob] = await Promise.all([client.getBalances(sym), client.getOrderBook(sym)]);
        const amt = bal.baseToken;
        if (amt * ob.mid > 1 && client.placeIOC) {
          log(`SHUTDOWN flatten [${sym}]: selling ${amt.toFixed(6)} (~$${(amt * ob.mid).toFixed(1)}) into the market`);
          await exec(async () => { await client.cancelAll(sym); await client.placeIOC!(sym, "sell", ob.bid, amt); });
          anySold = true;
        }
      } catch (e) { log(`SHUTDOWN flatten [${sym}] error: ${(e as Error).message}`); }
    }
    if (!anySold) break;
    await new Promise(r => setTimeout(r, 3000));                  // let fills reflect in the balance
  }
  // SOMI → USDso, leave 2 for gas (best-effort: a wrapped-native pair, may be thin)
  try {
    const somiSym = "SOMI/USDso";
    if (client.getSpec?.(somiSym) && client.placeIOC) {
      const [bal, ob] = await Promise.all([client.getBalances(somiSym), client.getOrderBook(somiSym)]);
      const sellable = Math.max(0, bal.gasSOMI - 2);             // native SOMI − 2 for gas
      if (sellable > 1 && ob.bid > 0) {
        log(`SHUTDOWN flatten SOMI: selling ${sellable.toFixed(2)} SOMI (leaving 2 for gas)`);
        await exec(async () => { await client.placeIOC!(somiSym, "sell", ob.bid, sellable); });
      }
    }
  } catch (e) { log(`SHUTDOWN flatten SOMI (no matter, ~$2): ${(e as Error).message}`); }
  log("✅ SHUTDOWN DONE: trading stopped, inventory flattened to USDso. Check the balance on the dashboard/explorer.");
}

// OSCILLATOR — regime switching. The taker is funded from the WALLET (pull the vault out → the multiplier grows,
// capital is free for volume). The maker is funded from the VAULT (top it up again). Cancel resting orders on a switch.
async function switchToTaker() {
  switching = true;
  await exec(async () => {
    await cancelAllPairs();
    if (client.recoverVaults) await client.recoverVaults([]);        // the whole vault → wallet (for taker + multiplier)
  });
  switching = false;
}
async function switchToMaker() {
  switching = true;
  await exec(async () => {
    await cancelAllPairs();
    if (client.resetVaultFunding) client.resetVaultFunding();        // allow topping up the vault again (adaptive does it on maker orders)
  });
  switching = false;
}

async function tick() {
  if (risk.halted || stopped) return;
  await refreshFair();   // refresh the external fair for pickoff
  // ONE read of balances+books per tick (all numbers from one source → they don't diverge)
  const books: Record<string, OrderBook> = {};
  const bals: Record<string, Balances> = {};
  for (const sym of cfg.pairs) {
    const [bal, ob] = await Promise.all([client.getBalances(sym), client.getOrderBook(sym)]);
    bals[sym] = bal; books[sym] = ob;
  }
  const g = computeSnapshot(bals, books);
  // ── RELIABLE EQUITY = MEDIAN OF A READ WINDOW ────────────────────────────────
  // The API returns pockets (wallet/vault/orders) NON-atomically → individual ticks miss by ±1 clip
  // both DOWN (the order pocket isn't counted yet) and UP (base briefly visible in the wallet AND the order = double-counted).
  // The window MEDIAN drops both kinds of outliers (they're the minority) and holds the true center; a real smooth
  // shift is tracked by the median. We DON'T latch the extreme (an earlier version latched the max → over-counting to $150).
  // A glitch can neither stop the bot nor distort the multiplier; real capital protection is the FLOOR + INVENTORY LIMIT.
  equityBuf.push(g.equity);
  if (equityBuf.length > 9) equityBuf.shift();
  const equitySmooth = median(equityBuf);   // ALL decisions (risk/regime/floor/dashboard) use the median
  const r = risk.assess(equitySmooth, g.gas);
  if (!r.ok) {
    log(`RISK STOP: ${r.reason} | equity=$${equitySmooth.toFixed(1)} inv=$${g.inv.toFixed(1)}`);
    if (risk.halted) await exec(cancelAllPairs);
    return;
  }
  // PEG-GUARD: on live we feed the USDso price from a feed here; in the mock = 1.0.
  const usdsoUsd = 1.0; // TODO launch day: real USDso/USD (Frax PoR / the USDso-USDC pool)
  if (!risk.pegGuard(usdsoUsd, cfg.pegTolerancePct)) { log(`PEG STOP: USDso de-peg ${usdsoUsd}`); await exec(cancelAllPairs); return; }

  // Gas is controlled by the HARD floor in risk.assess (gas <= gasFloorSOMI → pause).
  // Rate pacing removed: on the SOMI/USDso pair native SOMI is both the gas and the base asset,
  // so trading "rocked" the gas read and falsely throttled the bot.

  // ADAPTIVE REGIME: on a capital drawdown we mute the volume module and keep the earners.
  const ddPct = risk.startEquity ? (1 - equitySmooth / risk.startEquity) * 100 : 0;
  const regime = regimeMgr.update(ddPct);
  const active = new Set(regimeMgr.activeModules());   // a copy — we mutate it for the oscillator without touching regimeMgr
  // FLOOR OSCILLATOR (ratchet): taker while there's headroom above the floor; touched the floor → maker accumulates back;
  // grown by +hysteresis → taker again. The body is protected by the floor, the earnings on top get spent on volume. Round and round.
  if (cfg.oscillator && !switching) {
    const floor = cfg.equityFloorUSDso ?? 0;
    const hyst = cfg.floorHysteresisUSDso ?? 1;
    if (takerMode && equitySmooth <= floor) {
      takerMode = false; log(`🛡 FLOOR $${floor}: equity=$${equitySmooth.toFixed(1)} → MAKER (accumulate back, body protected)`);
      await switchToMaker();
    } else if (!takerMode && equitySmooth >= floor + hyst) {
      takerMode = true; log(`🚀 +$${hyst} above the floor: equity=$${equitySmooth.toFixed(1)} → TAKER (push volume)`);
      await switchToTaker();
    }
  }
  if (cfg.oscillator) {
    if (takerMode) { active.delete("growth"); active.delete("grid"); active.add("volume"); }
    else { active.delete("volume"); active.add("growth"); }
  }
  const clipTotal = cfg.perPairClipUSDso * cfg.pairs.length * regimeMgr.clipMult();
  // FLOOR — BODY PROTECTION (works even without the oscillator): equity below the floor → DON'T buy (don't grow inventory),
  // the maker only sells inventory back to USDso → the body rises toward the floor. Doesn't force a dump, just protects.
  const belowFloor = (cfg.equityFloorUSDso ?? 0) > 0 && equitySmooth < (cfg.equityFloorUSDso ?? 0);
  if (belowFloor !== belowFloorState) {   // log ONLY the state change (no spam every tick)
    belowFloorState = belowFloor;
    log(belowFloor
      ? `🛡 below the floor $${cfg.equityFloorUSDso} (equity=$${equitySmooth.toFixed(1)}) → protection: sell-off to USDso only, buys stopped`
      : `✅ above the floor $${cfg.equityFloorUSDso} (equity=$${equitySmooth.toFixed(1)}) → normal trading`);
  }

  // #2 DYNAMIC ALLOCATION: more clip on pairs that already have a spread (cheaper to push volume).
  const weights: Record<string, number> = {};
  let sumW = 0;
  for (const sym of cfg.pairs) {
    const ob = books[sym];
    const spread = (ob.ask - ob.bid) / ob.mid;
    const w = cfg.dynamicAllocation ? 1 / Math.max(spread, 1e-6) : 1;
    weights[sym] = w; sumW += w;
  }

  const pairRows: PairRow[] = [];
  for (const sym of cfg.pairs) {
    const ob = books[sym];
    const bal = bals[sym];
    const clip = clipTotal * (weights[sym] / sumW);
    const invUSDsoPair = bal.baseToken * ob.mid;
    // USDso FLOOR: only buy for the amount ABOVE the floor → USDso (wallet+vault) doesn't fall below minQuoteUSDso
    const floorShare = (cfg.minQuoteUSDso ?? 0) / cfg.pairs.length;
    let buyable = Math.max(0, bal.quoteUSDso / cfg.pairs.length - floorShare);
    // SELL-OFF PHASE (one-time at start): while inventory > target — DON'T buy, only sell to USDso
    if (cfg.flattenFirst && !flattened[sym]) {
      if (invUSDsoPair > (cfg.flattenTargetUSDso ?? 8)) buyable = 0;
      else { flattened[sym] = true; log(`[${sym}] inventory sold off (≈$${invUSDsoPair.toFixed(1)}) → start two-sided making`); }
    }
    if ((cfg.liquidatePairs ?? []).includes(sym)) buyable = 0;   // liquidation: only sell (no new buys → no drift)
    if (belowFloor) buyable = 0;                                 // body protection: below the floor don't buy, only sell off to USDso
    const vaultBaseUSDso = (bal.baseVault ?? bal.baseToken) * ob.mid;   // base in vault/orders (for compatibility; the maker is now wallet-funded)
    const spec = client.getSpec?.(sym);
    const binFair = fairPrice[sym];
    const fresh = (Date.now() - (fairTs[sym] ?? 0)) < FAIR_FRESH_MS && binFair > 0;
    // CENTER for the maker = Binance + a SLOW EMA of the basis (dreamDEX's structural offset from Binance).
    // So the center moves WITH Binance instantly (anti-stale-pickoff) but holds the correct dreamDEX level.
    let centerFair: number | undefined;
    if (fresh) {
      const basis = ob.mid - binFair;
      basisEMA[sym] = basisEMA[sym] === undefined ? basis : basisEMA[sym] * 0.8 + basis * 0.2;  // converges faster to the dreamDEX mid → both sides at the touch (catch both sides of the flow)
      centerFair = binFair + basisEMA[sym];
    }
    const fairFresh = fresh && centerFair !== undefined;
    const ctx: StratCtx = { symbol: sym, ob, invUSDso: invUSDsoPair, quoteUSDso: buyable, clipUSDso: clip, fair: centerFair ?? binFair, vaultBaseUSDso, tick: spec?.tick, fairFresh };
    let proposed: DesiredOrder[] = [];
    const isMakerPair = (cfg.makerPairs ?? cfg.pairs).includes(sym);   // maker only where the vault is working (WETH)
    for (const s of strategies) if (active.has(s.name)) {
      if (cfg.oscillator) {
        // oscillator: one regime across ALL pairs (taker OR maker) — the gate is already done via active
        if (takerMode && (s.name === "growth" || s.name === "grid")) continue;
        if (!takerMode && s.name === "volume") continue;
      } else {
        if ((s.name === "growth" || s.name === "grid") && !isMakerPair) continue;  // maker only on makerPairs
        if (s.name === "volume" && isMakerPair) continue;                          // taker-churn NOT on makerPairs (otherwise self-match with our own maker)
      }
      proposed.push(...s.propose(ctx));
    }
    proposed = risk.filter(proposed, g.inv);          // wallet-level veto
    // TAKER RATE LIMITER (final volume boost): let volume orders through at most once per volumePaceSec per pair
    // → spread the volume evenly over time, don't burn gas/capital in a burst. volumePaceSec=0 → off (normal mode).
    if ((cfg.volumePaceSec ?? 0) > 0 && proposed.some(o => o.tag === "volume")) {
      if (Date.now() - (lastVolMs[sym] ?? 0) < (cfg.volumePaceSec ?? 0) * 1000) proposed = proposed.filter(o => o.tag !== "volume");
      else lastVolMs[sym] = Date.now();
    }
    // FORCED TAKER FLATTEN: inventory stuck above the hard threshold (the maker didn't offload it — no counter-taker).
    // Hit the bid with IOC → guaranteed inventory reduction, free up USDso, keep on-chain activity (anti-DQ). Throttled.
    const hardInv = cfg.hardInventoryUSDso ?? Infinity;
    const canFlatten = !READONLY && !!client.placeIOC && invUSDsoPair > hardInv && !belowFloor
      && (Date.now() - (lastFlatten[sym] ?? 0) > (cfg.takerFlattenThrottleSec ?? 30) * 1000);
    const isTaker = proposed.some(o => !o.postOnly);
    // GAS EFFICIENCY: re-quote ONLY when it makes sense. Otherwise orders JUST REST and get executed
    // (a fill = someone else's taker pays the gas, free for us). Don't burn gas re-placing the same price every tick.
    // Triggers: (1) our price moved > requoteMoveBps (the touch moved there → we must catch up); (2) the set of
    // sides changed (overLong↔two-sided); (3) a fill happened (inventory changed); (4) heartbeat (anti-DQ).
    const desiredBid = proposed.find(o => o.side === "buy" && o.postOnly)?.price;
    const desiredAsk = proposed.find(o => o.side === "sell" && o.postOnly)?.price;
    const lq = lastQuote[sym];
    const thresh = ob.mid * (cfg.requoteMoveBps ?? 4) * 1e-4;                 // how far the price must move to re-quote
    const sideGone = (d?: number, l?: number) => (d === undefined) !== (l === undefined);
    const moved1 = (d?: number, l?: number) => d !== undefined && l !== undefined && Math.abs(d - l) >= thresh;
    const priceChanged = !lq || sideGone(desiredBid, lq.bid) || sideGone(desiredAsk, lq.ask) || moved1(desiredBid, lq.bid) || moved1(desiredAsk, lq.ask);
    const invChanged = lastInvSnap[sym] === undefined || Math.abs(invUSDsoPair - lastInvSnap[sym]) > Math.max(3, clip * 0.3); // ~fill detection (above read noise)
    const quoteStale = Date.now() - (lastQuoteMs[sym] ?? 0) > (cfg.quoteHeartbeatSec ?? 300) * 1000;
    const needRequote = priceChanged || invChanged || quoteStale;
    if (canFlatten) {
      lastFlatten[sym] = Date.now();
      const reduceUSD = Math.min(invUSDsoPair - (cfg.softInventoryUSDso ?? 30), clip);
      const sz = reduceUSD / ob.mid;
      if (sz > 0) {
        log(`⚖ taker-flatten [${sym}]: inventory $${invUSDsoPair.toFixed(1)} > $${hardInv} → selling ~$${reduceUSD.toFixed(0)} into the market`);
        lastQuote[sym] = {}; lastInvSnap[sym] = invUSDsoPair; lastQuoteMs[sym] = Date.now();
        await exec(async () => { await client.cancelAll(sym); await client.placeIOC!(sym, "sell", ob.bid, sz); });
      }
    } else if (!READONLY && proposed.length && (isTaker || needRequote)) {
      lastQuote[sym] = { bid: desiredBid, ask: desiredAsk };
      lastInvSnap[sym] = invUSDsoPair;
      lastQuoteMs[sym] = Date.now();
      await exec(async () => {
        await client.cancelAll(sym);   // ALWAYS pull resting orders (a taker could have hung too) → free the balance, else ERC20InsufficientBalance
        for (const o of proposed) {
          // A taker order is IOC ONLY: filled immediately or cancelled by the exchange, it CAN'T rest.
          // A normalOrder (GTC) with a runaway price used to hang in the book and LOCK the balance (deadlock: $76 in 2 buy orders).
          if (!o.postOnly && client.placeIOC) await client.placeIOC(o.symbol, o.side, o.price, o.size);
          else await client.placeLimit(o.symbol, o.side, o.price, o.size, o.postOnly);
        }
      });
    } else if (!READONLY && !proposed.length && Date.now() - (lastSweepMs[sym] ?? 0) > 90_000) {
      // ANTI-DEADLOCK: nothing to propose — usually because the balance is locked in stuck orders,
      // and the cancelAll branch above only fires when there are new orders → a closed loop.
      // Once per 90s pull resting orders: polling open orders is free (REST), transactions only if there's something to pull.
      lastSweepMs[sym] = Date.now();
      await exec(() => client.cancelAll(sym));
    }
    pairRows.push({ symbol: sym, mid: ob.mid, spreadBps: (ob.ask - ob.bid) / ob.mid * 1e4, allocPct: weights[sym] / sumW * 100, invUSDso: bal.baseToken * ob.mid });
  }
  // update the dashboard
  const running = strategies.filter(s => active.has(s.name)).map(s => s.name); // actually running modules
  stats.regime = regime; stats.equity = equitySmooth; stats.startEquity = risk.startEquity; stats.ddPct = ddPct;
  stats.inv = g.inv; stats.gas = g.gas; stats.halted = risk.halted; stats.activeModules = running;  // raw inventory (≥0, no negative glitch)
  stats.quoteUSDso = g.quote; stats.minQuoteUSDso = cfg.minQuoteUSDso ?? 0;
  stats.pairs = pairRows; stats.cumVolume = cumVolume;
  stats.recordTick({ ts: Date.now(), equity: equitySmooth, ddPct, regime, inv: g.inv, gas: g.gas });

  const alloc = cfg.pairs.map(s => `${s.split("/")[0]}:${(weights[s] / sumW * 100).toFixed(0)}%`).join(" ");
  log(`equity=$${equitySmooth.toFixed(1)} dd=${ddPct.toFixed(2)}% regime=${regime} clip×${regimeMgr.clipMult()} inv=$${g.inv.toFixed(1)} gas=${g.gas.toFixed(2)} alloc[${alloc}] active=${running.join("+")}`);
}

async function shutdown(timer: ReturnType<typeof setInterval>) {
  clearInterval(timer);
  await exec(cancelAllPairs);
  log(`Stopped. Final volume=$${cumVolume.toFixed(0)} | ~reward=$${(cumVolume / 500000 * 25).toFixed(2)}`);
  process.exit(0);
}

async function main() {
  log(`dreamDEX volume bot start (DRY=${DRY}${READONLY ? ", READ-ONLY" : ""}) | pairs: ${cfg.pairs.join(", ")} | modules: ${strategies.map(s => s.name).join("+")}`);
  if (!DRY && existsSync(stopFile)) { stopped = true; stats.halted = true; log("🛑 Found a STOPPED file → SHUTDOWN mode: trading does NOT start (delete the STOPPED file + restart to resume)."); }
  await client.connect();
  // At start, move stuck vaults into the wallet (vault = negative PnL). Keep the vault for maker pairs.
  if (!DRY && !READONLY && client.recoverVaults) {
    // THE MAKER IS NOW WALLET-FUNDED → the vault isn't needed at all. Pull EVERYTHING from the vault into the wallet (keep=[]),
    // so capital works in wallet-funded orders instead of sitting in the vault (where the leaderboard doesn't count it).
    log(`moving everything out of the vaults into the wallet (maker is wallet-funded, vault not needed)…`);
    await client.recoverVaults([]);
  }
  const timer = setInterval(() => { tick().catch(e => log(`tick error: ${(e as Error).message}`)); }, cfg.requoteMs);
  // WATCHDOG (anti-DQ): the event rule — no on-chain activity for 24h = disqualification. If the bot "freezes" (no single
  // successful transaction for longer than maxIdleSec) — exit with code 1, and pm2 (autorestart) brings up a fresh process
  // (re-does auth/markets/recoverVaults — which usually unsticks a jammed order state). Default 20 min.
  if (!DRY && !READONLY) {
    const maxIdleMs = (cfg.maxIdleSec ?? 1200) * 1000;
    setInterval(() => {
      if (risk.halted || stopped) return;                        // an intentional stop/shutdown — don't restart
      const last = (client as any).lastTxMs ?? 0;
      const idle = Date.now() - (last || startTime);             // if there was no tx yet — count from start
      if (idle > maxIdleMs) {
        log(`WATCHDOG: no successful tx for ${Math.floor(idle / 1000)}s (> ${cfg.maxIdleSec ?? 1200}s) → exit(1), pm2 will restart`);
        process.exit(1);
      }
    }, 60000);
  }
  process.on("SIGINT", () => shutdown(timer));
  const runSeconds = Number(process.env.RUN_SECONDS ?? 0);
  if (runSeconds > 0) setTimeout(() => shutdown(timer), runSeconds * 1000);
}
main().catch(e => { log(`fatal: ${(e as Error).message}`); process.exit(1); });
