# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
REST client for the DreamDEX HTTP API.

Auth flow (per docs):
  1. POST /v0/auth/nonce → returns a nonce + EIP-4361 message template (5 min TTL)
  2. Client signs the SIWE message with private key
  3. POST /v0/auth/login {signature, message} → returns {token, expiresAt}
  4. Subsequent requests carry Authorization: Bearer <token>
  5. On 401: re-run 1-3. There is no refresh-token endpoint.

Order flow:
  1. POST /v0/markets/{symbol}/orders → server returns an unsigned tx
  2. Client signs and broadcasts via the Signer
  3. Server picks up the on-chain event via its indexer

This client owns:
  - The active JWT (with proactive refresh ~60s before expiry)
  - Backoff and retry on transient failures (429 / 5xx)
  - Rate-limit response inspection (since dreamDEX docs don't specify limits,
    we treat any 429 as a real find and log it as evidence for a feedback report)
"""

from __future__ import annotations

import asyncio
import time
from typing import Any
from urllib.parse import urlparse

import httpx
from eth_account.messages import encode_defunct
from siwe import SiweMessage

from dreamdex_bot.core.signer import Signer
from dreamdex_bot.utils.logger import get_logger, EvidenceLog


log = get_logger(__name__)


ORDER_TYPE_TO_API = {
    "gtc": "normalOrder",
    "fok": "fillOrKill",
    "ioc": "immediateOrCancel",
    "post_only": "postOnly",
}


class AuthError(Exception):
    pass


class RateLimitedError(Exception):
    """Raised when API returns 429. We capture this as evidence — the docs
    don't currently document REST rate limits, so any 429 is a feedback finding."""


class RestClient:
    def __init__(
        self,
        api_base: str,
        signer: Signer,
        evidence: EvidenceLog | None = None,
        timeout: float = 10.0,
    ) -> None:
        self.api_base = api_base.rstrip("/")
        self.signer = signer
        self.evidence = evidence
        self._client = httpx.AsyncClient(timeout=timeout)
        self._jwt: str | None = None
        self._jwt_expires_at: float = 0.0
        self._auth_lock = asyncio.Lock()

    async def close(self) -> None:
        await self._client.aclose()

    # ────────────────────────────────────────────────────────────────
    # Auth
    # ────────────────────────────────────────────────────────────────

    async def ensure_auth(self) -> str:
        """Return a valid JWT, refreshing if within 60s of expiry."""
        async with self._auth_lock:
            if self._jwt and time.time() < self._jwt_expires_at - 60:
                return self._jwt
            return await self._authenticate()

    async def _authenticate(self) -> str:
        """Run the full SIWE auth flow. Caller holds the lock."""
        # Step 1: get nonce
        r = await self._client.get(
            f"{self.api_base}/v0/auth/nonce",
        )
        r.raise_for_status()
        nonce_data = r.json()
        nonce = nonce_data["nonce"]
        message_str = nonce_data.get("message")  # If server provides full message
        # If the server returns just the nonce, we construct the SIWE message ourselves
        if message_str is None:
            parsed_api_base = urlparse(self.api_base)
            siwe = SiweMessage(
                domain=parsed_api_base.netloc,
                address=self.signer.address,
                statement="Sign in to DreamDEX",
                uri=self.api_base,
                version="1",
                chain_id=self.signer.chain_id,
                nonce=nonce,
                issued_at=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            )
            message_str = siwe.prepare_message()

        # Step 2: sign
        encoded = encode_defunct(text=message_str)
        signature = self.signer.account.sign_message(encoded).signature.hex()
        if not signature.startswith("0x"):
            signature = "0x" + signature

        # Step 3: login
        r = await self._client.post(
            f"{self.api_base}/v0/auth/login",
            json={
                "message": message_str,
                "signature": signature,
            },
        )
        if r.status_code != 200:
            if self.evidence:
                self.evidence.record(
                    event="auth_login_failed",
                    category="auth",
                    status=r.status_code,
                    body=r.text[:1000],
                )
            log.error("auth.login_failed", status=r.status_code, body=r.text[:500])
            raise AuthError(f"SIWE login failed: {r.status_code} {r.text}")
        login_data = r.json()
        self._jwt = login_data.get("token") or login_data.get("jwt")
        if not self._jwt:
            raise AuthError("SIWE login response did not include token")
        # expiresAt may be ISO timestamp or epoch — handle both
        exp = login_data.get("expiresAt")
        if isinstance(exp, str):
            from datetime import datetime
            self._jwt_expires_at = datetime.fromisoformat(exp.replace("Z", "+00:00")).timestamp()
        else:
            exp_float = float(exp)
            # Docs use Unix timestamp in milliseconds.
            self._jwt_expires_at = exp_float / 1000 if exp_float > 10_000_000_000 else exp_float
        log.info("auth.logged_in", expires_in=self._jwt_expires_at - time.time())
        return self._jwt

    # ────────────────────────────────────────────────────────────────
    # Request layer
    # ────────────────────────────────────────────────────────────────

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict | None = None,
        json_body: dict | None = None,
        authed: bool = True,
        max_retries: int = 3,
    ) -> Any:
        url = f"{self.api_base}{path}"
        headers: dict[str, str] = {}
        if authed:
            jwt = await self.ensure_auth()
            headers["Authorization"] = f"Bearer {jwt}"

        for attempt in range(max_retries):
            t0 = time.time()
            r = await self._client.request(method, url, params=params, json=json_body, headers=headers)
            latency_ms = (time.time() - t0) * 1000

            if r.status_code == 200:
                return r.json()

            if r.status_code == 401 and authed:
                # JWT may have expired before our proactive refresh; force re-auth and retry
                if self.evidence:
                    self.evidence.record(
                        event="rest_401_reauth",
                        category="api",
                        path=path,
                        method=method,
                        status=401,
                        body=r.text[:1000],
                    )
                log.warning("rest.401_reauth", path=path)
                self._jwt = None
                self._jwt_expires_at = 0
                async with self._auth_lock:
                    await self._authenticate()
                headers["Authorization"] = f"Bearer {self._jwt}"
                continue

            if r.status_code == 429:
                # FEEDBACK-WORTHY: undocumented rate limit. Capture evidence.
                if self.evidence:
                    self.evidence.record(
                        event="rest_rate_limit",
                        category="api",
                        probe="rest_rate_limit",
                        path=path, method=method,
                        status=429, body=r.text[:1000],
                        retry_after=r.headers.get("Retry-After"),
                        verdict="undocumented_rate_limit_observed",
                    )
                log.warning("rest.429", path=path, attempt=attempt)
                await asyncio.sleep(min(2 ** attempt, 8))
                continue

            if 500 <= r.status_code < 600:
                if self.evidence:
                    self.evidence.record(
                        event="rest_5xx",
                        category="api",
                        path=path,
                        method=method,
                        status=r.status_code,
                        body=r.text[:1000],
                        attempt=attempt,
                    )
                log.warning("rest.5xx", path=path, status=r.status_code, attempt=attempt)
                await asyncio.sleep(min(2 ** attempt, 8))
                continue

            # 4xx (other than 401/429) — non-retryable. Log + raise.
            if self.evidence:
                self.evidence.record(
                    event="rest_4xx",
                    category="api",
                    path=path,
                    method=method,
                    status=r.status_code,
                    body=r.text[:1000],
                    latency_ms=latency_ms,
                )
            log.error("rest.4xx", path=path, status=r.status_code, body=r.text[:500], latency_ms=latency_ms)
            r.raise_for_status()

        raise RateLimitedError(f"{method} {path} failed after {max_retries} retries")

    # ────────────────────────────────────────────────────────────────
    # Endpoint wrappers — fill in as we map the docs to code.
    # Each one is a thin pass-through that logs request/response.
    # ────────────────────────────────────────────────────────────────

    async def get_markets(self) -> list[dict[str, Any]]:
        data = await self._request("GET", "/v0/markets", authed=False)
        if isinstance(data, dict):
            return data.get("markets", [])
        return data

    async def get_orderbook(self, market: str, depth: int = 20) -> dict[str, Any]:
        data = await self._request(
            "GET", "/v0/orderbooks",
            params={"symbols": market, "depth": depth}, authed=False,
        )
        books = data.get("orderbooks", []) if isinstance(data, dict) else []
        for book in books:
            if book.get("symbol") == market:
                return {
                    "market": book.get("symbol", market),
                    "bids": book.get("bids", []),
                    "asks": book.get("asks", []),
                    "timestamp": book.get("timestamp"),
                }
        return {"market": market, "bids": [], "asks": []}

    async def get_my_orders(
        self,
        market: str | None = None,
        markets: list[str] | None = None,
        status: str | None = "open",
    ) -> list[dict[str, Any]]:
        symbols = [market] if market else (markets or [])
        if not symbols:
            raise ValueError("get_my_orders requires market or markets")
        out: list[dict[str, Any]] = []
        for symbol in symbols:
            params = {"status": status} if status else None
            data = await self._request("GET", f"/v0/markets/{symbol}/orders", params=params)
            raw_orders = data if isinstance(data, list) else data.get("orders", [])
            for order in raw_orders:
                out.append(self.normalize_order(order))
        return out

    async def get_account_balances(self, address: str, markets: list[str] | None = None) -> dict[str, Any]:
        """Fetch documented vault balances per market.

        The docs expose vault balances only:
        GET /v0/markets/{symbol}/vault/balance?walletAddress=...
        Wallet balances still need on-chain reads.
        """
        if not markets:
            return {}

        async def _fetch_one(symbol: str) -> tuple[str, dict[str, Any] | None]:
            try:
                data = await self._request(
                    "GET", f"/v0/markets/{symbol}/vault/balance",
                    params={"walletAddress": address},
                )
            except Exception as e:
                log.warning("rest.vault_balance_unavailable", market=symbol, error=str(e))
                return symbol, None
            return symbol, data

        # Layer 3: parallel per-market REST calls. Safe with F9 nonce resync
        # AND the streak-race fix in _execute_signal that ignores "nonce too
        # low" (since signer auto-recovers those).
        results = await asyncio.gather(*(_fetch_one(s) for s in markets))

        out: dict[str, Any] = {}
        for symbol, data in results:
            if data is None:
                continue
            entry = {"walletBase": "0", "walletQuote": "0", "vaultBase": "0", "vaultQuote": "0"}
            for bal in data.get("balances", []):
                currency = str(bal.get("currency", ""))
                amount = str(bal.get("amount", "0"))
                base_code, quote_code = symbol.split(":", 1)
                if currency in {base_code, base_code.replace(".e", "")}:
                    entry["vaultBase"] = amount
                elif currency == quote_code:
                    entry["vaultQuote"] = amount
            out[symbol] = entry
        return out

    async def prepare_order(
        self,
        market: str,
        side: str,
        order_type: str,
        quantity: str,
        price: str | None,
        funding: str,  # "wallet" | "vault"
        client_order_id: str,
        wallet_address: str | None = None,
        self_matching_option: str = "cancelTaker",
    ) -> dict[str, Any]:
        """POST /v0/markets/{symbol}/orders → returns an unsigned tx."""
        body = {
            "type": "limit" if price is not None else "market",
            "side": side,
            "amount": quantity,
            "fundingSource": funding,
            "orderType": ORDER_TYPE_TO_API.get(order_type, order_type),
            "selfMatchingOption": self_matching_option,
        }
        if wallet_address is not None:
            body["walletAddress"] = wallet_address
        if price is not None:
            body["price"] = price
        return await self._request("POST", f"/v0/markets/{market}/orders", json_body=body)

    async def prepare_cancel(self, market: str, order_id: str) -> dict[str, Any]:
        return await self._request("DELETE", f"/v0/markets/{market}/orders/{order_id}")

    async def prepare_vault_approve(
        self, market: str, wallet_address: str, currency: str, amount: str,
    ) -> dict[str, Any] | None:
        return await self._request(
            "POST", f"/v0/markets/{market}/vault/approve",
            json_body={"walletAddress": wallet_address, "currency": currency, "amount": amount},
        )

    async def prepare_vault_deposit(
        self, market: str, wallet_address: str, currency: str, amount: str,
    ) -> dict[str, Any]:
        return await self._request(
            "POST", f"/v0/markets/{market}/vault/deposit",
            json_body={"walletAddress": wallet_address, "currency": currency, "amount": amount},
        )

    async def prepare_vault_withdraw(
        self, market: str, wallet_address: str, currency: str, amount: str,
    ) -> dict[str, Any]:
        return await self._request(
            "POST", f"/v0/markets/{market}/vault/withdraw",
            json_body={"walletAddress": wallet_address, "currency": currency, "amount": amount},
        )

    def normalize_order(self, order: dict[str, Any]) -> dict[str, Any]:
        """Convert documented REST order fields to the engine's internal shape."""
        normalized = dict(order)
        if "symbol" in order and "market" not in normalized:
            normalized["market"] = order["symbol"]
        if "id" in order and "orderId" not in normalized:
            normalized["orderId"] = str(order["id"])
        if "amount" in order and "quantity" not in normalized:
            normalized["quantity"] = order["amount"]
        if "remaining" in order and "remainingQuantity" not in normalized:
            normalized["remainingQuantity"] = order["remaining"]
        status = str(normalized.get("status", "")).lower()
        if status == "canceled":
            normalized["status"] = "cancelled"
        return normalized
