/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// WALLET-LEVEL risk manager. It has the final say: it sees the whole wallet
// (equity/inventory/gas across all pairs) and can veto or trim any module's orders.

import { DesiredOrder } from "./strategy.js";

export interface RiskConfig { maxDrawdownPct: number; maxInventoryUSDso: number; gasFloorSOMI: number; }

export class RiskManager {
  startEquity = 0;
  halted = false;
  private breaches = 0;
  constructor(private cfg: RiskConfig) {}

  // bot.ts feeds an ALREADY read-glitch-cleaned equity (trustedEquity) here → only REAL thresholds below.
  assess(equity: number, gasSOMI: number): { ok: boolean; reason?: string } {
    if (!this.startEquity) this.startEquity = equity;
    // Gas floor — the ONLY reliable reason to pause (native SOMI reads from chain, no REST glitches).
    if (gasSOMI <= this.cfg.gasFloorSOMI) return { ok: false, reason: `low gas ${gasSOMI.toFixed(2)} SOMI` };
    // Catastrophic REAL drawdown. At maxDrawdownPct=90 it basically never fires —
    // capital is protected by the FLOOR (sell-only) + INVENTORY LIMIT, not a hard halt (halt = idle = DQ risk).
    const dd = (1 - equity / this.startEquity) * 100;
    if (dd >= this.cfg.maxDrawdownPct) {
      this.breaches++;
      if (this.breaches >= 3) { this.halted = true; return { ok: false, reason: `drawdown ${dd.toFixed(1)}% ×3 → STOP` }; }
      return { ok: false, reason: `drawdown ${dd.toFixed(1)}% — watching (${this.breaches}/3)` };
    }
    this.breaches = 0;
    return { ok: true };
  }

  // PEG-GUARD: stop if USDso drifts from $1 more than allowed (a new stablecoin = de-peg risk).
  pegGuard(usdsoUsd: number, tolPct: number): boolean {
    if (Math.abs(usdsoUsd - 1) * 100 > tolPct) { this.halted = true; return false; }
    return true;
  }

  // Global inventory netting: trim orders that worsen an already-breached limit.
  filter(orders: DesiredOrder[], globalInvUSDso: number): DesiredOrder[] {
    if (Math.abs(globalInvUSDso) <= this.cfg.maxInventoryUSDso) return orders;
    return orders.filter(o => {
      if (globalInvUSDso > 0 && o.side === "buy") return false;   // already over-long → don't buy more
      if (globalInvUSDso < 0 && o.side === "sell") return false;  // already over-short → don't sell more
      return true;
    });
  }
}
