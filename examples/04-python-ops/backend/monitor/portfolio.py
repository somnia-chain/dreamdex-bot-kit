# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

# backend/monitor/portfolio.py
"""
Portfolio — tracks live balances by querying the SpotPool vault
and the wallet's ERC-20 USDso balance.

Calls getWithdrawableBalance(user, token) on each pool contract to
read vault deposits. Falls back to wallet ERC-20 balance for total.
"""
import time
import threading
from web3 import Web3
from config import (
    SOMNIA_RPC, MARKETS, USDSO_ADDRESS,
    AGENT_CAPITAL, MANUAL_CAPITAL, TOTAL_CAPITAL, MY_ADDRESS
)

VAULT_ABI = [
    {
        "name": "getWithdrawableBalance",
        "type": "function",
        "stateMutability": "view",
        "inputs": [
            {"name": "user",  "type": "address"},
            {"name": "token", "type": "address"},
        ],
        "outputs": [{"name": "", "type": "uint256"}],
    }
]

ERC20_ABI = [
    {
        "name": "balanceOf",
        "type": "function",
        "stateMutability": "view",
        "inputs": [{"name": "account", "type": "address"}],
        "outputs": [{"name": "", "type": "uint256"}],
    }
]


class Portfolio:
    def __init__(self):
        self.w3    = Web3(Web3.HTTPProvider(SOMNIA_RPC))
        self._lock = threading.Lock()
        self._stats = {
            "agent_balance":  AGENT_CAPITAL,
            "manual_balance": MANUAL_CAPITAL,
            "total_value":    TOTAL_CAPITAL,
            "usdso_wallet":   0.0,
            "usdso_vaults":   {},
        }
        self.running = False

    def start(self):
        # Synchronous first refresh so agent's first tick has on-chain data to
        # gate its capital-floor check against (C2). Without this, the first
        # tick would see last_refresh=0 and hold ("portfolio stale") — fine
        # but noisy.
        try:
            self._refresh()
        except Exception as e:
            print(f"[Portfolio] initial refresh failed: {e}")
        self.running = True
        threading.Thread(target=self._loop, daemon=True).start()
        print("[Portfolio] Started balance tracker")

    def _loop(self):
        while self.running:
            try:
                self._refresh()
            except Exception as e:
                print(f"[Portfolio] refresh error: {e}")
            time.sleep(60)

    def _refresh(self):
        if not self.w3.is_connected():
            print("[Portfolio] RPC not connected, skipping refresh")
            return

        me    = Web3.to_checksum_address(MY_ADDRESS)
        usdso = Web3.to_checksum_address(USDSO_ADDRESS)

        usdso_decimals = 18
        for _mkt in MARKETS.values():
            usdso_decimals = int(_mkt.get("quoteDecimals", 18))
            break

        # Wallet ERC-20 USDso balance
        erc20 = self.w3.eth.contract(address=usdso, abi=ERC20_ABI)
        try:
            wallet_raw = erc20.functions.balanceOf(me).call()
            wallet_usdso = wallet_raw / (10 ** usdso_decimals)
        except Exception as e:
            print(f"[Portfolio] balanceOf error: {e}")
            wallet_usdso = 0.0

        # Vault balances per pool (USDso side — quoteDecimals scaling)
        vault_totals: dict[str, float] = {}
        # Base-token (inventory) balances in the wallet — what the agent
        # has bought but not yet sold back to USDso. The contest leaderboard
        # only sees USDso, so this inventory looks like "loss" to the dashboard
        # unless we surface and value it ourselves.
        wallet_base: dict[str, dict] = {}
        for pair, mkt in MARKETS.items():
            try:
                pool = self.w3.eth.contract(
                    address=Web3.to_checksum_address(mkt["contract"]), abi=VAULT_ABI
                )
                raw = pool.functions.getWithdrawableBalance(me, usdso).call()
                vault_totals[pair] = raw / (10 ** int(mkt.get("quoteDecimals", 18)))
            except Exception:
                vault_totals[pair] = 0.0

            # Read wallet base balance per pair (for non-native pools).
            # Native pools (SOMI) report base via eth_getBalance below.
            base_addr = mkt.get("base")
            base_dec  = int(mkt.get("baseDecimals", 18))
            if mkt.get("native"):
                wallet_base[pair] = {"qty": 0.0, "decimals": base_dec, "address": None}
                continue
            if not base_addr or int(base_addr, 16) == 0:
                wallet_base[pair] = {"qty": 0.0, "decimals": base_dec, "address": None}
                continue
            try:
                erc20_base = self.w3.eth.contract(
                    address=Web3.to_checksum_address(base_addr), abi=ERC20_ABI
                )
                raw_b = erc20_base.functions.balanceOf(me).call()
                wallet_base[pair] = {
                    "qty": raw_b / (10 ** base_dec),
                    "decimals": base_dec,
                    "address": base_addr,
                }
            except Exception:
                wallet_base[pair] = {"qty": 0.0, "decimals": base_dec, "address": base_addr}

        total_vault = sum(vault_totals.values())

        # Native gas-token balance.
        try:
            native_wei = self.w3.eth.get_balance(me)
            native_balance = native_wei / 1e18
        except Exception:
            native_balance = 0.0

        # The native pool's base lives in native_balance directly.
        for pair, mkt in MARKETS.items():
            if mkt.get("native"):
                wallet_base[pair]["qty"] = native_balance
                break

        # All-buckets internal valuation. This is what the dashboard should
        # show as PnL — NOT the leaderboard's wallet-only number, which
        # under-reports value while inventory is mid-cycle. Mid-prices come
        # from server.py at read time; the Portfolio just exposes raw qty.
        with self._lock:
            self._stats = {
                "agent_balance":  wallet_usdso + total_vault,
                "manual_balance": MANUAL_CAPITAL,
                "total_value":    wallet_usdso + total_vault,  # dashboard recomputes with base inventory
                "usdso_wallet":   wallet_usdso,
                "usdso_vaults":   vault_totals,
                "native_balance": native_balance,
                "wallet_base":    wallet_base,   # per-pair {qty, decimals, address}
                "last_refresh":   time.time(),
            }

    def summary(self) -> dict:
        with self._lock:
            return dict(self._stats)
