/**
 * A runtime child for the supervisor tests that reports a process fault over IPC the way `runtime-process.ts` does:
 * before `ready` when started with `before-ready`, else on `GET /fault`; `GET /fault-during-request` reports it while
 * an action of request 812 is active, `GET /fault-twice` reports two distinct faults.
 */
import { createServer } from "node:http";
import { reportRuntimeLiveness } from "../server/runtime-liveness.js";
import { ExecutionScope } from "../execution/execution-scope.js";

const fault = (message: string) => ({
  kind: "fault",
  fault: { kind: "unhandled_rejection", message, stack: `Error: ${message}\n    at faulting-runtime`, observedAt: new Date().toISOString(), repeats: 0 },
});
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

reportRuntimeLiveness();
process.once("disconnect", () => process.exit(0));
if (process.argv[2] === "before-ready") process.send?.(fault("raised before ready"));
const server = createServer(async (request, response) => {
  if (request.url === "/fault") process.send?.(fault("raised while ready"));
  if (request.url === "/fault-twice") {
    process.send?.(fault("first distinct fault"));
    process.send?.(fault("second distinct fault"));
  }
  if (request.url === "/fault-during-request") {
    const execution = new ExecutionScope({ bot: "FaultTest", operation: "navigate", targetId: null, requestId: 812, actionId: "fault-action-812" });
    await execution.run("route", async () => {
      await wait(500); // two heartbeats: the supervisor knows this scope before the fault arrives
      process.send?.(fault("raised during request 812"));
      await wait(300);
    });
  }
  response.end('{"ok":true}');
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string") process.send?.({ kind: "ready", port: address.port });
});
