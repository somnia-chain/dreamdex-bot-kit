# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""Tests for RestClient: auth flow, 401 re-auth, 429 evidence capture, retries."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from dreamdex_bot.core.rest_client import RateLimitedError, RestClient


@pytest.fixture
def fake_signer():
    """A minimal signer that returns a deterministic fake signature."""
    signer = MagicMock()
    signer.address = "0x" + "1" * 40
    # eth_account.sign_message returns an object with .signature
    signed = MagicMock()
    signed.signature.hex.return_value = "ff" * 65
    signer.account.sign_message.return_value = signed
    return signer


@pytest.fixture
def rest_client(fake_signer):
    client = RestClient(api_base="https://api.test", signer=fake_signer)
    return client


def make_response(status: int, body=None, text: str = "", headers: dict | None = None):
    """Build an httpx.Response stand-in."""
    r = MagicMock(spec=httpx.Response)
    r.status_code = status
    r.json.return_value = body if body is not None else {}
    r.text = text or (str(body) if body is not None else "")
    r.headers = headers or {}
    r.raise_for_status = MagicMock()
    if status >= 400:
        r.raise_for_status.side_effect = httpx.HTTPStatusError(
            f"{status}", request=MagicMock(), response=r,
        )
    return r


class TestPublicEndpoint:
    @pytest.mark.asyncio
    async def test_get_markets_does_not_require_auth(self, rest_client):
        """get_markets is unauthed — should never trigger SIWE flow."""
        markets_response = {"markets": [{"symbol": "WETH:USDso"}]}
        with patch.object(rest_client._client, "request", new=AsyncMock(
                return_value=make_response(200, markets_response))) as mock_req:
            result = await rest_client.get_markets()
            assert result == markets_response["markets"]
            # Should be called exactly once — no auth round-trip
            assert mock_req.await_count == 1
            # And no Authorization header should have been sent
            _, call_kwargs = mock_req.await_args
            assert "Authorization" not in (call_kwargs.get("headers") or {})


class TestAuthFlow:
    @pytest.mark.asyncio
    async def test_authed_call_triggers_siwe_first(self, rest_client):
        """First authed call: nonce → sign → login → real request."""
        nonce_response = {"nonce": "abc123", "message": "siwe-message-template"}
        login_response = {"jwt": "fake.jwt.token", "expiresAt": 9999999999}
        orders_response = []

        with patch.object(rest_client._client, "request", new=AsyncMock()) as mock_req, \
             patch("dreamdex_bot.core.rest_client.SiweMessage") as mock_siwe:
            # Mock SIWE message construction + signing prep
            mock_siwe_instance = MagicMock()
            mock_siwe_instance.prepare_message.return_value = "prepared-siwe-message"
            mock_siwe.from_message.return_value = mock_siwe_instance

            mock_req.side_effect = [
                make_response(200, nonce_response),
                make_response(200, login_response),
                make_response(200, orders_response),
            ]

            result = await rest_client.get_my_orders(market="SOMI:USDso")
            assert result == orders_response
            # nonce, login, then orders → 3 calls
            assert mock_req.await_count == 3


class TestRetry401:
    @pytest.mark.asyncio
    async def test_401_triggers_reauth_and_retries(self, rest_client):
        """When a 401 hits mid-session, we should re-auth and retry the same request."""
        # Pre-populate JWT so the first request goes straight to the endpoint
        rest_client._jwt = "stale-jwt"
        rest_client._jwt_expires_at = 9999999999

        success_body = [{"orderId": "1"}]
        with patch.object(rest_client._client, "request", new=AsyncMock()) as mock_req, \
             patch("dreamdex_bot.core.rest_client.SiweMessage") as mock_siwe:
            mock_siwe_instance = MagicMock()
            mock_siwe_instance.prepare_message.return_value = "siwe-msg"
            mock_siwe.from_message.return_value = mock_siwe_instance

            mock_req.side_effect = [
                make_response(401, text="jwt expired"),          # stale token rejected
                make_response(200, {"nonce": "n", "message": "m"}),  # new nonce
                make_response(200, {"jwt": "fresh-jwt", "expiresAt": 9999999999}),  # re-login
                make_response(200, success_body),                # retried orders request
            ]
            result = await rest_client.get_my_orders(market="SOMI:USDso")
            assert result == success_body
            assert mock_req.await_count == 4
            assert rest_client._jwt == "fresh-jwt"


class TestRateLimit429:
    @pytest.mark.asyncio
    async def test_429_records_evidence_and_retries(self, rest_client):
        """A 429 response should be logged as evidence AND retried."""
        evidence = MagicMock()
        evidence.record = MagicMock()
        rest_client.evidence = evidence
        rest_client._jwt = "valid-jwt"
        rest_client._jwt_expires_at = 9999999999

        success = [{"orderId": "1"}]
        with patch.object(rest_client._client, "request", new=AsyncMock()) as mock_req, \
             patch("asyncio.sleep", new=AsyncMock()):  # skip the backoff delay
            mock_req.side_effect = [
                make_response(429, text="rate limited", headers={"Retry-After": "1"}),
                make_response(200, success),
            ]
            result = await rest_client.get_my_orders(market="SOMI:USDso")
            assert result == success
            # Evidence should have been recorded with status 429
            evidence.record.assert_called_once()
            kwargs = evidence.record.call_args.kwargs
            assert kwargs["status"] == 429
            assert kwargs["verdict"] == "undocumented_rate_limit_observed"
            assert kwargs["retry_after"] == "1"

    @pytest.mark.asyncio
    async def test_429_persistent_raises_after_max_retries(self, rest_client):
        """If 429 doesn't clear within max_retries, we raise RateLimitedError."""
        rest_client._jwt = "valid-jwt"
        rest_client._jwt_expires_at = 9999999999

        with patch.object(rest_client._client, "request", new=AsyncMock(
                return_value=make_response(429))), \
             patch("asyncio.sleep", new=AsyncMock()):
            with pytest.raises(RateLimitedError):
                await rest_client.get_my_orders(market="SOMI:USDso")


class TestRetry5xx:
    @pytest.mark.asyncio
    async def test_5xx_retries_then_succeeds(self, rest_client):
        rest_client._jwt = "valid-jwt"
        rest_client._jwt_expires_at = 9999999999

        success = [{"orderId": "x"}]
        with patch.object(rest_client._client, "request", new=AsyncMock()) as mock_req, \
             patch("asyncio.sleep", new=AsyncMock()):
            mock_req.side_effect = [
                make_response(503),
                make_response(200, success),
            ]
            result = await rest_client.get_my_orders(market="SOMI:USDso")
            assert result == success
            assert mock_req.await_count == 2


class TestBalanceFetchFallback:
    """The balance endpoint path is hypothetical; the client should swallow errors
    and return {} rather than crash the bot at startup."""

    @pytest.mark.asyncio
    async def test_balance_fetch_returns_empty_on_404(self, rest_client):
        rest_client._jwt = "valid-jwt"
        rest_client._jwt_expires_at = 9999999999

        with patch.object(rest_client._client, "request", new=AsyncMock(
                return_value=make_response(404, text="not found"))), \
             patch("asyncio.sleep", new=AsyncMock()):
            result = await rest_client.get_account_balances("0x" + "1" * 40)
            assert result == {}
