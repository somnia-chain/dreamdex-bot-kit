/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Assertion-based check of the regime state machine.
// Run: npm test  (tsx src/regime.test.ts — no test framework needed).
import assert from "node:assert/strict";
import { RegimeManager } from "./regime.js";

const rm = new RegimeManager({ cautionDrawdownPct: 4, defensiveDrawdownPct: 9, cautionClipMult: 0.6, defensiveClipMult: 0.3 });

// (drawdown %, expected regime, expected clip multiplier) — hysteresis = 2.
const cases: Array<[number, string, number]> = [
  [0, "healthy", 1],      // no drawdown → all modules
  [2, "healthy", 1],      // below the caution threshold
  [5, "caution", 0.6],    // >= 4% → caution
  [8, "caution", 0.6],    // still caution (< 9%)
  [11, "defensive", 0.3], // >= 9% → defensive
  [7, "defensive", 0.3],  // 7 is not < 9-2 → stays defensive (hysteresis)
  [5, "caution", 0.6],    // 5 < 9-2 → steps back to caution
  [1, "healthy", 1],      // 1 < 4-2 → back to healthy
];

let passed = 0;
for (const [dd, expectRegime, expectClip] of cases) {
  const regime = rm.update(dd);
  assert.equal(regime, expectRegime, `dd=${dd}% → expected regime ${expectRegime}, got ${regime}`);
  assert.equal(rm.clipMult(), expectClip, `dd=${dd}% → expected clip×${expectClip}, got ${rm.clipMult()}`);
  passed++;
}

// caution mutes pure volume; defensive keeps only the earners.
const rm2 = new RegimeManager({ cautionDrawdownPct: 4, defensiveDrawdownPct: 9, cautionClipMult: 0.6, defensiveClipMult: 0.3 });
rm2.update(0);
assert.ok(rm2.activeModules().has("volume"), "healthy should run volume");
rm2.update(5);
assert.ok(!rm2.activeModules().has("volume"), "caution should mute volume");
assert.ok(rm2.activeModules().has("growth"), "caution should keep growth");
rm2.update(11);
assert.ok(!rm2.activeModules().has("volume"), "defensive should mute volume");
assert.ok(rm2.activeModules().has("growth"), "defensive should keep growth");
passed += 5;

console.log(`✓ regime state machine: ${passed} assertions passed`);
