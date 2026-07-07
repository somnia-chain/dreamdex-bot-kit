# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

import os
import time
import math
from datetime import datetime, timezone
from pathlib import Path

import requests
from dotenv import load_dotenv
from web3 import Web3
from eth_account import Account
from eth_account.messages import encode_defunct

load_dotenv(Path(__file__).parent / ".env")

# ====== Config ======
RPC_URL = os.getenv("MAINNET_RPC_URL", "https://api.infra.mainnet.somnia.network")
API_URL = os.getenv("MAINNET_API_URL", "https://api.dreamdex.io")
CHAIN_ID = int(os.getenv("MAINNET_CHAIN_ID", "5031"))
PRIVATE_KEY = os.getenv("MAINNET_BOT_PK", os.getenv("DREAMDEX_PRIVATE_KEY", ""))
WALLET_ADDRESS = os.getenv("MAINNET_WALLET_ADDRESS", os.getenv("DREAMDEX_WALLET_ADDRESS", "")).lower()

PAIR = "WETH:USDso"
BUY_USDSO = 30
POLL_MS = 60.0
MIN_RANGE = 3
TP_AMOUNT = 2.0
SL_AMOUNT = 1.0
MAX_BUY_RETRIES = 3
LOT_SIZE = 0.0001
TICK_SIZE = 0.01
COOLDOWN_POLLS = 3
NORMAL_WINDOW = 5
SL_WINDOW = 10
BALANCE_RETRY_MS = 1.0
HOLD_POLL_MS = 0.5
RETRY_DELAY_MS = 2.0

# ====== Web3 ======
w3 = Web3(Web3.HTTPProvider(RPC_URL))
account = Account.from_key(PRIVATE_KEY)
address = account.address

LOG_PLACED_TOPIC = "0xd90f62f61ee2f606b132cfdfd883ddd079228b6fd6bffd9d7cf848daf824639d"

ERC20_ABI = [
    {"inputs": [{"name": "account", "type": "address"}], "name": "balanceOf", "outputs": [{"type": "uint256"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}], "name": "approve", "outputs": [{"type": "bool"}], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}], "name": "allowance", "outputs": [{"type": "uint256"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "decimals", "outputs": [{"type": "uint8"}], "stateMutability": "view", "type": "function"},
]

def log(level, tag, msg):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now().microsecond // 1000:03d}Z"
    print(f"[{ts}] [{level.upper()}] [{tag}] {msg}")

def round_lot(amount):
    return math.floor(amount / LOT_SIZE + 1e-9) * LOT_SIZE

def round_tick(amount):
    return round(amount / TICK_SIZE + 1e-9) * TICK_SIZE

# ====== State ======
POOL_ADDRESS = None
BASE_TOKEN = None
QUOTE_TOKEN = None
QUOTE_DECIMALS = 18
JWT_TOKEN = None
JWT_EXPIRY = 0
PRICE_WINDOW = []
WINDOW_SIZE_ACTIVE = NORMAL_WINDOW
COOLDOWN = 0
INITIAL_BALANCE = 0

# ====== API ======
def api_call(method, path, headers=None, data=None):
    url = f"{API_URL}{path}"
    h = {"Accept": "application/json"}
    if headers:
        h.update(headers)
    if data is not None:
        h["Content-Type"] = "application/json"
        r = requests.request(method, url, headers=h, json=data)
    else:
        r = requests.request(method, url, headers=h)
    try:
        body = r.json() if r.text else {}
    except:
        body = {"raw": r.text}
    return r.status_code, body

def authenticate():
    global JWT_TOKEN, JWT_EXPIRY
    log("info", "auth", "Authenticating via SIWE...")
    status, body = api_call("GET", "/v0/auth/nonce")
    if status != 200 or "nonce" not in body:
        raise Exception(f"Nonce failed: {status}")
    nonce = body["nonce"]
    domain = API_URL.replace("https://", "").replace("http://", "")
    issued_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + "000Z"
    message = (
        f"{domain} wants you to sign in with your Ethereum account:\n"
        f"{address}\n\n"
        f"Sign in to dreamDEX\n\n"
        f"URI: {API_URL}\n"
        f"Version: 1\n"
        f"Chain ID: {CHAIN_ID}\n"
        f"Nonce: {nonce}\n"
        f"Issued At: {issued_at}"
    )
    signed = Account.sign_message(encode_defunct(text=message), PRIVATE_KEY)
    status, body = api_call("POST", "/v0/auth/login", data={"message": message, "signature": "0x" + signed.signature.hex()})
    if status != 200 or "token" not in body:
        raise Exception(f"Login failed: {status} {body}")
    JWT_TOKEN = body["token"]
    JWT_EXPIRY = time.time() + 3300
    log("success", "auth", "Authenticated.")

def get_auth_headers():
    global JWT_TOKEN, JWT_EXPIRY
    if not JWT_TOKEN or time.time() > JWT_EXPIRY - 60:
        authenticate()
    return {"Authorization": f"Bearer {JWT_TOKEN}"}

# ====== Blockchain ======
def fetch_market_info():
    global POOL_ADDRESS, BASE_TOKEN, QUOTE_TOKEN, QUOTE_DECIMALS
    status, body = api_call("GET", "/v0/markets")
    if status != 200:
        raise Exception("Failed to fetch markets")
    markets = body.get("markets", [])
    market = next((m for m in markets if m["symbol"] == PAIR), None)
    if not market:
        raise Exception(f"Market {PAIR} not found")
    POOL_ADDRESS = market["contract"]
    BASE_TOKEN = market["base"]
    QUOTE_TOKEN = market["quote"]
    log("info", "vault", f"Pool: {POOL_ADDRESS}")

    status, body = api_call("GET", "/v0/currencies")
    if status == 200:
        currencies = body.get("currencies", [])
        usdso = next((c for c in currencies if c["code"] == "USDso"), None)
        if usdso:
            QUOTE_DECIMALS = usdso.get("decimals", 6)
    try:
        contract = w3.eth.contract(address=Web3.to_checksum_address(QUOTE_TOKEN), abi=ERC20_ABI)
        QUOTE_DECIMALS = contract.functions.decimals().call()
    except:
        pass
    log("info", "vault", f"Quote decimals: {QUOTE_DECIMALS}")

def send_tx(tx_data):
    to_addr = tx_data["to"]
    data_hex = tx_data["data"]
    if not data_hex.startswith("0x"):
        data_hex = "0x" + data_hex
    value = tx_data["value"]
    gas_limit = tx_data["gas"]

    nonce = w3.eth.get_transaction_count(address)
    gas_price = w3.eth.gas_price

    tx = {
        "to": to_addr,
        "data": data_hex,
        "value": value,
        "gas": gas_limit,
        "gasPrice": max(gas_price, int(2e9)),
        "nonce": nonce,
        "chainId": CHAIN_ID,
    }
    signed = account.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    log("info", "trade", f"Tx: {tx_hash.hex()}")
    return tx_hash

def place_order(side, price, amount):
    headers = get_auth_headers()
    payload = {
        "type": "limit", "side": side, "price": str(price), "amount": str(amount),
        "walletAddress": address, "fundingSource": "wallet", "orderType": "immediateOrCancel",
    }
    log("info", "trade", f"Placing {side.upper()} {amount} WETH @ {price} (IOC)")
    status, body = api_call("POST", f"/v0/markets/{PAIR}/orders", headers=headers, data=payload)
    if status != 200 or "to" not in body:
        log("error", "trade", f"Prepare failed: {status}")
        return None

    tx_data = {
        "to": Web3.to_checksum_address(body["to"]),
        "data": body["data"],
        "value": int(body.get("value", "0")),
        "gas": int(body.get("gasLimit", 8000000)),
    }
    tx_hash = send_tx(tx_data)
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=45)
    if receipt["status"] != 1:
        log("error", "trade", "Tx reverted")
        return None

    for log_entry in receipt.get("logs", []):
        topics = log_entry.get("topics", [])
        if topics and topics[0].hex() == LOG_PLACED_TOPIC:
            log("success", "trade", f"{side.upper()} filled! {amount} WETH @ {price} Tx: {tx_hash.hex()}")
            return {"tx_hash": tx_hash.hex(), "filled": True}

    log("warn", "trade", f"{side.upper()} IOC cancelled at {price}")
    return {"filled": False}

def get_weth_balance():
    contract = w3.eth.contract(address=Web3.to_checksum_address(BASE_TOKEN), abi=ERC20_ABI)
    bal = contract.functions.balanceOf(address).call()
    return bal / 1e18

def wait_for_weth(timeout_sec=30):
    start = time.time()
    while time.time() - start < timeout_sec:
        weth = get_weth_balance()
        if weth > 0:
            return weth
        time.sleep(BALANCE_RETRY_MS)
    return 0

def _get_pnl():
    try:
        usdso_contract = w3.eth.contract(address=Web3.to_checksum_address(QUOTE_TOKEN), abi=ERC20_ABI)
        current = usdso_contract.functions.balanceOf(address).call() / 10**QUOTE_DECIMALS
        return current - INITIAL_BALANCE
    except:
        return 0

def sell_all_weth(sell_buffer=0):
    while True:
        weth = round_lot(get_weth_balance())
        if weth <= 0:
            return True

        ob = fetch_orderbook()
        if not ob or ob["bid"] <= 0:
            time.sleep(RETRY_DELAY_MS)
            continue

        sell_price = round_tick(ob["bid"] - sell_buffer)
        log("info", "sell", f"Selling {weth:.4f} WETH @ {sell_price:.6f} (bid {ob['bid']:.4f} - buffer {sell_buffer})")
        result = place_order("sell", f"{sell_price:.8f}", f"{weth:.8f}")

        if result and result.get("filled"):
            remaining = round_lot(get_weth_balance())
            if remaining > 0:
                if remaining >= 0.001:
                    log("warn", "sell", f"Partial fill, selling rest...")
                    continue
                log("info", "sell", f"{remaining:.4f} remaining (< 0.001), skip.")
                return True
            log("success", "sell", f"Sold all. PnL: {_get_pnl():+.4f} USDso")
            return True

        log("warn", "sell", "Not filled, retrying...")
        time.sleep(RETRY_DELAY_MS)

def fetch_orderbook():
    status, body = api_call("GET", f"/v0/orderbooks?symbols={PAIR}")
    if status != 200:
        return None
    obs = body.get("orderbooks", [body])
    ob = obs[0] if obs else {}
    bids = ob.get("bids", [])
    asks = ob.get("asks", [])
    if not bids or not asks:
        return None
    bid = float(bids[0].get("price", bids[0][0] if isinstance(bids[0], list) else 0))
    ask = float(asks[0].get("price", asks[0][0] if isinstance(asks[0], list) else 0))
    return {"bid": bid, "ask": ask}

def approve_if_needed():
    for addr, symbol, decs in [(QUOTE_TOKEN, "USDso", QUOTE_DECIMALS), (BASE_TOKEN, "WETH", 18)]:
        contract = w3.eth.contract(address=Web3.to_checksum_address(addr), abi=ERC20_ABI)
        allowance = contract.functions.allowance(address, Web3.to_checksum_address(POOL_ADDRESS)).call()
        required = int(1_000_000 * 10**decs)
        if allowance < required:
            log("info", "approve", f"Approving {symbol}...")
            nonce = w3.eth.get_transaction_count(address)
            gas_price = w3.eth.gas_price
            tx = contract.functions.approve(
                Web3.to_checksum_address(POOL_ADDRESS), required * 10
            ).build_transaction({
                "from": address, "nonce": nonce, "gas": 5000000, "gasPrice": gas_price, "chainId": CHAIN_ID,
            })
            signed = account.sign_transaction(tx)
            tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
            w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)
            log("success", "approve", f"{symbol} approved")
        else:
            log("info", "approve", f"{symbol} already approved")

# ====== Strategy ======
def gap_monitor(entry_bid, entry_ask):
    log("info", "hold", f"Monitoring. EntryBid={entry_bid:.4f} EntryAsk={entry_ask:.4f} TP:+{TP_AMOUNT} SL:-{SL_AMOUNT}")

    while True:
        ob = fetch_orderbook()
        if ob and ob["bid"] > 0:
            bid = ob["bid"]
            if bid >= entry_ask + TP_AMOUNT:
                log("success", "hold", f"TP! bid={bid:.4f} >= {entry_ask + TP_AMOUNT:.4f}")
                sell_all_weth(SELL_BUFFER)
                pnl = _get_pnl()
                log("success", "hold", f"PnL: {pnl:+.4f} USDso")
                return "TP"
            if bid <= entry_bid - SL_AMOUNT:
                log("warn", "hold", f"SL! bid={bid:.4f} <= {entry_bid - SL_AMOUNT:.4f}")
                sell_all_weth(SELL_BUFFER)
                pnl = _get_pnl()
                log("warn", "hold", f"PnL: {pnl:+.4f} USDso")
                return "SL"
        time.sleep(HOLD_POLL_MS)

    sell_all_weth(SELL_BUFFER)
    return "SL"

def execute_scalp():
    log("banner", "scalp", f"Buy | TP:+{TP_AMOUNT} SL:-{SL_AMOUNT}")

    weth_bal = get_weth_balance()
    if weth_bal >= 0.001:
        log("warn", "scalp", f"WETH {weth_bal:.4f} leftover, selling first...")
        sell_all_weth(SELL_BUFFER)

    ob = fetch_orderbook()
    if not ob or ob["ask"] <= 0:
        return
    entry_ask = ob["ask"]
    entry_bid = ob["bid"]

    buy_amount = round_lot(BUY_USDSO / entry_ask)
    if buy_amount <= 0:
        return
    log("info", "scalp", f"Buy {buy_amount:.4f} WETH @ ask {entry_ask:.4f} + buffer {BUY_BUFFER}")

    buy_result = None
    for attempt in range(MAX_BUY_RETRIES):
        buy_price = round_tick(entry_ask + BUY_BUFFER)
        buy_result = place_order("buy", f"{buy_price:.8f}", f"{buy_amount:.8f}")
        if buy_result and buy_result.get("filled"):
            break
        log("info", "scalp", f"Retry {attempt + 2}/{MAX_BUY_RETRIES}...")
        time.sleep(0.5)

    if not buy_result or not buy_result.get("filled"):
        log("info", "scalp", "Buy failed after retries.")
        return

    total_weth = wait_for_weth(30)
    if total_weth <= 0:
        log("error", "scalp", "WETH never appeared.")
        return
    log("info", "scalp", f"WETH received: {total_weth:.4f}")

    log("info", "scalp", "Stabilizing 3s...")
    time.sleep(3)

    result = gap_monitor(entry_bid, entry_ask)

    global WINDOW_SIZE_ACTIVE, COOLDOWN, PRICE_WINDOW
    if result == "SL":
        WINDOW_SIZE_ACTIVE = SL_WINDOW
        COOLDOWN = COOLDOWN_POLLS
        PRICE_WINDOW.clear()
        log("warn", "scalp", f"SL. Window={SL_WINDOW} Cooldown={COOLDOWN_POLLS}polls.")
    else:
        WINDOW_SIZE_ACTIVE = NORMAL_WINDOW
        COOLDOWN = COOLDOWN_POLLS
        PRICE_WINDOW.clear()
        log("info", "scalp", f"TP. Window={NORMAL_WINDOW} Cooldown={COOLDOWN_POLLS}polls.")

    time.sleep(3)

# ====== Main ======
def main():
    log("info", "main", "=== Scalper Mainnet (Python) ===")
    log("banner", "main", f"Pair={PAIR} Buy=${BUY_USDSO} Win={NORMAL_WINDOW}/{SL_WINDOW} Range≥${MIN_RANGE} TP+{TP_AMOUNT} SL-{SL_AMOUNT} Buffer={SELL_BUFFER} Poll={int(POLL_MS)}s")

    log("info", "main", "Fetching market info...")
    fetch_market_info()
    log("info", "main", f"Wallet: {address} | SOMI: {w3.eth.get_balance(address) / 1e18:.4f}")

    authenticate()

    weth_bal = get_weth_balance()
    if weth_bal >= 0.001:
        log("warn", "main", f"WETH {weth_bal:.4f} leftover, selling...")
        sell_all_weth(SELL_BUFFER)
    elif weth_bal > 0:
        log("info", "main", f"WETH {weth_bal:.4f} (< 0.001), skip.")

    approve_if_needed()

    global INITIAL_BALANCE
    try:
        usdso_contract = w3.eth.contract(address=Web3.to_checksum_address(QUOTE_TOKEN), abi=ERC20_ABI)
        INITIAL_BALANCE = usdso_contract.functions.balanceOf(address).call() / 10**QUOTE_DECIMALS
        log("info", "main", f"Initial USDso: {INITIAL_BALANCE:.4f}")
    except:
        INITIAL_BALANCE = 0

    log("info", "main", f"Polling {int(POLL_MS)}s. Window: {NORMAL_WINDOW}/{SL_WINDOW} Range≥${MIN_RANGE}")

    global PRICE_WINDOW, WINDOW_SIZE_ACTIVE, COOLDOWN
    trading = False

    while True:
        if trading:
            time.sleep(1)
            continue

        try:
            ob = fetch_orderbook()
            if not ob:
                time.sleep(1)
                continue

            mid = (ob["bid"] + ob["ask"]) / 2
            PRICE_WINDOW.append(mid)
            if len(PRICE_WINDOW) > WINDOW_SIZE_ACTIVE:
                PRICE_WINDOW.pop(0)

            if len(PRICE_WINDOW) >= WINDOW_SIZE_ACTIVE:
                r = max(PRICE_WINDOW) - min(PRICE_WINDOW)
                log("info", "state", f"Window {len(PRICE_WINDOW)}/{WINDOW_SIZE_ACTIVE} Range: ${r:.2f}{' Cooldown:' + str(COOLDOWN) if COOLDOWN > 0 else ''}{' → TRIGGER!' if r >= MIN_RANGE else ''}")

                if r >= MIN_RANGE:
                    log("success", "signal", f"Range ${r:.2f} >= ${MIN_RANGE}! Buying...")
                    trading = True
                    execute_scalp()
                    trading = False
                    continue

            if COOLDOWN > 0:
                COOLDOWN -= 1
                if COOLDOWN <= 0:
                    WINDOW_SIZE_ACTIVE = NORMAL_WINDOW
                    log("info", "state", "Cooldown done. Back to normal.")

            time.sleep(POLL_MS)

        except KeyboardInterrupt:
            log("info", "main", "Shutdown by user")
            break
        except Exception as e:
            log("error", "main", str(e))
            time.sleep(5)

if __name__ == "__main__":
    main()
