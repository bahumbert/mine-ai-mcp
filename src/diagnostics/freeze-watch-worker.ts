import fs from "node:fs";
import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { freezeViews, MARKER_BYTES, MARKER_SLOTS, REPEATS_INDEX, SLOT_BYTES, type FreezeWatchWorkerData } from "./freeze-watch.js";

const { shared, dir, botName, stallMs }: FreezeWatchWorkerData = workerData;
const views = freezeViews(shared);
const decoder = new TextDecoder();
let recorded = false;

function markers() {
  const end = Atomics.load(views.head, 0);
  const found: { sequence: number; at: string; text: string; repeats: number }[] = [];
  for (let sequence = Math.max(0, end - MARKER_SLOTS); sequence < end; sequence++) {
    const slot = sequence % MARKER_SLOTS;
    if (Atomics.load(views.slots, slot * (SLOT_BYTES / 4)) !== sequence + 1) continue;
    const length = Math.min(views.slots[slot * (SLOT_BYTES / 4) + 1]!, MARKER_BYTES);
    const base = slot * SLOT_BYTES + 16;
    found.push({
      sequence,
      at: new Date(views.times[slot * (SLOT_BYTES / 8) + 1]!).toISOString(),
      text: decoder.decode(views.text.subarray(base, base + length)),
      repeats: views.slots[slot * (SLOT_BYTES / 4) + REPEATS_INDEX]!,
    });
  }
  return found;
}

/** Ask the paused main thread where it is; Bun may not implement this, which is itself worth recording. */
async function mainThreadStack(budgetMs: number): Promise<string | string[]> {
  try {
    const { Session } = await import("node:inspector");
    const session = new Session();
    session.connectToMainThread();
    const frames = await new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no pause within ${budgetMs} ms`)), budgetMs);
      session.on("Debugger.paused", (message) => {
        clearTimeout(timer);
        const callFrames = (message.params as { callFrames: { functionName: string; url: string; location: { lineNumber: number } }[] }).callFrames;
        resolve(callFrames.map((frame) => `${frame.functionName || "(anonymous)"} ${frame.url}:${frame.location.lineNumber + 1}`));
      });
      session.post("Debugger.enable", (cause) => {
        if (cause) return reject(cause);
        session.post("Debugger.pause", (failure) => failure && reject(failure));
      });
    });
    session.post("Debugger.resume");
    session.disconnect();
    return frames;
  } catch (cause) {
    return `unavailable: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

async function record(stalledForMs: number): Promise<void> {
  const stallStart = new Date(views.bump[0]!).toISOString();
  const snapshot = markers();
  const stack = await mainThreadStack(500);
  const memory = process.memoryUsage();
  const file = path.join(dir, `freeze-${stallStart.replace(/[:.]/g, "-")}.json`);
  fs.mkdirSync(dir, { recursive: true });
  const fd = fs.openSync(file, "w");
  try {
    fs.writeSync(fd, JSON.stringify({ bot: botName, stallStart, stalledForMs, stallMs, markers: snapshot, memory, stack }, null, 2));
  } finally {
    fs.closeSync(fd);
  }
  parentPort?.postMessage({ file });
}

setInterval(() => {
  const stalledForMs = Date.now() - views.bump[0]!;
  if (stalledForMs < stallMs) {
    recorded = false;
    return;
  }
  if (recorded) return;
  recorded = true;
  void record(stalledForMs).catch((cause) => process.stderr.write(`[mine-ai-mcp] freeze record failed: ${cause}\n`));
}, 100);
