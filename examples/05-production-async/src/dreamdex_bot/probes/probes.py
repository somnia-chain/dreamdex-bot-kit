# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
QA Prober — deliberately violates the protocol's rules to capture rejection
behavior, response shapes, and edge case handling. Each probe writes an
evidence log entry that feeds the feedback reports.

Probes are designed to be run ONE AT A TIME from a CLI:

    python -m dreamdex_bot.probes.run --probe tick_precision
    python -m dreamdex_bot.probes.run --probe stp
    python -m dreamdex_bot.probes.run --probe rate_limit_burst

This isolation is intentional: a single probe with a clean log is much easier
to turn into a feedback report than 14 interleaved probes.

Each probe function:
  - Returns a dict summarizing the finding (verdict, evidence file path)
  - Catches exceptions and records them as part of the evidence
  - Never leaves orders open (cleans up at the end)
"""

from __future__ import annotations

import asyncio
import time
from decimal import Decimal
from typing import Any

from eth_abi import decode, encode
from eth_utils import keccak

from dreamdex_bot.config import MARKETS, MarketSymbol, Settings
from dreamdex_bot.core.rest_client import RestClient
from dreamdex_bot.utils.logger import EvidenceLog, get_logger


log = get_logger(__name__)


# ════════════════════════════════════════════════════════════════════
# Probe 1: tick-size precision rejection
# ════════════════════════════════════════════════════════════════════

async def probe_tick_precision(rest: RestClient, evidence: EvidenceLog, market: str) -> dict:
    """Submit prices that violate tickSize. Capture how the API responds."""
    spec = MARKETS[MarketSymbol(market)]
    tick = spec.tick_size

    # Test 1: price not a multiple of tick (one raw unit off)
    off_grid = Decimal("1.0") + tick / 2  # halfway between two ticks
    try:
        result = await rest.prepare_order(
            market=market, side="buy", order_type="ioc",
            quantity="0.1", price=str(off_grid),
            funding="wallet", client_order_id=f"probe_tick_{int(time.time())}",
        )
        verdict = "ACCEPTED_BUT_SHOULD_REJECT"
        evidence_data = {"prepare_response": result}
    except Exception as e:
        verdict = "REJECTED_AS_EXPECTED"
        evidence_data = {"error_class": type(e).__name__, "message": str(e)}

    evidence.record(
        probe="tick_precision_off_grid", market=market,
        request={"price": str(off_grid), "tick_size": str(tick)},
        verdict=verdict, **evidence_data,
        notes="Submitted price halfway between two valid ticks.",
    )

    # Test 2: extreme decimal precision (18 places)
    high_prec = Decimal("1.000000000000000001")
    try:
        result = await rest.prepare_order(
            market=market, side="buy", order_type="ioc",
            quantity="0.1", price=str(high_prec),
            funding="wallet", client_order_id=f"probe_tickhi_{int(time.time())}",
        )
        verdict = "ACCEPTED"
        evidence_data = {"prepare_response": result}
    except Exception as e:
        verdict = "REJECTED"
        evidence_data = {"error_class": type(e).__name__, "message": str(e)}

    evidence.record(
        probe="tick_precision_high_decimals", market=market,
        request={"price": str(high_prec)},
        verdict=verdict, **evidence_data,
    )

    return {"probe": "tick_precision", "completed": True}


# ════════════════════════════════════════════════════════════════════
# Probe 2: minimum quantity / lot-size violations
# ════════════════════════════════════════════════════════════════════

async def probe_min_quantity(rest: RestClient, evidence: EvidenceLog, market: str) -> dict:
    spec = MARKETS[MarketSymbol(market)]
    too_small = spec.min_quantity / 2

    try:
        await rest.prepare_order(
            market=market, side="buy", order_type="ioc",
            quantity=str(too_small), price="1.0",
            funding="wallet", client_order_id=f"probe_minq_{int(time.time())}",
        )
        verdict = "ACCEPTED_BUT_SHOULD_REJECT"
        evidence_data: dict = {}
    except Exception as e:
        verdict = "REJECTED_AS_EXPECTED"
        evidence_data = {"error_class": type(e).__name__, "message": str(e)}

    evidence.record(
        probe="min_quantity_under", market=market,
        request={"quantity": str(too_small), "min_quantity": str(spec.min_quantity)},
        verdict=verdict, **evidence_data,
    )
    return {"probe": "min_quantity", "completed": True}


# ════════════════════════════════════════════════════════════════════
# Probe 3: self-trade prevention (STP)
# ════════════════════════════════════════════════════════════════════

async def probe_stp(rest: RestClient, evidence: EvidenceLog, market: str) -> dict:
    """Place a resting maker, then submit a taker that would self-match.
    Test both STP modes (cancelTaker, cancelMaker). Verify documented behavior.

    NOTE: requires vault funding for the maker leg, so this probe is a no-op
    until vault is set up. Stub raises in that case.
    """
    # Implementation outline:
    #   1. Place a PostOnly bid at price P, qty Q from vault. Wait for confirm.
    #   2. Submit an IOC sell at price P, qty Q, STP=cancelTaker. Verify the
    #      taker side is cancelled (no fill, no trade event).
    #   3. Submit an IOC sell at price P, qty Q, STP=cancelMaker. Verify the
    #      maker leg is cancelled (no fill, our PostOnly is gone).
    #   4. Compare against docs claims.
    evidence.record(
        probe="stp", market=market, verdict="NOT_IMPLEMENTED",
        notes="Requires vault deposit + the test plan above. Run after first vault setup.",
    )
    return {"probe": "stp", "completed": False}


# ════════════════════════════════════════════════════════════════════
# Probe 4: PostOnly that would cross
# ════════════════════════════════════════════════════════════════════

async def probe_post_only_crosses(rest: RestClient, evidence: EvidenceLog, market: str) -> dict:
    """Submit PostOnly bid at a price ABOVE the best ask. Should reject."""
    book = await rest.get_orderbook(market, depth=1)
    if not book.get("asks"):
        evidence.record(
            probe="post_only_crosses", market=market, verdict="SKIPPED_EMPTY_BOOK",
            notes="No asks available to cross against.",
        )
        return {"probe": "post_only_crosses", "completed": False}

    best_ask = Decimal(book["asks"][0]["price"])
    crossing_bid = best_ask + MARKETS[MarketSymbol(market)].tick_size

    try:
        result = await rest.prepare_order(
            market=market, side="buy", order_type="post_only",
            quantity="0.1", price=str(crossing_bid),
            funding="vault", client_order_id=f"probe_pocr_{int(time.time())}",
        )
        verdict = "ACCEPTED_BUT_SHOULD_REJECT"
        evidence_data = {"prepare_response": result}
    except Exception as e:
        verdict = "REJECTED_AS_EXPECTED"
        evidence_data = {"error_class": type(e).__name__, "message": str(e)}

    evidence.record(
        probe="post_only_crosses", market=market,
        request={"side": "buy", "price": str(crossing_bid), "best_ask": str(best_ask)},
        verdict=verdict, **evidence_data,
    )
    return {"probe": "post_only_crosses", "completed": True}


# ════════════════════════════════════════════════════════════════════
# Probe 5: FOK at size larger than book
# ════════════════════════════════════════════════════════════════════

async def probe_fok_undersize(rest: RestClient, evidence: EvidenceLog, market: str) -> dict:
    """Submit FOK buy for more than total resting ask depth at any price.
    Should reject with no fill."""
    book = await rest.get_orderbook(market, depth=20)
    total_ask_qty = sum(Decimal(a["quantity"]) for a in book.get("asks", []))
    oversized = total_ask_qty * 2 + Decimal("1")
    best_ask = Decimal(book["asks"][0]["price"]) if book.get("asks") else Decimal("1")

    try:
        result = await rest.prepare_order(
            market=market, side="buy", order_type="fok",
            quantity=str(oversized), price=str(best_ask * Decimal("1.01")),
            funding="wallet", client_order_id=f"probe_fok_{int(time.time())}",
        )
        verdict = "ACCEPTED_PROCEED_TO_SIGN"  # FOK may be accepted by REST but reject on chain
        evidence_data = {"prepare_response": result}
    except Exception as e:
        verdict = "REJECTED_AT_REST"
        evidence_data = {"error_class": type(e).__name__, "message": str(e)}

    evidence.record(
        probe="fok_undersize", market=market,
        request={"qty": str(oversized), "total_ask_depth": str(total_ask_qty)},
        verdict=verdict, **evidence_data,
    )
    return {"probe": "fok_undersize", "completed": True}


# ════════════════════════════════════════════════════════════════════
# Probe 6: IOC against empty book
# ════════════════════════════════════════════════════════════════════

async def probe_ioc_empty_book(rest: RestClient, evidence: EvidenceLog, market: str) -> dict:
    """Submit IOC at a price that has no resting counter-side."""
    book = await rest.get_orderbook(market, depth=1)
    # Submit a buy WAY below market so no asks match
    super_low = Decimal("0.0001")
    try:
        result = await rest.prepare_order(
            market=market, side="buy", order_type="ioc",
            quantity="0.1", price=str(super_low),
            funding="wallet", client_order_id=f"probe_ioce_{int(time.time())}",
        )
        verdict = "ACCEPTED_PROCEED_TO_SIGN"
        evidence_data = {"prepare_response": result, "note": "Verify on-chain: should return 0 fills, no revert."}
    except Exception as e:
        verdict = "REJECTED_AT_REST"
        evidence_data = {"error_class": type(e).__name__, "message": str(e)}

    evidence.record(
        probe="ioc_empty_book", market=market, verdict=verdict, **evidence_data,
    )
    return {"probe": "ioc_empty_book", "completed": True}


# ════════════════════════════════════════════════════════════════════
# Probe 7: REST rate limit burst — find the actual ceiling
# ════════════════════════════════════════════════════════════════════

async def probe_rate_limit_burst(
    rest: RestClient, evidence: EvidenceLog, market: str,
    burst_size: int = 100, burst_window_sec: float = 1.0,
) -> dict:
    """Fire `burst_size` market-data reads in `burst_window_sec`.
    Capture the response distribution: 200, 429, 5xx, timeouts.

    The dreamDEX docs do NOT specify a REST rate limit. This is the highest-
    leverage feedback report opportunity — document what we empirically observe.
    """
    results = {"200": 0, "429": 0, "5xx": 0, "timeout": 0, "other": 0}
    statuses: list[Any] = []

    async def one_request(i: int) -> None:
        try:
            await rest.get_orderbook(market, depth=1)
            results["200"] += 1
            statuses.append((i, 200))
        except Exception as e:
            msg = str(e).lower()
            if "429" in msg or "rate limit" in msg or "too many" in msg:
                results["429"] += 1
                statuses.append((i, 429))
            elif "timeout" in msg:
                results["timeout"] += 1
                statuses.append((i, "timeout"))
            elif "5" in msg[:3]:
                results["5xx"] += 1
                statuses.append((i, "5xx"))
            else:
                results["other"] += 1
                statuses.append((i, type(e).__name__))

    t0 = time.time()
    tasks = [one_request(i) for i in range(burst_size)]
    await asyncio.gather(*tasks, return_exceptions=True)
    elapsed = time.time() - t0

    evidence.record(
        probe="rate_limit_burst", market=market,
        burst_size=burst_size, target_window_sec=burst_window_sec, actual_elapsed_sec=elapsed,
        results=results, statuses=statuses[:200],  # cap evidence size
        observed_qps=burst_size / max(elapsed, 0.001),
        verdict="DOCS_DO_NOT_SPECIFY_REST_RATE_LIMIT",
        notes="The DreamDEX docs do not currently document a REST rate limit. "
              "This probe characterizes the actual empirical behavior.",
    )
    return {"probe": "rate_limit_burst", "completed": True, "summary": results}


# ════════════════════════════════════════════════════════════════════
# Probe 8: WebSocket reconnect drift (placeholder — requires WS client run)
# ════════════════════════════════════════════════════════════════════

async def probe_ws_reconnect_drift(*args, **kwargs) -> dict:
    """STUB: needs WS client integration. Plan:
       1. Connect, subscribe to orders channel.
       2. Place a few orders, capture their state via WS.
       3. Force-disconnect (close socket).
       4. Reconnect, re-subscribe.
       5. Compare WS-reported state vs REST-reported state.
       6. Any divergence is a feedback finding.
    """
    return {"probe": "ws_reconnect_drift", "completed": False, "reason": "stub"}


# ════════════════════════════════════════════════════════════════════
# Probe 9: Prepared order expiry field inspection
# ════════════════════════════════════════════════════════════════════

def _hex_data(tx: dict[str, Any]) -> str:
    data = tx.get("data") or tx.get("calldata") or tx.get("input")
    if not isinstance(data, str) or not data.startswith("0x"):
        raise ValueError(f"prepared tx did not include hex calldata: keys={list(tx.keys())}")
    return data


def _decode_static_words(data: str) -> list[int]:
    payload = data[10:] if data.startswith("0x") else data[8:]
    words: list[int] = []
    for i in range(0, len(payload), 64):
        word = payload[i:i + 64]
        if len(word) == 64:
            words.append(int(word, 16))
    return words


def _timestamp_like_words(words: list[int]) -> list[dict[str, Any]]:
    now_ns = int(time.time()) * 1_000_000_000
    day_ns = 24 * 60 * 60 * 1_000_000_000
    out = []
    for idx, value in enumerate(words):
        if value == 0 or now_ns - day_ns <= value <= now_ns + 7 * day_ns:
            out.append({
                "word_index": idx,
                "value": str(value),
                "looks_like": "zero" if value == 0 else "timestamp_ns_near_now",
            })
    return out


async def probe_prepare_expiry_decode(
    rest: RestClient, evidence: EvidenceLog, market: str,
) -> dict:
    """Prepare one IOC order and inspect the returned calldata words.

    This checks whether REST prepare_order embeds an expireTimestampNs=0-style
    value in the unsigned transaction. It does not broadcast anything.
    """
    book = await rest.get_orderbook(market, depth=1)
    side = "buy"
    price = Decimal("1")
    if book.get("asks"):
        price = Decimal(str(book["asks"][0]["price"]))
    elif book.get("bids"):
        side = "sell"
        price = Decimal(str(book["bids"][0]["price"]))

    spec = MARKETS[MarketSymbol(market)]
    quantity = spec.min_quantity
    client_order_id = f"probe_expiry_{int(time.time())}"
    prepared = await rest.prepare_order(
        market=market,
        side=side,
        order_type="ioc",
        quantity=str(quantity),
        price=str(price),
        funding="wallet",
        client_order_id=client_order_id,
        wallet_address=rest.signer.address,
    )
    data = _hex_data(prepared)
    words = _decode_static_words(data)
    selector = data[:10]
    timestamp_words = _timestamp_like_words(words)
    zero_word_indexes = [w["word_index"] for w in timestamp_words if w["looks_like"] == "zero"]

    evidence.record(
        probe="prepare_expiry_decode",
        market=market,
        request={
            "side": side,
            "order_type": "ioc",
            "quantity": str(quantity),
            "price": str(price),
            "client_order_id": client_order_id,
        },
        prepared_tx_summary={
            "to": prepared.get("to"),
            "value": prepared.get("value"),
            "gas": prepared.get("gas") or prepared.get("gasLimit"),
            "selector": selector,
            "calldata_bytes": (len(data) - 2) // 2,
            "word_count": len(words),
        },
        timestamp_or_zero_words=timestamp_words,
        zero_word_indexes=zero_word_indexes,
        verdict=(
            "ZERO_WORDS_PRESENT_REVIEW_ABI"
            if zero_word_indexes else "NO_ZERO_STATIC_WORDS_FOUND"
        ),
        notes=(
            "Best-effort static calldata inspection. A zero word is not by itself proof "
            "of expireTimestampNs=0 unless matched to the exact function ABI, but a "
            "timestamp-like nonzero word near now+expiry is a useful positive signal."
        ),
    )
    return {
        "probe": "prepare_expiry_decode",
        "completed": True,
        "selector": selector,
        "word_count": len(words),
        "timestamp_or_zero_words": timestamp_words,
    }


# ════════════════════════════════════════════════════════════════════
# Probe 10: REST orderbook vs on-chain getBookLevels
# ════════════════════════════════════════════════════════════════════

GET_BOOK_LEVELS_INPUTS = [
    ("getBookLevels(bool,uint64)", ["bool", "uint64"]),
    ("getBookLevels(bool,uint256)", ["bool", "uint256"]),
    ("getBookLevels(bool,uint128)", ["bool", "uint128"]),
    ("getBookLevels(bool,uint16)", ["bool", "uint16"]),
    ("getBookLevels(bool,uint8)", ["bool", "uint8"]),
]

GET_BOOK_LEVELS_OUTPUTS = [
    ("tuple_array_u128", ["(uint128,uint128)[]"]),
    ("tuple_array_u256", ["(uint256,uint256)[]"]),
    ("parallel_u128_arrays", ["uint128[]", "uint128[]"]),
    ("parallel_u256_arrays", ["uint256[]", "uint256[]"]),
]


def _selector(signature: str) -> str:
    return "0x" + keccak(text=signature)[:4].hex()


async def _call_get_book_levels(
    rest: RestClient,
    pool: str,
    is_bid: bool,
    depth: int,
) -> dict[str, Any]:
    last_error = None
    for signature, input_types in GET_BOOK_LEVELS_INPUTS:
        data = _selector(signature) + encode(input_types, [is_bid, depth]).hex()
        try:
            raw = await rest.signer.w3.eth.call({"to": pool, "data": data})
        except Exception as e:
            last_error = str(e)
            continue
        raw_hex = raw.hex() if hasattr(raw, "hex") else str(raw)
        for output_name, output_types in GET_BOOK_LEVELS_OUTPUTS:
            try:
                decoded = decode(output_types, raw)
                return {
                    "signature": signature,
                    "selector": _selector(signature),
                    "output_schema": output_name,
                    "raw": raw_hex,
                    "decoded": decoded,
                }
            except Exception as e:
                last_error = str(e)
        return {
            "signature": signature,
            "selector": _selector(signature),
            "raw": raw_hex,
            "decode_error": last_error,
        }
    raise RuntimeError(f"getBookLevels call failed for all signatures: {last_error}")


def _levels_from_decoded(decoded: Any, market: MarketSymbol) -> list[dict[str, str]]:
    spec = MARKETS[market]
    if not decoded:
        return []
    first = decoded[0]
    pairs: list[tuple[int, int]] = []
    if len(decoded) == 1 and isinstance(first, (list, tuple)):
        pairs = [(int(p[0]), int(p[1])) for p in first]
    elif len(decoded) == 2:
        prices, quantities = decoded
        pairs = [(int(p), int(q)) for p, q in zip(prices, quantities)]
    levels = []
    for price_raw, qty_raw in pairs:
        if price_raw == 0 or qty_raw == 0:
            continue
        levels.append({
            "price": str(Decimal(price_raw) / (Decimal(10) ** spec.quote_decimals)),
            "quantity": str(Decimal(qty_raw) / (Decimal(10) ** spec.base_decimals)),
            "price_raw": str(price_raw),
            "quantity_raw": str(qty_raw),
        })
    return levels


def _summarize_side(levels: list[dict[str, Any]]) -> list[dict[str, str]]:
    return [
        {
            "price": str(level.get("price")),
            "quantity": str(level.get("quantity")),
        }
        for level in levels
    ]


async def probe_book_source_compare(
    rest: RestClient, evidence: EvidenceLog, market: str,
) -> dict:
    """Compare REST /v0/orderbooks to on-chain getBookLevels over time."""
    market_symbol = MarketSymbol(market)
    settings = Settings()
    pool = settings.pool_address(market_symbol)
    samples: list[dict[str, Any]] = []
    mismatches = 0
    sample_count = 5
    interval_sec = 30

    for i in range(sample_count):
        rest_t0 = time.time()
        rest_book = await rest.get_orderbook(market, depth=5)
        rest_t1 = time.time()
        chain_t0 = time.time()
        chain_bids_raw = await _call_get_book_levels(rest, pool, True, 5)
        chain_asks_raw = await _call_get_book_levels(rest, pool, False, 5)
        chain_t1 = time.time()

        chain_bids = _levels_from_decoded(chain_bids_raw.get("decoded"), market_symbol)
        chain_asks = _levels_from_decoded(chain_asks_raw.get("decoded"), market_symbol)
        rest_bids = _summarize_side(rest_book.get("bids", [])[:5])
        rest_asks = _summarize_side(rest_book.get("asks", [])[:5])

        equivalent = rest_bids == _summarize_side(chain_bids) and rest_asks == _summarize_side(chain_asks)
        if not equivalent:
            mismatches += 1
        sample = {
            "sample": i,
            "rest_started_at": rest_t0,
            "rest_finished_at": rest_t1,
            "chain_started_at": chain_t0,
            "chain_finished_at": chain_t1,
            "delta_rest_to_chain_start_sec": chain_t0 - rest_t1,
            "pool": pool,
            "rest": {"bids": rest_bids, "asks": rest_asks},
            "chain": {"bids": chain_bids, "asks": chain_asks},
            "chain_call": {
                "bids_signature": chain_bids_raw.get("signature"),
                "bids_output_schema": chain_bids_raw.get("output_schema"),
                "asks_signature": chain_asks_raw.get("signature"),
                "asks_output_schema": chain_asks_raw.get("output_schema"),
            },
            "equivalent": equivalent,
        }
        samples.append(sample)
        evidence.record(probe="book_source_compare_sample", market=market, **sample)
        if i < sample_count - 1:
            await asyncio.sleep(interval_sec)

    verdict = "REST_CHAIN_MATCHED_ALL_SAMPLES" if mismatches == 0 else "REST_CHAIN_DISAGREED"
    evidence.record(
        probe="book_source_compare",
        market=market,
        sample_count=sample_count,
        interval_sec=interval_sec,
        mismatches=mismatches,
        verdict=verdict,
        samples=samples,
    )
    return {
        "probe": "book_source_compare",
        "completed": True,
        "market": market,
        "sample_count": sample_count,
        "mismatches": mismatches,
        "verdict": verdict,
    }


# ════════════════════════════════════════════════════════════════════
# Registry
# ════════════════════════════════════════════════════════════════════

PROBES: dict[str, Any] = {
    "tick_precision": probe_tick_precision,
    "min_quantity": probe_min_quantity,
    "stp": probe_stp,
    "post_only_crosses": probe_post_only_crosses,
    "fok_undersize": probe_fok_undersize,
    "ioc_empty_book": probe_ioc_empty_book,
    "rate_limit_burst": probe_rate_limit_burst,
    "ws_reconnect_drift": probe_ws_reconnect_drift,
    "prepare_expiry_decode": probe_prepare_expiry_decode,
    "book_source_compare": probe_book_source_compare,
}
