/**
 * Phase 0 done-check: parse a real save and print a sane text summary.
 *   bun run cli/summarize-save.ts [path-to-save]
 */

import { loadSaveFromFile } from "../src/save/load-save";
import { formatSummary, summarizeGame } from "../src/save/game-summary";

const path = process.argv[2] ?? "saves/turn518-14civs.unciv";
const game = await loadSaveFromFile(path);
console.log(formatSummary(summarizeGame(game)));
