/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { DreamDexHttpClient } from '../dex/http.js';
import type { MarketInfo, OrderExecutionResult, PrepareOrderRequest } from '../dex/types.js';
import { TransactionExecutor } from './signer.js';
import type { OrderExecutor } from './types.js';

export class HttpOrderExecutor implements OrderExecutor {
  constructor(
    private readonly http: DreamDexHttpClient,
    private readonly transactionExecutor: TransactionExecutor,
  ) {}

  async executeOrder(
    market: MarketInfo,
    request: PrepareOrderRequest,
  ): Promise<OrderExecutionResult> {
    const prepared = await this.http.prepareOrder(market.symbol, request);

    let approvalTxHash: string | undefined;
    if (prepared.approval) {
      approvalTxHash = await this.transactionExecutor.sendApprovalIfNeeded(
        prepared.approval,
        market.contract,
      );
    }

    const txHash = await this.transactionExecutor.sendPreparedTransaction(prepared);
    return {
      mode: 'http',
      txHash,
      approvalTxHash,
    };
  }
}
