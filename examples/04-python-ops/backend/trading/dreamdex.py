# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

# backend/trading/dreamdex.py
"""
DreamDEX REST API wrapper.

Auth flow (SIWE → JWT):
  1. GET  /v0/auth/nonce  → { nonce }
  2. Build SIWE message, sign with private key
  3. POST /v0/auth/login  → { token, expiresAt }
  4. Use Bearer token on all authed endpoints

Order flow (HTTP-API path):
  1. POST /v0/markets/{symbol}/orders → returns unsigned tx
  2. If "approval" field present, sign+broadcast approve tx first
  3. Sign+broadcast the order tx
  4. Return tx hash

Order types:   "gtc" | "fillOrKill" | "immediateOrCancel" | "postOnly"
Funding:       "vault" | "wallet"

IMPORTANT GOTCHAS (from docs):
  - Market buy with fundingSource="wallet" returns 400 — use IOC limit above best ask
  - expireTimestampNs=0 is rejected on testnet — always set now+1h
  - placeOrder can return success=false with tx.status=1 (silent reject) — always check logs
  - Builder codes disabled in v1.0 — pass address(0) + 0
"""
import os
import time
import json
import datetime
import requests
from config import DREAMDEX_HTTP, MY_ADDRESS, CHAIN_ID
from trading.wallet import SomniaWallet


class DreamDEX:
    def __init__(self, private_key: str | None = None, address: str | None = None):
        self.base_url = DREAMDEX_HTTP
        self.wallet   = SomniaWallet(private_key=private_key, address=address)
        self._token: str | None  = None
        self._token_expiry: float = 0.0
        self._session = requests.Session()
        self._session.headers["Content-Type"] = "application/json"
        # Try to populate live tick/lot/min and real base token addresses
        # from /v0/markets. Falls back silently if the endpoint is unreachable
        # so unit tests / offline runs still work.
        try:
            self.refresh_market_params()
        except Exception as e:
            print(f"[DreamDEX] Boot-time /v0/markets refresh failed: {e}")

    def refresh_market_params(self):
        """Pull canonical base/quote/decimals/tick/lot/min from /v0/markets
        and patch the in-memory MARKETS dict. Docs (dreamdex-apis.md) require
        these be queried — hardcoded tick/lot tables drift."""
        from config import MARKETS
        markets = self.get_markets()
        if not markets:
            return
        patched = 0
        for m in markets:
            sym = m.get("symbol")
            if sym not in MARKETS:
                continue
            mkt = MARKETS[sym]
            base = m.get("base")
            quote = m.get("quote")
            # Only override base if doc gives a non-zero address. Native pools
            # legitimately use 0x0 sentinel — keep mkt["native"] as source of truth.
            # M5: only override base if config has the 0x0 sentinel. Otherwise
            # the hardcoded canonical mainnet address wins; we warn on mismatch
            # but don't silently replace (testnet API can return casing/quirks
            # that would corrupt mainnet config).
            cfg_base = (mkt.get("base") or "").lower()
            is_sentinel = cfg_base in ("", "0x0000000000000000000000000000000000000000")
            if base and int(base, 16) != 0 and not mkt.get("native"):
                if is_sentinel:
                    mkt["base"] = base
                elif cfg_base != base.lower():
                    print(f"[DreamDEX] ⚠️  API base {base} != config base {cfg_base} for {sym} — keeping config")
            if quote:
                cfg_quote = (mkt.get("quote") or "").lower()
                if cfg_quote in ("", "0x0000000000000000000000000000000000000000"):
                    mkt["quote"] = quote
                elif cfg_quote != quote.lower():
                    print(f"[DreamDEX] ⚠️  API quote {quote} != config quote {cfg_quote} for {sym} — keeping config")
            if "baseDecimals" in m:
                cfg_dec = int(mkt.get("baseDecimals", -1))
                api_dec = int(m["baseDecimals"])
                if cfg_dec == -1:
                    mkt["baseDecimals"] = api_dec
                elif cfg_dec != api_dec:
                    print(f"[DreamDEX] ⚠️  API baseDecimals {api_dec} != config {cfg_dec} for {sym} — keeping config")
            if "quoteDecimals" in m:
                cfg_dec = int(mkt.get("quoteDecimals", -1))
                api_dec = int(m["quoteDecimals"])
                if cfg_dec == -1:
                    mkt["quoteDecimals"] = api_dec
                elif cfg_dec != api_dec:
                    print(f"[DreamDEX] ⚠️  API quoteDecimals {api_dec} != config {cfg_dec} for {sym} — keeping config")
            # Floats parsed from string for downstream price/qty snapping
            for k in ("tickSize", "lotSize", "minQuantity"):
                if k in m:
                    try:
                        mkt[k] = float(m[k])
                    except (TypeError, ValueError):
                        pass
            patched += 1
        if patched:
            print(f"[DreamDEX] Refreshed pool params for {patched} markets from /v0/markets")

    # ── Auth ──────────────────────────────────────────────────────────

    def _ensure_auth(self):
        """Authenticate if no valid JWT token."""
        if self._token and time.time() < self._token_expiry - 60:
            return
        self._login()

    def _login(self):
        from urllib.parse import urlparse
        # Step 1: get nonce
        r = self._session.get(f"{self.base_url}/v0/auth/nonce", timeout=10)
        r.raise_for_status()
        nonce = r.json()["nonce"]

        # Step 2: build SIWE message
        # Domain must match the API server's registered domain (tested empirically)
        domain = urlparse(self.base_url).netloc  # e.g. stg.api.dreamdex.io or api.dreamdex.io
        now_iso = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        siwe_msg = (
            f"{domain} wants you to sign in with your Ethereum account:\n"
            f"{MY_ADDRESS}\n\n"
            f"Sign in to dreamDEX\n\n"
            f"URI: {self.base_url}\n"
            f"Version: 1\n"
            f"Chain ID: {CHAIN_ID}\n"
            f"Nonce: {nonce}\n"
            f"Issued At: {now_iso}"
        )

        # Step 3: sign
        signature = self.wallet.sign_message(siwe_msg)

        # Step 4: login
        r = self._session.post(
            f"{self.base_url}/v0/auth/login",
            json={"message": siwe_msg, "signature": signature},
            timeout=10,
        )
        if r.status_code != 200:
            # Surface the server's reason — SIWE domain/URI mismatch is the
            # most common cause and the response body usually names it.
            print(f"[DreamDEX] SIWE login {r.status_code}: {r.text[:500]}")
            print(f"[DreamDEX]   sent domain={domain} uri={self.base_url} chainId={CHAIN_ID}")
        r.raise_for_status()
        data = r.json()
        self._token = data["token"]
        # expiresAt may be ISO string or unix timestamp
        expires = data.get("expiresAt", "")
        try:
            self._token_expiry = datetime.datetime.fromisoformat(
                expires.replace("Z", "+00:00")
            ).timestamp()
        except Exception:
            self._token_expiry = time.time() + 3600
        self._session.headers["Authorization"] = f"Bearer {self._token}"
        print(f"[DreamDEX] Authenticated — token expires at {expires}")

    # ── Market data (no auth) ─────────────────────────────────────────

    def get_markets(self) -> list:
        r = self._session.get(f"{self.base_url}/v0/markets", timeout=10)
        r.raise_for_status()
        data = r.json()
        return data.get("markets", data) if isinstance(data, dict) else data

    def get_ticker(self, symbol: str) -> dict:
        """24h OHLCV snapshot for a market. Returns {} on error."""
        try:
            r = self._session.get(
                f"{self.base_url}/v0/markets/{symbol}/tickers", timeout=5
            )
            if r.status_code == 200:
                return r.json()
        except Exception as e:
            print(f"[DreamDEX] ticker error {symbol}: {e}")
        return {}

    def get_recent_trades(self, symbol: str, limit: int = 5) -> list:
        try:
            r = self._session.get(
                f"{self.base_url}/v0/markets/{symbol}/trades",
                params={"limit": limit},
                timeout=5,
            )
            if r.status_code == 200:
                return r.json()
        except Exception as e:
            print(f"[DreamDEX] trades error {symbol}: {e}")
        return []

    def get_orderbook(self, symbol: str) -> dict:
        """Best bid / best ask from REST orderbook. Returns
        {'bid': float|None, 'ask': float|None, 'bid_qty': ..., 'ask_qty': ...}.
        Empty book is a legitimate testnet state — caller must check."""
        out = {"bid": None, "ask": None, "bid_qty": 0.0, "ask_qty": 0.0}
        for path, params in [
            (f"/v0/orderbooks", {"symbols": symbol}),
        ]:
            try:
                r = self._session.get(f"{self.base_url}{path}", params=params, timeout=5)
                if r.status_code != 200:
                    continue
                data = r.json()
                # Real shape: {"orderbooks":[{"asks":[{price,quantity}], "bids":[...]}]}
                book = data
                if isinstance(data, dict) and "orderbooks" in data and data["orderbooks"]:
                    book = data["orderbooks"][0]
                elif isinstance(data, dict) and "symbols" in data and data["symbols"]:
                    book = data["symbols"][0]
                elif isinstance(data, list) and data:
                    book = data[0]
                bids = book.get("bids") or []
                asks = book.get("asks") or []
                if bids:
                    top = bids[0]
                    out["bid"]     = float(top.get("price", top[0] if isinstance(top, list) else 0))
                    out["bid_qty"] = float(top.get("quantity", top[1] if isinstance(top, list) else 0))
                if asks:
                    top = asks[0]
                    out["ask"]     = float(top.get("price", top[0] if isinstance(top, list) else 0))
                    out["ask_qty"] = float(top.get("quantity", top[1] if isinstance(top, list) else 0))
                if out["bid"] or out["ask"]:
                    return out
            except Exception as e:
                print(f"[DreamDEX] orderbook {path} err: {e}")
        return out

    # ── Order simulation (eth_call, no gas) ───────────────────────────

    def simulate_order_tx(self, tx: dict) -> tuple[bool, int, str]:
        """Replay the prepared tx via eth_call before broadcasting.
        Docs (dreamdex-contracts.md): if returned success==false, do not
        broadcast. Returns (success, orderId, raw_hex)."""
        from web3 import Web3
        try:
            call_obj = {
                "to":    Web3.to_checksum_address(tx["to"]),
                "from":  Web3.to_checksum_address(self.wallet.address),
                "data":  tx.get("data", "0x"),
                "value": int(tx.get("value", 0)),
            }
            raw = self.wallet.w3.eth.call(call_obj)
            raw_hex = raw.hex() if hasattr(raw, "hex") else str(raw)
            # Normalize: web3.py v7's bytes.hex() returns WITHOUT 0x prefix.
            h = raw_hex[2:] if raw_hex.startswith("0x") else raw_hex
            # placeOrder returns (bool success, uint128 orderId) → 64 bytes = 128 hex chars
            if not h or len(h) < 128:
                return (False, 0, raw_hex or "")
            success = int(h[0:64], 16) == 1
            order_id = int(h[64:128], 16)
            return (success, order_id, raw_hex)
        except Exception as e:
            # eth_call revert lands here — treat as "would revert"
            return (False, 0, f"revert: {e}")

    # ── Orders ────────────────────────────────────────────────────────

    def place_order(
        self,
        symbol: str,
        side: str,           # "buy" | "sell"
        qty: float,          # base token quantity (human units)
        order_type: str = "market",
        limit_price: float | None = None,
        funding: str = "wallet",
        skip_sim: bool = False,
    ) -> dict:
        """
        Prepare + sign + broadcast an order.
        Returns {"status": "success", "tx_hash": "0x..."}  or  {"status": "error", ...}
        """
        self._ensure_auth()

        # Map plan's order_type strings to DreamDEX API strings.
        # NOTE: API rejects "gtc" with HTTP 400 — enum is
        # [normalOrder, fillOrKill, immediateOrCancel, postOnly]
        # (docs/cheatsheet show "gtc" — that's a doc-impl mismatch).
        type_map = {
            "market":    "immediateOrCancel",
            "limit":     "normalOrder",
            "gtc":       "normalOrder",
            "ioc":       "immediateOrCancel",
            "fok":       "fillOrKill",
            "postonly":  "postOnly",
            "post_only": "postOnly",
        }
        api_order_type = type_map.get(order_type.lower(), "immediateOrCancel")

        payload: dict = {
            "side":          side.lower(),
            "amount":        str(qty),
            "walletAddress": MY_ADDRESS,
            "fundingSource": funding,
            "orderType":     api_order_type,
        }
        # Price required for limit/postOnly. For "market" we still post a limit
        # priced to cross the live book — `priceRaw=0` is NOT interpreted as
        # market by the contract (devrel confirmed). So we need a real price
        # at-or-better than the opposite side's top of book.
        from config import MARKETS
        tick = float(MARKETS.get(symbol, {}).get("tickSize", 0.0001))

        if limit_price:
            payload["type"]  = "limit"
            payload["price"] = str(limit_price)
        else:
            payload["type"] = "limit"
            book = self.get_orderbook(symbol)
            if side.lower() == "buy":
                top = book["ask"]
                if not top:
                    return {"status": "error", "error": "no asks in book — would silent-reject"}
                # R3: +1 tick was empirically not crossing on mainnet (likely
                # JIT/MEV layer pulls the ask). +5 ticks fills cleanly via
                # wallet funding. Tiny extra slippage for actual fills.
                raw_price = top + 5 * tick
            else:
                top = book["bid"]
                if not top:
                    return {"status": "error", "error": "no bids in book — would silent-reject"}
                # Symmetric buffer for sells. Wallet-funded sells fill at -1 tick
                # in our tests, but keep some headroom for thin-bid moments.
                raw_price = max(top - 3 * tick, tick)
            # M2: format price at exactly the tick's decimal precision so
            # floating-point artifacts (0.0000999…) don't survive rstrip("0").
            tick_str = f"{tick:.10f}".rstrip("0")
            tick_decimals = max(0, len(tick_str.split(".")[1])) if "." in tick_str else 0
            snapped = round(round(raw_price / tick) * tick, tick_decimals)
            payload["price"] = f"{snapped:.{tick_decimals}f}"
            print(f"[DreamDEX] book top: bid={book['bid']} ask={book['ask']}  → limit {payload['price']}")

        try:
            r = self._session.post(
                f"{self.base_url}/v0/markets/{symbol}/orders",
                json=payload,
                timeout=15,
            )
            if r.status_code != 200:
                print(f"[DreamDEX] place_order HTTP {r.status_code}: {r.text[:300]}")
                return {"status": "error", "code": r.status_code, "body": r.text[:300]}

            resp = r.json()

            # Handle optional ERC-20 approval
            if resp.get("approval"):
                print(f"[DreamDEX] Allowance insufficient. Approving token on-chain first...")
                app_token = resp["approval"]["token"]
                app_amount = float(resp["approval"]["amount"])

                from web3 import Web3
                token_addr_checksum = Web3.to_checksum_address(app_token)

                erc20_abi = [
                    {"name": "approve", "type": "function", "stateMutability": "nonpayable",
                     "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
                     "outputs": [{"name": "", "type": "bool"}]},
                    {"name": "decimals", "type": "function", "stateMutability": "view",
                     "inputs": [], "outputs": [{"name": "", "type": "uint8"}]},
                ]
                token_contract = self.wallet.w3.eth.contract(address=token_addr_checksum, abi=erc20_abi)
                # Prefer the on-chain decimals(); fall back to MARKETS metadata
                # rather than blindly defaulting to 18 — over-approves 1e10x on WBTC.
                from config import MARKETS
                mkt = MARKETS.get(symbol, {})
                fallback_dec = 18
                if app_token.lower() == str(mkt.get("base", "")).lower():
                    fallback_dec = int(mkt.get("baseDecimals", 18))
                elif app_token.lower() == str(mkt.get("quote", "")).lower():
                    fallback_dec = int(mkt.get("quoteDecimals", 18))
                try:
                    dec = token_contract.functions.decimals().call()
                except Exception:
                    dec = fallback_dec

                # H2: cap approve at 2x the order's actual cost. If the API ever
                # returns the amount as a raw integer (already 10^dec scaled), the
                # naive `app_amount * 10^dec` would over-approve by 1e6–1e18×.
                # Sanity bound: 2× (qty × price) in quote, or 2× qty in base.
                raw_naive = int(app_amount * (10 ** dec))
                # Compute the conservative cap. Use the order's own price/qty.
                from config import MARKETS as _M
                _mkt = _M.get(symbol, {})
                if app_token.lower() == str(_mkt.get("quote", "")).lower():
                    cap_human = float(payload.get("price", "0") or 0) * qty * 2.0
                else:
                    cap_human = qty * 2.0
                raw_cap = int(cap_human * (10 ** dec)) if cap_human > 0 else raw_naive
                # If naive is wildly bigger than cap (more than 1e4×), assume the
                # API returned a raw int already — use cap. Otherwise trust naive.
                if cap_human > 0 and raw_naive > raw_cap * 10_000:
                    print(f"[DreamDEX] ⚠️  approval.amount={app_amount} looks already-scaled; capping at {cap_human}")
                    raw_amount = raw_cap
                else:
                    raw_amount = raw_naive

                from config import MARKETS
                pool_addr = Web3.to_checksum_address(MARKETS[symbol]["contract"])

                tx = token_contract.functions.approve(pool_addr, raw_amount).build_transaction({
                    "from":  self.wallet.address,
                    "nonce": self.wallet.reserve_nonce(),
                    **self.wallet._gas_fields(),
                })
                from eth_account import Account
                try:
                    a_hash = self.wallet.sign_and_send(tx)
                except Exception:
                    self.wallet.reset_nonce()
                    raise
                self.wallet.wait_for_receipt(a_hash)
                print(f"[DreamDEX] Approve confirmed: {a_hash}")

            # Pre-flight eth_call simulation. Docs (dreamdex-contracts.md:183):
            # "Simulate first via eth_call. If success == false, do not broadcast."
            # Covers expireNs=0, self-trade, PostOnly cross, FOK underfill,
            # IOC no-match — all the silent-reject modes — without paying gas.
            if skip_sim:
                print("[DreamDEX] sim skipped (skip_sim=True) — broadcasting direct")
            else:
                sim_ok, sim_id, sim_raw = self.simulate_order_tx(resp)
                print(f"[DreamDEX] eth_call sim: success={sim_ok} orderId={sim_id} raw={sim_raw[:80]}")
                if not sim_ok:
                    return {"status": "would_revert", "sim_raw": sim_raw[:200]}

            # C4 + R1: capture pre-trade balances. Native pools deliver base to the
            # EOA wallet, not the vault — so for those we must read both vault and
            # wallet native. After tx mining we wait briefly to let dreamDEX's
            # in-block settlement land before re-reading. Fill is proven only if
            # BOTH sides moved in the expected direction (single-side movement =
            # order placed but didn't match, USDso/base just reserved).
            import time as _time
            from web3 import Web3 as _Web3
            from config import MARKETS as _MARKETS
            mkt = _MARKETS.get(symbol, {})
            is_native = bool(mkt.get("native"))
            pool_addr_cs = _Web3.to_checksum_address(resp.get("to") or mkt.get("contract", ""))
            quote_addr_cs = _Web3.to_checksum_address(mkt["quote"]) if mkt.get("quote") else None
            base_addr_cs = None
            if mkt.get("base") and not is_native and int(mkt["base"], 16) != 0:
                base_addr_cs = _Web3.to_checksum_address(mkt["base"])
            wb_abi = [{
                "name": "getWithdrawableBalance", "type": "function", "stateMutability": "view",
                "inputs": [{"name": "u", "type": "address"}, {"name": "t", "type": "address"}],
                "outputs": [{"name": "", "type": "uint256"}],
            }]
            erc20_abi = [{
                "name":"balanceOf","type":"function","stateMutability":"view",
                "inputs":[{"name":"a","type":"address"}],"outputs":[{"name":"","type":"uint256"}],
            }]
            pool_c = self.wallet.w3.eth.contract(address=pool_addr_cs, abi=wb_abi)
            quote_tok = self.wallet.w3.eth.contract(address=quote_addr_cs, abi=erc20_abi) if quote_addr_cs else None
            base_tok = self.wallet.w3.eth.contract(address=base_addr_cs, abi=erc20_abi) if base_addr_cs else None

            def _read_state():
                """Read both vault and wallet balances. The wallet side is what
                catches wallet-funded fills (which leave the vault untouched)."""
                st = {"v_quote": 0, "v_base": 0, "w_quote": 0, "w_base": 0, "w_native": 0}
                try:
                    if quote_addr_cs:
                        st["v_quote"] = pool_c.functions.getWithdrawableBalance(self.wallet.address, quote_addr_cs).call()
                except Exception:
                    pass
                try:
                    if base_addr_cs:
                        st["v_base"] = pool_c.functions.getWithdrawableBalance(self.wallet.address, base_addr_cs).call()
                except Exception:
                    pass
                try:
                    if quote_tok:
                        st["w_quote"] = quote_tok.functions.balanceOf(self.wallet.address).call()
                except Exception:
                    pass
                try:
                    if base_tok:
                        st["w_base"] = base_tok.functions.balanceOf(self.wallet.address).call()
                except Exception:
                    pass
                try:
                    st["w_native"] = self.wallet.w3.eth.get_balance(self.wallet.address)
                except Exception:
                    pass
                return st

            state_before = _read_state()

            # Sign + broadcast the order tx
            tx_hash = self.wallet.send_unsigned_tx(resp)
            print(f"[DreamDEX] Order TX sent: {tx_hash}")
            receipt = self.wallet.wait_for_receipt(tx_hash)

            # Tx-level revert?
            status = receipt.get("status")
            if status is not None and int(status) != 1:
                print(f"[DreamDEX] ❌ TX reverted on-chain (status={status})")
                return {"status": "reverted", "tx_hash": tx_hash}

            # R1: brief settlement delay — dreamDEX sometimes credits/debits
            # asynchronously within a few seconds of mining.
            _time.sleep(3)
            state_after = _read_state()

            # Estimate gas cost (in native units) so we don't mistake it for inventory loss.
            gas_used = int(receipt.get("gasUsed", 0) or 0)
            tx_obj = None
            try:
                tx_obj = self.wallet.w3.eth.get_transaction(tx_hash)
            except Exception:
                pass
            gas_price = 0
            if tx_obj is not None:
                gas_price = int(getattr(tx_obj, "effectiveGasPrice", 0) or tx_obj.get("gasPrice", 0) or 0)
            gas_cost_native = gas_used * gas_price  # in wei

            # Aggregate quote-side and base-side movement across BOTH vault and wallet,
            # so vault-funded AND wallet-funded fills both produce a clear signal.
            quote_out = (state_before["v_quote"] - state_after["v_quote"]) \
                      + (state_before["w_quote"] - state_after["w_quote"])
            quote_in  = -quote_out  # negative quote_out means quote came in
            v_base_in = state_after["v_base"] - state_before["v_base"]
            w_base_in = state_after["w_base"] - state_before["w_base"]
            native_net = state_after["w_native"] - state_before["w_native"] + gas_cost_native  # back out gas
            base_in_native = native_net if is_native else 0
            base_in_total = v_base_in + w_base_in + (base_in_native if base_in_native > 0 else 0)
            base_out_total = (state_before["v_base"] - state_after["v_base"]) \
                           + (state_before["w_base"] - state_after["w_base"]) \
                           + (-base_in_native if is_native and base_in_native < 0 else 0)

            fill_proven = False
            fill_summary = ""
            if side.lower() == "buy":
                # Buy: quote left wallet or vault AND base arrived somewhere.
                if quote_out > 0 and base_in_total > 0:
                    fill_proven = True
                    fill_summary = f"quote -{quote_out}, base +{base_in_total}"
                elif quote_out > 0 and base_in_total <= 0:
                    print(f"[DreamDEX] ⚠️  BUY {symbol}: quote -{quote_out} reserved, base +0 — placed_unfilled (no match)")
                    return {"status": "placed_unfilled", "tx_hash": tx_hash, "block": str(receipt.get("blockNumber")),
                            "reserved": quote_out, "side": "buy"}
            else:
                # Sell: base left wallet or vault AND quote arrived.
                if quote_in > 0 and base_out_total > 0:
                    fill_proven = True
                    fill_summary = f"base -{base_out_total}, quote +{quote_in}"
                elif base_out_total > 0 and quote_in <= 0:
                    print(f"[DreamDEX] ⚠️  SELL {symbol}: base -{base_out_total} reserved, quote +0 — placed_unfilled")
                    return {"status": "placed_unfilled", "tx_hash": tx_hash, "block": str(receipt.get("blockNumber")),
                            "reserved": base_out_total, "side": "sell"}

            if not fill_proven:
                # Neither side moved — true silent reject (or maybe wallet-funded with zero-side accounting).
                logs = receipt.get("logs", []) or []
                pool_addr_l = pool_addr_cs.lower()
                pool_logs = [l for l in logs if str(getattr(l, "address", l.get("address", ""))).lower() == pool_addr_l]
                if not pool_logs:
                    print(f"[DreamDEX] ⚠️  status=1 but no balance movement + no pool logs — silent reject")
                    return {"status": "silent_reject", "tx_hash": tx_hash}
                print(f"[DreamDEX] ⚠️  no balance movement but pool emitted logs — marking unverified")
                return {"status": "unverified", "tx_hash": tx_hash, "block": str(receipt.get("blockNumber"))}

            print(f"[DreamDEX] ✅ {side.upper()} {qty} {symbol} confirmed ({fill_summary}) "
                  f"(block {receipt.get('blockNumber')})")
            return {
                "status":      "success",
                "tx_hash":     tx_hash,
                "block":       str(receipt.get("blockNumber")),
                "vault_delta": fill_summary,
            }

        except Exception as e:
            print(f"[DreamDEX] place_order exception: {e}")
            return {"status": "error", "error": str(e)}

    def cancel_order(self, symbol: str, order_id: str) -> dict:
        """Cancel an open order by ID."""
        self._ensure_auth()
        try:
            r = self._session.delete(
                f"{self.base_url}/v0/markets/{symbol}/orders/{order_id}",
                timeout=10,
            )
            if r.status_code != 200:
                return {"status": "error", "code": r.status_code}
            resp = r.json()
            tx_hash = self.wallet.send_unsigned_tx(resp)
            receipt = self.wallet.wait_for_receipt(tx_hash)
            return {"status": "cancelled", "tx_hash": tx_hash}
        except Exception as e:
            return {"status": "error", "error": str(e)}

    def get_open_orders(self, symbol: str) -> list:
        """List open orders for the authed account."""
        self._ensure_auth()
        try:
            r = self._session.get(
                f"{self.base_url}/v0/markets/{symbol}/orders",
                params={"status": "open"},
                timeout=10,
            )
            if r.status_code == 200:
                return r.json() if isinstance(r.json(), list) else r.json().get("orders", [])
        except Exception as e:
            print(f"[DreamDEX] get_open_orders error: {e}")
        return []

    # ── Vault Deposit / Withdraw ──────────────────────────────────────

    def vault_deposit(self, symbol: str, token_addr: str, amount: float) -> str:
        """Approve and deposit base/quote tokens into the SpotPool vault."""
        from config import MARKETS
        from eth_account import Account
        from web3 import Web3

        mkt = MARKETS.get(symbol)
        if not mkt:
            raise ValueError(f"Unknown symbol: {symbol}")

        pool_addr = Web3.to_checksum_address(mkt["contract"])
        # is_native must be driven by the pool's nature, NOT by a 0x0 token
        # sentinel — non-native pools may still have a base addr we haven't
        # discovered yet. Only depositNative() on pools explicitly flagged native.
        is_native = bool(mkt.get("native")) and token_addr.lower() == mkt["base"].lower()
        if not is_native and (not token_addr or int(token_addr, 16) == 0):
            raise ValueError(
                f"vault_deposit: refusing to deposit token 0x0 on non-native pool "
                f"{symbol}. Real base address not yet discovered — "
                f"call refresh_market_params() or set MARKETS[{symbol!r}]['base'] explicitly."
            )
        token_addr_checksum = Web3.to_checksum_address(token_addr)

        # Determine decimals
        decimals = 18
        if token_addr.lower() == mkt["base"].lower():
            decimals = mkt["baseDecimals"]
        elif token_addr.lower() == mkt["quote"].lower():
            decimals = mkt["quoteDecimals"]

        raw_amount = int(amount * (10 ** decimals))

        if is_native:
            # Payable depositNative() call
            pool_abi = [
                {"name": "depositNative", "type": "function", "stateMutability": "payable",
                 "inputs": [], "outputs": []}
            ]
            pool = self.wallet.w3.eth.contract(address=pool_addr, abi=pool_abi)
            print(f"[DreamDEX] Depositing {amount} native STT into SpotPool {pool_addr}...")
            tx = pool.functions.depositNative().build_transaction({
                "from": self.wallet.address,
                "value": raw_amount,
                "nonce": self.wallet.reserve_nonce(),
                **self.wallet._gas_fields(),
            })
            tx_hash = self.wallet.sign_and_send(tx)
            self.wallet.wait_for_receipt(tx_hash)
            print(f"[DreamDEX] Native deposit confirmed: {tx_hash}")
            return tx_hash
        else:
            # Standard ERC20 deposit
            # 1. Approve if necessary
            erc20_abi = [
                {"name": "approve", "type": "function", "stateMutability": "nonpayable",
                 "inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}],
                 "outputs": [{"name": "", "type": "bool"}]},
                {"name": "allowance", "type": "function", "stateMutability": "view",
                 "inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}],
                 "outputs": [{"name": "", "type": "uint256"}]},
            ]
            token = self.wallet.w3.eth.contract(address=token_addr_checksum, abi=erc20_abi)
            allowance = token.functions.allowance(self.wallet.address, pool_addr).call()

            if allowance < raw_amount:
                print(f"[DreamDEX] Approving {amount} USDso/ERC20 to SpotPool {pool_addr}...")
                tx = token.functions.approve(pool_addr, raw_amount).build_transaction({
                    "from":  self.wallet.address,
                    "nonce": self.wallet.reserve_nonce(),
                    **self.wallet._gas_fields(),
                })
                tx_hash = self.wallet.sign_and_send(tx)
                self.wallet.wait_for_receipt(tx_hash)
                print(f"[DreamDEX] Approval confirmed: {tx_hash}")

            # 2. Deposit
            pool_abi = [
                {"name": "deposit", "type": "function", "stateMutability": "nonpayable",
                 "inputs": [{"name": "token", "type": "address"}, {"name": "amount", "type": "uint256"}],
                 "outputs": []}
            ]
            pool = self.wallet.w3.eth.contract(address=pool_addr, abi=pool_abi)
            print(f"[DreamDEX] Depositing {amount} token {token_addr} into SpotPool...")
            tx = pool.functions.deposit(token_addr_checksum, raw_amount).build_transaction({
                "from": self.wallet.address,
                "nonce": self.wallet.reserve_nonce(),
                **self.wallet._gas_fields(),
            })
            tx_hash = self.wallet.sign_and_send(tx)
            self.wallet.wait_for_receipt(tx_hash)
            print(f"[DreamDEX] Deposit confirmed: {tx_hash}")
            return tx_hash

    def vault_withdraw(self, symbol: str, token_addr: str, amount: float) -> str:
        """Withdraw base/quote tokens from the SpotPool vault back to the wallet."""
        from config import MARKETS
        from eth_account import Account
        from web3 import Web3

        mkt = MARKETS.get(symbol)
        if not mkt:
            raise ValueError(f"Unknown symbol: {symbol}")

        pool_addr = Web3.to_checksum_address(mkt["contract"])
        token_addr_checksum = Web3.to_checksum_address(token_addr)

        # Determine decimals
        decimals = 18
        if token_addr.lower() == mkt["base"].lower():
            decimals = mkt["baseDecimals"]
        elif token_addr.lower() == mkt["quote"].lower():
            decimals = mkt["quoteDecimals"]

        raw_amount = int(amount * (10 ** decimals))

        pool_abi = [
            {"name": "withdraw", "type": "function", "stateMutability": "nonpayable",
             "inputs": [{"name": "token", "type": "address"}, {"name": "amount", "type": "uint256"}],
             "outputs": []}
        ]
        pool = self.wallet.w3.eth.contract(address=pool_addr, abi=pool_abi)
        print(f"[DreamDEX] Withdrawing {amount} token {token_addr} from SpotPool vault...")
        tx = pool.functions.withdraw(token_addr_checksum, raw_amount).build_transaction({
            "from":  self.wallet.address,
            "nonce": self.wallet.reserve_nonce(),
            **self.wallet._gas_fields(),
        })
        tx_hash = self.wallet.sign_and_send(tx)
        self.wallet.wait_for_receipt(tx_hash)
        print(f"[DreamDEX] Withdrawal confirmed: {tx_hash}")
        return tx_hash

