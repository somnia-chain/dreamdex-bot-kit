/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { MarketInfo, OrderExecutionResult, PrepareOrderRequest } from '../dex/types.js';

export interface OrderExecutor {
  executeOrder(
    market: MarketInfo,
    request: PrepareOrderRequest,
  ): Promise<OrderExecutionResult>;
}
