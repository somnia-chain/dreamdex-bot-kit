---
name: somnia
description: >-
  Reference for the Somnia blockchain — an EVM-compatible high-performance L1.
  Use when connecting to Somnia, configuring an RPC/chain ID, reasoning about
  the native SOMI gas token, USDso, or deploying/reading contracts on Somnia
  mainnet or the Shannon testnet.
---

# Somnia

Somnia is an EVM-compatible, high-performance Layer 1. Everything works like
Ethereum (same JSON-RPC, same tooling — viem, ethers, web3.py, Foundry, Hardhat),
so build as you would for any EVM chain and just point it at the right network.

## Networks

| Network | chainId | RPC | Explorer |
| --- | --- | --- | --- |
| **Mainnet** | `5031` | `https://api.infra.mainnet.somnia.network` | `https://explorer.somnia.network` |
| **Shannon Testnet** | `50312` | `https://dream-rpc.somnia.network` | `https://shannon-explorer.somnia.network` |

Always develop and test on **testnet first**, then switch the network for mainnet.

## The gas token: native SOMI

- The chain's native/gas token is **SOMI** — it pays for gas, exactly like ETH on
  Ethereum. Keep a SOMI balance in any account that sends transactions.
- SOMI has **no ERC-20 contract**. When a protocol needs to reference "native" as
  a token address, it uses a sentinel, **not** `address(0)`. On DreamDEX that
  sentinel is `0x28f34DeFd2b4CB48d9eE6d89f2Be4Bc601694c00`. Read a native balance
  with the standard RPC `eth_getBalance`, not an ERC-20 `balanceOf`.
- Operations that deliver native SOMI to a recipient can need a **higher gas
  limit** than a plain ERC-20 transfer (the payout path runs a gas-headroom
  guard). If a native-delivering call reverts, raise the gas limit and re-simulate
  at the same limit you broadcast.

## Tokens & decimals

Never hard-code token decimals — read them from the contract/API. On Somnia,
notably **USDso (the DreamDEX quote stablecoin) is 18 decimals**, not the
6-decimal USDC convention. Assuming 6 will misprice everything by 10^12.

## Signing / SIWE

If a Somnia dApp uses Sign-In With Ethereum (SIWE), the `Chain ID` in the signed
message **must match the network** you're transacting on (`5031` mainnet /
`50312` testnet). A mismatch causes intermittent auth failures.

## Building on Somnia

Because it's EVM-equivalent, standard workflows apply:

- **Wallets / RPC:** add the network above to MetaMask, viem, ethers, or web3.py.
- **Contracts:** deploy with Foundry or Hardhat targeting the Somnia RPC.
- **Reads/events:** `eth_call`, logs, and topic filters behave as on Ethereum.

For trading on **DreamDEX** (Somnia's on-chain CLOB) specifically, use the
companion **`dreamdex-bot`** skill in this repo — it covers the exchange contract
surface, the DreamDEX-specific gotchas, and the bot toolkit.
