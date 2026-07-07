# @license
# Copyright DreamDEX S.A.
#
# Use of this source code is governed by an MIT-style license that can be
# found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE

import os
import time
import json
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
BUY_USDSO = 10
MAX_SPREAD = 0.43
SELL_BUFFER = 0.05
LOT_SIZE = 0.0001
TICK_SIZE = 0.01
POLL_MS = 1.0
RETRY_SELL_MS = 0.5
BALANCE_RETRY_MS = 0.2

# ====== Web3 Setup ======
w3 = Web3(Web3.HTTPProvider(RPC_URL))
account = Account.from_key(PRIVATE_KEY)
address = account.address

LOG_PLACED_TOPIC = "0xd90f62f61ee2f606b132cfdfd883ddd079228b6fd6bffd9d7cf848daf824639d"

ERC20_ABI = [
    {"inputs": [{"name": "account", "type": "address"}], "name": "balanceOf", "outputs": [{"type": "uint256"}], "stateMutability": "view", "type": "function"},
    {"inputs": [], "name": "decimals", "outputs": [{"type": "uint8"}], "stateMutability": "view", "type": "function"},
    {"inputs": [{"name": "spender", "type": "address"}, {"name": "amount", "type": "uint256"}], "name": "approve", "outputs": [{"type": "bool"}], "stateMutability": "nonpayable", "type": "function"},
    {"inputs": [{"name": "owner", "type": "address"}, {"name": "spender", "type": "address"}], "name": "allowance", "outputs": [{"type": "uint256"}], "stateMutability": "view", "type": "function"},
]

def log(level, tag, msg):
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{datetime.now().microsecond // 1000:03d}Z"
    print(f"[{ts}] [{level.upper()}] [{tag}] {msg}")

def round_lot(amount):
    return math.floor(amount / LOT_SIZE + 1e-9) * LOT_SIZE

def round_tick(amount):
    return round(amount / TICK_SIZE + 1e-9) * TICK_SIZE

# ====== API ======
JWT_TOKEN = None
JWT_EXPIRY = 0

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
TOKEN_ADDRESSES = {}
QUOTE_DECIMALS = 6

def fetch_market_info():
    global TOKEN_ADDRESSES, QUOTE_DECIMALS
    status, body = api_call("GET", "/v0/markets")
    if status != 200:
        raise Exception("Failed to fetch markets")
    markets = body.get("markets", [])
    market = next((m for m in markets if m["symbol"] == PAIR), None)
    if not market:
        raise Exception(f"Market {PAIR} not found")
    pool = market["contract"]
    TOKEN_ADDRESSES["pool"] = pool
    TOKEN_ADDRESSES["base"] = market["base"]
    TOKEN_ADDRESSES["quote"] = market["quote"]
    log("info", "vault", f"Pool: {pool}")

    status, body = api_call("GET", "/v0/currencies")
    if status == 200:
        currencies = body.get("currencies", [])
        usdso = next((c for c in currencies if c["code"] == "USDso"), None)
        if usdso:
            QUOTE_DECIMALS = usdso.get("decimals", 6)
    try:
        contract = w3.eth.contract(address=Web3.to_checksum_address(TOKEN_ADDRESSES["quote"]), abi=ERC20_ABI)
        QUOTE_DECIMALS = contract.functions.decimals().call()
    except:
        pass
    log("info", "vault", f"Quote decimals: {QUOTE_DECIMALS}")

def get_weth_balance():
    contract = w3.eth.contract(address=Web3.to_checksum_address(TOKEN_ADDRESSES["base"]), abi=ERC20_ABI)
    bal = contract.functions.balanceOf(address).call()
    return bal / 1e18

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

def place_order(side, price, amount):
    headers = get_auth_headers()
    payload = {
        "type": "limit",
        "side": side,
        "price": str(price),
        "amount": str(amount),
        "walletAddress": address,
        "fundingSource": "wallet",
        "orderType": "immediateOrCancel",
    }
    status, body = api_call("POST", f"/v0/markets/{PAIR}/orders", headers=headers, data=payload)
    if status != 200 or "to" not in body:
        log("error", "trade", f"Prepare failed: {status} {body.get('description','')}")
        return None

    tx_data = {
        "to": Web3.to_checksum_address(body["to"]),
        "data": body["data"],
        "value": int(body.get("value", "0")),
        "gas": int(body.get("gasLimit", 8000000)),
    }
    tx_hash = send_tx(tx_data)
    if not tx_hash:
        return None

    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=45)
    if receipt["status"] != 1:
        log("error", "trade", "Tx reverted")
        return None

    for log_entry in receipt.get("logs", []):
        topics = log_entry.get("topics", [])
        if topics and topics[0].hex() == LOG_PLACED_TOPIC:
            log("success", "trade", f"{side.upper()} filled! {amount} WETH @ {price} | Tx: {tx_hash.hex()}")
            return {"tx_hash": tx_hash.hex()}

    log("warn", "trade", f"{side.upper()} IOC not filled at {price}")
    return {"filled": False}

def send_tx(tx_data):
    try:
        to_addr = tx_data["to"]
        data_hex = tx_data["data"]
        if not data_hex.startswith("0x"):
            data_hex = "0x" + data_hex
        value = tx_data["value"]
        gas_limit = 1000000

        nonce = w3.eth.get_transaction_count(address)

        # Fixed gas: 10 Gwei
        tx = {
            "to": to_addr,
            "data": data_hex,
            "value": value,
            "gas": gas_limit,
            "gasPrice": 10_000_000_000,
            "nonce": nonce,
            "chainId": CHAIN_ID,
        }

        signed = account.sign_transaction(tx)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        log("info", "trade", f"Tx sent: {tx_hash.hex()}")
        return tx_hash
    except Exception as e:
        log("error", "trade", f"Send tx failed: {e}")
        return None

def approve_if_needed():
    for key, symbol, dec in [("quote", "USDso", QUOTE_DECIMALS), ("base", "WETH", 18)]:
        addr = TOKEN_ADDRESSES[key]
        contract = w3.eth.contract(address=Web3.to_checksum_address(addr), abi=ERC20_ABI)
        allowance = contract.functions.allowance(address, Web3.to_checksum_address(TOKEN_ADDRESSES["pool"])).call()
        required = int(1_000_000 * 10**dec)
        if allowance < required:
            log("info", "approve", f"Approving {symbol}...")
            nonce = w3.eth.get_transaction_count(address)
            gas_price = w3.eth.gas_price
            tx = contract.functions.approve(
                Web3.to_checksum_address(TOKEN_ADDRESSES["pool"]),
                required * 10
            ).build_transaction({
                "from": address,
                "nonce": nonce,
                "gas": 5000000,
                "gasPrice": gas_price,
                "chainId": CHAIN_ID,
            })
            signed = account.sign_transaction(tx)
            tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
            w3.eth.wait_for_transaction_receipt(tx_hash, timeout=60)
            log("success", "approve", f"{symbol} approved")
        else:
            log("info", "approve", f"{symbol} already approved")

# ====== Trading ======
def buy_sell_cycle(auth_headers, initial_ask, initial_bid):
    log("info", "cycle", f"Ask: {initial_ask:.4f} | Initial bid: {initial_bid:.4f} | Spread: {initial_ask - initial_bid:.4f}")

    buy_amount = round_lot(BUY_USDSO / initial_ask)
    if buy_amount <= 0:
        return False

    buy_result = None
    for attempt in range(3):
        fresh_ob = fetch_orderbook()
        current_ask = fresh_ob["ask"] if fresh_ob else initial_ask
        buy_price = round_tick(current_ask)
        log("info", "cycle", f"BUY {buy_amount:.4f} WETH @ {buy_price:.8f} (retry {attempt + 1}/3)")
        buy_result = place_order("buy", f"{buy_price:.8f}", f"{buy_amount:.8f}")
        if buy_result and buy_result.get("filled") is not False:
            break
        time.sleep(0.5)

    if not buy_result or buy_result.get("filled") is False:
        return False

    weth = 0
    for _ in range(30):
        weth = get_weth_balance()
        if weth > 0:
            break
        time.sleep(BALANCE_RETRY_MS)
    if weth <= 0:
        log("error", "cycle", "WETH never appeared")
        return False

    sell_amount = round_lot(weth)
    if sell_amount <= 0:
        return False

    sell_price = round_tick(initial_bid - SELL_BUFFER)
    log("info", "cycle", f"SELL {sell_amount:.4f} WETH @ {sell_price:.8f} (initial bid {initial_bid:.4f} - buffer {SELL_BUFFER})")

    for attempt in range(1, 21):
        sell_result = place_order("sell", f"{sell_price:.8f}", f"{sell_amount:.8f}")
        if sell_result and sell_result.get("filled") is not False:
            final_weth = get_weth_balance()
            log("success", "cycle", f"Sell success! WETH left: {final_weth:.4f}")
            return True
        log("info", "cycle", f"Sell retry {attempt}/20 @ {sell_price:.8f}...")
        time.sleep(RETRY_SELL_MS)

    log("error", "cycle", "Sell failed after 20 retries")
    return False

def main():
    log("info", "main", "=== Volume Scalper Mainnet (Python) ===")
    log("info", "main", f"Pair: {PAIR} | Buy: {BUY_USDSO} USDso | Max spread: {MAX_SPREAD} | Sell buffer: {SELL_BUFFER}")

    log("info", "main", "Fetching market info...")
    fetch_market_info()
    log("info", "main", f"Wallet: {address} | SOMI: {w3.eth.get_balance(address) / 1e18:.4f}")

    approve_if_needed()

    log("info", "main", "Starting volume loops...\n")
    cycle_count = 0

    while True:
        ob = fetch_orderbook()
        if not ob:
            time.sleep(POLL_MS)
            continue

        spread = ob["ask"] - ob["bid"]
        log("info", "main", f"Spread: {spread:.4f} (max: {MAX_SPREAD})")

        if spread > MAX_SPREAD:
            log("info", "main", f"Spread {spread:.4f} > {MAX_SPREAD}, waiting...")
            time.sleep(POLL_MS)
            continue

        cycle_count += 1
        log("banner", "main", f"=== Volume Cycle #{cycle_count} | Spread: {spread:.4f} ===")

        auth_headers = get_auth_headers()
        success = buy_sell_cycle(auth_headers, ob["ask"], ob["bid"])

        if not success:
            log("warn", "main", f"Cycle {cycle_count} incomplete. Continuing...")

        time.sleep(POLL_MS)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        log("info", "main", "Shutdown by user")
    except Exception as e:
        log("error", "fatal", str(e))
        raise
