/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// Load environment from .env files, walking UP from the current directory.
//
// This makes a monorepo "just work": you can keep PRIVATE_KEY / NETWORK in the
// repo-root .env and per-strategy knobs in a strategy's own .env, and both are
// found no matter which directory you run a strategy from. Nearest .env wins on
// a key conflict; existing process env vars are never overridden.

import { config as dotenvConfig } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function loadEnv(start: string = process.cwd()): void {
  const found: string[] = [];
  let dir = start;
  // Collect .env files from cwd up to the filesystem root.
  while (true) {
    const p = join(dir, ".env");
    if (existsSync(p)) found.push(p);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Load nearest-first so a strategy-local .env overrides the shared root one.
  for (const p of found) dotenvConfig({ path: p, override: false });
}
