/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";
import { ethers } from "ethers";
import { getActiveNetwork } from "../src/config/network.js";
import { getPool } from "../src/config/pairs.js";
import { getToken } from "../src/config/tokens.js";

// Reconcile realized trading friction on the WETH:USDso pool for the Reg wallet.
// Scans ERC20 Transfer events (USDso + WETH) between Reg wallet and the pool,
// sums directional flows, and computes net USDso spent vs net WETH gained →
// implied avg buy/sell price + per-round-trip spread.
//
// Usage: tsx scripts/analyze-friction.ts [blockLookback=5000]

const LOOKBACK = Number(process.argv[2] ?? "5000");
const CHUNK = 999;
const REG = "0x8f0A24AE910D4B89C4422b6884d71739DBC1ec86".toLowerCase();
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

function pad(addr: string): string {
  return ethers.zeroPadValue(addr, 32).toLowerCase();
}

async function sumTransfers(
  provider: ethers.JsonRpcProvider,
  token: string,
  decimals: number,
  poolAddr: string,
  fromBlock: number,
  toBlock: number,
): Promise<{ poolToReg: bigint; regToPool: bigint; countIn: number; countOut: number }> {
  let poolToReg = 0n;
  let regToPool = 0n;
  let countIn = 0;
  let countOut = 0;
  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, toBlock);
    // pool -> reg
    const logsIn = await provider.getLogs({
      address: token,
      fromBlock: start,
      toBlock: end,
      topics: [TRANSFER_TOPIC, pad(poolAddr), pad(REG)],
    });
    for (const l of logsIn) { poolToReg += BigInt(l.data); countIn++; }
    // reg -> pool
    const logsOut = await provider.getLogs({
      address: token,
      fromBlock: start,
      toBlock: end,
      topics: [TRANSFER_TOPIC, pad(REG), pad(poolAddr)],
    });
    for (const l of logsOut) { regToPool += BigInt(l.data); countOut++; }
  }
  return { poolToReg, regToPool, countIn, countOut };
}

async function main(): Promise<void> {
  const net = getActiveNetwork();
  const provider = new ethers.JsonRpcProvider(net.rpc, { chainId: net.chainId, name: net.name });
  const pool = getPool(net.name, "WETH:USDso");
  const weth = getToken(net.name, "WETH");
  const usdso = getToken(net.name, "USDso");

  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - LOOKBACK);
  console.log(`Scanning WETH:USDso pool <-> Reg flows over blocks ${fromBlock}..${latest} (${LOOKBACK})`);

  const wethFlow = await sumTransfers(provider, weth.address, weth.decimals, pool.poolAddress, fromBlock, latest);
  const usdsoFlow = await sumTransfers(provider, usdso.address, usdso.decimals, pool.poolAddress, fromBlock, latest);

  const wethIn = Number(ethers.formatUnits(wethFlow.poolToReg, weth.decimals));   // bought
  const wethOut = Number(ethers.formatUnits(wethFlow.regToPool, weth.decimals));  // sold
  const usdsoIn = Number(ethers.formatUnits(usdsoFlow.poolToReg, usdso.decimals)); // received (sells + refunds)
  const usdsoOut = Number(ethers.formatUnits(usdsoFlow.regToPool, usdso.decimals)); // sent (buy escrow)

  const netWeth = wethIn - wethOut;       // + = accumulated WETH inventory
  const netUsdso = usdsoIn - usdsoOut;    // - = net USDso spent

  console.log("\n=== Raw flows (this window) ===");
  console.log(`WETH  in (bought): ${wethIn.toFixed(6)}   out (sold): ${wethOut.toFixed(6)}   net: ${netWeth.toFixed(6)}`);
  console.log(`USDso in (recv):   ${usdsoIn.toFixed(4)}   out (sent):  ${usdsoOut.toFixed(4)}   net: ${netUsdso.toFixed(4)}`);
  console.log(`Transfer counts: WETH in=${wethFlow.countIn} out=${wethFlow.countOut} | USDso in=${usdsoFlow.countIn} out=${usdsoFlow.countOut}`);

  // Implied avg prices
  if (wethIn > 0) console.log(`\nImplied avg BUY price:  ${(usdsoOut / wethIn).toFixed(2)} USDso/WETH (escrow basis)`);
  if (wethOut > 0) console.log(`Implied avg SELL price: ${(usdsoIn_sellOnly(usdsoIn, usdsoOut, wethIn) / wethOut).toFixed(2)} USDso/WETH (approx)`);

  // Friction: net USDso change minus value of net WETH inventory change (at current mid)
  // mark net WETH at the avg traded price
  const avgPrice = wethIn > 0 ? usdsoOut / wethIn : 1978;
  const inventoryValue = netWeth * avgPrice;
  const realizedFriction = netUsdso + inventoryValue; // netUsdso is negative (spent); +inventory we hold
  console.log(`\n=== Friction reconciliation (window) ===`);
  console.log(`Net USDso change:        ${netUsdso.toFixed(4)}`);
  console.log(`Net WETH inventory:      ${netWeth.toFixed(6)} (worth ~${inventoryValue.toFixed(4)} USDso @ ${avgPrice.toFixed(0)})`);
  console.log(`Realized friction:       ${realizedFriction.toFixed(4)} USDso  (negative = loss)`);
  const roundTrips = Math.min(wethFlow.countOut, wethFlow.countIn);
  if (roundTrips > 0) {
    console.log(`Approx round-trips:      ${roundTrips}`);
    console.log(`Friction per round-trip: ${(realizedFriction / roundTrips).toFixed(5)} USDso`);
  }
}

// USDso received includes both SELL proceeds AND buy-refunds. Rough split:
// total usdso in = sell_proceeds + buy_refunds; buy_refunds = usdsoOut - (wethIn*marketPrice)
// This is approximate; for a cleaner read use the net figures above.
function usdsoIn_sellOnly(usdsoIn: number, _usdsoOut: number, _wethIn: number): number {
  return usdsoIn; // approximation: treat all USDso-in as sell-side for avg-price display
}

main().catch((err) => { console.error(err); process.exit(1); });
