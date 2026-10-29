# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

"""
Check a transaction the dreamDEX HTTP API prepared before the bot signs it.

The API answers with `to`, `data` and `value` for the client to sign. Signing
them unchecked means signing whatever arrives, including a token transfer or a
plain coin transfer out of the bot's wallet. So a prepared transaction is only
signed when it calls one of the order or vault functions this bot expects on an
official pool, carries no native coin unless it is a native-coin order or
deposit, names no builder fee on an order, and is for the chain the bot is on.
An approval is only signed for the pool the bot expects. The caller simulates
it before signing.

No dependencies: the chain is reached through a `call(tx) -> bytes | str`
function, e.g. `lambda tx: w3.eth.call(tx)` with web3.py.
"""
import re

# Function selectors of the calls the API prepares for spot trading.
SELECTORS = {
    "placeOrder": "0x4e978373",
    "cancelOrder": "0xdbc91396",
    "reduceOrders": "0x58b91c42",
    "deposit": "0x47e7ef24",
    "withdraw": "0xf3fef3a3",
    "depositNative": "0xdb6b5246",
    "approve": "0x095ea7b3",
}

# Only a sell on a pool whose base is the native coin, and a native vault
# deposit, send coin with the call. Everything else must carry value 0.
PAYABLE = {SELECTORS["placeOrder"], SELECTORS["depositNative"]}

# The protocol's SpotPoolRegistry per chain: the list of official spot pools.
POOL_REGISTRY = {
    5031: "0xB601bc1099B040E4882089D94690F7C38AF4CCD2",
    50312: "0x07A29A0A086Bc8262a9320db93E603eE13D57962",
}
IS_REGISTERED = "0xc3c5a547"  # isRegistered(address)
# Pools the registry has confirmed in this process, so each one costs a single lookup.
_CONFIRMED_POOLS: set[str] = set()

# placeOrder(bool,uint64,uint256,uint256,uint64,uint8,uint8,address builder,uint96 builderFeeBpsTimes1k):
# nine static words, the builder in the 8th and its fee in the 9th.
_ORDER_CALLDATA_LENGTH = 10 + 9 * 64

_ADDRESS = re.compile(r"^0x[0-9a-fA-F]{40}$")
_CALLDATA = re.compile(r"^0x(?:[0-9a-fA-F]{2}){4,}$")


class PreparedTxRejected(Exception):
    pass


def _hex(v) -> str:
    if isinstance(v, (bytes, bytearray)):
        return "0x" + bytes(v).hex()
    s = str(v or "")
    return s if s.startswith("0x") else "0x" + s


def _int(v) -> int:
    if isinstance(v, int):
        return v
    s = str(v).strip()
    return int(s, 16) if s.lower().startswith("0x") else int(s or 0)


def check_prepared_tx(tx: dict, *, allow, chain_id: int, is_known_pool, approve_spender: str | None = None) -> dict:
    """Validate a prepared transaction against the calls this bot expects.

    Returns `{"to", "data", "value"}` with `value` as an int, or raises
    `PreparedTxRejected`. An approval passes only when `approve` is in `allow`
    and its spender is `approve_spender`."""
    to = str(tx.get("to") or "")
    data = _hex(tx.get("data")) if tx.get("data") else ""
    if not _ADDRESS.match(to):
        raise PreparedTxRejected(f'prepared transaction has no valid target: "{to}"')
    if not _CALLDATA.match(data):
        raise PreparedTxRejected("prepared transaction does not call a function")
    selector = data[:10].lower()
    if selector not in allow:
        raise PreparedTxRejected(f"prepared transaction calls {selector}, expected one of {', '.join(allow)}")
    if tx.get("chainId") not in (None, "") and _int(tx["chainId"]) != chain_id:
        raise PreparedTxRejected(f"prepared transaction is for chain {tx['chainId']}, the bot is on chain {chain_id}")
    value = _int(tx.get("value") or 0)
    if value < 0:
        raise PreparedTxRejected("prepared transaction has a negative value")
    if value > 0 and selector not in PAYABLE:
        raise PreparedTxRejected(f"prepared transaction sends {value} wei with {selector}, which takes no coin")
    if selector == SELECTORS["approve"]:
        # An approval goes to the token; what matters is who it lets spend.
        spender = "0x" + data[34:74]
        if not approve_spender or spender.lower() != approve_spender.lower():
            raise PreparedTxRejected(f"prepared approval is for {spender}, expected {approve_spender}")
        return {"to": to, "data": data, "value": value}
    if selector == SELECTORS["placeOrder"]:
        # These examples trade without a builder code, so an order must not route a fee to one.
        if len(data) < _ORDER_CALLDATA_LENGTH:
            raise PreparedTxRejected("prepared order is too short to be a placeOrder call")
        builder, builder_fee = "0x" + data[482:522], int(data[522:586], 16)
        if int(builder, 16) != 0 or builder_fee != 0:
            raise PreparedTxRejected(f"prepared order names builder {builder} with fee {builder_fee}, expected none")
    if not is_known_pool(to):
        raise PreparedTxRejected(f"prepared transaction calls {to}, which is not an official pool")
    return {"to": to, "data": data, "value": value}


def registry_pool_check(call, chain_id: int):
    """An `is_known_pool` that asks the chain's SpotPoolRegistry. On a chain with
    no known registry every address is unknown, so nothing is signed there."""
    registry = POOL_REGISTRY.get(chain_id)

    def is_known_pool(address: str) -> bool:
        if not registry:
            return False
        key = f"{chain_id}:{address.lower()}"
        if key in _CONFIRMED_POOLS:
            return True
        out = _hex(call({"to": registry, "data": IS_REGISTERED + address[2:].lower().rjust(64, "0")}))
        known = int(out[2:] or "0", 16) == 1
        if known:
            _CONFIRMED_POOLS.add(key)
        return known

    return is_known_pool


def require_official_pool(call, chain_id: int, address: str) -> str:
    """The pool address the API reported, once the chain's registry confirms it
    is an official pool. Approvals are granted to this address, so an address
    the API made up would otherwise collect them."""
    if not _ADDRESS.match(str(address)) or not registry_pool_check(call, chain_id)(address):
        raise PreparedTxRejected(f"{address} is not an official pool on chain {chain_id}")
    return address
