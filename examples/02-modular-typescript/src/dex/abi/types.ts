/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

import type { ethers } from "ethers";

export interface SpotPoolMethods {
  placeOrder: ethers.BaseContractMethod<
    [
      boolean,
      bigint,
      bigint,
      bigint,
      bigint,
      number,
      number,
      string,
      bigint,
    ],
    [boolean, bigint],
    ethers.ContractTransactionResponse
  >;
  placeTakerOrderWithoutVault: ethers.BaseContractMethod<
    [
      boolean,
      bigint,
      bigint,
      bigint,
      bigint,
      number,
      number,
      string,
      bigint,
    ],
    [boolean, bigint],
    ethers.ContractTransactionResponse
  >;
  cancelOrder: ethers.BaseContractMethod<
    [bigint],
    void,
    ethers.ContractTransactionResponse
  >;
  deposit: ethers.BaseContractMethod<
    [string, bigint],
    void,
    ethers.ContractTransactionResponse
  >;
  depositNative: ethers.BaseContractMethod<
    [],
    void,
    ethers.ContractTransactionResponse
  >;
  withdraw: ethers.BaseContractMethod<
    [string, bigint],
    void,
    ethers.ContractTransactionResponse
  >;
  approve: ethers.BaseContractMethod<
    [string, bigint],
    void,
    ethers.ContractTransactionResponse
  >;
  getPoolParams: ethers.BaseContractMethod<
    [],
    [string, string, bigint, bigint, bigint, bigint, bigint],
    [string, string, bigint, bigint, bigint, bigint, bigint]
  >;
  getBookLevels: ethers.BaseContractMethod<
    [boolean, number],
    [bigint[], bigint[]],
    [bigint[], bigint[]]
  >;
  getOwnOpenOrders: ethers.BaseContractMethod<[string], bigint[], bigint[]>;
  getWithdrawableBalance: ethers.BaseContractMethod<
    [string, string],
    bigint,
    bigint
  >;
}

export type SpotPoolContract = ethers.Contract & SpotPoolMethods;

export interface Erc20Methods {
  name: ethers.BaseContractMethod<[], string, string>;
  symbol: ethers.BaseContractMethod<[], string, string>;
  decimals: ethers.BaseContractMethod<[], bigint, bigint>;
  balanceOf: ethers.BaseContractMethod<[string], bigint, bigint>;
  allowance: ethers.BaseContractMethod<[string, string], bigint, bigint>;
  approve: ethers.BaseContractMethod<
    [string, bigint],
    boolean,
    ethers.ContractTransactionResponse
  >;
  transfer: ethers.BaseContractMethod<
    [string, bigint],
    boolean,
    ethers.ContractTransactionResponse
  >;
}

export type Erc20Contract = ethers.Contract & Erc20Methods;
