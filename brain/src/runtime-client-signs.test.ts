// Failed sign reads must remain distinct from successfully observed cells with no sign.
import assert from "node:assert/strict";
import test from "node:test";
import { McpBotRuntime } from "./runtime-client.ts";

test("readSigns preserves action failures and accepts a successful empty reading", async () => {
  for (const status of ["succeeded", "failed", "partial", "cancelled"]) {
    const runtime = McpBotRuntime.over({
      callTool: async () => ({ structuredContent: { response: { format: "json", data: { result: {
        status, ...(status !== "succeeded" && { error: "[READ_SIGNS_UNLOADED] Move closer and read again." }), signs: [],
      } } } } }), close: async () => {},
    });
    const reading = runtime.readSigns({ x: 1, y: 64, z: -1 });
    if (status === "succeeded") assert.deepEqual(await reading, []);
    else await assert.rejects(reading, /READ_SIGNS_UNLOADED/u);
  }
});
