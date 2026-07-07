# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

import asyncio
import json
import logging
import os
import random
import time
from datetime import datetime, timezone
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Dict, List, Optional, Tuple

import requests
from eth_account import Account
from eth_account.messages import encode_defunct
from web3 import Web3
from web3.exceptions import ContractCustomError

logger = logging.getLogger(__name__)


NATIVE_TOKEN = Web3.to_checksum_address("0x28f34DeFd2b4CB48d9eE6d89f2Be4Bc601694c00")
ZERO_ADDRESS = Web3.to_checksum_address("0x0000000000000000000000000000000000000000")

# On-chain OrderType enum
ORDER_NORMAL = 0
ORDER_FOK = 1
ORDER_IOC = 2
ORDER_POST_ONLY = 3

ORDER_TYPE_API = {
    ORDER_NORMAL: "normalOrder",
    ORDER_FOK: "fillOrKill",
    ORDER_IOC: "immediateOrCancel",
    ORDER_POST_ONLY: "postOnly",
}
ORDER_TYPE_ON_CHAIN = {value: key for key, value in ORDER_TYPE_API.items()}

NATIVE_BASE_BUY_GAS = 5_000_000


POOL_ABI = [
    {
        "inputs": [
            {"internalType": "bool", "name": "isBid", "type": "bool"},
            {"internalType": "uint64", "name": "userData", "type": "uint64"},
            {"internalType": "uint256", "name": "price", "type": "uint256"},
            {"internalType": "uint256", "name": "quantity", "type": "uint256"},
            {"internalType": "uint64", "name": "expireTimestampNs", "type": "uint64"},
            {"internalType": "uint8", "name": "orderType", "type": "uint8"},
            {"internalType": "uint8", "name": "selfMatchingOption", "type": "uint8"},
            {"internalType": "address", "name": "builder", "type": "address"},
            {"internalType": "uint96", "name": "builderFeeBpsTimes1k", "type": "uint96"},
        ],
        "name": "placeOrder",
        "outputs": [
            {"internalType": "bool", "name": "success", "type": "bool"},
            {"internalType": "uint128", "name": "orderId", "type": "uint128"},
        ],
        "stateMutability": "payable",
        "type": "function",
    },
    {
        "inputs": [
            {"internalType": "address", "name": "owner", "type": "address"},
            {"internalType": "bool", "name": "isBid", "type": "bool"},
            {"internalType": "uint256", "name": "price", "type": "uint256"},
            {"internalType": "uint256", "name": "quantity", "type": "uint256"},
            {"internalType": "uint96", "name": "builderFeeBpsTimes1k", "type": "uint96"},
        ],
        "name": "getAutoPullRequirement",
        "outputs": [
            {"internalType": "address", "name": "inputToken", "type": "address"},
            {"internalType": "uint256", "name": "requiredAmount", "type": "uint256"},
            {"internalType": "uint256", "name": "delta", "type": "uint256"},
        ],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "getPoolParams",
        "outputs": [
            {"internalType": "address", "name": "baseToken_", "type": "address"},
            {"internalType": "address", "name": "quoteToken_", "type": "address"},
            {"internalType": "uint256", "name": "makerFeeBpsTimes1k_", "type": "uint256"},
            {"internalType": "uint256", "name": "takerFeeBpsTimes1k_", "type": "uint256"},
            {"internalType": "uint256", "name": "tickSize_", "type": "uint256"},
            {"internalType": "uint256", "name": "minQuantity_", "type": "uint256"},
            {"internalType": "uint256", "name": "lotSize_", "type": "uint256"},
        ],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {"internalType": "bool", "name": "isBid", "type": "bool"},
            {"internalType": "uint64", "name": "numLevels", "type": "uint64"},
        ],
        "name": "getBookLevels",
        "outputs": [
            {
                "components": [
                    {"internalType": "uint256", "name": "price", "type": "uint256"},
                    {"internalType": "uint256", "name": "quantity", "type": "uint256"},
                ],
                "internalType": "struct OrderBookLevel[]",
                "name": "",
                "type": "tuple[]",
            }
        ],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {"internalType": "uint256", "name": "baseQuantity", "type": "uint256"},
            {"internalType": "uint256", "name": "priceQuote", "type": "uint256"},
        ],
        "name": "convertToQuoteAtPriceCeil",
        "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
]

ROUTER_ABI = [
    {
        "inputs": [
            {"internalType": "tuple[]", "name": "route", "type": "tuple[]"},
            {"internalType": "address", "name": "inputToken", "type": "address"},
            {"internalType": "uint256", "name": "inputAmount", "type": "uint256"},
        ],
        "name": "quoteMarketExactIn",
        "outputs": [
            {"internalType": "bool", "name": "ok", "type": "bool"},
            {"internalType": "uint256", "name": "amountIn", "type": "uint256"},
            {"internalType": "uint256", "name": "amountOut", "type": "uint256"},
            {"internalType": "tuple[]", "name": "legs", "type": "tuple[]"},
        ],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {"internalType": "tuple[]", "name": "route", "type": "tuple[]"},
            {"internalType": "address", "name": "inputToken", "type": "address"},
            {"internalType": "address", "name": "outputToken", "type": "address"},
            {"internalType": "uint256", "name": "outputAmount", "type": "uint256"},
        ],
        "name": "quoteExactOut",
        "outputs": [
            {"internalType": "bool", "name": "ok", "type": "bool"},
            {"internalType": "uint256", "name": "amountIn", "type": "uint256"},
            {"internalType": "uint256", "name": "amountOut", "type": "uint256"},
            {"internalType": "tuple[]", "name": "legs", "type": "tuple[]"},
        ],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [
            {
                "components": [
                    {"internalType": "address", "name": "inputToken", "type": "address"},
                    {"internalType": "uint256", "name": "inputAmount", "type": "uint256"},
                    {"internalType": "address", "name": "outputToken", "type": "address"},
                    {"internalType": "uint256", "name": "minOutputAmount", "type": "uint256"},
                    {"internalType": "tuple[]", "name": "route", "type": "tuple[]"},
                    {"internalType": "uint64", "name": "deadlineNs", "type": "uint64"},
                ],
                "internalType": "struct ISpotRouter.SwapExactInParams",
                "name": "params",
                "type": "tuple",
            }
        ],
        "name": "swapExactIn",
        "outputs": [
            {"internalType": "uint256", "name": "amountOut", "type": "uint256"},
            {"internalType": "uint256", "name": "amountInUsed", "type": "uint256"},
        ],
        "stateMutability": "payable",
        "type": "function",
    },
    {
        "inputs": [
            {
                "components": [
                    {"internalType": "address", "name": "inputToken", "type": "address"},
                    {"internalType": "uint256", "name": "maxInputAmount", "type": "uint256"},
                    {"internalType": "address", "name": "outputToken", "type": "address"},
                    {"internalType": "uint256", "name": "outputAmount", "type": "uint256"},
                    {"internalType": "tuple[]", "name": "route", "type": "tuple[]"},
                    {"internalType": "uint64", "name": "deadlineNs", "type": "uint64"},
                ],
                "internalType": "struct ISpotRouter.SwapExactOutParams",
                "name": "params",
                "type": "tuple",
            }
        ],
        "name": "swapExactOut",
        "outputs": [
            {"internalType": "uint256", "name": "amountIn", "type": "uint256"},
            {"internalType": "uint256", "name": "amountOutReceived", "type": "uint256"},
        ],
        "stateMutability": "payable",
        "type": "function",
    },
]


ERC20_ABI = [
    {
        "inputs": [
            {"internalType": "address", "name": "spender", "type": "address"},
            {"internalType": "uint256", "name": "amount", "type": "uint256"},
        ],
        "name": "approve",
        "outputs": [{"internalType": "bool", "name": "", "type": "bool"}],
        "stateMutability": "nonpayable",
        "type": "function",
    },
    {
        "inputs": [
            {"internalType": "address", "name": "owner", "type": "address"},
            {"internalType": "address", "name": "spender", "type": "address"},
        ],
        "name": "allowance",
        "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [{"internalType": "address", "name": "account", "type": "address"}],
        "name": "balanceOf",
        "outputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "stateMutability": "view",
        "type": "function",
    },
    {
        "inputs": [],
        "name": "decimals",
        "outputs": [{"internalType": "uint8", "name": "", "type": "uint8"}],
        "stateMutability": "view",
        "type": "function",
    },
]


@dataclass
class Market:
    symbol: str
    pool: str
    base: str
    quote: str
    base_code: str
    quote_code: str
    base_decimals: int
    quote_decimals: int
    taker_fee_bps_times1k: int
    tick_size: int
    min_quantity: int
    lot_size: int
    base_is_native: bool
    quote_is_native: bool


class LiveDreamDexBot:
    def __init__(self, cfg: Dict[str, Any]):
        self.cfg = cfg
        self.rpc_url = cfg["rpc_url"]
        self.market_data_base = cfg.get("market_data_base", "https://api.dreamdex.io")
        self.private_key = os.getenv(cfg.get("private_key_env", "PRIVATE_KEY"))
        if not self.private_key:
            raise ValueError("Missing private key environment variable")

        self.account = Account.from_key(self.private_key)
        self.address = self.account.address
        self.web3 = Web3(Web3.HTTPProvider(self.rpc_url, request_kwargs={"timeout": 30}))
        if not self.web3.is_connected():
            raise RuntimeError(f"Cannot connect to RPC: {self.rpc_url}")

        self.native_token = Web3.to_checksum_address(cfg.get("native_token", NATIVE_TOKEN))
        self.pool_address_override = cfg.get("pool_address")
        self.max_orders = cfg.get("max_orders")
        self.min_input = Decimal(str(cfg.get("min_input", "0.01")))
        self.max_input = Decimal(str(cfg.get("max_input", "0.05")))
        # High-turnover mode: larger per-order size, fewer transactions
        self.volume_mode = bool(cfg.get("volume_mode", False))
        self.bulk_mode = bool(cfg.get("bulk_mode", False))
        self.bulk_multiplier = int(cfg.get("bulk_multiplier", 5))
        self.use_fok_for_bulk = bool(cfg.get("use_fok_for_bulk", False))
        self.trade_fraction = float(cfg.get("trade_fraction", 0.90))
        self.reserve_quote_fraction = float(cfg.get("reserve_quote_fraction", 0.05))
        self.reserve_native_wei = int(cfg.get("reserve_native_wei", 50_000_000_000_000_000))
        self.volume_target_quote_raw = cfg.get("volume_target_quote_raw")
        self.freq_sec = float(cfg.get("freq_sec", 18 if self.volume_mode else 10))
        self.min_loop_sec = float(cfg.get("min_loop_sec", 3 if self.volume_mode else self.freq_sec))
        self.slippage_bps = int(cfg.get("slippage_bps", 50))
        self.deadline_sec = int(cfg.get("deadline_sec", 120))
        self.only_buy = bool(cfg.get("only_buy", False))
        self.only_sell = bool(cfg.get("only_sell", False))
        self.metrics_path = cfg.get("metrics_path", "metrics.json")
        self.state_path = cfg.get("state_path", "bot_state.json")
        self.max_approval = int(cfg.get("max_approval", 2**256 - 1))
        self.priority_fee_gwei = cfg.get("priority_fee_gwei", 1)
        self.native_base_buy_gas = int(cfg.get("native_base_buy_gas", NATIVE_BASE_BUY_GAS))
        # Cancelling a native maker order needs a high gas LIMIT (the pool checks
        # gasleft() on the auto-pull refund path); standard estimate reverts with
        # custom error 0x782b2567. Hard-code a safe budget. See docs/INCIDENT-*.md.
        self.cancel_gas = int(cfg.get("cancel_gas", 6_000_000))
        self.funding_source_maker = str(cfg.get("funding_source_maker", "wallet"))
        self.funding_source_taker = str(cfg.get("funding_source_taker", "wallet"))
        self.vault_enabled = bool(cfg.get("vault_enabled", False))
        self.vault_deposit_usdso = float(cfg.get("vault_deposit_usdso", 0))
        self.vault_market = str(cfg.get("vault_market", "WETH:USDso"))
        self.vault_auto_topup = bool(cfg.get("vault_auto_topup", True))
        self.vault_topup_interval_sec = float(cfg.get("vault_topup_interval_sec", 120))
        self.vault_target_usdso = float(cfg.get("vault_target_usdso", 50))
        self.vault_target_weth = float(cfg.get("vault_target_weth", 0.003))
        self.vault_wallet_reserve_usdso = float(cfg.get("vault_wallet_reserve_usdso", 10))
        self.vault_min_deposit_usdso = float(cfg.get("vault_min_deposit_usdso", 2))
        self._last_vault_topup_ts = 0.0
        self.dry_run = bool(cfg.get("dry_run", False))
        self.use_websocket = bool(cfg.get("use_websocket", True))
        self.max_drawdown_pct = float(cfg.get("max_drawdown_pct", 0.15))
        self.drawdown_stop = bool(cfg.get("drawdown_stop", True))
        self.strategy_name = str(cfg.get("strategy", "taker"))
        self.order_type_default = str(cfg.get("order_type_rebalance", "immediateOrCancel"))
        # Builder codes not supported in v1.0 - must be zero
        self.builder = ZERO_ADDRESS
        self.builder_fee_bps_times1k = 0
        self._api_token: Optional[str] = None
        self._api_token_expires_at_ms: int = 0
        self._ws_book = None
        self._ws_multi_book = None
        self._price_ref = None  # external global price reference (Binance), set by strategy
        self._initial_portfolio_quote_raw: Optional[int] = None
        self._last_trades_since_ms: int = 0

        self.metrics = {
            "orders": 0,
            "volume_in_raw": 0,
            "volume_out_raw": 0,
            "errors": 0,
            "api_volume_quote_raw": 0,
            "pnl_quote_raw": 0,
            "last_activity_at": 0,
        }
        self._load_metrics()
        self._load_state()
        self._currency_codes = self._load_currency_codes()
        self.watch_symbols = self._resolve_watch_symbols()
        self.markets_registry: Dict[str, Market] = {}
        self.pools_registry: Dict[str, Any] = {}
        self._load_markets_registry()
        initial_symbol = self.cfg.get("market_symbol") or self.watch_symbols[0]
        if initial_symbol.upper() not in {s.upper() for s in self.markets_registry}:
            initial_symbol = self.watch_symbols[0]
        self._set_active_market(initial_symbol, update_ws=False)
        if cfg.get("use_router"):
            raise RuntimeError("Router flow is disabled; this bot uses direct pool taker orders only")

        native_balance = self.web3.eth.get_balance(self.address)
        if self.market.base_is_native and native_balance == 0:
            raise RuntimeError(f"Wallet {self.address} has zero native balance; cannot trade native market")
        if native_balance < self.reserve_native_wei:
            logger.warning(
                f"Low native (gas) balance: {native_balance} wei "
                f"(reserve {self.reserve_native_wei})"
            )

        mode = "high_turnover" if self.volume_mode else "standard"
        logger.info(
            f"Bot initialized: wallet={self.address}, markets={list(self.markets_registry.keys())}, "
            f"active={self.market.symbol}, strategy={self.strategy_name}, mode={mode}"
        )
        self._initial_portfolio_quote_raw = self._resolve_initial_portfolio_raw()

    def _resolve_initial_portfolio_raw(self) -> int:
        fixed_usdso = self.cfg.get("competition_initial_usdso")
        if fixed_usdso is not None:
            quote_decimals = next(iter(self.markets_registry.values())).quote_decimals
            baseline = int(Decimal(str(fixed_usdso)) * (Decimal(10) ** quote_decimals))
            logger.info(f"Competition PnL baseline: {fixed_usdso} USDso (leaderboard starting capital)")
            return baseline
        return self._portfolio_value_usdso_all()

    def _fetch_json(self, path: str) -> Dict[str, Any]:
        url = f"{self.market_data_base.rstrip('/')}{path}"
        response = requests.get(url, timeout=30)
        response.raise_for_status()
        return response.json()

    def _api_request(self, method: str, path: str, body: Optional[Dict[str, Any]] = None, auth: bool = True) -> Any:
        url = f"{self.market_data_base.rstrip('/')}{path}"
        headers = {"Accept": "application/json"}
        if auth:
            headers["Authorization"] = f"Bearer {self._get_api_token()}"
        if body is not None:
            headers["Content-Type"] = "application/json"

        response = requests.request(method, url, headers=headers, json=body, timeout=30)
        response.raise_for_status()
        if not response.content:
            return None
        return response.json()

    def _get_api_token(self) -> str:
        now_ms = int(time.time() * 1000)
        if self._api_token and self._api_token_expires_at_ms > now_ms + 60_000:
            return self._api_token

        nonce_response = self._api_request("GET", "/v0/auth/nonce", auth=False)
        nonce = nonce_response["nonce"]
        issued_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        message = (
            f"api.dreamdex.io wants you to sign in with your Ethereum account:\n{self.address}\n\n"
            f"Sign in to dreamDEX\n\n"
            f"URI: https://api.dreamdex.io\n"
            f"Version: 1\n"
            f"Chain ID: {int(self.cfg.get('chain_id', 5031))}\n"
            f"Nonce: {nonce}\n"
            f"Issued At: {issued_at}"
        )
        signature = self.account.sign_message(encode_defunct(text=message)).signature.hex()
        login_response = self._api_request(
            "POST",
            "/v0/auth/login",
            body={"message": message, "signature": f"0x{signature}"},
            auth=False,
        )
        self._api_token = login_response["token"]
        self._api_token_expires_at_ms = int(login_response.get("expiresAt", 0))
        return self._api_token

    def _decimal_string(self, raw_value: int, decimals: int) -> str:
        value = Decimal(raw_value) / (Decimal(10) ** decimals)
        normalized = format(value, "f")
        return normalized.rstrip("0").rstrip(".") if "." in normalized else normalized

    def _apply_gas_estimate(self, tx: Dict[str, Any], is_bid: Optional[bool] = None) -> None:
        floor = self._gas_limit_for_order(is_bid) if is_bid is not None else int(
            self.cfg.get("fallback_gas", 2_000_000)
        )
        estimate_fields = {
            "from": tx["from"],
            "to": tx["to"],
            "data": tx.get("data", "0x"),
            "value": tx.get("value", 0),
        }
        try:
            estimated = int(self.web3.eth.estimate_gas({**estimate_fields, "gas": floor}))
            tx["gas"] = max(int(tx.get("gas", 0)), floor, int(estimated * 1.2))
        except Exception as exc:
            logger.warning(f"Gas estimate failed, using fallback: {exc}")
            tx["gas"] = max(floor, int(self.cfg.get("fallback_gas", 2_000_000)))

    def _gas_limit_for_order(self, is_bid: bool) -> int:
        if self.market.base_is_native:
            return self.native_base_buy_gas
        return int(self.cfg.get("fallback_gas", 2_000_000))

    def _prepared_tx_to_web3_tx(
        self, prepared: Dict[str, Any], is_bid: Optional[bool] = None, gas_override: Optional[int] = None
    ) -> Dict[str, Any]:
        tx = self._build_base_tx(is_bid=is_bid)
        tx["to"] = Web3.to_checksum_address(prepared["to"])
        tx["data"] = prepared["data"]
        tx["value"] = int(prepared.get("value", "0"))
        tx["chainId"] = int(prepared["chainId"])
        if gas_override is not None:
            # Bypass the (often-reverting) estimate; use an explicit high budget.
            tx["gas"] = int(gas_override)
            return tx
        gas_limit = prepared.get("gasLimit")
        if gas_limit is not None:
            tx["gas"] = int(gas_limit)
        self._apply_gas_estimate(tx, is_bid=is_bid)
        return tx

    def _simulate_prepared_tx(self, prepared: Dict[str, Any], is_bid: bool) -> Tuple[bool, int]:
        gas_limit = self._gas_limit_for_order(is_bid)
        tx_fields = {
            "from": self.address,
            "to": Web3.to_checksum_address(prepared["to"]),
            "data": prepared["data"],
            "value": int(prepared.get("value", "0")),
            "gas": gas_limit,
        }
        try:
            result = self.web3.eth.call(tx_fields)
            if len(result) >= 64:
                success = int.from_bytes(result[31:32], "big") == 1
                order_id = int.from_bytes(result[32:64], "big")
                return success, order_id
            return False, 0
        except Exception as exc:
            logger.warning(f"Prepared tx simulation failed: {exc}")
            return False, 0

    def _broadcast_prepared_tx(
        self, prepared: Dict[str, Any], is_bid: Optional[bool] = None, gas_override: Optional[int] = None
    ) -> str:
        tx = self._prepared_tx_to_web3_tx(prepared, is_bid=is_bid, gas_override=gas_override)
        if self.dry_run:
            logger.info(f"DRY RUN: would broadcast tx to={tx['to']} gas={tx.get('gas')}")
            return "0x" + "0" * 64
        tx_hash = self._sign_and_send(tx)
        return tx_hash

    def _resolve_watch_symbols(self) -> List[str]:
        configured = self.cfg.get("watch_symbols")
        if configured:
            return [str(symbol) for symbol in configured]
        return [str(self.cfg.get("market_symbol", "USDC.e:USDso"))]

    def _symbols_for_registry(self) -> List[str]:
        """Markets loaded for trading + portfolio valuation (union, stable order)."""
        extra = self.cfg.get("portfolio_symbols") or []
        seen: set = set()
        symbols: List[str] = []
        for symbol in list(self._resolve_watch_symbols()) + [str(s) for s in extra]:
            key = symbol.upper()
            if key in seen:
                continue
            seen.add(key)
            symbols.append(symbol)
        return symbols

    def _load_currency_codes(self) -> Dict[str, str]:
        currency_codes: Dict[str, str] = {}
        for currency in self._fetch_json("/v0/currencies").get("currencies", []):
            currency_id = currency.get("id")
            currency_code = currency.get("code")
            if currency_id and currency_code:
                currency_codes[Web3.to_checksum_address(currency_id)] = str(currency_code)
        return currency_codes

    def _build_market_from_api(self, market: Dict[str, Any]) -> Market:
        pool = Web3.to_checksum_address(market["contract"])
        pool_contract = self.web3.eth.contract(address=pool, abi=POOL_ABI)
        params = pool_contract.functions.getPoolParams().call()
        base_token = Web3.to_checksum_address(params[0])
        quote_token = Web3.to_checksum_address(params[1])
        base_code = self._currency_codes.get(
            base_token, market.get("baseCode") or market.get("baseCurrency") or ""
        )
        quote_code = self._currency_codes.get(
            quote_token, market.get("quoteCode") or market.get("quoteCurrency") or ""
        )
        return Market(
            symbol=market["symbol"],
            pool=pool,
            base=base_token,
            quote=quote_token,
            base_code=str(base_code),
            quote_code=str(quote_code),
            base_decimals=int(market["baseDecimals"]),
            quote_decimals=int(market["quoteDecimals"]),
            taker_fee_bps_times1k=int(params[3]),
            tick_size=int(params[4]),
            min_quantity=int(params[5]),
            lot_size=int(params[6]),
            base_is_native=base_token == self.native_token,
            quote_is_native=quote_token == self.native_token,
        )

    def _load_markets_registry(self) -> None:
        api_markets = self._fetch_json("/v0/markets").get("markets", [])
        desired = {symbol.upper() for symbol in self._symbols_for_registry()}
        for item in api_markets:
            symbol = item.get("symbol", "")
            if symbol.upper() not in desired:
                continue
            if self.pool_address_override:
                if Web3.to_checksum_address(item["contract"]) != Web3.to_checksum_address(
                    self.pool_address_override
                ):
                    continue
            market = self._build_market_from_api(item)
            self.markets_registry[market.symbol] = market
            self.pools_registry[market.symbol] = self.web3.eth.contract(
                address=market.pool, abi=POOL_ABI
            )
        missing = desired - {symbol.upper() for symbol in self.markets_registry}
        if missing:
            raise RuntimeError(f"Markets not found for watch_symbols: {sorted(missing)}")

    def _set_active_market(self, symbol: str, update_ws: bool = True) -> None:
        market = self.markets_registry.get(symbol)
        if market is None:
            for key, value in self.markets_registry.items():
                if key.upper() == symbol.upper():
                    market = value
                    break
        if market is None:
            raise RuntimeError(f"Unknown market symbol: {symbol}")
        self.market = market
        self.pool = self.pools_registry[market.symbol]
        self.base_token_contract = None if market.base_is_native else self.web3.eth.contract(
            address=market.base, abi=ERC20_ABI
        )
        self.quote_token_contract = None if market.quote_is_native else self.web3.eth.contract(
            address=market.quote, abi=ERC20_ABI
        )

    def _load_market(self) -> Market:
        markets = self._fetch_json("/v0/markets").get("markets", [])
        desired_symbol = self.cfg.get("market_symbol", "SOMI:USDso").upper()

        market = None
        if self.pool_address_override:
            desired_pool = Web3.to_checksum_address(self.pool_address_override)
            for item in markets:
                if Web3.to_checksum_address(item["contract"]) == desired_pool:
                    market = item
                    break

        if market is None:
            for item in markets:
                if item.get("symbol", "").upper() == desired_symbol:
                    market = item
                    break

        if market is None:
            raise RuntimeError(f"Market not found for {desired_symbol}")

        return self._build_market_from_api(market)

    def _build_base_tx(self, is_bid: Optional[bool] = None) -> Dict[str, Any]:
        tx: Dict[str, Any] = {
            "from": self.address,
            "nonce": self.web3.eth.get_transaction_count(self.address),
            "chainId": int(self.cfg.get("chain_id", 5031)),
        }
        latest_block = self.web3.eth.get_block("latest")
        base_fee = latest_block.get("baseFeePerGas")
        if base_fee is not None:
            priority = self.web3.to_wei(self.priority_fee_gwei, "gwei")
            tx["maxPriorityFeePerGas"] = int(priority)
            tx["maxFeePerGas"] = int(base_fee * 2 + priority)
            tx["type"] = 2
        else:
            tx["gasPrice"] = self.web3.eth.gas_price
        tx["gas"] = self._gas_limit_for_order(is_bid) if is_bid is not None else int(
            self.cfg.get("fallback_gas", 2_000_000)
        )
        return tx

    def _sign_and_send(self, tx: Dict[str, Any]) -> str:
        if self.dry_run:
            logger.info(
                f"DRY RUN: would broadcast tx to={tx.get('to')} gas={tx.get('gas')}"
            )
            return "0x" + "0" * 64
        signed = self.account.sign_transaction(tx)
        tx_hash = self.web3.eth.send_raw_transaction(signed.raw_transaction)
        return tx_hash.hex()

    def _token_balance(self, token: str) -> int:
        if token == self.native_token:
            return self.web3.eth.get_balance(self.address)
        contract = self.web3.eth.contract(address=token, abi=ERC20_ABI)
        return int(contract.functions.balanceOf(self.address).call())

    def _token_decimals(self, token: str) -> int:
        checksum_token = Web3.to_checksum_address(token)
        if checksum_token == self.market.base:
            return int(self.market.base_decimals)
        if checksum_token == self.market.quote:
            return int(self.market.quote_decimals)
        contract = self.web3.eth.contract(address=checksum_token, abi=ERC20_ABI)
        return int(contract.functions.decimals().call())

    def _approval_amount(self, is_bid: bool, quantity_raw: int, price_raw: int) -> int:
        if is_bid:
            principal = self._quote_cost(quantity_raw, price_raw)
        else:
            principal = int(quantity_raw)

        fee_overhead = (principal * int(self.market.taker_fee_bps_times1k) + 999_999) // 1_000_000
        return principal + fee_overhead

    def _currency_code_for_token(self, token: str) -> str:
        checksum = Web3.to_checksum_address(token)
        if checksum == self.market.base:
            return self.market.base_code or "BASE"
        if checksum == self.market.quote:
            return self.market.quote_code or "QUOTE"
        for market in self.markets_registry.values():
            if checksum == market.base:
                return market.base_code or "BASE"
            if checksum == market.quote:
                return market.quote_code or "QUOTE"
        raise ValueError(f"Unknown token for market: {token}")

    def _market_for_token(self, token: str) -> Optional[Market]:
        checksum = Web3.to_checksum_address(token)
        for market in self.markets_registry.values():
            if checksum in (market.base, market.quote):
                return market
        return None

    def _approve_via_api(self, token: str, amount_needed: int) -> Optional[str]:
        decimals = self._token_decimals(token)
        if amount_needed >= 10 ** (decimals + 12):
            amount_human = "1000000"
        else:
            amount_human = self._decimal_string(amount_needed, decimals)
        body = {
            "walletAddress": self.address,
            "currency": self._currency_code_for_token(token),
            "amount": amount_human,
        }
        prepared = self._api_request(
            "POST",
            f"/v0/markets/{self.market.symbol}/vault/approve",
            body=body,
        )
        if prepared is None:
            return None
        tx_hash = self._broadcast_prepared_tx(prepared)
        if self.dry_run:
            return tx_hash
        receipt = self.web3.eth.wait_for_transaction_receipt(tx_hash)
        if receipt.status != 1:
            raise RuntimeError(f"API approve failed: {tx_hash}")
        return tx_hash

    def _approve_token(self, token: str, amount_needed: int, pool: Optional[str] = None) -> Optional[str]:
        if token == self.native_token:
            return None

        spender = Web3.to_checksum_address(pool or self.market.pool)
        contract = self.web3.eth.contract(address=token, abi=ERC20_ABI)
        allowance = int(contract.functions.allowance(self.address, spender).call())
        if allowance >= amount_needed:
            return None

        try:
            if allowance > 0:
                zero_tx = contract.functions.approve(spender, 0).build_transaction(
                    self._build_base_tx()
                )
                zero_tx["gas"] = self.web3.eth.estimate_gas(zero_tx)
                zero_hash = self._sign_and_send(zero_tx)
                if not self.dry_run:
                    self.web3.eth.wait_for_transaction_receipt(zero_hash)

            tx = contract.functions.approve(spender, amount_needed).build_transaction(
                self._build_base_tx()
            )
            tx["gas"] = self.web3.eth.estimate_gas(tx)
            tx_hash = self._sign_and_send(tx)
            if self.dry_run:
                return tx_hash
            receipt = self.web3.eth.wait_for_transaction_receipt(tx_hash)
            if receipt.status == 1:
                return tx_hash
        except Exception as exc:
            logger.warning(f"Direct approve failed for {token}: {exc}")

        return self._approve_via_api(token, amount_needed)

    def _ensure_order_allowance(self, is_bid: bool, quantity_raw: int, price_raw: int) -> Optional[str]:
        if self.dry_run:
            return None
        token = self.market.quote if is_bid else self.market.base
        if token == self.native_token:
            return None
        amount_needed = self._approval_amount(is_bid, quantity_raw, price_raw)
        contract = self.web3.eth.contract(address=token, abi=ERC20_ABI)
        allowance = int(contract.functions.allowance(self.address, self.market.pool).call())
        if allowance >= amount_needed:
            return None
        return self._approve_token(token, amount_needed)

    def _load_state(self) -> None:
        try:
            with open(self.state_path, "r", encoding="utf-8") as handle:
                state = json.load(handle)
            if state.get("wallet", "").lower() != self.address.lower():
                logger.info("State file is for a different wallet; resetting activity timer")
                self.metrics["last_activity_at"] = 0
                return
            updated_at = int(state.get("updated_at", 0))
            if updated_at > int(self.metrics.get("last_activity_at", 0)):
                self.metrics["last_activity_at"] = updated_at
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            pass

    def seconds_since_last_activity(self) -> float:
        last_at = int(self.metrics.get("last_activity_at", 0))
        if last_at <= 0:
            return 0.0
        return max(0.0, time.time() - last_at)

    def competition_stats(self) -> Dict[str, float]:
        quote_decimals = next(iter(self.markets_registry.values())).quote_decimals
        scale = Decimal(10) ** quote_decimals
        raw_vol = Decimal(int(self.metrics.get("api_volume_quote_raw", 0))) / scale
        pnl = Decimal(int(self.metrics.get("pnl_quote_raw", 0))) / scale
        initial = Decimal(int(self._initial_portfolio_quote_raw or 0)) / scale
        pnl_pct = float((pnl / initial) * 100) if initial > 0 else 0.0
        multiplier = max(0.0, 1.0 + pnl_pct / 100.0)
        effective = float(raw_vol) * multiplier
        idle_hours = self.seconds_since_last_activity() / 3600.0
        return {
            "pnl_usdso": float(pnl),
            "pnl_pct": pnl_pct,
            "raw_volume_usdso": float(raw_vol),
            "effective_volume_usdso": effective,
            "tx_count": int(self.metrics.get("orders", 0)),
            "idle_hours": idle_hours,
        }

    def _load_metrics(self) -> None:
        try:
            with open(self.metrics_path, "r", encoding="utf-8") as handle:
                saved = json.load(handle)
            for key in self.metrics:
                if key in saved:
                    self.metrics[key] = saved[key]
        except FileNotFoundError:
            pass
        except (json.JSONDecodeError, OSError) as exc:
            logger.warning(f"Could not load metrics from {self.metrics_path}: {exc}")

    def _order_type_on_chain(self, order_type_api: Optional[str] = None) -> int:
        if order_type_api:
            return ORDER_TYPE_ON_CHAIN.get(order_type_api, ORDER_IOC)
        if self.volume_mode:
            return ORDER_IOC
        if self.bulk_mode and self.use_fok_for_bulk:
            return ORDER_FOK
        return ORDER_TYPE_ON_CHAIN.get(self.order_type_default, ORDER_IOC)

    def _order_type_for_api(self, on_chain: Optional[int] = None) -> str:
        if on_chain is not None:
            return ORDER_TYPE_API.get(on_chain, "immediateOrCancel")
        return ORDER_TYPE_API.get(self._order_type_on_chain(), "immediateOrCancel")

    def _get_vault_balances(self, symbol: Optional[str] = None) -> Dict[str, Decimal]:
        sym = symbol or self.market.symbol
        url = f"{self.market_data_base.rstrip('/')}/v0/markets/{sym}/vault/balance"
        headers = {"Accept": "application/json", "Authorization": f"Bearer {self._get_api_token()}"}
        response = requests.get(
            url, headers=headers, params={"walletAddress": self.address}, timeout=30
        )
        response.raise_for_status()
        out: Dict[str, Decimal] = {}
        for entry in response.json().get("balances", []):
            out[str(entry.get("currency", ""))] = Decimal(str(entry.get("amount", "0")))
        return out

    def _vault_balance_raw(self, token: str, symbol: Optional[str] = None) -> int:
        market = self.markets_registry[symbol or self.market.symbol]
        balances = self._get_vault_balances(symbol)
        if token == market.quote:
            code, dec = market.quote_code, market.quote_decimals
        elif token == market.base:
            code, dec = market.base_code, market.base_decimals
        else:
            return 0
        return int(balances.get(code or "", Decimal(0)) * (Decimal(10) ** dec))

    def _vault_deposit(self, currency_code: str, amount_human: str, symbol: Optional[str] = None) -> str:
        sym = symbol or self.market.symbol
        prepared = self._api_request(
            "POST",
            f"/v0/markets/{sym}/vault/deposit",
            body={"walletAddress": self.address, "currency": currency_code, "amount": amount_human},
            auth=True,
        )
        if prepared is None:
            raise RuntimeError(f"Vault deposit prepare empty for {sym} {currency_code}")
        tx_hash = self._broadcast_prepared_tx(prepared)
        if not self.dry_run:
            receipt = self.web3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
            if receipt.status != 1:
                raise RuntimeError(f"Vault deposit failed: {tx_hash}")
        return tx_hash

    def _vault_deposit_currency(
        self, currency_code: str, amount_human: str, symbol: Optional[str] = None
    ) -> str:
        sym = symbol or self.market.symbol
        token = self.markets_registry[sym].quote
        market = self.markets_registry[sym]
        if currency_code.upper() != (market.quote_code or "USDso").upper():
            token = market.base
        try:
            amount_raw = int(Decimal(amount_human) * (Decimal(10) ** (
                market.quote_decimals if token == market.quote else market.base_decimals
            )))
            if amount_raw > 0:
                self._approve_via_api(token, amount_raw)
        except Exception as exc:
            logger.warning(f"Vault approve ({currency_code}): {exc}")
        tx = self._vault_deposit(currency_code, amount_human, sym)
        logger.info(f"Vault deposit {amount_human} {currency_code} → {sym} tx={tx[:18]}…")
        return tx

    def _ensure_vault_deposit(self) -> None:
        """Deposit USDso into vault up to vault_target_usdso (startup + periodic top-up)."""
        if not self.vault_enabled or self.dry_run:
            return
        symbol = self.vault_market
        if symbol not in self.markets_registry:
            logger.warning(f"vault_market {symbol} unknown; skipping deposit")
            return
        market = self.markets_registry[symbol]
        self._set_active_market(symbol)
        wallet_usd = self._token_balance(market.quote) / (Decimal(10) ** market.quote_decimals)
        target = self.vault_target_usdso
        if self.vault_deposit_usdso > 0:
            target = min(target, self.vault_deposit_usdso)
        if target < self.vault_min_deposit_usdso:
            return
        vault_usd = self._vault_balance_raw(market.quote, symbol) / (Decimal(10) ** market.quote_decimals)
        escrow_usd = self._open_order_escrow_quote_raw(market) / (Decimal(10) ** market.quote_decimals)
        vault_total = float(vault_usd) + float(escrow_usd)
        if vault_total >= target * 0.92:
            return
        need = max(0.0, target - vault_total)
        if need < self.vault_min_deposit_usdso:
            return
        spendable = max(0.0, float(wallet_usd) - self.vault_wallet_reserve_usdso)
        deposit = min(need, spendable)
        if deposit < self.vault_min_deposit_usdso:
            logger.debug(
                f"Vault USDso top-up skipped: need={need:.2f} wallet={wallet_usd:.2f} "
                f"reserve={self.vault_wallet_reserve_usdso:.2f}"
            )
            return
        amount_human = f"{deposit:.2f}"
        try:
            self._vault_deposit_currency(market.quote_code or "USDso", amount_human, symbol)
        except Exception as exc:
            logger.warning(f"Vault USDso deposit skipped (non-fatal): {exc}")

    def _ensure_vault_weth_deposit(self) -> None:
        """Move wallet WETH into vault so sell-side maker quotes can rest."""
        if not self.vault_enabled or self.dry_run:
            return
        symbol = self.vault_market
        if symbol not in self.markets_registry:
            return
        market = self.markets_registry[symbol]
        if market.base_is_native:
            return
        self._set_active_market(symbol)
        vault_weth = self._vault_balance_raw(market.base, symbol) / (Decimal(10) ** market.base_decimals)
        wallet_weth = self._token_balance(market.base) / (Decimal(10) ** market.base_decimals)
        min_human = float(market.min_quantity) / (10 ** market.base_decimals)
        total_weth = float(vault_weth) + float(wallet_weth)
        target = max(self.vault_target_weth, min_human * 2)
        bb, ba = self._best_prices_for(market)
        if bb and ba and not self.cfg.get("always_two_sided_mm"):
            ratio = self._mm_inventory_ratio(bb, ba)
            inv_target = float(self.cfg.get("target_inventory_ratio", 0.5))
            if ratio > inv_target + 0.05:
                # Long ETH — keep most base in vault for sell quotes.
                target = max(target, total_weth * 0.75)
        if float(vault_weth) >= target * 0.9:
            return
        need = target - float(vault_weth)
        if need < min_human * 0.5:
            return
        deposit = min(float(wallet_weth) * 0.92, need)
        if deposit < min_human:
            return
        amount_human = f"{deposit:.6f}".rstrip("0").rstrip(".")
        try:
            self._vault_deposit_currency(market.base_code or "WETH", amount_human, symbol)
        except Exception as exc:
            logger.warning(f"Vault WETH deposit skipped (non-fatal): {exc}")

    def _vault_liquidity_low(self) -> bool:
        """True when vault cannot place both sides — bypass top-up throttle."""
        if not self.vault_enabled:
            return False
        symbol = self.vault_market
        market = self.markets_registry.get(symbol)
        if market is None:
            return False
        vault_quote = float(
            self._vault_balance_raw(market.quote, symbol) / (Decimal(10) ** market.quote_decimals)
        )
        vault_base = float(
            self._vault_balance_raw(market.base, symbol) / (Decimal(10) ** market.base_decimals)
        )
        if vault_quote < self.vault_target_usdso * 0.4 or vault_base < self.vault_target_weth * 0.4:
            return True
        bb, ba = self._best_prices_for(market)
        if not bb or not ba:
            return vault_quote < self.vault_min_deposit_usdso
        ratio = self._mm_inventory_ratio(bb, ba)
        target = float(self.cfg.get("target_inventory_ratio", 0.5))
        soft = float(self.cfg.get("inventory_skew_bps", 200)) / 10_000.0
        if ratio > target + soft and vault_base < self.vault_target_weth * 0.6:
            return True
        if ratio < target - soft and vault_quote < self.vault_target_usdso * 0.6:
            return True
        return False

    def _ensure_vault_ready(self, force: bool = False) -> None:
        """Keep vault funded for continuous two-sided maker quotes."""
        if not self.vault_enabled or not self.vault_auto_topup:
            if force:
                self._ensure_vault_deposit()
                self._ensure_vault_weth_deposit()
            return
        now = time.time()
        urgent = self._vault_liquidity_low()
        if not force and not urgent and (now - self._last_vault_topup_ts) < self.vault_topup_interval_sec:
            return
        self._last_vault_topup_ts = now
        self._ensure_vault_deposit()
        self._ensure_vault_weth_deposit()

    def _balance_raw(self, is_bid: bool, funding_source: Optional[str] = None) -> int:
        src = funding_source or self.funding_source_taker
        if src == "vault":
            return self._vault_balance_raw(
                self.market.quote if is_bid else self.market.base
            )
        if is_bid:
            return self._token_balance(self.market.quote)
        bal = self._token_balance(self.market.base)
        if self.market.base_is_native:
            return max(0, bal - self.reserve_native_wei)
        return bal

    def _spendable_quote_balance(self, funding_source: Optional[str] = None) -> int:
        balance = self._balance_raw(True, funding_source)
        if not self.volume_mode:
            return balance
        reserve = int(balance * self.reserve_quote_fraction)
        spendable = max(0, balance - reserve)
        return int(spendable * self.trade_fraction)

    def _spendable_base_balance(self, funding_source: Optional[str] = None) -> int:
        balance = self._balance_raw(False, funding_source)
        if not self.volume_mode:
            return balance
        return int(balance * self.trade_fraction)

    def _cumulative_volume_quote_raw(self) -> int:
        return int(self.metrics["volume_in_raw"]) + int(self.metrics["volume_out_raw"])

    def _ensure_startup_allowances(self) -> None:
        if self.dry_run:
            logger.info("DRY RUN: skipping startup token approvals")
            return
        seen: set = set()
        for market in self.markets_registry.values():
            for token in (market.quote, market.base):
                if token == self.native_token:
                    continue
                key = (Web3.to_checksum_address(token), Web3.to_checksum_address(market.pool))
                if key in seen:
                    continue
                seen.add(key)
                try:
                    tx_hash = self._approve_token(token, self.max_approval, pool=market.pool)
                    if tx_hash:
                        logger.info(f"Startup approval for {token} on {market.symbol}: {tx_hash}")
                except Exception as exc:
                    logger.warning(f"Startup approval skipped for {token} on {market.symbol}: {exc}")

    def _preflight_checks(self) -> None:
        best_bid, best_ask = self._best_prices()
        quote_bal = self._token_balance(self.market.quote)
        base_bal = self._token_balance(self.market.base)
        native_bal = self.web3.eth.get_balance(self.address)
        logger.info(
            f"Preflight: bid={best_bid} ask={best_ask} "
            f"quote_bal={quote_bal} base_bal={base_bal} native={native_bal}"
        )
        if best_bid is None or best_ask is None:
            logger.warning("Preflight: order book has no depth yet")
        spendable_quote = self._spendable_quote_balance()
        buy_price = self._price_for_order(True, best_bid or 0, best_ask or 1)
        max_buy_qty = self._buy_quantity_from_balance(spendable_quote, buy_price)
        logger.info(
            f"Preflight: spendable_quote={spendable_quote} max_buy_qty={max_buy_qty} "
            f"min_qty={self.market.min_quantity}"
        )
        if max_buy_qty < self.market.min_quantity and self._spendable_base_balance() < self.market.min_quantity:
            logger.warning("Preflight: balances may be too small for min order size")

    def _align_to_lot(self, quantity_raw: int) -> int:
        lot = max(1, self.market.lot_size)
        aligned = (quantity_raw // lot) * lot
        if aligned == 0:
            aligned = lot
        return max(aligned, self.market.min_quantity)

    def _align_quantity_down(self, quantity_raw: int) -> int:
        lot = max(1, self.market.lot_size)
        aligned = (quantity_raw // lot) * lot
        if aligned < self.market.min_quantity:
            return 0
        return aligned

    def _sell_quantity_from_balance(self, base_balance_raw: int) -> int:
        return self._align_quantity_down(base_balance_raw)

    def _maker_notional_quantity_raw(
        self,
        notional_usdso: float,
        price_raw: int,
        is_bid: bool,
        funding_source: Optional[str] = None,
    ) -> int:
        """Fixed USDso notional per maker side (capped by vault/wallet spendable)."""
        if notional_usdso <= 0:
            return 0
        price_raw = max(1, int(price_raw))
        fs = funding_source or "wallet"
        notional_raw = int(Decimal(str(notional_usdso)) * (Decimal(10) ** self.market.quote_decimals))
        qty_approx = int(
            (Decimal(notional_raw) * (Decimal(10) ** self.market.base_decimals)) / Decimal(price_raw)
        )
        qty = self._align_quantity_down(qty_approx)
        if qty < self.market.min_quantity:
            qty = self._align_to_lot(self.market.min_quantity)
        if is_bid:
            spendable = self._spendable_quote_balance(fs)
            lot = max(1, self.market.lot_size)
            while qty >= self.market.min_quantity and self._quote_cost(qty, price_raw) > spendable:
                qty = self._align_quantity_down(qty - lot)
            if qty < self.market.min_quantity:
                return 0
            return qty if self._can_afford(True, qty, price_raw, fs) else 0
        spendable = self._spendable_base_balance(fs)
        qty = min(qty, self._align_quantity_down(spendable))
        return qty if qty >= self.market.min_quantity else 0

    def _buy_quantity_from_balance(self, quote_balance_raw: int, price_raw: int) -> int:
        lot = max(1, self.market.lot_size)
        price_raw = max(1, int(price_raw))
        approx = int((Decimal(quote_balance_raw) * (Decimal(10) ** self.market.base_decimals)) / Decimal(price_raw))
        upper_steps = max(1, self._align_to_lot(max(approx, self.market.min_quantity)) // lot)
        low_steps = 0
        high_steps = upper_steps
        best_steps = 0

        while low_steps <= high_steps:
            mid_steps = (low_steps + high_steps) // 2
            quantity_raw = max(lot, mid_steps * lot)
            if quantity_raw < self.market.min_quantity:
                quantity_raw = self._align_to_lot(self.market.min_quantity)
            if self._quote_cost(quantity_raw, price_raw) <= quote_balance_raw:
                best_steps = mid_steps
                low_steps = mid_steps + 1
            else:
                high_steps = mid_steps - 1

        return max(best_steps * lot, 0)

    def _best_prices_for(self, market: Market) -> Tuple[Optional[int], Optional[int]]:
        if self._ws_multi_book is not None and self._ws_multi_book.connected:
            bid, ask = self._ws_multi_book.best_prices(market.symbol)
            if bid is not None and ask is not None:
                return bid, ask
        pool = self.pools_registry[market.symbol]
        asks = pool.functions.getBookLevels(False, 1).call()
        bids = pool.functions.getBookLevels(True, 1).call()
        best_ask = int(asks[0][0]) if asks else None
        best_bid = int(bids[0][0]) if bids else None
        return best_bid, best_ask

    def _best_prices(self) -> Tuple[Optional[int], Optional[int]]:
        if self._ws_multi_book is not None and self._ws_multi_book.connected:
            bid, ask = self._ws_multi_book.best_prices(self.market.symbol)
            if bid is not None and ask is not None:
                return bid, ask
        if self._ws_book is not None and self._ws_book.connected:
            bid, ask = self._ws_book.best_prices()
            if bid is not None and ask is not None:
                return bid, ask
        return self._best_prices_for(self.market)

    def _spread_bps(self, best_bid: int, best_ask: int) -> int:
        if best_bid <= 0 or best_ask <= best_bid:
            return 10_000
        mid = (best_bid + best_ask) // 2
        return int((best_ask - best_bid) * 10_000 // max(1, mid))

    def _mid_price_raw(self, best_bid: int, best_ask: int) -> int:
        return (best_bid + best_ask) // 2

    def _align_price(self, price_raw: int, is_bid: bool) -> int:
        tick = max(1, self.market.tick_size)
        remainder = price_raw % tick
        if remainder == 0:
            return price_raw
        if is_bid:
            return price_raw + (tick - remainder)
        return max(tick, price_raw - remainder)

    def _price_for_order(
        self,
        is_bid: bool,
        best_bid: int,
        best_ask: int,
        slippage_bps: Optional[int] = None,
    ) -> int:
        slip = self.slippage_bps if slippage_bps is None else slippage_bps
        if is_bid:
            aggressive = (best_ask * (10_000 + slip)) // 10_000
            return self._align_price(aggressive, True)
        aggressive = (best_bid * (10_000 - slip)) // 10_000
        return self._align_price(aggressive, False)

    def _maker_price(self, is_bid: bool, mid_raw: int, spread_ticks: int) -> int:
        offset = spread_ticks * max(1, self.market.tick_size)
        if is_bid:
            return self._align_price(max(self.market.tick_size, mid_raw - offset), True)
        return self._align_price(mid_raw + offset, False)

    def _maker_price_touch(self, is_bid: bool, best_bid: int, best_ask: int, improve_ticks: int = 0) -> int:
        """PostOnly-safe price at the book touch (join/improve without crossing)."""
        tick = max(1, self.market.tick_size)
        improve = improve_ticks * tick
        if is_bid:
            price = best_bid + improve
            max_bid = best_ask - tick
            if max_bid < tick:
                return 0
            return self._align_price(min(price, max_bid), True)
        price = best_ask - improve
        min_ask = best_bid + tick
        if min_ask <= 0:
            return 0
        return self._align_price(max(price, min_ask), False)

    def _mm_inventory_balances_raw(self, market: Optional["Market"] = None) -> Tuple[int, int]:
        """Quote and base for MM skew: wallet + vault + open-order escrow."""
        m = market or self.market
        sym = m.symbol
        quote_raw = self._token_balance(m.quote)
        base_raw = self._token_balance(m.base)
        if self.vault_enabled and sym == self.vault_market:
            quote_raw += self._vault_balance_raw(m.quote, sym)
            base_raw += self._vault_balance_raw(m.base, sym)
        prev = self.market.symbol
        try:
            self._set_active_market(sym, update_ws=False)
            quote_raw += self._open_order_escrow_quote_raw(m)
            base_raw += self._open_order_escrow_base_raw(m)
        finally:
            if prev != sym:
                self._set_active_market(prev, update_ws=False)
        return quote_raw, base_raw

    def _mm_inventory_ratio(self, best_bid: int, best_ask: int) -> float:
        """Inventory ratio for vault MM — full deployable stack, not vault-only."""
        quote_raw, base_raw = self._mm_inventory_balances_raw()
        mid = self._mid_price_raw(best_bid, best_ask)
        if mid <= 0:
            return 0.5
        base_notional = int(
            (Decimal(base_raw) * Decimal(mid)) / (Decimal(10) ** self.market.base_decimals)
        )
        total = quote_raw + base_notional
        if total <= 0:
            return 0.5
        return base_notional / total

    def _inventory_ratio(self, best_bid: int, best_ask: int) -> float:
        quote_bal = self._token_balance(self.market.quote)
        base_bal = self._token_balance(self.market.base)
        mid = self._mid_price_raw(best_bid, best_ask)
        if mid <= 0:
            return 0.5
        base_notional = int((Decimal(base_bal) * Decimal(mid)) / (Decimal(10) ** self.market.base_decimals))
        total = quote_bal + base_notional
        if total <= 0:
            return 0.5
        return base_notional / total

    def _inventory_quote_sides(
        self,
        best_bid: int,
        best_ask: int,
        target_ratio: float,
        skew_bps: int,
    ) -> Tuple[bool, bool]:
        """Return (quote_bid, quote_ask) — one-sided when inventory skews."""
        ratio = self._inventory_ratio(best_bid, best_ask)
        soft = skew_bps / 10_000
        if ratio > target_ratio + soft:
            return False, True
        if ratio < target_ratio - soft:
            return True, False
        return True, True

    def _can_afford(
        self,
        is_bid: bool,
        quantity_raw: int,
        price_raw: int,
        funding_source: Optional[str] = None,
    ) -> bool:
        if is_bid:
            quote_cost = self._quote_cost(quantity_raw, price_raw)
            return self._balance_raw(True, funding_source) >= quote_cost
        base_balance = self._balance_raw(False, funding_source)
        if self.market.base_is_native and (funding_source or "wallet") != "vault":
            return quantity_raw + self.reserve_native_wei <= base_balance
        return base_balance >= quantity_raw

    def _quote_cost(self, quantity_raw: int, price_raw: int) -> int:
        return int(self.pool.functions.convertToQuoteAtPriceCeil(quantity_raw, price_raw).call())

    def _choose_side(self, best_bid: int, best_ask: int) -> Optional[bool]:
        buy_price = self._price_for_order(True, best_bid, best_ask)
        can_buy = (
            self._buy_quantity_from_balance(self._spendable_quote_balance(), buy_price)
            >= self.market.min_quantity
        )
        can_sell = (
            self._sell_quantity_from_balance(self._spendable_base_balance())
            >= self.market.min_quantity
        )

        logger.debug(f"Side decision: can_buy={can_buy}, can_sell={can_sell}, orders={self.metrics['orders']}")

        if self.only_buy:
            return True if can_buy else None
        if self.only_sell:
            return False if can_sell else None

        # Alternate buy/sell when both sides are affordable
        if can_buy and can_sell:
            side = (self.metrics["orders"] % 2) == 0
            if side and not can_buy:
                side = False
            elif not side and not can_sell:
                side = True
            logger.debug(f"Alternating side: {'buy' if side else 'sell'}")
            return side
        if can_buy:
            logger.debug("Only buy possible")
            return True
        if can_sell:
            logger.debug("Only sell possible")
            return False
        logger.warning("Neither buy nor sell possible")
        return None

    def _order_value(self, is_bid: bool, quantity_raw: int, price_raw: int) -> int:
        try:
            input_token, required_amount, _ = self.pool.functions.getAutoPullRequirement(
                self.address,
                is_bid,
                int(price_raw),
                int(quantity_raw),
                self.builder_fee_bps_times1k,
            ).call()
            if Web3.to_checksum_address(input_token) == self.native_token:
                return int(required_amount)
        except Exception as exc:
            logger.debug(f"getAutoPullRequirement fallback: {exc}")
        if is_bid and self.market.quote_is_native:
            return quantity_raw
        if not is_bid and self.market.base_is_native:
            return quantity_raw
        return 0

    def _auto_pull_requirement(self, is_bid: bool, quantity_raw: int, price_raw: int) -> Tuple[str, int, int]:
        input_token, required, delta = self.pool.functions.getAutoPullRequirement(
            self.address,
            is_bid,
            int(price_raw),
            int(quantity_raw),
            self.builder_fee_bps_times1k,
        ).call()
        return Web3.to_checksum_address(input_token), int(required), int(delta)

    def _portfolio_value_usdso_all(self) -> int:
        quote_token = None
        for market in self.markets_registry.values():
            if market.quote_code.upper().startswith("USDSO") or market.quote_code.upper() == "USDSO":
                quote_token = market.quote
                break
        if quote_token is None:
            quote_token = next(iter(self.markets_registry.values())).quote

        total = self._token_balance(quote_token) if quote_token != self.native_token else 0
        max_spread = int(self.cfg.get("max_spread_bps", 80))
        priced_bases: set = set()
        for symbol, market in self.markets_registry.items():
            if market.base_is_native or market.base in priced_bases:
                continue
            base_bal = self._token_balance(market.base)
            if base_bal <= 0:
                priced_bases.add(market.base)
                continue
            mark_raw = self._reference_mark_raw(symbol, market, max_spread)
            if mark_raw is None:
                continue
            base_as_quote = int(
                (Decimal(base_bal) * Decimal(mark_raw)) / (Decimal(10) ** market.base_decimals)
            )
            total += base_as_quote
            priced_bases.add(market.base)

        native_bal = self.web3.eth.get_balance(self.address)
        for market in self.markets_registry.values():
            if market.base_is_native:
                mark_raw = self._reference_mark_raw(market.symbol, market, max_spread)
                if mark_raw is not None:
                    total += int(
                        (Decimal(native_bal) * Decimal(mark_raw)) / (Decimal(10) ** market.base_decimals)
                    )
                break

        # Funds locked in open orders are invisible to balanceOf / get_balance.
        total += self._open_orders_value_quote_raw(max_spread)
        if self.vault_enabled:
            total += self._vault_value_quote_raw(max_spread)
        return total

    def _vault_value_quote_raw(self, max_spread: int) -> int:
        """Vault USDso + vault base (marked) across all markets."""
        total = 0
        for symbol, market in self.markets_registry.items():
            try:
                balances = self._get_vault_balances(symbol)
            except Exception:
                continue
            q_amt = balances.get(market.quote_code, Decimal(0))
            total += int(q_amt * (Decimal(10) ** market.quote_decimals))
            b_amt = balances.get(market.base_code, Decimal(0))
            if b_amt <= 0:
                continue
            mark_raw = self._reference_mark_raw(symbol, market, max_spread)
            if mark_raw is None:
                continue
            total += int(b_amt * Decimal(mark_raw))
        return total

    def _open_orders_value_quote_raw(self, max_spread: int) -> int:
        """USDso escrowed in open BUY orders + base escrowed in open SELL orders
        (valued at mark), summed across all markets."""
        prev_symbol = self.market.symbol
        total = 0
        try:
            for symbol, market in self.markets_registry.items():
                try:
                    self._set_active_market(symbol)
                    orders = self._list_open_orders()
                except Exception:
                    continue
                mark_raw = None
                for order in orders:
                    side = order.get("side")
                    remaining = order.get("remaining") or order.get("amount") or "0"
                    if side == "buy":
                        price = order.get("price") or "0"
                        total += int(
                            Decimal(str(remaining)) * Decimal(str(price))
                            * (Decimal(10) ** market.quote_decimals)
                        )
                    elif side == "sell":
                        if mark_raw is None:
                            mark_raw = self._reference_mark_raw(symbol, market, max_spread)
                        if mark_raw:
                            total += int(
                                Decimal(str(remaining)) * Decimal(mark_raw)
                            )
        finally:
            try:
                self._set_active_market(prev_symbol)
            except Exception:
                pass
        return total

    def _reference_mark_raw(self, symbol: str, market: "Market", max_spread: int) -> Optional[int]:
        """Mark price (quote raw per base) preferring the external global reference
        (Binance) when available — robust against DEX order-book glitches; falls
        back to the DEX mid when within an acceptable spread."""
        # 1) External global reference (BTC/ETH): authoritative, glitch-proof.
        if self._price_ref is not None and getattr(self._price_ref, "connected", False):
            try:
                gp = self._price_ref.global_price(symbol)
            except Exception:
                gp = None
            if gp and gp > 0:
                return int(Decimal(str(gp)) * (Decimal(10) ** market.quote_decimals))
        # 2) DEX mid, only if the book looks sane.
        best_bid, best_ask = self._best_prices_for(market)
        if best_bid and best_ask and self._spread_bps(best_bid, best_ask) <= max_spread:
            return self._mid_price_raw(best_bid, best_ask)
        return None

    def _portfolio_value_quote_raw(self, best_bid: Optional[int] = None, best_ask: Optional[int] = None) -> int:
        # Full valuation (vault, escrow, price_ref) — wallet-only mid mark missed vault funds.
        return self._portfolio_value_usdso_all()

    def _inventory_drift_bps(self, best_bid: int, best_ask: int, target_ratio: float) -> int:
        quote_bal = self._token_balance(self.market.quote)
        base_bal = self._token_balance(self.market.base)
        mid = self._mid_price_raw(best_bid, best_ask)
        if mid <= 0:
            return 0
        base_notional = int((Decimal(base_bal) * Decimal(mid)) / (Decimal(10) ** self.market.base_decimals))
        total = quote_bal + base_notional
        if total <= 0:
            return 0
        current_ratio = base_notional / total
        drift = abs(current_ratio - target_ratio)
        return int(drift * 10_000)

    def _funding_for_order_type(self, order_type_api: Optional[str]) -> str:
        ot = order_type_api or self._order_type_for_api()
        if ot in ("postOnly", "goodTillCancelled", "normal"):
            return self.funding_source_maker
        return self.funding_source_taker

    def _prepare_order(
        self,
        is_bid: bool,
        quantity_raw: int,
        price_raw: int,
        order_type_api: Optional[str] = None,
        funding_source: Optional[str] = None,
    ) -> Dict[str, Any]:
        side = "buy" if is_bid else "sell"
        amount = self._decimal_string(quantity_raw, self.market.base_decimals)
        price = self._decimal_string(price_raw, self.market.quote_decimals)
        fs = funding_source or self._funding_for_order_type(order_type_api)
        body = {
            "type": "limit",
            "side": side,
            "price": price,
            "amount": amount,
            "walletAddress": self.address,
            "fundingSource": fs,
            "orderType": order_type_api or self._order_type_for_api(),
        }
        return self._api_request("POST", f"/v0/markets/{self.market.symbol}/orders", body=body, auth=True)

    def _prepare_approval(self, approval: Dict[str, Any]) -> Optional[str]:
        if self.dry_run:
            logger.info("DRY RUN: skipping inline order approval")
            return None
        token = approval.get("token")
        amount = approval.get("amount")
        if not token or not amount:
            return None

        token = Web3.to_checksum_address(token)
        if token == self.native_token:
            return None

        approval_amount_raw = int(Decimal(str(amount)) * (Decimal(10) ** self._token_decimals(token)))
        return self._approve_token(token, approval_amount_raw)

    def _submit_order(
        self,
        is_bid: bool,
        quantity_raw: int,
        price_raw: int,
        order_type_api: Optional[str] = None,
        funding_source: Optional[str] = None,
    ) -> Tuple[str, bool, int]:
        prepared_order = self._prepare_order(
            is_bid, quantity_raw, price_raw,
            order_type_api=order_type_api,
            funding_source=funding_source,
        )
        approval = prepared_order.get("approval")
        if approval:
            approval_tx_hash = self._prepare_approval(approval)
            if approval_tx_hash:
                logger.info(f"Approval submitted: {approval_tx_hash}")

        success, order_id = self._simulate_prepared_tx(prepared_order, is_bid)
        if not success:
            return "", False, 0

        tx_hash = self._broadcast_prepared_tx(prepared_order, is_bid=is_bid)
        return tx_hash, True, order_id

    def _list_open_orders(self) -> List[Dict[str, Any]]:
        url = f"{self.market_data_base.rstrip('/')}/v0/markets/{self.market.symbol}/orders"
        headers = {"Accept": "application/json", "Authorization": f"Bearer {self._get_api_token()}"}
        response = requests.get(url, headers=headers, params={"status": "open"}, timeout=30)
        response.raise_for_status()
        payload = response.json()
        return payload.get("orders", [])

    def _cancel_order(self, order_id: str) -> str:
        prepared = self._api_request(
            "DELETE",
            f"/v0/markets/{self.market.symbol}/orders/{order_id}",
            auth=True,
        )
        if prepared is None:
            raise RuntimeError(f"Cancel prepare returned empty for order {order_id}")
        # Force a high gas limit: cancelling a native maker order reverts under the
        # standard estimate (custom error 0x782b2567 / gasleft check on auto-pull).
        return self._broadcast_prepared_tx(prepared, gas_override=self.cancel_gas)

    def _open_order_escrow_base_raw(self, market: "Market") -> int:
        """Base tokens locked in this market's open SELL orders (not visible in balanceOf)."""
        total = Decimal(0)
        try:
            for order in self._list_open_orders():
                if order.get("side") != "sell":
                    continue
                remaining = order.get("remaining") or order.get("amount") or "0"
                total += Decimal(str(remaining))
        except Exception as exc:
            logger.warning(f"escrow base lookup failed: {exc}")
            return 0
        return int(total * (Decimal(10) ** market.base_decimals))

    def _open_order_escrow_quote_raw(self, market: "Market") -> int:
        """Quote (USDso) locked in this market's open BUY orders."""
        total = Decimal(0)
        try:
            for order in self._list_open_orders():
                if order.get("side") != "buy":
                    continue
                remaining = order.get("remaining") or order.get("amount") or "0"
                price = order.get("price") or "0"
                total += Decimal(str(remaining)) * Decimal(str(price))
        except Exception as exc:
            logger.warning(f"escrow quote lookup failed: {exc}")
            return 0
        return int(total * (Decimal(10) ** market.quote_decimals))

    def _base_inventory_with_escrow_raw(self, market: "Market") -> int:
        """True base inventory = wallet balance + base locked in open sell orders.

        For native-base markets balanceOf hides escrow, so naive sizing double-buys.
        """
        self._set_active_market(market.symbol)
        return self._token_balance(market.base) + self._open_order_escrow_base_raw(market)

    def _reap_stale_orders(self, max_age_sec: float) -> int:
        """Cancel any open order older than max_age_sec across all watched markets.

        Safety net against orphaned escrow (the root cause of the 'disappearing
        funds' incident). max_age_sec must exceed any active strategy's hold time.
        """
        now_ms = time.time() * 1000.0
        cancelled = 0
        for symbol in list(self.markets_registry.keys()):
            try:
                self._set_active_market(symbol)
                for order in self._list_open_orders():
                    created = float(order.get("createdAt", 0) or 0)
                    age_sec = (now_ms - created) / 1000.0 if created else 0.0
                    if created and age_sec < max_age_sec:
                        continue
                    oid = str(order.get("id"))
                    try:
                        tx = self._cancel_order(oid)
                        if not self.dry_run:
                            self.web3.eth.wait_for_transaction_receipt(tx, timeout=90)
                        cancelled += 1
                        logger.warning(
                            f"Reaper cancelled stale {order.get('side')} {symbol} "
                            f"age={age_sec:.0f}s amount={order.get('remaining')} id={oid[:12]}…"
                        )
                    except Exception as exc:
                        logger.warning(f"Reaper cancel failed {symbol} {oid[:12]}: {exc}")
            except Exception as exc:
                logger.warning(f"Reaper scan failed {symbol}: {exc}")
        return cancelled

    def _log_inventory_reconciliation(self, tag: str = "") -> None:
        """Log wallet balance + open-order escrow per market so invisible inventory
        can never silently accumulate again."""
        lines = []
        for symbol, market in self.markets_registry.items():
            try:
                self._set_active_market(symbol)
                bal = self._token_balance(market.base)
                esc_b = self._open_order_escrow_base_raw(market)
                esc_q = self._open_order_escrow_quote_raw(market)
                bd = Decimal(10) ** market.base_decimals
                qd = Decimal(10) ** market.quote_decimals
                lines.append(
                    f"{symbol}: base_wallet={Decimal(bal)/bd:.4f} "
                    f"base_in_sells={Decimal(esc_b)/bd:.4f} "
                    f"usdso_in_buys={Decimal(esc_q)/qd:.2f}"
                )
            except Exception as exc:
                lines.append(f"{symbol}: reconcile err {exc}")
        logger.info(f"Inventory reconciliation {tag}: " + " | ".join(lines))

    def _reduce_order(self, order_id: str, new_quantity_remaining: int) -> str:
        amount = self._decimal_string(new_quantity_remaining, self.market.base_decimals)
        prepared = self._api_request(
            "PATCH",
            f"/v0/markets/{self.market.symbol}/orders/{order_id}/reduce",
            body={"newQuantityRemaining": amount},
            auth=True,
        )
        if prepared is None:
            raise RuntimeError(f"Reduce prepare returned empty for order {order_id}")
        return self._broadcast_prepared_tx(prepared)

    def _fetch_my_trades(self, since_ms: Optional[int] = None) -> List[Dict[str, Any]]:
        path = f"/v0/markets/{self.market.symbol}/trades/mine"
        url = f"{self.market_data_base.rstrip('/')}{path}"
        headers = {"Accept": "application/json", "Authorization": f"Bearer {self._get_api_token()}"}
        params: Dict[str, Any] = {}
        if since_ms is not None:
            params["since"] = since_ms
        response = requests.get(url, headers=headers, params=params, timeout=30)
        response.raise_for_status()
        payload = response.json()
        return payload.get("trades", [])

    def _sync_api_volume(self) -> None:
        since_ms = self._last_trades_since_ms or int((time.time() - 3600) * 1000)
        trades = self._fetch_my_trades(since_ms=since_ms)
        added = Decimal(0)
        latest_ts = since_ms
        for trade in trades:
            cost = trade.get("cost")
            if cost:
                added += Decimal(str(cost))
            ts = int(trade.get("timestamp", 0))
            if ts > latest_ts:
                latest_ts = ts
        if trades:
            self._last_trades_since_ms = latest_ts + 1
        if added > 0:
            raw_added = int(added * (Decimal(10) ** self.market.quote_decimals))
            self.metrics["api_volume_quote_raw"] = int(self.metrics.get("api_volume_quote_raw", 0)) + raw_added

    def _update_pnl_metrics(self, best_bid: Optional[int] = None, best_ask: Optional[int] = None) -> None:
        self._sync_api_volume()
        current = self._portfolio_value_quote_raw(best_bid, best_ask)
        if self._initial_portfolio_quote_raw is not None:
            self.metrics["pnl_quote_raw"] = current - self._initial_portfolio_quote_raw

    def _drawdown_exceeded(self, best_bid: Optional[int] = None, best_ask: Optional[int] = None) -> bool:
        if self._initial_portfolio_quote_raw is None or self._initial_portfolio_quote_raw <= 0:
            return False
        self._update_pnl_metrics(best_bid, best_ask)
        pnl = int(self.metrics.get("pnl_quote_raw", 0))
        limit = int(self._initial_portfolio_quote_raw * self.max_drawdown_pct)
        breached = pnl < -limit
        if breached and not self.drawdown_stop:
            quote_decimals = next(iter(self.markets_registry.values())).quote_decimals
            pnl_human = pnl / (10 ** quote_decimals)
            logger.warning(
                f"Drawdown soft limit hit (pnl={pnl_human:.2f}, limit=-{limit / (10 ** quote_decimals):.2f}) "
                f"— continuing (drawdown_stop=false)"
            )
            return False
        return breached

    async def _start_websocket(self) -> None:
        if not self.use_websocket:
            return
        try:
            from ws_book import MultiOrderBookFeed, OrderBookFeed

            ws_url = self.cfg.get("ws_url", "wss://api.dreamdex.io/v0/ws/public")
            if len(self.watch_symbols) > 1:
                quote_decimals = next(iter(self.markets_registry.values())).quote_decimals
                self._ws_multi_book = MultiOrderBookFeed(
                    self.watch_symbols, ws_url=ws_url, quote_decimals=quote_decimals
                )
                await self._ws_multi_book.start()
            else:
                self._ws_book = OrderBookFeed(self.market.symbol, ws_url=ws_url)
                await self._ws_book.start(self.market.quote_decimals)
            await asyncio.sleep(1.0)
        except Exception as exc:
            logger.warning(f"WebSocket orderbook unavailable, using RPC: {exc}")
            self._ws_book = None
            self._ws_multi_book = None

    async def _stop_websocket(self) -> None:
        if self._ws_multi_book is not None:
            await self._ws_multi_book.stop()
        if self._ws_book is not None:
            await self._ws_book.stop()

    def _save_metrics(self) -> None:
        with open(self.metrics_path, "w", encoding="utf-8") as handle:
            json.dump(self.metrics, handle)

    def _save_state(self, last_tx: str) -> None:
        now = int(time.time())
        self.metrics["last_activity_at"] = now
        state = {
            "wallet": self.address,
            "market": self.market.symbol,
            "pool": self.market.pool,
            "last_tx": last_tx,
            "updated_at": now,
        }
        with open(self.state_path, "w", encoding="utf-8") as handle:
            json.dump(state, handle)
        self._save_metrics()

    async def run(self) -> None:
        logger.info(f"Connected wallet: {self.address}")
        logger.info(f"Market: {self.market.symbol} | pool={self.market.pool}")
        logger.info(f"Chain ID: {self.cfg.get('chain_id', 5031)}")
        logger.info(f"Strategy: {self.strategy_name}")
        if self.dry_run:
            logger.info("DRY RUN mode enabled — no transactions will be broadcast")

        await self._start_websocket()
        try:
            if self.strategy_name == "competition":
                from strategies.competition import CompetitionStrategy

                await CompetitionStrategy(self).run()
            elif self.strategy_name == "multi_hybrid":
                from strategies.multi_hybrid import MultiHybridStrategy

                await MultiHybridStrategy(self).run()
            elif self.strategy_name == "hybrid":
                from strategies.hybrid import HybridStrategy

                await HybridStrategy(self).run()
            else:
                from strategies.taker import TakerStrategy

                await TakerStrategy(self).run()
        finally:
            await self._stop_websocket()
