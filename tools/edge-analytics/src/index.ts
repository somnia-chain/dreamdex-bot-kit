/**
 * @license
 * Copyright DreamDEX S.A.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://github.com/somnia-chain/dreamdex-bot-kit/blob/main/LICENSE
 */

// CLI: turn a trade log into an edge report.
//
//   tsx src/index.ts --trades <csv> [--mid <csv> | --mid-from-trades <csv>]
//                    [--horizons 1,10,60] [--json]
//
// Examples:
//   # Full analysis from a bot's csv-logger output + a book-mid poll:
//   tsx src/index.ts --trades data/trades.csv --mid data/mids.csv
//
//   # No book log? Approximate the mid from a public trade tape (lower bound):
//   tsx src/index.ts --trades data/trades.csv --mid-from-trades data/tape.csv
//
//   # Zero-setup demo on the bundled sample:
//   npm start

import { loadTradeRows, loadMidCsv, loadTradesCsv } from "./csv.js";
import { markoutFills, midSeriesFromTrades } from "./markout.js";
import { buildReport, formatReport } from "./report.js";
import type { MidTick } from "./types.js";

interface Args {
  trades?: string;
  mid?: string;
  midFromTrades?: string;
  horizonsMs?: number[];
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    switch (k) {
      case "--trades": a.trades = v; i++; break;
      case "--mid": a.mid = v; i++; break;
      case "--mid-from-trades": a.midFromTrades = v; i++; break;
      case "--horizons":
        a.horizonsMs = (v ?? "").split(",").map((s) => Number(s) * 1000);
        i++;
        break;
      case "--json": a.json = true; break;
      default: break;
    }
  }
  return a;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));

  // Default to the bundled sample so `npm start` just works.
  const tradesPath = args.trades ?? "sample/trades.csv";
  const usingSample = !args.trades;

  const { fills, actions } = loadTradeRows(tradesPath);
  if (fills.length === 0) {
    console.error(
      `No fills found in ${tradesPath}. Expected kit csv-logger rows with action=fill.`,
    );
    process.exit(1);
  }

  let mids: MidTick[];
  let midProxy = false;
  if (args.mid) {
    mids = loadMidCsv(args.mid);
  } else if (args.midFromTrades) {
    mids = midSeriesFromTrades(loadTradesCsv(args.midFromTrades));
    midProxy = true;
  } else if (usingSample) {
    mids = loadMidCsv("sample/mids.csv");
  } else {
    console.error(
      "Provide a mid path: --mid <ts,mid csv> (preferred) or --mid-from-trades <ts,price csv>.",
    );
    process.exit(1);
    return;
  }

  const markouts = markoutFills(fills, mids, { horizonsMs: args.horizonsMs });
  const report = buildReport(markouts, actions);

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report, midProxy));
  }
}

main();
