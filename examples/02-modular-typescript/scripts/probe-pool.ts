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
import { SPOTPOOL_ABI } from "../src/dex/abi/spotpool.js";
import { logger } from "../src/utils/logger.js";

const POOL_SYMBOL = process.argv[2] ?? "SOMI:USDso";

async function main(): Promise<void> {
  const net = getActiveNetwork();
  const provider = new ethers.JsonRpcProvider(net.rpc, { chainId: net.chainId, name: net.name });
  const pool = getPool(net.name, POOL_SYMBOL);
  const baseT = getToken(net.name, pool.base);
  const quoteT = getToken(net.name, pool.quote);

  const c = new ethers.Contract(pool.poolAddress, SPOTPOOL_ABI, provider);

  const params = await (c.getPoolParams as ethers.BaseContractMethod<[], [string, string, bigint, bigint, bigint, bigint, bigint], [string, string, bigint, bigint, bigint, bigint, bigint]>)();
  logger.info(
    {
      base: params[0],
      quote: params[1],
      makerFeeBpsTimes1k: params[2].toString(),
      takerFeeBpsTimes1k: params[3].toString(),
      tickRaw: params[4].toString(),
      tickDecimal: Number(ethers.formatUnits(params[4], quoteT.decimals)),
      lotRaw: params[5].toString(),
      lotDecimal: Number(ethers.formatUnits(params[5], baseT.decimals)),
      minQtyRaw: params[6].toString(),
      minQtyDecimal: Number(ethers.formatUnits(params[6], baseT.decimals)),
    },
    `Pool params for ${POOL_SYMBOL}`,
  );

  for (const isBid of [true, false]) {
    try {
      const [prices, sizes] = (await (c.getBookLevels as ethers.BaseContractMethod<[boolean, number], [bigint[], bigint[]], [bigint[], bigint[]]>)(isBid, 5));
      logger.info(
        {
          side: isBid ? "BID" : "ASK",
          count: prices.length,
          levels: prices.map((p, i) => ({
            priceRaw: p.toString(),
            price: Number(ethers.formatUnits(p, quoteT.decimals)),
            sizeRaw: (sizes[i] ?? 0n).toString(),
            size: Number(ethers.formatUnits(sizes[i] ?? 0n, baseT.decimals)),
          })),
        },
        "Book",
      );
    } catch (err) {
      logger.warn({ side: isBid ? "BID" : "ASK", err: (err as Error).message }, "Book empty/revert");
    }
  }
}

main().catch((err) => { logger.fatal({ err: err.message ?? err }); process.exit(1); });
