/**
 * Bundled by `bundle.test.ts` into `src/server/bundle-probe.js`, the folder of `runtime-process.js`, and run with Bun from a
 * folder that has only the trimmed `minecraft-data` in its `node_modules`: it does what the shipped runtime does at start,
 * so a file the bundle lacks fails here and not in the player's first game. Prints one JSON line.
 * Never shipped (`launcher/src/build` stays out of the package).
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../../../src/actions/use-container/window-answer.ts";
import "../../../src/navigation/mineflayer/cell-resync.ts";
import "../../../src/runtime/player-events.ts";
import "../../../src/world/crafting.ts";
import { BOT_DATA_SCHEMA } from "../../../src/bot-data/bot-data-schema.ts";
import { startWalCheckpointer } from "../../../src/bot-data/wal-checkpointer.ts";
import { startFreezeWatch } from "../../../src/diagnostics/freeze-watch.ts";

const WORKER_SETTLE_MS = 600;
const STALL_MS = 50;
const FREEZE_MS = 400;
const FREEZE_ATTEMPTS = 5;

const folder = mkdtempSync(join(tmpdir(), "bundle-probe-"));
const database = new DatabaseSync(join(folder, "bot-data.sqlite"));
database.exec(BOT_DATA_SCHEMA);
database.exec("PRAGMA journal_mode = WAL");

const walFailures: string[] = [];
const walCheckpointer = startWalCheckpointer(join(folder, "bot-data.sqlite"), { intervalMs: 50, fellBack: (cause) => walFailures.push(cause) });
const freezeDirectory = join(folder, "freeze");
const freezeWatch = startFreezeWatch({ dir: freezeDirectory, botName: "probe", stallMs: STALL_MS });

// The freeze worker records a stall once the main thread answers again. A worker that starts after a freeze has ended sees no
// stall, so the main thread freezes again (at most FREEZE_ATTEMPTS times, ~1 s each) until a record exists.
for (let attempt = 0; attempt < FREEZE_ATTEMPTS && freezeWatch.lastRecord() === null; attempt++) {
  const frozenUntil = Date.now() + FREEZE_MS;
  while (Date.now() < frozenUntil);
  await new Promise((resolve) => setTimeout(resolve, WORKER_SETTLE_MS));
}

console.log("PROBE " + JSON.stringify({
  schemaBytes: BOT_DATA_SCHEMA.length,
  walFailures,
  freezeRecord: freezeWatch.lastRecord(),
  freezeFiles: existsSync(freezeDirectory) ? readdirSync(freezeDirectory).length : 0,
}));
walCheckpointer[Symbol.dispose]();
freezeWatch[Symbol.dispose]();
database.close();
rmSync(folder, { recursive: true, force: true });
process.exit(0);
