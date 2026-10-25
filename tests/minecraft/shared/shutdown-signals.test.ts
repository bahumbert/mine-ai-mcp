import test from "node:test";
import assert from "node:assert/strict";
import { installShutdownSignals } from "./shutdown-signals.ts";

test("SIGTERM, SIGINT and SIGHUP each run the shutdown once, and the handlers can be removed", async () => {
  const reasons: string[] = [];
  const hangupHandlersBefore = process.listenerCount("SIGHUP");
  const uninstall = installShutdownSignals(async reason => { reasons.push(reason); });
  try {
    process.emit("SIGTERM");
    process.emit("SIGINT");
    process.emit("SIGHUP");
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.deepEqual(reasons, ["SIGTERM"], "the second and third signal find the shutdown already running");
  } finally {
    uninstall();
  }
  assert.equal(process.listenerCount("SIGHUP"), hangupHandlersBefore);
});

test("after the handlers are removed a signal no longer reaches the shutdown", () => {
  const before = process.listenerCount("SIGTERM");
  const uninstall = installShutdownSignals(async () => {});
  assert.equal(process.listenerCount("SIGTERM"), before + 1);
  uninstall();
  assert.equal(process.listenerCount("SIGTERM"), before);
});
