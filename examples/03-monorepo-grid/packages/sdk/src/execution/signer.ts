/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import { Contract, JsonRpcProvider, MaxUint256, Wallet, parseUnits } from 'ethers';
import type { UnsignedTransactionPayload } from '../dex/types.js';

const ERC20_ABI = [
  'function decimals() view returns (uint8)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
] as const;

export class TransactionExecutor {
  private readonly signer: Wallet;
  private readonly expectedChainId: number;

  constructor(rpcUrl: string, privateKey: string, expectedChainId: number) {
    const provider = new JsonRpcProvider(rpcUrl, expectedChainId);
    this.signer = new Wallet(privateKey, provider);
    this.expectedChainId = expectedChainId;
  }

  async sendApprovalIfNeeded(
    approval: UnsignedTransactionPayload['approval'],
    spender: string,
  ): Promise<string | undefined> {
    if (!approval) {
      return undefined;
    }

    const amount = await this.normalizeApprovalAmount(
      approval.token,
      approval.amount,
    );
    return this.approveTokenSpend(approval.token, spender, amount);
  }

  get walletAddress(): string {
    return this.signer.address;
  }

  getSigner(): Wallet {
    return this.signer;
  }

  async assertConnectedChain(): Promise<void> {
    const network = await this.signer.provider!.getNetwork();
    const connectedChainId = Number(network.chainId);
    if (connectedChainId !== this.expectedChainId) {
      throw new Error(
        `RPC chain mismatch: connected RPC is chain ${connectedChainId}, but DREAMDEX_CHAIN_ID is ${this.expectedChainId}. Update DREAMDEX_RPC_URL or DREAMDEX_CHAIN_ID so they point to the same network.`,
      );
    }
  }

  async getErc20Allowance(token: string, spender: string): Promise<bigint> {
    const erc20 = new Contract(token, ERC20_ABI, this.signer);
    return (await erc20.allowance(this.signer.address, spender)) as bigint;
  }

  async getNativeBalance(address = this.signer.address): Promise<bigint> {
    return this.signer.provider!.getBalance(address);
  }

  async getErc20Balance(
    token: string,
    address = this.signer.address,
  ): Promise<bigint> {
    const erc20 = new Contract(token, ERC20_ABI, this.signer);
    return (await erc20.balanceOf(address)) as bigint;
  }

  async getErc20Decimals(token: string): Promise<number> {
    const erc20 = new Contract(token, ERC20_ABI, this.signer);
    return Number(await erc20.decimals());
  }

  async approveTokenSpend(
    token: string,
    spender: string,
    amount: bigint,
  ): Promise<string> {
    const erc20 = new Contract(token, ERC20_ABI, this.signer);
    const tx = await erc20.approve(spender, amount);
    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error(
        'Approval transaction broadcasted but no receipt was returned',
      );
    }

    return receipt.hash;
  }

  async ensureErc20Allowance(
    token: string,
    spender: string,
    requiredAmount: bigint,
  ): Promise<string | undefined> {
    const allowance = await this.getErc20Allowance(token, spender);
    if (allowance >= requiredAmount) {
      return undefined;
    }

    // Approve max so this token never needs another approval tx.
    return this.approveTokenSpend(token, spender, MaxUint256);
  }

  private async normalizeApprovalAmount(
    token: string,
    amount: string,
  ): Promise<bigint> {
    if (/^\d+$/.test(amount)) {
      return BigInt(amount);
    }

    const decimals = await this.getErc20Decimals(token);
    return parseUnits(amount, decimals);
  }

  async sendPreparedTransaction(
    payload: UnsignedTransactionPayload,
  ): Promise<string> {
    await this.assertConnectedChain();

    const txChainId = Number(payload.chainId);
    if (txChainId !== this.expectedChainId) {
      throw new Error(
        `Prepared transaction chain mismatch: API returned chain ${txChainId}, but the bot is configured for chain ${this.expectedChainId}. Check DREAMDEX_BASE_URL, DREAMDEX_CHAIN_ID, and DREAMDEX_RPC_URL.`,
      );
    }

    const tx = await this.signer.sendTransaction({
      to: payload.to,
      data: payload.data,
      value: BigInt(payload.value),
      chainId: txChainId,
      gasLimit: payload.gasLimit ? BigInt(payload.gasLimit) : undefined,
      nonce: payload.nonce !== undefined ? Number(payload.nonce) : undefined,
    });

    const receipt = await tx.wait();
    if (!receipt) {
      throw new Error('Transaction broadcasted but no receipt was returned');
    }

    return receipt.hash;
  }
}
