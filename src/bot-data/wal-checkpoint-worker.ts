// The checkpoint thread of wal-checkpointer.ts: its own connection to the bot-data file, never writing rows.
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { closeSqlDatabase } from "./sql-bot-data.js";
import { createCheckpointRunner, type WalCheckpointerMessage, type WalCheckpointerWorkerData } from "./wal-checkpointer.js";

const { file, intervalMs, released } = workerData as WalCheckpointerWorkerData;
const port = parentPort;
if (!port) throw new Error("wal-checkpoint-worker must run as a worker thread.");

const database = new DatabaseSync(file, { allowExtension: false, defensive: true });
database.exec("PRAGMA busy_timeout = 5000");
// exec, not a kept prepared statement: Bun leaves a statement unfinalised after close, which keeps the file locked.
const run = createCheckpointRunner(
  { checkpoint: () => database.exec("PRAGMA wal_checkpoint(PASSIVE)") },
  (message) => {
    const reply: WalCheckpointerMessage = { kind: "checkpoint-failed", message };
    port.postMessage(reply);
  },
);

const timer = setInterval(run, intervalMs);
port.on("message", (message) => {
  if (message !== "stop") return;
  clearInterval(timer);
  closeSqlDatabase(database);
  const flag = new Int32Array(released);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
  port.close();
});
