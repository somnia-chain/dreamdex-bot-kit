# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Non-destructive smoke test against testnet. Reads only — no orders broadcast."""
import os, json, traceback

os.environ.setdefault("DREAMDEX_ENV", "testnet")

def line(s): print(f"\n--- {s} ---")

def main():
    line("1. Import config")
    from config import ENV, CHAIN_ID, SOMNIA_RPC, DREAMDEX_HTTP, MY_ADDRESS, MARKETS, PRIVATE_KEY
    print(f"ENV={ENV} CHAIN_ID={CHAIN_ID}")
    print(f"RPC={SOMNIA_RPC}")
    print(f"API={DREAMDEX_HTTP}")
    print(f"WALLET={MY_ADDRESS}  key_set={bool(PRIVATE_KEY)}")
    print(f"Pairs: {list(MARKETS.keys())}")

    line("2. RPC connectivity")
    from web3 import Web3
    w3 = Web3(Web3.HTTPProvider(SOMNIA_RPC))
    print(f"connected={w3.is_connected()}  chainId={w3.eth.chain_id}  block={w3.eth.block_number}")
    print(f"native STT balance: {w3.eth.get_balance(MY_ADDRESS)/1e18:.6f}")

    line("3. /v0/markets discovery (Fix 2+3)")
    from trading.dreamdex import DreamDEX
    try:
        dex = DreamDEX()
    except Exception as e:
        print(f"DreamDEX init failed: {e}")
        traceback.print_exc()
        return
    for sym, m in MARKETS.items():
        print(f"  {sym}: base={m.get('base')} baseDec={m.get('baseDecimals')} "
              f"tick={m.get('tickSize','-')} lot={m.get('lotSize','-')} min={m.get('minQuantity','-')}")

    line("4. Public tickers")
    for sym in MARKETS:
        t = dex.get_ticker(sym)
        if t:
            syms = t.get("symbols") if isinstance(t, dict) else None
            row = (syms[0] if syms else t) if isinstance(syms, list) else t
            print(f"  {sym}: close={row.get('close')} high={row.get('high')} low={row.get('low')}")
        else:
            print(f"  {sym}: <empty>")

    line("5. Recent trades")
    for sym in MARKETS:
        tr = dex.get_recent_trades(sym, limit=1)
        if isinstance(tr, dict):
            tr = tr.get("trades", [])
        print(f"  {sym}: {tr[:1] if tr else '<none>'}")

    line("6. SIWE login (Fix 5 — will print body if it fails)")
    if not PRIVATE_KEY:
        print("  SKIPPED — no PRIVATE_KEY set")
    else:
        try:
            dex._ensure_auth()
            print(f"  ✓ JWT obtained, expires_ts={dex._token_expiry}")
        except Exception as e:
            print(f"  login failed: {e}")

    line("7. Vault withdrawable balance (read-only contract call)")
    try:
        from web3 import Web3
        for sym, mkt in MARKETS.items():
            pool = w3.eth.contract(
                address=Web3.to_checksum_address(mkt["contract"]),
                abi=[{"name":"getWithdrawableBalance","type":"function","stateMutability":"view",
                      "inputs":[{"name":"u","type":"address"},{"name":"t","type":"address"}],
                      "outputs":[{"name":"","type":"uint256"}]}])
            quote_addr = Web3.to_checksum_address(mkt["quote"])
            try:
                bal = pool.functions.getWithdrawableBalance(MY_ADDRESS, quote_addr).call()
                print(f"  {sym} USDso vault bal: {bal/10**mkt['quoteDecimals']:.6f}")
            except Exception as e:
                print(f"  {sym} vault read err: {e}")
    except Exception as e:
        print(f"vault block err: {e}")

    line("8. Agent decision (no execution)")
    try:
        from agent.brain import decide
        # minimal context — exercises rule-based fallback if no OPENAI_KEY
        prices = {sym: {"mid": 1.0, "history": []} for sym in MARKETS}
        d = decide(prices, {}, {"usdso": 30.0, "weth":0,"wbtc":0,"somi":0,"total":30.0}, [], {"my_rank":"?","total":0,"my_tx":0,"third_tx":0,"gap":0,"signal":"MAINTAIN"})
        print(f"  decision: {json.dumps(d)}")
    except Exception as e:
        print(f"  decide() err: {e}")

    print("\n=== smoke test done — no transactions broadcast ===")

if __name__ == "__main__":
    main()
