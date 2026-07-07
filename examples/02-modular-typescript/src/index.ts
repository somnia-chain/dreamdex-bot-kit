/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import "dotenv/config";
import { logger } from "./utils/logger.js";
import { getActiveNetwork } from "./config/network.js";
import { getPool } from "./config/pairs.js";
import { getToken } from "./config/tokens.js";
import { Orchestrator } from "./orchestrator.js";
import {
  ALLOCATIONS,
  PAIRS,
  SPREADS_BPS,
  ORDER,
  RISK,
  DAY7,
  LLM,
  FEATURES,
} from "./config/constants.js";

function parseFlags(argv: string[]): { dryRun: boolean; configOnly: boolean } {
  const flags = { dryRun: false, configOnly: false };
  for (const a of argv.slice(2)) {
    if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--config-only") flags.configOnly = true;
  }
  return flags;
}

async function logConfig(): Promise<void> {
  const network = getActiveNetwork();
  logger.info(
    { network: network.name, chainId: network.chainId, rpc: network.rpc },
    "DreamTend booting…",
  );

  const usdso = getToken(network.name, "USDso");
  logger.info(
    { address: usdso.address, decimals: usdso.decimals },
    "USDso settlement token loaded",
  );

  for (const [label, symbol] of [
    ["primary", PAIRS.primary],
    ["secondary", PAIRS.secondary],
  ] as const) {
    try {
      const pool = getPool(network.name, symbol);
      logger.info(
        {
          symbol: pool.symbol,
          poolAddress: pool.poolAddress,
          tickSize: pool.tickSize,
          lotSize: pool.lotSize,
          minQty: pool.minQuantity,
        },
        `${label} pool config OK`,
      );
    } catch (err) {
      logger.warn(
        { symbol, reason: (err as Error).message },
        `${label} pool unavailable on ${network.name}`,
      );
    }
  }

  logger.info(
    {
      allocations: ALLOCATIONS,
      spreadsBps: SPREADS_BPS,
      orderNotionalUsdso: ORDER.notionalUsdso,
      maxOpenPerSide: ORDER.maxOpenOrdersPerSide,
      requoteTriggerBps: ORDER.requoteTriggerBps,
      riskFloorUsdso: RISK.hardFloorUsdso,
      maxTxNotional: RISK.maxTxNotionalUsdso,
      day7At: DAY7.liquidateAt,
      llm: { enabled: LLM.enabled, model: LLM.model },
      features: FEATURES,
    },
    "Strategy parameters loaded",
  );
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv);
  await logConfig();

  if (flags.configOnly) {
    logger.info("--config-only passed; exiting without starting orchestrator");
    return;
  }

  const orchestrator = new Orchestrator({ dryRun: flags.dryRun });
  await orchestrator.start();
}

main().catch((err) => {
  logger.fatal({ err }, "Fatal startup error");
  process.exit(1);
});
