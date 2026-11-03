import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createFakeClock, flush } from "../test-support/fake-bot/index.js";
import { closeIdleClientSessions, createMinecraftMcpHttpApplication } from "./http.js";

async function host(t: TestContext, health = () => ({ connected: true }), clientIdleTimeoutMs?: number) {
  const application = createMinecraftMcpHttpApplication({
    health,
    clientIdleTimeoutMs,
    createServer: () => {
      const server = new McpServer({ name: "http-contract-test", version: "1" });
      server.registerTool("observe", { description: "Observe a shared runtime" }, async () => ({
        content: [{ type: "text", text: "runtime available" }],
      }));
      return server;
    },
  });
  const listener = createServer(application.app);
  t.after(async () => {
    await application.close();
    const closed = new Promise<void>((resolve, reject) => {
      listener.close((error) => error ? reject(error) : resolve());
    });
    listener.closeAllConnections();
    await closed;
  });
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address === "object");
  return { application, url: `http://127.0.0.1:${address.port}` };
}

test("independent HTTP clients can disconnect without closing another client's runtime access", async (t) => {
  const { application, url } = await host(t);
  const first = new Client({ name: "first", version: "1" });
  const second = new Client({ name: "second", version: "1" });
  const firstTransport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
  const secondTransport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
  try {
    await first.connect(firstTransport);
    await second.connect(secondTransport);
    assert.equal(application.clientSessionCount, 2);
    assert.deepEqual((await first.listTools()).tools.map((tool) => tool.name), ["observe"]);
    await firstTransport.terminateSession();
    assert.equal(application.clientSessionCount, 1);
    const result = await second.callTool({ name: "observe", arguments: {} });
    assert.deepEqual(result.content, [{ type: "text", text: "runtime available" }]);
    await application.close();
    assert.equal(application.clientSessionCount, 0);
    assert.equal((await fetch(`${url}/mcp`, {
      headers: { "mcp-session-id": secondTransport.sessionId! },
    })).status, 404);
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test("HTTP boundary rejects foreign origins and invalid sessions and reports disconnected health", async (t) => {
  let connected = false;
  const { url } = await host(t, () => ({ connected }));
  assert.equal((await fetch(`${url}/health`)).status, 503);
  connected = true;
  assert.equal((await fetch(`${url}/health`)).status, 200);
  assert.equal((await fetch(`${url}/health`, {
    headers: { origin: "https://example.com" },
  })).status, 403);
  assert.equal((await fetch(`${url}/health`, {
    headers: { origin: "http://localhost:1234" },
  })).status, 200);
  for (const method of ["GET", "POST", "DELETE"]) {
    assert.equal((await fetch(`${url}/mcp`, { method })).status, 400);
    assert.equal((await fetch(`${url}/mcp`, {
      method,
      headers: { "mcp-session-id": "unknown" },
    })).status, 404);
  }
});

test("an expiring client session whose close rejects does not reject the reaper", async () => {
  const log: string[] = [];
  const sessions = new Map([
    ["rejects", { lastActiveAt: 0, server: { connect: async () => {}, close: async () => { throw new Error("close refused"); } } }],
    ["throws", { lastActiveAt: 0, server: { connect: async () => {}, close: () => { throw new Error("close threw"); } } }],
    ["fresh", { lastActiveAt: 1_000, server: { connect: async () => {}, close: async () => {} } }],
  ]);
  assert.doesNotThrow(() => closeIdleClientSessions(sessions, 500, (message) => log.push(message)));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual([...sessions.keys()], ["fresh"], "both expired sessions left the map, the fresh one stayed");
  assert.deepEqual(
    log.filter((line) => /close (refused|threw)/.test(line)).length,
    2,
    `each failed close is logged once: ${log.join(" | ")}`,
  );
});

// WSL steps its wall clock: the idle reaper's cutoff and each session's last activity are both monotonic readings, so a
// step reaps a live session (forward) or keeps a dead one (back) only if one of them reads `Date.now()`.
for (const [direction, stepMs, survives] of [["forward", 600_000, true], ["back", -600_000, false]] as const) {
  test(`a client session idle for ${survives ? "under" : "over"} its timeout is ${survives ? "kept" : "reaped"} across a wall clock step ${direction}`, async (t) => {
    const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
    using _installed = clock.install();
    const { application, url } = await host(t, undefined, 60_000);
    const client = new Client({ name: "idle", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    // A request after connect, and the client's own follow-ups drained: the session's last activity is before the step.
    await client.listTools();
    await flush();
    assert.equal(application.clientSessionCount, 1);
    clock.stepWallClock(stepMs);
    // The reaper ticks every 60 s: at 60 s the session has been idle exactly the timeout, at 120 s twice it.
    await clock.advance(survives ? 60_000 : 120_000, 1000);
    assert.equal(application.clientSessionCount, survives ? 1 : 0);
    await client.close().catch(() => undefined);
  });
}
