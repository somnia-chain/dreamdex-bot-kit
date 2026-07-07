/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Connection layer. Strategy/risk depend ONLY on the ExchangeClient interface,
// so the real dreamDEX client can be wired in on launch day without touching the logic.
// MockClient (multi-pair) lets you run the bot right now on simulated prices.

export type Side = "buy" | "sell";

// NETWORK TIMEOUTS: the connection sometimes "hangs" (socket open, no response, no error) → a request
// without a timeout waits FOREVER → the tick stalls → the bot freezes. These wrappers abort a hung call.
async function fetchT(url: string, opts: any = {}, ms = 12000): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ac.signal }); }
  finally { clearTimeout(t); }
}
function withT<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout ${label}`)), ms))]);
}

export interface OrderBook { symbol: string; bid: number; ask: number; mid: number; ts: number; }
export interface Fill { symbol: string; side: Side; price: number; size: number; orderId: string; ts: number; }
export interface Balances { quoteUSDso: number; baseToken: number; gasSOMI: number; baseWallet?: number; baseVault?: number; }
export interface PlacedOrder { id: string; }

export interface MarketSpec { tick: number; lot: number; minQty: number; }

export interface ExchangeClient {
  connect(): Promise<void>;
  getOrderBook(symbol: string): Promise<OrderBook>;
  getBalances(symbol: string): Promise<Balances>;   // baseToken — for THIS pair; quote/gas — shared across the wallet
  placeLimit(symbol: string, side: Side, price: number, size: number, postOnly: boolean): Promise<PlacedOrder>;
  cancelAll(symbol: string): Promise<void>;
  onFill(cb: (f: Fill) => void): void;
  lastTxMs?: number;                                 // time of the last SUCCESSFUL on-chain tx (for the anti-DQ watchdog)
  getSpec?(symbol: string): MarketSpec | undefined;  // market tick/lot/minQty (from /markets) — the maker needs it to quote at the touch
  placeIOC?(symbol: string, side: Side, price: number, size: number): Promise<PlacedOrder>;  // taker immediate-or-cancel (flatten inventory)
  recoverVaults?(keep?: string[]): Promise<void>;    // pull USDso out of the vaults (except keep-pairs) into the wallet
  resetVaultFunding?(): void;                         // reset the "vault funded" flags (on a regime switch)
  depositBaseToVault?(symbol: string, amount: number): Promise<void>;  // base from wallet → vault (so the maker can sell it)
}

// ---------------------------------------------------------------------------
// REAL dreamDEX adapter — FILL IN on launch day.
// Docs: CCXT (TS/JS) + REST + WebSocket + the Solidity orderbook contract.
// IMPORTANT: one wallet = one nonce → all orders/cancels go THROUGH ONE queue
// (the orchestrator already serializes this), and here — a single signer/nonce manager.
// ---------------------------------------------------------------------------
// REAL adapter, written FROM THE DOCS (api.dreamdex.io/v0). Auth is SIWE→JWT;
// markets/addresses from GET /v0/markets; book GET /v0/orderbooks; order POST /v0/markets/{sym}/orders
// → returns an UNSIGNED tx → sign with the wallet and send; fills are caught on-chain (OrderFilled).
// WRITTEN TO THE SPEC, NOT run against the live API — verify on testnet on launch day.
// Remaining VERIFY: exact SIWE message format, the open-orders list path, OrderId encoding.
// ethers loads lazily → DRY mode (mock) doesn't require it.
export class DreamDexClient implements ExchangeClient {
  private fillCbs: ((f: Fill) => void)[] = [];
  private signer: any; private provider: any; private ethers: any;
  public lastTxMs = 0;                                   // time of the last successful on-chain tx (watchdog)
  private emptyLogTs: Record<string, number> = {};       // throttle for "empty tx" logs (once a minute per pair+side)
  private authing: Promise<void> | null = null;          // re-auth in progress (one re-login for all requests that got a 401)
  private reauthLogged = 0;                               // throttle for the re-auth log
  private token = "";
  private markets: Record<string, any> = {};            // key = API symbol "BASE:QUOTE"
  private myOrders: Record<string, { symbol: string; side: Side }> = {};
  private approved: Record<string, boolean> = {};
  private vaulted: Record<string, boolean> = {};
  private vaultTry: Record<string, number> = {};        // throttle for vault top-up attempts (once per N sec)
  private lastBalances: Record<string, Balances> = {};  // cache of the last SUCCESSFUL read (REST failed → don't lose the vault)
  private lastBook: Record<string, { ob: OrderBook; ts: number }> = {};  // book cache (malformed format under load → take the last good one)
  private restFailLogged = false;
  private bookFailLogged = false;
  private obLogged = false;
  private balLogged = false;
  private ordLogged = false;
  private depLogged = false;
  private placeLoggedSyms = new Set<string>();
  private base: string; private chainId: number;

  constructor(private cfg: { restUrl?: string; wsUrl?: string; rpc: string; privateKey: string; orderbookContract?: string; tokens?: Record<string, string>; vaultDepositUSDso?: number; gasReserveSOMI?: number; }) {
    this.base = cfg.restUrl || "https://api.dreamdex.io/v0";
    this.chainId = this.base.includes("stg") ? 50312 : 5031;   // testnet : mainnet
  }

  private apiSym(s: string) { return s.replace("/", ":"); }    // bot "SOMI/USDso" → API "SOMI:USDso"
  private headers() { return { "content-type": "application/json", authorization: `Bearer ${this.token}` }; }

  // ONE re-auth for everyone: if several requests hit a 401 at once, we re-login exactly once.
  private async ensureAuth(): Promise<void> {
    if (!this.authing) this.authing = this.auth().finally(() => { this.authing = null; });
    return this.authing;
  }
  // Private request with auto re-login: JWT expired (401) → SIWE again → one retry. Returns parsed JSON.
  private async authedJson(url: string, opts: any = {}, ms = 12000): Promise<any> {
    const run = () => fetchT(url, { ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}), authorization: `Bearer ${this.token}` } }, ms);
    let r = await run();
    if (r.status === 401) {                               // token expired → re-login and one retry
      if (Date.now() - this.reauthLogged > 60000) { this.reauthLogged = Date.now(); console.log("[dreamdex] 401 → re-authenticating via SIWE…"); }
      await this.ensureAuth();
      r = await run();
    }
    return r.json();
  }
  private async send(tx: any) {
    // SINGLE safeguard: an empty/broken tx (data "" or "0x") = a guaranteed revert + burned gas
    // (≈1.08M gas each). Happens when the API returns "nothing to do" on cancel/withdraw with empty data.
    const okData = tx?.data && tx.data !== "0x" && tx.data !== "";
    if (!tx?.to || !okData) { return ""; }
    const s: any = await withT(this.signer.sendTransaction({ to: tx.to, data: tx.data, value: tx.value ?? 0 }), 30000, "sendTx");
    await withT(s.wait(), 60000, "txWait");
    this.lastTxMs = Date.now();                              // successful tx → reset the idle watchdog
    return s.hash;   // the tx can "hang" waiting to be mined → timeout
  }

  // market tick/lot/minQty from /markets — the maker needs it to quote precisely at the touch (and not cross).
  getSpec(symbol: string): MarketSpec | undefined {
    const m = this.markets[this.apiSym(symbol)];
    if (!m) return undefined;
    return { tick: parseFloat(m.tickSize ?? "0"), lot: parseFloat(m.lotSize ?? "0"), minQty: parseFloat(m.minQuantity ?? "0") };
  }

  async connect(): Promise<void> {
    const { ethers } = await import("ethers"); this.ethers = ethers;
    this.provider = new ethers.JsonRpcProvider(this.cfg.rpc || "https://api.infra.mainnet.somnia.network/");
    this.signer = new ethers.Wallet(this.cfg.privateKey, this.provider);
    await this.auth();
    await this.loadMarkets();
    this.watchFills();
    console.log(`[dreamdex] ${await this.signer.getAddress()} | chain ${this.chainId} | markets: ${Object.keys(this.markets).length}`);
  }

  // SIWE: nonce → signature → JWT bearer
  private async auth(): Promise<void> {
    const addr = await this.signer.getAddress();
    const { nonce } = await (await fetchT(`${this.base}/auth/nonce`)).json();
    const domain = new URL(this.base).host;
    const msg = [
      `${domain} wants you to sign in with your Ethereum account:`, addr, "",
      "Sign in to dreamDEX", "",
      `URI: https://${domain}`, "Version: 1", `Chain ID: ${this.chainId}`,
      `Nonce: ${nonce}`, `Issued At: ${new Date().toISOString()}`,
    ].join("\n");
    const signature = await this.signer.signMessage(msg);
    const r: any = await (await fetchT(`${this.base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: msg, signature }) })).json();
    this.token = r.token;
    // >>> VERIFY: the SIWE message format must exactly match what the server expects. <<<
  }

  private async loadMarkets(): Promise<void> {
    const d: any = await (await fetchT(`${this.base}/markets`)).json();
    for (const m of d.markets) this.markets[m.symbol] = m;
  }

  async getOrderBook(symbol: string): Promise<OrderBook> {
    const sym = this.apiSym(symbol);
    const d: any = await (await fetchT(`${this.base}/orderbooks?symbols=${encodeURIComponent(sym)}&depth=1`)).json();
    if (!this.obLogged) { this.obLogged = true; console.log("[dreamdex] orderbook raw:", JSON.stringify(d).slice(0, 500)); }
    const ob = Array.isArray(d) ? d[0] : (d.orderbooks?.[0] ?? d[sym] ?? d.orderbook ?? d);
    const px = (x: any) => Array.isArray(x) ? +x[0] : +(x?.price ?? x?.px ?? x?.p); // level: [price,size] OR {price}
    const bid = px(ob?.bids?.[0]); const ask = px(ob?.asks?.[0]);
    if (!isFinite(bid) || !isFinite(ask)) {
      // under load / during an API crash it sometimes returns an empty/malformed book → DON'T drop the tick, take the last good one (if fresh <60s)
      const c = this.lastBook[symbol];
      if (c && Date.now() - c.ts < 60000) {
        if (!this.bookFailLogged) { this.bookFailLogged = true; console.log(`[dreamdex] book ${symbol} malformed → using the last good one (not dropping the tick)`); }
        return c.ob;
      }
      throw new Error("book: could not recognize the level format (see raw above)");
    }
    const book = { symbol, bid, ask, mid: (bid + ask) / 2, ts: Date.now() };
    this.lastBook[symbol] = { ob: book, ts: book.ts };
    return book;
  }

  async getBalances(symbol: string): Promise<Balances> {
    const ethers = this.ethers; const addr = await this.signer.getAddress();
    const native = Number(ethers.formatEther(await withT(this.provider.getBalance(addr), 12000, "getBalance"))); // native SOMI = gas
    // PRIMARY source — REST /wallets/{addr}/balance (wallet+vault, reads wSOMI, no RPC glitches)
    try {
      const r: any = await this.authedJson(`${this.base}/wallets/${addr}/balance`);
      const markets = r.markets || [];
      const mk = markets.find((x: any) => x.symbol === this.apiSym(symbol));
      if (mk) {
        if (!this.balLogged) { this.balLogged = true; console.log(`[dreamdex] balance raw: ${JSON.stringify(mk)}`); }
        const num = (v: any) => v == null ? 0 : parseFloat(v ?? 0);
        // USDso = wallet (shared) + ALL vaults across ALL markets (money in any vault is ours;
        // otherwise on a multi-pair setup we lose the other pair's vault → false drawdown → false stop).
        const walletQuote = num(mk.quote?.wallet);
        let vaultQuote = 0;
        for (const m of markets) vaultQuote += num(m.quote?.vault);
        const baseWalletVault = num(mk.base?.wallet) + num(mk.base?.vault);   // base — the token of THIS pair
        const res = await this.getReserved(symbol);                          // money in THIS pair's resting orders
        let baseToken = baseWalletVault + res.base;
        let baseWallet = num(mk.base?.wallet);   // base IN THE WALLET: the maker does NOT sell it from the vault → flatten with a taker
        // SOMI: the base = wrapped-native, but we hold NATIVE SOMI. Count it ABOVE the gas reserve as sellable
        // inventory → the bot converts stuck SOMI back to USDso itself (selling SOMI sends native msg.value).
        // The reserve (gasReserveSOMI) is NOT sold: baseToken ≤ native−reserve → native SOMI is always ≥ the reserve.
        const mkt = this.markets[this.apiSym(symbol)];
        if (mkt && (mkt.base ?? "").toLowerCase() === "0x28f34defd2b4cb48d9ee6d89f2be4bc601694c00") {
          baseToken = Math.max(0, native - (this.cfg.gasReserveSOMI ?? 50));
          baseWallet = 0;   // SOMI = native, its own logic, no taker-flatten needed
        }
        // baseVault = the base the MAKER can sell (in the vault + in our resting orders; the wallet part is NOT sold by the maker)
        const result = { quoteUSDso: walletQuote + vaultQuote + res.quote, baseToken, baseWallet, baseVault: Math.max(0, baseToken - baseWallet), gasSOMI: native };
        this.lastBalances[symbol] = result;            // remembered a good read (with vault)
        return result;
      }
    } catch { /* fall through below: cache first, then on-chain */ }
    // REST didn't answer → take the LAST GOOD balance (with vault!), only refresh gas.
    // Otherwise we'd fall to on-chain wallet-only → lose the vault → PHANTOM drawdown → false floor breach.
    if (this.lastBalances[symbol]) {
      if (!this.restFailLogged) { this.restFailLogged = true; console.log(`[dreamdex] REST balance didn't answer → using cache (keep vault, no false drawdown)`); }
      return { ...this.lastBalances[symbol], gasSOMI: native };
    }
    // FALLBACK on-chain (only if there's no cache yet — the very first tick; vault at start ≈0, not critical)
    const m = this.markets[this.apiSym(symbol)];
    const erc20 = ["function balanceOf(address) view returns (uint256)"];
    const isNative = (t?: string) => !t || /^0x0+$/i.test(t);
    const bal = async (token: string, dec: number) => {
      if (isNative(token)) return native;
      try { return Number(ethers.formatUnits(await new ethers.Contract(token, erc20, this.provider).balanceOf(addr), dec)); }
      catch { return 0; }
    };
    const quoteUSDso = m ? await bal(m.quote, m.quoteDecimals) : 0;
    const baseToken = m ? await bal(m.base, m.baseDecimals) : 0;
    return { quoteUSDso, baseToken, gasSOMI: native };
  }

  // 3rd pocket: USDso/base LOCKED in resting orders. REST wallet/vault doesn't show it
  // as available → without this, equity falsely "drops" and the stop fires.
  // CACHE: on an API failure/error (timeout or an error object instead of an array) return the LAST good
  // value, NOT 0 — otherwise equity falsely loses ~$36 "in orders" → false drawdown → false halt.
  private lastReserved: Record<string, { quote: number; base: number }> = {};
  private async getReserved(symbol: string): Promise<{ quote: number; base: number }> {
    const sym = this.apiSym(symbol);
    const cached = this.lastReserved[sym] ?? { quote: 0, base: 0 };
    try {
      const list: any = await this.authedJson(`${this.base}/markets/${encodeURIComponent(sym)}/orders?status=open`);
      const valid = Array.isArray(list?.orders) || Array.isArray(list);   // a valid response (even an empty array = really 0 orders)
      if (!valid) return cached;                                          // API under load sends an error object → DON'T trust 0, hold the cache
      const orders = Array.isArray(list?.orders) ? list.orders : list;
      if (!this.ordLogged && orders.length) { this.ordLogged = true; console.log(`[dreamdex] open-order raw: ${JSON.stringify(orders[0])}`); }
      let quote = 0, base = 0;
      for (const o of orders) {
        const px = parseFloat(o.price ?? o.limitPrice ?? 0);
        const remain = parseFloat(o.remainingQuantity ?? o.remaining ?? o.openQuantity ?? o.quantity ?? o.amount ?? 0);
        if (String(o.side ?? "").toLowerCase() === "buy") quote += px * remain; else base += remain;
      }
      const res = { quote, base };
      this.lastReserved[sym] = res;                                       // remembered a good value
      return res;
    } catch { return cached; }                                           // timeout/network → last good, not 0
  }

  // How much is ALREADY in the vault for a currency (so we don't duplicate the deposit on every restart).
  private async vaultBalance(symbol: string, currency: string): Promise<number> {
    try {
      const addr = await this.signer.getAddress();
      const r: any = await this.authedJson(`${this.base}/wallets/${addr}/balance`);
      const mk = (r.markets || []).find((x: any) => x.symbol === this.apiSym(symbol));
      if (!mk) return 0;
      const b = currency === "USDso" ? mk.quote : mk.base;
      return b == null ? 0 : parseFloat(b.vault ?? 0);
    } catch { return 0; }
  }

  // Reset the vault-funding state: after returning to the MAKER phase of the oscillator
  // we need to re-fund the vaults (adaptive ensureVaultFunded does it on the next maker orders).
  resetVaultFunding(): void { this.vaulted = {}; this.vaultTry = {}; }

  // Base from the WALLET → into the VAULT. Then the maker can sell it NORMALLY (postOnly, catching the spread)
  // instead of dumping it with a taker at a loss. Needed when inventory is stuck in the wallet (e.g. after taker-buys/a crash).
  async depositBaseToVault(symbol: string, amount: number): Promise<void> {
    const sym = this.apiSym(symbol);
    const m = this.markets[sym]; if (!m || amount <= 0) return;
    const baseCur = sym.split(":")[0];                                   // e.g. "WETH"
    // RECOMPUTE the real base in the wallet NOW: the amount from the tick may be stale (sells/a prior deposit) → "exceeds balance"
    let curWallet = amount;
    try {
      const addr = await this.signer.getAddress();
      const r: any = await this.authedJson(`${this.base}/wallets/${addr}/balance`);
      const mk = (r.markets || []).find((x: any) => x.symbol === sym);
      if (mk?.base) curWallet = parseFloat(mk.base.wallet ?? 0);
    } catch { /* no read → use the passed value */ }
    await this.ensureApproved(sym);                                      // base approved to the pool
    const lot = parseFloat(m.lotSize ?? "0");
    let amt = Math.min(amount, curWallet) * 0.999;                       // no more than really available (rounding buffer)
    amt = lot > 0 ? Math.floor(amt / lot) * lot : amt;                  // down to the lot
    if (amt <= 0) return;
    const r: any = await this.authedJson(`${this.base}/markets/${encodeURIComponent(sym)}/vault/deposit`, { method: "POST", body: JSON.stringify({ walletAddress: await this.signer.getAddress(), currency: baseCur, amount: String(amt) }) });
    const tx = r.transaction ?? r;
    const okData = tx?.data && tx.data !== "0x" && tx.data !== "";
    if (tx?.to && okData) { const h = await this.send(tx); console.log(`[dreamdex] base→vault: ${amt} ${baseCur} (${sym}) → ${(h || "").slice(0, 12)}…`); }
    else console.log(`[dreamdex] base→vault ${sym}: API didn't return a valid tx (base deposit may be unsupported) → ${JSON.stringify(r).slice(0, 160)}`);
  }

  // USDso in the WALLET and in the VAULT for a pair in one request (for the adaptive deposit).
  private async quoteWalletVault(symbol: string): Promise<{ wallet: number; vault: number }> {
    try {
      const addr = await this.signer.getAddress();
      const r: any = await this.authedJson(`${this.base}/wallets/${addr}/balance`);
      const mk = (r.markets || []).find((x: any) => x.symbol === this.apiSym(symbol));
      if (!mk || !mk.quote) return { wallet: 0, vault: 0 };
      return { wallet: parseFloat(mk.quote.wallet ?? 0), vault: parseFloat(mk.quote.vault ?? 0) };
    } catch { return { wallet: 0, vault: 0 }; }
  }

  // IMPORTANT for the leaderboard: USDso in the vault counts as MINUS-PnL (the leaderboard only sees the wallet).
  // Pull vault funds into the wallet — EXCEPT the pairs in keep (there the vault is needed for maker orders).
  async recoverVaults(keep: string[] = []): Promise<void> {
    try {
      const keepSet = new Set(keep.map(p => this.apiSym(p)));
      const addr = await this.signer.getAddress();
      const r: any = await this.authedJson(`${this.base}/wallets/${addr}/balance`);
      const withdraw = async (sym: string, currency: string, amount: number) => {
        if (!(amount > 0.0000001)) return;
        const body = { walletAddress: addr, currency, amount: String(amount) };
        const resp: any = await this.authedJson(`${this.base}/markets/${encodeURIComponent(sym)}/vault/withdraw`, { method: "POST", body: JSON.stringify(body) });
        const tx = resp.transaction ?? resp;
        if (tx?.to) { const h = await this.send(tx); console.log(`[dreamdex] VAULT withdraw ${amount} ${currency} (${sym}) → ${(h || "").slice(0, 12)}…`); }
        else console.log(`[dreamdex] vault withdraw ${sym} ${currency}: no tx (${JSON.stringify(resp).slice(0, 120)})`);
      };
      for (const m of (r.markets || [])) {
        if (keepSet.has(m.symbol)) continue;                     // keep-pair — leave the vault
        await withdraw(m.symbol, "USDso", parseFloat(m.quote?.vault ?? 0));                 // pull USDso out of the vault → wallet
        const baseCur = (m.symbol || "").split(":")[0];
        if (baseCur && baseCur !== "USDso") await withdraw(m.symbol, baseCur, parseFloat(m.base?.vault ?? 0)); // and the base (WETH/WBTC) too
      }
    } catch (e) { console.log(`[dreamdex] recoverVaults error: ${(e as Error).message}`); }
  }

  // dreamDEX: before trading, approve the tokens to the pool (a direct ERC-20 approve, as in the quick-start). Once per market.
  private async ensureApproved(sym: string): Promise<void> {
    if (this.approved[sym]) return;
    const m = this.markets[sym]; if (!m) { this.approved[sym] = true; return; }
    const ethers = this.ethers;
    const abi = ["function approve(address,uint256) returns (bool)"];
    for (const token of [m.quote, m.base]) {                 // quote(USDso) for buying, base for selling
      if (!token || /^0x0+$/i.test(token)) continue;         // native token — skip
      try { const c = new ethers.Contract(token, abi, this.signer); await (await c.approve(m.contract, ethers.MaxUint256)).wait(); console.log(`[dreamdex] approve ok ${token.slice(0, 8)}→pool ${sym}`); }
      catch (e) { console.log(`[dreamdex] approve FAIL ${token.slice(0, 8)}→pool ${sym}: ${(e as Error).message.slice(0, 90)}`); }
    }
    this.approved[sym] = true;
  }

  // dreamDEX: deposit USDso into the pool's vault — needed for maker limits (fundingSource:"vault").
  // ADAPTIVE: we deposit only what's REALLY in the wallet (minus a buffer). If at start the capital
  // is still in inventory (little free USDso) — the deposit does NOT revert (0xe450d38c), it tops up on later ticks
  // once selling inventory refills the wallet. This way both vaults (WETH+WBTC) are guaranteed to be funded.
  private async ensureVaultFunded(sym: string): Promise<void> {
    if (this.vaulted[sym]) return;
    const target = parseFloat(String(this.cfg.vaultDepositUSDso ?? 0));
    if (target <= 0) { this.vaulted[sym] = true; return; }
    const now = Date.now();
    if (now - (this.vaultTry[sym] ?? 0) < 15000) return;           // no more than once per 15s (wait for USDso to free up)
    this.vaultTry[sym] = now;
    await this.ensureApproved(sym);
    const { wallet, vault } = await this.quoteWalletVault(sym);
    const need = target - vault;
    if (need <= 0.5) { console.log(`[dreamdex] VAULT funded: ${vault.toFixed(2)}/${target} USDso (${sym})`); this.vaulted[sym] = true; return; }
    const buffer = 5;                                              // leave a bit of USDso in the wallet (for taker/gas-asset)
    const amt = Math.min(need, wallet - buffer);
    if (amt < 1) { console.log(`[dreamdex] vault ${sym}: little USDso in the wallet ($${wallet.toFixed(1)}) — will top up later`); return; }   // DON'T set vaulted → tops up on the next tick
    const r: any = await this.authedJson(`${this.base}/markets/${encodeURIComponent(sym)}/vault/deposit`, { method: "POST", body: JSON.stringify({ walletAddress: await this.signer.getAddress(), currency: "USDso", amount: String(amt) }) });
    if (!this.depLogged) { this.depLogged = true; console.log(`[dreamdex] deposit raw (${sym}): ${JSON.stringify(r).slice(0, 320)}`); }
    const tx = r.transaction ?? r;
    const okData = tx?.data && tx.data !== "0x" && tx.data !== "";
    if (tx?.to && okData) { const h = await this.send(tx); console.log(`[dreamdex] VAULT deposit ${amt.toFixed(2)} USDso (was ${vault.toFixed(2)}, target ${target}) → ${(h || "—").slice(0, 12)}…`); }
    else { console.log(`[dreamdex] deposit ${sym}: no valid tx → skip`); return; }
    if (vault + amt >= target * 0.9) this.vaulted[sym] = true;     // target nearly reached → stop topping up
  }

  // public wrappers: maker (postOnly) and taker (immediate-or-cancel, for flattening inventory).
  async placeLimit(symbol: string, side: Side, price: number, size: number, postOnly: boolean): Promise<PlacedOrder> {
    return this._place(symbol, side, price, size, postOnly ? "postOnly" : "normalOrder");
  }
  async placeIOC(symbol: string, side: Side, price: number, size: number): Promise<PlacedOrder> {
    return this._place(symbol, side, price, size, "immediateOrCancel");
  }

  private async _place(symbol: string, side: Side, price: number, size: number, orderType: "postOnly" | "normalOrder" | "immediateOrCancel"): Promise<PlacedOrder> {
    const sym = this.apiSym(symbol);
    const m = this.markets[sym];
    // round the price to tickSize, the size down to lotSize; below minQuantity — don't send
    const dec = (s?: string) => (s?.split(".")[1] || "").length;
    const tick = parseFloat(m?.tickSize ?? "0"); const lot = parseFloat(m?.lotSize ?? "0"); const minQ = parseFloat(m?.minQuantity ?? "0");
    const p = tick > 0 ? Math.round(price / tick) * tick : price;
    const a = lot > 0 ? Math.floor(size / lot) * lot : size;
    if (minQ > 0 && a < minQ) return { id: "" };                         // below the minimum → skip
    const priceStr = p.toFixed(dec(m?.tickSize)); const amtStr = a.toFixed(dec(m?.lotSize));
    await this.ensureApproved(sym);   // WALLET-funding for ALL orders: per the docs a filled order returns the coins TO THE WALLET
    // (even vault-funded!), so the correct continuous maker = wallet-funded postOnly: a buy puts USDso→WETH into the wallet,
    // a sell WETH→USDso into the wallet. No vault/deposits/stuck states. Only an ERC-20 approve is needed (ensureApproved).
    const body = { type: "limit", side, amount: amtStr, price: priceStr, orderType, fundingSource: "wallet" };
    const r: any = await this.authedJson(`${this.base}/markets/${encodeURIComponent(sym)}/orders`, { method: "POST", body: JSON.stringify(body) });
    if (!this.placeLoggedSyms.has(sym)) { this.placeLoggedSyms.add(sym); console.log(`[dreamdex] order resp (${sym} ${side} ${orderType}): ${JSON.stringify(r).slice(0, 340)}`); }   // once per pair: check whether there's a value
    const tx = r.transaction ?? r;                       // the unsigned tx {to,data,value}
    // wrapped-native base (wSOMI): on SELL the contract requires sending NATIVE SOMI as msg.value = amount
    // (it wraps it itself). The API returns value:0 → we add it ourselves, else InvalidMsgValue (0x1f89f671).
    const WSOMI = "0x28f34defd2b4cb48d9ee6d89f2be4bc601694c00";
    if (side === "sell" && (m?.base ?? "").toLowerCase() === WSOMI) {
      tx.value = this.ethers.parseUnits(amtStr, m.baseDecimals).toString();
    }
    const okData = tx?.data && tx.data !== "0x" && tx.data !== "";   // DON'T send an empty/broken tx → else revert + burned gas
    if (!tx?.to || !okData) {
      // DIAGNOSTICS: log WHY the tx is empty (the API response body) — throttled once a minute per pair+side, so as not to spam.
      const k = sym + side; const now = Date.now();
      if (now - (this.emptyLogTs[k] ?? 0) > 60000) { this.emptyLogTs[k] = now; console.log(`[dreamdex] ORDER ${side} ${sym} (${orderType}) empty tx → skip. resp: ${JSON.stringify(r).slice(0, 240)}`); }
      return { id: "" };
    }
    const hash = await this.send(tx);
    if (!hash) return { id: "" };                                     // send filtered out a broken tx
    console.log(`[dreamdex] ORDER ${side} ${amtStr} @ ${priceStr} (${orderType}) → ${hash.slice(0, 12)}…`);
    const id = String(r.id ?? hash);
    this.myOrders[id] = { symbol, side };
    // OPTIMISTIC estimate for the live log only: assumes the taker filled in FULL,
    // but an IOC can partial on a thin book — so this over-counts. The AUTHORITATIVE
    // volume is the on-chain OrderFilled stream (watchFills), which reports the real
    // quantityFilled. NOTE: reconciling the two needs the REST order id ↔ on-chain
    // OrderId mapping (a launch-day VERIFY) — until that's wired, watchFills keys on
    // takerOrderId and this placement-time count is only an upper-bound display value,
    // NOT the number to report as your competition volume.
    if (orderType !== "postOnly") this.fillCbs.forEach(cb => cb({ symbol, side, price: p, size: a, orderId: id, ts: Date.now() }));
    return { id };
  }

  async cancelAll(symbol: string): Promise<void> {
    const sym = this.apiSym(symbol);
    // >>> VERIFY: the exact open-orders list path. <<<
    const list: any = await this.authedJson(`${this.base}/markets/${encodeURIComponent(sym)}/orders?status=open`);
    // ARRAY ONLY: under load the API returns an error object ({message:"Too many requests"}) → iterating the object = "not iterable"
    const arr = Array.isArray(list?.orders) ? list.orders : (Array.isArray(list) ? list : []);
    for (const o of arr) {
      const r: any = await this.authedJson(`${this.base}/markets/${encodeURIComponent(sym)}/orders/${o.id}`, { method: "DELETE" });
      const tx = r.transaction ?? r; if (tx?.to) await this.send(tx);
    }
  }

  // On-chain fills: listen to OrderFilled on each market's contract (no WS needed).
  private watchFills(): void {
    const ethers = this.ethers;
    const topic = "0xc87f4223e9e7c4e4f39f9b34fc9d64d78cdb95d9035b3748cbde59521261a399";
    const iface = new ethers.Interface(["event OrderFilled(uint128 indexed takerOrderId, uint128 indexed makerOrderId, uint256 quantityFilled, uint256 takerRemainingQuantity, uint256 makerRemainingQuantity, uint256 fillPrice)"]);
    for (const apiSym in this.markets) {
      const m = this.markets[apiSym]; const botSym = apiSym.replace(":", "/");
      this.provider.on({ address: m.contract, topics: [topic] }, (lg: any) => {
        try {
          const p: any = iface.parseLog(lg);
          const size = Number(ethers.formatUnits(p.args.quantityFilled, m.baseDecimals));
          const price = Number(ethers.formatUnits(p.args.fillPrice, m.quoteDecimals));
          const taker = String(p.args.takerOrderId);
          const mine = this.myOrders[taker] ?? this.myOrders[String(p.args.makerOrderId)];
          if (!mine) return;                              // not our order
          this.fillCbs.forEach(cb => cb({ symbol: botSym, side: mine.side, price, size, orderId: taker, ts: Date.now() }));
        } catch { /* someone else's / non-matching log */ }
      });
    }
    // >>> VERIFY: OrderId encoding (a custom type) and matching against myOrders for the precise side. <<<
  }

  onFill(cb: (f: Fill) => void): void { this.fillCbs.push(cb); }
}

// ---------------------------------------------------------------------------
// MOCK (multi-pair) — `npm run dry`. A random price walk on each pair,
// a shared wallet (quote+gas), per-symbol base. You can see volume/inventory/risk.
// ---------------------------------------------------------------------------
export class MockClient implements ExchangeClient {
  private mids: Record<string, number> = {};
  private base: Record<string, number> = {};
  private quote: number;
  private gas = 50;
  public lastTxMs = Date.now();
  private resting: { symbol: string; side: Side; price: number; size: number }[] = [];
  private fillCbs: ((f: Fill) => void)[] = [];

  constructor(symbols: string[], startUSDso = 1000) {
    this.quote = startUSDso;
    const seed: Record<string, number> = { "BTC/USDso": 65000, "ETH/USDso": 3000, "SOMI/USDso": 0.5 };
    for (const s of symbols) { this.mids[s] = seed[s] ?? 100; this.base[s] = 0; }
  }
  async connect() {}
  async getOrderBook(symbol: string): Promise<OrderBook> {
    const m = (this.mids[symbol] *= 1 + (Math.random() - 0.5) * 0.001); // ~5 bps step
    const half = m * 0.0003;                                            // ~3 bps book
    return { symbol, bid: m - half, ask: m + half, mid: m, ts: Date.now() };
  }
  async getBalances(symbol: string): Promise<Balances> {
    const b = this.base[symbol] ?? 0;
    return { quoteUSDso: this.quote, baseToken: b, baseVault: b, baseWallet: 0, gasSOMI: this.gas };  // in the mock all base is "in the vault"
  }
  getSpec(symbol: string): MarketSpec { const m = this.mids[symbol] ?? 100; return { tick: m * 1e-4, lot: 1e-6, minQty: 1e-6 }; }
  async placeLimit(symbol: string, side: Side, price: number, size: number, _postOnly = false): Promise<PlacedOrder> {
    this.lastTxMs = Date.now();
    this.resting.push({ symbol, side, price, size });
    setTimeout(() => this.maybeFill(symbol), 50 + Math.random() * 300);
    return { id: "m" + Math.random().toString(36).slice(2, 8) };
  }
  async placeIOC(symbol: string, side: Side, price: number, size: number): Promise<PlacedOrder> {
    this.lastTxMs = Date.now();
    if (side === "buy") { this.base[symbol] = (this.base[symbol] ?? 0) + size; this.quote -= size * price; }
    else { this.base[symbol] = (this.base[symbol] ?? 0) - size; this.quote += size * price; }
    this.gas -= 0.01;
    this.fillCbs.forEach(cb => cb({ symbol, side, price, size, orderId: "ioc", ts: Date.now() }));
    return { id: "ioc" + Math.random().toString(36).slice(2, 6) };
  }
  private maybeFill(symbol: string) {
    const idx = this.resting.findIndex(r => r.symbol === symbol);
    if (idx < 0) return;
    const r = this.resting.splice(idx, 1)[0];
    const m = this.mids[symbol];
    const dist = Math.abs(r.price - m) / m;
    if (Math.random() < Math.max(0, 0.9 - dist * 200)) {
      if (r.side === "buy") { this.base[symbol] += r.size; this.quote -= r.size * r.price; }
      else { this.base[symbol] -= r.size; this.quote += r.size * r.price; }
      this.gas -= 0.01;
      this.fillCbs.forEach(cb => cb({ symbol, side: r.side, price: r.price, size: r.size, orderId: "f", ts: Date.now() }));
    }
  }
  async cancelAll(symbol: string) { this.resting = this.resting.filter(r => r.symbol !== symbol); }
  onFill(cb: (f: Fill) => void) { this.fillCbs.push(cb); }
}
