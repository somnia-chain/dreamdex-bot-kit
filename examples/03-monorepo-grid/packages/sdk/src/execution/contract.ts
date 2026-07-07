/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { Contract, parseUnits, ZeroAddress } from 'ethers';
import type {
  MarketInfo,
  OrderExecutionResult,
  PrepareOrderRequest,
} from '../dex/types.js';
import type { OrderType, SelfMatchingOption } from '../dex/types.js';
import { TransactionExecutor } from './signer.js';
import type { OrderExecutor } from './types.js';

const SPOT_POOL_ABI = [
  'function placeTakerOrderWithoutVault(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) payable returns (bool success, uint128 orderId)',
  'function placeOrder(bool isBid, uint64 userData, uint256 price, uint256 quantity, uint64 expireTimestampNs, uint8 orderType, uint8 selfMatchingOption, address builder, uint96 builderFeeBpsTimes1k) returns (bool success, uint128 orderId)',
] as const;

const ORDER_TYPE_TO_ENUM: Record<OrderType, number> = {
  normalOrder: 0,
  fillOrKill: 1,
  immediateOrCancel: 2,
  postOnly: 3,
};

const SELF_MATCH_TO_ENUM: Record<SelfMatchingOption, number> = {
  cancelTaker: 0,
  cancelMaker: 1,
};

export class ContractOrderExecutor implements OrderExecutor {
  constructor(
    private readonly transactionExecutor: TransactionExecutor,
    private readonly expireSeconds: number,
    private readonly chainId: number,
  ) {}

  async executeOrder(
    market: MarketInfo,
    request: PrepareOrderRequest,
  ): Promise<OrderExecutionResult> {
    if (!request.price) {
      throw new Error('Contract execution currently requires a limit price');
    }

    if (
      request.fundingSource === 'wallet' &&
      request.orderType !== 'immediateOrCancel' &&
      request.orderType !== 'fillOrKill'
    ) {
      throw new Error(
        'Wallet-funded contract execution only supports IOC or FOK orders',
      );
    }

    const spotPool = new Contract(
      market.contract,
      SPOT_POOL_ABI,
      this.transactionExecutor.getSigner(),
    );
    const priceRaw = parseUnits(request.price, market.quoteDecimals);
    const quantityRaw = parseUnits(request.amount, market.baseDecimals);
    const isBid = request.side === 'buy';
    const expireTimestampNs = this.getExpireTimestampNs();
    const orderType = ORDER_TYPE_TO_ENUM[request.orderType];
    const selfMatchingOption =
      SELF_MATCH_TO_ENUM[request.selfMatchingOption ?? 'cancelTaker'];
    const args = [
      isBid,
      0,
      priceRaw,
      quantityRaw,
      expireTimestampNs,
      orderType,
      selfMatchingOption,
      ZeroAddress,
      0,
    ] as const;

    let approvalTxHash: string | undefined;
    let value = 0n;

    if (request.fundingSource === 'wallet') {
      const requiredInput = this.getWalletInputRequirement(
        market,
        request.side,
        priceRaw,
        quantityRaw,
      );
      value = requiredInput.value;

      if (requiredInput.token && requiredInput.amount > 0n) {
        approvalTxHash = await this.transactionExecutor.ensureErc20Allowance(
          requiredInput.token,
          market.contract,
          requiredInput.amount,
        );
      }
    }

    if (request.fundingSource === 'wallet') {
      const [success, orderId] =
        (await spotPool.placeTakerOrderWithoutVault.staticCall(...args, {
          value,
        })) as [boolean, bigint];
      if (!success) {
        throw new Error(
          `Contract simulation returned success=false; order would be rejected on-chain. side=${request.side} symbol=${market.symbol} price=${request.price} amount=${request.amount} funding=${request.fundingSource} value=${value.toString()}`,
        );
      }

      const tx = await spotPool.placeTakerOrderWithoutVault(...args, { value });
      const receipt = await tx.wait();
      if (!receipt) {
        throw new Error(
          'Contract order transaction broadcasted but no receipt was returned',
        );
      }

      return {
        mode: 'contract',
        txHash: receipt.hash,
        approvalTxHash,
        simulatedOrderId: orderId.toString(),
      };
    }

    const [success, orderId] = (await spotPool.placeOrder.staticCall(...args, {
      value,
    })) as [boolean, bigint];
    if (!success) {
      throw new Error(
        `Contract simulation returned success=false; order would be rejected on-chain. side=${request.side} symbol=${market.symbol} price=${request.price} amount=${request.amount} funding=${request.fundingSource} value=${value.toString()}`,
      );
    }

    const tx = await spotPool.placeOrder(...args, { value });
    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error(
        'Contract order transaction broadcasted but no receipt was returned',
      );
    }

    return {
      mode: 'contract',
      txHash: receipt.hash,
      approvalTxHash,
      simulatedOrderId: orderId.toString(),
    };
  }

  private getExpireTimestampNs(): bigint {
    // DreamDEX Shannon testnet currently rejects 0 expiry for taker orders in practice,
    // even though the docs say 0 should mean "no expiry".
    if (this.expireSeconds <= 0 && this.chainId === 50312) {
      const expireSecondsFromNow = BigInt(Math.floor(Date.now() / 1000) + 3600);
      return expireSecondsFromNow * 1_000_000_000n;
    }

    if (this.expireSeconds <= 0) {
      return 0n;
    }

    const expireSecondsFromNow = BigInt(
      Math.floor(Date.now() / 1000) + this.expireSeconds,
    );
    return expireSecondsFromNow * 1_000_000_000n;
  }

  private getWalletInputRequirement(
    market: MarketInfo,
    side: PrepareOrderRequest['side'],
    priceRaw: bigint,
    quantityRaw: bigint,
  ): { token?: string; amount: bigint; value: bigint } {
    const isNativeSomiMarket = market.symbol.startsWith('SOMI:');

    if (side === 'sell') {
      if (isNativeSomiMarket) {
        return { amount: quantityRaw, value: quantityRaw };
      }

      return { token: market.base, amount: quantityRaw, value: 0n };
    }

    const quoteAmount =
      (priceRaw * quantityRaw) / 10n ** BigInt(market.baseDecimals);
    return { token: market.quote, amount: quoteAmount, value: 0n };
  }
}
