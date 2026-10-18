import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { McpBotRuntime, type ToolClient } from "./runtime-client.js";

function dropsClient(sources: readonly Record<string, unknown>[]): ToolClient {
  const data = { result: { drops: { items: [{ item: "wheat", sources, mobs: [] }], blocks: [] } } };
  return { callTool: async () => ({ structuredContent: { response: { format: "json", data } } }), close: async () => {} };
}

test("a planted drop source carries the seed the runtime names, a wild one has none", async () => {
  const runtime = McpBotRuntime.over(dropsClient([{ block: "wheat", chance: 1, planted: true, seed: "wheat_seeds" }, { block: "grass", chance: 0.1, planted: false }]));
  const sources = (await runtime.blockSources(["wheat"]))["wheat"]!;
  assert.deepEqual(sources, [{ block: "wheat", chance: 1, planted: true, seed: "wheat_seeds" }, { block: "grass", chance: 0.1, planted: false }]);
});

test("a source from a runtime that names no seed still parses", async () => {
  const runtime = McpBotRuntime.over(dropsClient([{ block: "wheat", chance: 1, planted: true }]));
  assert.deepEqual((await runtime.blockSources(["wheat"]))["wheat"], [{ block: "wheat", chance: 1, planted: true }]);
});

function sessionClient(replies: readonly (() => Promise<Record<string, unknown>>)[]): ToolClient & { calls: number; closed: boolean } {
  const client = {
    calls: 0,
    closed: false,
    callTool: async () => replies[client.calls++]!(),
    close: async () => {
      client.closed = true;
    },
  };
  return client;
}

const dropsReply = () => ({ structuredContent: { response: { format: "json", data: { result: { drops: { items: [{ item: "wheat", sources: [], mobs: [] }], blocks: [] } } } } } });
const lost = () => Promise.reject(new Error("Streamable HTTP error: 404 session not found"));

test("a call that met a lost session reconnects and fails as a restarted body; the next call goes through the new client", async () => {
  const old = sessionClient([lost]);
  const fresh = sessionClient([async () => dropsReply()]);
  const runtime = McpBotRuntime.over(old, async () => fresh);
  await assert.rejects(runtime.blockSources(["wheat"]), /^Error: \[BODY_RESTARTED\] the body restarted: view_block_drops was not done/u);
  assert.equal(old.closed, true);
  assert.deepEqual(await runtime.blockSources(["wheat"]), { wheat: [] });
  assert.equal(fresh.calls, 1);
});

test("a reconnect that fails throws the original error, and the next call tries again", async () => {
  let attempts = 0;
  const fresh = sessionClient([async () => dropsReply()]);
  const runtime = McpBotRuntime.over(sessionClient([lost]), async () => {
    if (++attempts === 1) throw new Error("connection refused");
    return fresh;
  });
  await assert.rejects(runtime.blockSources(["wheat"]), /404 session not found/u);
  assert.deepEqual(await runtime.blockSources(["wheat"]), { wheat: [] });
  assert.equal(attempts, 2);
});

test("a reply that names an unresponsive or exited runtime is a lost body too", async () => {
  const text = "[RUNTIME_UNRESPONSIVE] Runtime event-loop heartbeat absent";
  const runtime = McpBotRuntime.over(sessionClient([async () => ({ isError: true, content: [{ type: "text", text }] })]), async () => sessionClient([]));
  await assert.rejects(runtime.blockSources(["wheat"]), /\[BODY_RESTARTED\]/u);
});

test("a tool failure the runtime answered never reconnects", async () => {
  let reconnects = 0;
  const runtime = McpBotRuntime.over(sessionClient([async () => ({ isError: true, content: [{ type: "text", text: "invalid input" }] })]), async () => {
    reconnects++;
    return sessionClient([]);
  });
  await assert.rejects(runtime.blockSources(["wheat"]), /\[MCP_CALL_FAILED\]/u);
  assert.equal(reconnects, 0);
});

test("only a gone session, a lost connection or a killed runtime reconnects; other thrown errors are rethrown", async () => {
  const lostWith = async (error: Error): Promise<{ message: string; reopened: number }> => {
    let reopened = 0;
    const runtime = McpBotRuntime.over(sessionClient([() => Promise.reject(error)]), async () => {
      reopened++;
      return sessionClient([]);
    });
    const message = await runtime.blockSources(["wheat"]).then(() => "", (thrown: Error) => thrown.message);
    return { message, reopened };
  };
  assert.match((await lostWith(new StreamableHTTPError(404, "session not found"))).message, /^\[BODY_RESTARTED\]/u);
  assert.match((await lostWith(new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) }))).message, /^\[BODY_RESTARTED\]/u);
  assert.match((await lostWith(new McpError(ErrorCode.ConnectionClosed, "Connection closed"))).message, /^\[BODY_RESTARTED\]/u);
  assert.match((await lostWith(new McpError(ErrorCode.InternalError, "[RUNTIME_EXITED] Runtime exited"))).message, /^\[BODY_RESTARTED\]/u);
  for (const error of [new McpError(ErrorCode.RequestTimeout, "Request timed out"), new McpError(ErrorCode.InvalidParams, "bad input"), new Error("boom")]) {
    const { message, reopened } = await lostWith(error);
    assert.equal(message, error.message);
    assert.equal(reopened, 0, `${error.message} must not reopen a live session`);
  }
});

test("a refused connection whose reconnect also fails throws the original error, and the next call retries", async () => {
  const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect"), { code: "ECONNREFUSED" }) });
  let attempts = 0;
  const runtime = McpBotRuntime.over(sessionClient([() => Promise.reject(refused)]), async () => {
    if (++attempts === 1) throw new Error("still down");
    return sessionClient([async () => dropsReply()]);
  });
  await assert.rejects(runtime.blockSources(["wheat"]), /fetch failed/u);
  assert.deepEqual(await runtime.blockSources(["wheat"]), { wheat: [] });
});

test("a rationale longer than the contract's 200 characters is cut before it is sent", async () => {
  // Run 12: `[MCP_CALL_FAILED] craft_item: ... Too big: expected string to have <=200 characters at rationale`.
  const sent: Record<string, unknown>[] = [];
  const client: ToolClient = {
    callTool: async (call) => {
      sent.push(call.arguments as Record<string, unknown>);
      return { structuredContent: { response: { format: "json", data: { result: {} } } } };
    },
    close: async () => {},
  };
  const runtime = McpBotRuntime.over(client);
  await runtime.submit("craft_item", {}, "x".repeat(300), 1000).catch(() => undefined); // the empty reply is not a state; only what was sent counts
  assert.equal((sent[0]?.["rationale"] as string).length, 200);
  await runtime.submit("craft_item", {}, "short", 1000).catch(() => undefined); // the empty reply is not a state; only what was sent counts
  assert.equal(sent[1]?.["rationale"], "short");
});

test("the values a tool's input property accepts are read from the tool's schema, once", async () => {
  let listed = 0;
  const client: ToolClient = {
    callTool: async () => ({}),
    listTools: async () => {
      listed += 1;
      return { tools: [{ name: "use_bucket", inputSchema: { type: "object", properties: { liquid: { type: "string", enum: ["water", "lava"], default: "water" }, action: { type: "string" } } } }] };
    },
    close: async () => {},
  };
  const runtime = McpBotRuntime.over(client);
  assert.deepEqual(await runtime.toolEnum("use_bucket", "liquid"), ["water", "lava"]);
  assert.deepEqual(await runtime.toolEnum("use_bucket", "action"), [], "a property with no enum");
  assert.deepEqual(await runtime.toolEnum("use_bucket", "nothing"), [], "an unknown property");
  assert.deepEqual(await runtime.toolEnum("nothing", "liquid"), [], "an unknown tool");
  assert.equal(listed, 1);
});

test("a client that cannot list its tools gives no values", async () => {
  const runtime = McpBotRuntime.over({ callTool: async () => ({}), close: async () => {} });
  assert.deepEqual(await runtime.toolEnum("use_bucket", "liquid"), []);
});

test("an unreadable tool listing is asked for once and logged once, not on every call", async () => {
  // Run 14 review N12: gathering asks toolEnum every round; a failing listTools was retried each time, silently.
  let listed = 0;
  const client: ToolClient = {
    callTool: async () => ({}),
    listTools: async () => {
      listed += 1;
      throw new Error("tools/list is not supported");
    },
    close: async () => {},
  };
  const warnings: string[] = [];
  const warn = mock.method(console, "warn", (line: string) => { warnings.push(line); });
  try {
    const runtime = McpBotRuntime.over(client);
    assert.deepEqual(await runtime.toolEnum("use_bucket", "liquid"), []);
    assert.deepEqual(await runtime.toolEnum("use_bucket", "liquid"), []);
    assert.equal(listed, 1);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /tools\/list is not supported/u);
  } finally {
    warn.mock.restore();
  }
});
