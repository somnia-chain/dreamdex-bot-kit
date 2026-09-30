# Advanced: batching actions with EIP-7702

> **This is a technique demo, not a trading strategy.** It shows *how* to use EIP-7702 to batch
> several on-chain actions into a single transaction on DreamDEX — nothing here decides *what* to
> trade. Use the pattern to compose your own strategy's actions atomically; don't run it as a bot
> on its own.

The example it uses to demonstrate the technique is a **buy → sell round-trip in a single
transaction**: two fills per tx, one signature, one gas payment, inventory back to flat. The same
batching approach applies to any multi-step action you want to make atomic (e.g. approve + place,
or place + place across pairs).

## How it works

[EIP-7702](https://eips.ethereum.org/EIPS/eip-7702) lets an EOA adopt a contract's code. The
delegation is **not** scoped to one transaction: it stays on the account until the account signs
another authorization, and while it is there the account answers calls from anyone. So we:

1. **Delegate** the wallet to the [`DreamDexVolumeBatch7702`](contracts/DreamDexVolumeBatch7702.sol)
   implementation (sign an authorization).
2. **Call `atomicRoundTrip` on our own address** in a type-4 transaction. Because the EOA now runs
   the implementation's code, `address(this)` is the wallet itself — so, inside that one call, the
   wallet IOC-buys (the pool auto-pulls quote and auto-delivers the base back to us) and then
   IOC-sells **exactly the base it just received** (measured by balance delta, which handles
   partial fills). Uses the modern wallet auto-pull model — no vault step.
3. **Clear the delegation** by authorizing the zero address, whether or not the round-trip
   succeeded, so the wallet goes back to being a plain EOA.

## Safety

A delegated account runs the implementation's code for **every** call it receives, from anyone, for
as long as the delegation is installed. Two consequences this example takes seriously:

- `atomicRoundTrip` only accepts calls where `msg.sender == address(this)`, which under delegation
  means the wallet calling itself. A stranger's call reverts.
- The script clears the delegation at the end of every run, and each token approval is taken back
  in the same transaction that granted it, so nothing is left standing afterwards.

Check any wallet with `cast code <address>`: an empty result is a plain EOA, and a result starting
with `0xef0100` is a live delegation, followed by the implementation address. If a wallet of yours
still carries one from an earlier run of this example, clear it:

```bash
npm run clear -w batch-7702   # PRIVATE_KEY in .env, authorizes the zero address
```

If that wallet also has leftover token approvals from an older version, set them back to zero from
the wallet itself.

## Run

The script compiles the contract (via `solc`), deploys it once if needed, and runs the delegated
round-trip — no Foundry required.

```bash
npm install
cp .env.example .env         # set PRIVATE_KEY, NETWORK; leave IMPL_ADDRESS blank to auto-deploy
npm run start -w batch-7702
```

On the first run it prints the deployed implementation address and a tip to set `IMPL_ADDRESS` so
subsequent runs skip the deploy.

```
[7702] contract compiled OK ...
[7702] deployed at 0x…  (tx 0x…)
[7702] tx 0x… — waiting for receipt…
[7702] status=success gasUsed=… logs=13     ← logs>0 means the round-trip actually ran
[7702] cleared delegation 0x… from 0x… (tx 0x…)
```

## The one subtlety that will bite you

When the account that signs the authorization **also sends** the transaction (self-sponsored),
the authorization must be signed at **nonce + 1**, because the transaction itself consumes the
current nonce. In viem this is `signAuthorization({ …, executor: "self" })`. Without it, the
delegation is silently invalid: the transaction **succeeds but emits no logs** and the contract
code never runs (`logs=0`). This script sets `executor: "self"` — see the comment in
[`src/index.ts`](src/index.ts).

## Notes & caveats

- **ERC-20 pair only.** The runnable example targets `USDC.e:USDso`. Keep it on a pegged pair so
  each round-trip is near flat (it still crosses the real book, so you pay the spread twice —
  volume, not profit).
- **Gas.** Default `BATCH_GAS_LIMIT` is `6,000,000`. An atomic buy+sell uses ~2.3M.
- **7702 support** is recent — this example confirms Somnia accepts type-4 transactions. Make sure
  your viem version (≥ 2.30) and node support them.
- Verified live on Somnia mainnet: one type-4 tx, a buy and a sell fill, wallet back to flat.
- Test on testnet before mainnet.
