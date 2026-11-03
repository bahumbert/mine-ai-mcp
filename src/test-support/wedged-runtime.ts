import { createServer } from "node:http";
import { INCIDENT_HISTORY_MS } from "../diagnostics/incident-recorder.js";
import { reportRuntimeLiveness } from "../server/runtime-liveness.js";
import { ExecutionScope } from "../execution/execution-scope.js";
import { blockThread } from "./block-thread.js";

/** A child-side wait: `--<name>=<ms>` on the command line, else its default; the supervisor tests pass short ones. */
const waitMs = (name: string, fallback: number): number =>
  Number(process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback);
const slowMs = waitMs("slow-ms", 6000);
const pauseMs = waitMs("pause-ms", 7000);
/** The incident ring's age the supervisor under test was given (`incidentHistoryMs`); the `/background` wedge waits it out. */
const historyMs = waitMs("history-ms", INCIDENT_HISTORY_MS);

/**
 * Waits `ms` on the wall clock, which is the clock the incident ring ages its entries by. A `setTimeout` runs on the
 * monotonic clock and undershoots it when the machine steps its clock back (WSL's time sync did ~2 s, 2026-10-30).
 */
async function untilWallClock(ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) await new Promise<void>((resolve) => setTimeout(resolve, 50));
}
/** On top of the ring's age: covers a clock step back during the ~1 s the supervisor needs to declare the hang (steps measured: 1.95 s). */
const RING_MARGIN_MS = 2_000;

reportRuntimeLiveness();
process.once("disconnect", () => process.exit(0));
const server = createServer(async (request, response) => {
  if (request.url === "/background") {
    // The client has gone away and the entry transition will be older than the
    // incident ring when a callback blocks. Attribution must outlive both.
    const execution = new ExecutionScope({
      bot: "WatchdogTest",
      operation: "navigate",
      targetId: null,
      requestId: 812,
      actionId: "background-action-812",
    });
    void execution.run("route", async () => {
      await execution.run("brief_nested_phase", async () => {});
      response.end("accepted");
      await untilWallClock(historyMs + RING_MARGIN_MS);
      while (true) {}
    });
    return;
  }
  if (request.url === "/health") {
    response.end('{"ok":true}');
    return;
  }
  if (request.url === "/slow") {
    setTimeout(() => response.end("finished"), slowMs);
    return;
  }
  if (request.url === "/pause") {
    response.end("accepted");
    setTimeout(() => blockThread(pauseMs), 100);
    return;
  }
  if (request.url === "/crash") {
    process.exit(23);
  }
  if (request.url === "/sse-hang") {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": ready\n\n");
  }
  using execution = new ExecutionScope({ bot: "WatchdogTest", operation: "fault_injection", targetId: null });
  await execution.run(request.url ?? "unknown", async () => {
    if (request.url === "/microtask") while (true) await Promise.resolve();
    while (true) {} // Deliberately bypasses cooperative checkpoints.
  });
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") process.send?.({ kind: "ready", port: address.port });
});
