/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// One-time owner setup for session-key trading, run with your FUND key.
//
//   PRIVATE_KEY=<fund key>  OPERATOR_ADDRESS=0x<hot bot key address> \
//   OP_SYMBOL=USDC.e:USDso  OP_DEPOSIT_USDSO=50  [OP_DEPOSIT_BASE=0] \
//   npx tsx scripts/operator-setup.ts
//
// It puts the pool in manual vault mode, deposits working capital into the pool's
// vault, and grants the operator the place + cancel selectors. After this, run
// your bot with PRIVATE_KEY=<operator key> and OWNER_ADDRESS=<fund address>.
import "dotenv/config";
import { parseUnits } from "viem";
import { createChainContext, Pool, MARKETS, setManualVaultMode, depositVault, grantOperator, isOperatorAuthorized, OPERATOR_SELECTOR } from "@dreamdex-bot-kit/core";

async function main() {
  const operator = process.env.OPERATOR_ADDRESS as `0x${string}` | undefined;
  if (!operator) throw new Error("Set OPERATOR_ADDRESS to the hot bot key's address.");

  const fund = createChainContext(process.env.PRIVATE_KEY); // fund/owner key
  const symbol = process.env.OP_SYMBOL ?? "USDC.e:USDso";
  const meta = MARKETS[fund.net.name][symbol];
  if (!meta) throw new Error(`Unknown market "${symbol}" on ${fund.net.name}.`);
  const p = await Pool.load(fund, symbol);
  const owner = fund.account.address;
  console.log(`owner(fund)=${owner} operator=${operator} pool=${symbol} (${fund.net.name})`);

  console.log("→ setManualVaultMode(true):", await setManualVaultMode(fund, meta.pool, true));

  const quoteAmt = Number(process.env.OP_DEPOSIT_USDSO ?? "0");
  if (quoteAmt > 0) console.log(`→ deposit ${quoteAmt} USDso:`, await depositVault(fund, meta.pool, p.params.quoteToken, parseUnits(String(quoteAmt), p.quoteDecimals)));

  const baseAmt = Number(process.env.OP_DEPOSIT_BASE ?? "0");
  if (baseAmt > 0 && !meta.baseIsNative) console.log(`→ deposit ${baseAmt} base:`, await depositVault(fund, meta.pool, p.params.baseToken, parseUnits(String(baseAmt), p.baseDecimals)));
  else if (baseAmt > 0) console.log("  (skip base deposit: native base — use depositNative separately)");

  console.log("→ grantOperator (placeOrderFor + cancelOrderFor):", await grantOperator(fund, meta.pool, operator));
  const authed = await isOperatorAuthorized(fund.publicClient, meta.pool, owner, operator, OPERATOR_SELECTOR.placeOrderFor as `0x${string}`);
  console.log(`\n✓ operator authorized: ${authed}`);
  console.log(`Now run your bot with:  PRIVATE_KEY=<operator key>  OWNER_ADDRESS=${owner}`);
  console.log(`Revoke later with grantOperator(..., false) or setOperatorApprovalForPool(..., false).`);
}
main().catch((e) => { console.error(String(e).slice(0, 300)); process.exit(1); });
