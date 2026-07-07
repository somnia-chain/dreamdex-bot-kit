/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

export * from './dex/types.js';
export { DreamDexHttpClient } from './dex/http.js';
export { DreamDexWsClient } from './dex/ws.js';
export { ContractOrderExecutor } from './execution/contract.js';
export { HttpOrderExecutor } from './execution/http.js';
export { TransactionExecutor } from './execution/signer.js';
export type { OrderExecutor } from './execution/types.js';
export { VaultManager } from './execution/vault.js';
export { BotStateStore } from './persistence/store.js';
export type { PersistedBotSnapshot, PersistenceContext } from './persistence/store.js';
export { adjustPriceByBps, alignToStep } from './utils.js';
