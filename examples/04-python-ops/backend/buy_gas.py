#!/usr/bin/env python3
# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
buy_gas.py — top up native SOMI gas by swapping USDso → SOMI on the SOMI:USDso
pool (IOC, wallet-funded, delivers native SOMI to the wallet). If the wallet is
short on USDso, first sells a little USDC.e to raise it.

Run with the burst PAUSED (it shares the wallet nonce).

ENV:
  MAINNET_PRIVATE_KEY  signer (read from container env)
  GAS_BUY_USD          USDso to spend on SOMI (default 1.0)
"""
import os, sys, time
sys.path.insert(0, "/app")
from web3 import Web3
from eth_account import Account
from config import MARKETS, SOMNIA_RPC, CHAIN_ID

BUY_USD = float(os.environ.get("GAS_BUY_USD", "1.0"))
KEY = os.environ["MAINNET_PRIVATE_KEY"]
acct = Account.from_key(KEY)
w3 = Web3(Web3.HTTPProvider(SOMNIA_RPC, request_kwargs={"timeout": 20}))

POOL_ABI = [
    {"inputs":[{"name":"isBid","type":"bool"},{"name":"userData","type":"uint64"},
        {"name":"price","type":"uint256"},{"name":"quantity","type":"uint256"},
        {"name":"expireTimestampNs","type":"uint64"},{"name":"orderType","type":"uint8"},
        {"name":"selfMatchingOption","type":"uint8"},{"name":"builder","type":"address"},
        {"name":"builderFeeBpsTimes1k","type":"uint96"}],
     "name":"placeTakerOrderWithoutVault","outputs":[{"name":"s","type":"bool"},{"name":"o","type":"uint128"}],
     "stateMutability":"payable","type":"function"},
    {"inputs":[],"name":"getPoolParams","outputs":[{"name":"b","type":"address"},{"name":"q","type":"address"},
        {"name":"mf","type":"uint256"},{"name":"tf","type":"uint256"},{"name":"tick","type":"uint256"},
        {"name":"minq","type":"uint256"},{"name":"lot","type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"name":"isBid","type":"bool"},{"name":"n","type":"uint64"}],"name":"getBookLevels",
     "outputs":[{"components":[{"name":"price","type":"uint256"},{"name":"quantity","type":"uint256"}],
        "name":"","type":"tuple[]"}],"stateMutability":"view","type":"function"},
]
ERC20 = [
    {"inputs":[{"name":"s","type":"address"},{"name":"a","type":"uint256"}],"name":"approve",
     "outputs":[{"type":"bool"}],"stateMutability":"nonpayable","type":"function"},
    {"inputs":[{"name":"o","type":"address"},{"name":"s","type":"address"}],"name":"allowance",
     "outputs":[{"type":"uint256"}],"stateMutability":"view","type":"function"},
    {"inputs":[{"name":"a","type":"address"}],"name":"balanceOf","outputs":[{"type":"uint256"}],
     "stateMutability":"view","type":"function"},
]


def fetch(pool):
    p = pool.functions.getPoolParams().call()
    return p[4], p[5], p[6]  # tick, minq, lot


def top(pool, is_bid):
    lv = pool.functions.getBookLevels(is_bid, 1).call()
    return lv[0][0] if lv else 0


def approve_if_needed(token, spender, label):
    c = w3.eth.contract(address=token, abi=ERC20)
    if c.functions.allowance(acct.address, spender).call() >= 2**128:
        return
    n = w3.eth.get_transaction_count(acct.address, "pending")
    tx = c.functions.approve(spender, 2**256-1).build_transaction(
        {"from": acct.address, "nonce": n, "gas": 2_000_000, "gasPrice": w3.eth.gas_price, "chainId": CHAIN_ID})
    h = w3.eth.send_raw_transaction(w3.eth.account.sign_transaction(tx, KEY).raw_transaction)
    w3.eth.wait_for_transaction_receipt(h, timeout=90)
    print(f"[approve/{label}] done")


def ioc(pool_addr, is_bid, price_raw, qty_raw, value=0):
    pc = w3.eth.contract(address=pool_addr, abi=POOL_ABI)
    expire = (int(time.time())+3600)*1_000_000_000
    n = w3.eth.get_transaction_count(acct.address, "pending")
    tx = pc.functions.placeTakerOrderWithoutVault(
        bool(is_bid), 0, int(price_raw), int(qty_raw), expire, 2, 1,
        "0x0000000000000000000000000000000000000000", 0).build_transaction(
        {"from": acct.address, "nonce": n, "gas": 2_000_000, "gasPrice": w3.eth.gas_price,
         "chainId": CHAIN_ID, "value": value})
    h = w3.eth.send_raw_transaction(w3.eth.account.sign_transaction(tx, KEY).raw_transaction)
    r = w3.eth.wait_for_transaction_receipt(h, timeout=90)
    return r.status, h.hex()


def usdso_bal():
    q = Web3.to_checksum_address(MARKETS["SOMI:USDso"]["quote"])
    return w3.eth.contract(address=q, abi=ERC20).functions.balanceOf(acct.address).call() / 1e18


def main():
    somi0 = w3.eth.get_balance(acct.address) / 1e18
    print(f"signer={acct.address} SOMI before={somi0:.4f} USDso={usdso_bal():.4f} buy=${BUY_USD}")

    # 1) Ensure enough USDso. If short, sell a little USDC.e.
    need = BUY_USD + 0.05
    if usdso_bal() < need:
        uc = MARKETS["USDC.e:USDso"]
        pool = Web3.to_checksum_address(uc["contract"])
        pc = w3.eth.contract(address=pool, abi=POOL_ABI)
        tick, minq, lot = fetch(pc)
        base = Web3.to_checksum_address(uc["base"])
        approve_if_needed(base, pool, "USDC.e")
        bid = top(pc, True)
        # sell ~$2 USDC.e (>= minQty) at bid-3tick
        qty = max(minq, int(2 * 10**6))  # USDC.e 6dec, ~$2
        qty = (qty // lot) * lot
        st, hx = ioc(pool, False, max(bid - 3*tick, tick), qty)
        print(f"[raise-usdso] sold ~$2 USDC.e status={st} {hx[:14]}")
        time.sleep(3)

    # 2) Buy SOMI with USDso on SOMI:USDso (native base delivered to wallet).
    sm = MARKETS["SOMI:USDso"]
    pool = Web3.to_checksum_address(sm["contract"])
    pc = w3.eth.contract(address=pool, abi=POOL_ABI)
    tick, minq, lot = fetch(pc)
    quote = Web3.to_checksum_address(sm["quote"])
    approve_if_needed(quote, pool, "USDso")
    ask = top(pc, False)
    if ask == 0:
        print("no ask on SOMI pool; abort"); return
    price = ask + 3*tick
    # qty SOMI to acquire ≈ BUY_USD / price
    qty = int((BUY_USD / (price/1e18)) * 1e18)
    qty = (qty // lot) * lot
    if qty < minq:
        qty = minq
    st, hx = ioc(pool, True, price, qty)
    print(f"[buy-somi] BUY {qty/1e18:.4f} SOMI @ {price/1e18:.5f} status={st} {hx[:14]}")
    time.sleep(4)
    somi1 = w3.eth.get_balance(acct.address) / 1e18
    print(f"SOMI after={somi1:.4f} (gained {somi1-somi0:+.4f})  USDso={usdso_bal():.4f}")


if __name__ == "__main__":
    main()
