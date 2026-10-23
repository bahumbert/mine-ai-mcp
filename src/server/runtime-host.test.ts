import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import mineflayer from "mineflayer";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { SqlBotData } from "../bot-data/index.js";
import { createFakeBot, type FakeBotOptions } from "../test-support/fake-bot/index.js";
import { parseHostOptions } from "./config.js";
import { kickReason, startRuntimeHost } from "./runtime-host.js";

const source = { kind: "unavailable", reason: "Host lifecycle test" } as const;

test("a kick reason that is a text component is logged whole, a plain one as it is", () => {
  assert.equal(kickReason("Server closed"), "Server closed");
  assert.equal(
    kickReason({ type: "compound", value: { translate: { type: "string", value: "multiplayer.disconnect.flying" } } }),
    '{"type":"compound","value":{"translate":{"type":"string","value":"multiplayer.disconnect.flying"}}}',
  );
});

async function configuration(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "host-lifetime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { ...parseHostOptions(["--data-root", directory]), listenPort: 0 };
}

function connectedBot(t: TestContext, slots: FakeBotOptions["slots"] = {}) {
  const { bot } = createFakeBot({
    slots,
    // `kick.js`: quit ends the client, whose end Mineflayer re-emits as the bot's `end` (`loader.js:113`).
    overrides: { quit: () => bot.emit("end", "Host test closed") },
  });
  bot._client.uuid = "host-test";
  // The tool plugin as `loadBotPlugins` finds it already installed: the fake bot has no `loadPlugin`.
  Object.assign(bot, { tool: { equipForBlock: async () => {} } });
  // No chunk column is loaded: the frontier observes none. The fake world keeps blocks, not columns.
  Object.assign(bot.world, { getColumns: () => [], getColumn: () => undefined });
  t.mock.method(mineflayer, "createBot", () => {
    queueMicrotask(() => {
      bot._client.emit("login", { worldState: { hashedSeed: 1n } });
      bot.emit("spawn");
    });
    return bot;
  });
  return bot;
}

function failures(error: unknown): unknown[] {
  return error instanceof SuppressedError ? [...failures(error.suppressed), ...failures(error.error)] : [error];
}

test("a plugin startup failure still quits the newly created bot", async (t) => {
  const options = await configuration(t);
  const bot = connectedBot(t);
  const pluginFailure = new Error("Plugin loading failed");
  // Force the real plugin-loading boundary to fail before any spawn waiter exists.
  delete (bot as Partial<typeof bot>).tool;
  bot.loadPlugin = () => {
    throw pluginFailure;
  };
  const quit = t.mock.method(bot, "quit");
  await assert.rejects(startRuntimeHost(source, options), (error) => error === pluginFailure);
  assert.equal(quit.mock.callCount(), 1);
  assert.equal(bot._client.listenerCount("registry_data"), 0);
});

test("failed HTTP binding releases the runtime and bot and retains combined cleanup failures", async (t) => {
  const options = await configuration(t);
  const bot = connectedBot(t);
  await using occupied = createServer();
  await once(occupied.listen(0, "127.0.0.1"), "listening");
  const address = occupied.address();
  assert.ok(address && typeof address === "object");
  const runtimeFailure = new Error("Runtime disposal failed");
  const quitFailure = new Error("Bot quit failed");
  const closeDatabase = SqlBotData.prototype.close;
  const releases: string[] = [];
  t.mock.method(SqlBotData.prototype, "close", function (this: SqlBotData) {
    closeDatabase.call(this);
    releases.push("database");
    throw runtimeFailure;
  });
  t.mock.method(bot, "quit", () => {
    releases.push("bot");
    assert.equal(
      EventEmitter.prototype.listenerCount.call(bot, "path_update"),
      0,
      "The highlighter releases before bot.quit.",
    );
    bot.emit("end", "Host test closed");
    throw quitFailure;
  });
  await assert.rejects(startRuntimeHost(source, { ...options, listenPort: address.port }), (error) => {
    const causes = failures(error);
    assert.ok(causes.some((cause) => cause instanceof Error && "code" in cause && cause.code === "EADDRINUSE"));
    assert.ok(causes.includes(runtimeFailure));
    assert.ok(causes.includes(quitFailure));
    return true;
  });
  assert.deepEqual(releases, ["database", "bot"]);
  assert.equal(bot.listenerCount("physicsTick"), 0);
  assert.equal(bot.listenerCount("error"), 0);
});

test(
  "host disposal drains MCP streams before HTTP, runtime and bot, and concurrent close shares completion",
  { timeout: 10_000 },
  async (t) => {
    const options = await configuration(t);
    const bot = connectedBot(t);
    const signals = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];
    await using host = await startRuntimeHost(source, options);
    assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], signals);
    const address = host.server.address();
    assert.ok(address && typeof address === "object");
    const url = `http://127.0.0.1:${address.port}`;
    const initialize = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "lifetime-test", version: "1" },
        },
      }),
    });
    assert.equal(initialize.status, 200);
    await initialize.text();
    const sessionId = initialize.headers.get("mcp-session-id");
    assert.ok(sessionId);
    const stream = await fetch(`${url}/mcp`, {
      headers: { accept: "text/event-stream", "mcp-session-id": sessionId },
    });
    assert.equal(stream.status, 200);
    const streamClosed = stream.text();
    const closeDatabase = SqlBotData.prototype.close;
    const releases: string[] = [];
    t.mock.method(SqlBotData.prototype, "close", function (this: SqlBotData) {
      assert.equal(host.server.listening, false);
      closeDatabase.call(this);
      releases.push("database");
    });
    t.mock.method(bot, "quit", () => {
      releases.push("bot");
      assert.equal(bot.listenerCount("physicsTick"), 0);
      bot.emit("end", "Host test closed");
    });
    bot.emit("end", "Connection lost during test");
    assert.equal((await fetch(`${url}/health`)).status, 503);
    assert.equal(host.server.listening, true, "Disconnect keeps HTTP available to report failures.");
    const closed = host.close();
    assert.equal(host.close(), closed);
    await closed;
    await streamClosed;
    assert.deepEqual(releases, ["database", "bot"]);
  },
);

test("health publishes the bot's own slots and the calls an observer cannot otherwise see", async (t) => {
  const options = await configuration(t);
  connectedBot(t, { 36: { name: "cobblestone", count: 12 }, 5: { name: "iron_helmet", count: 1 } });
  await using host = await startRuntimeHost(source, options);
  const address = host.server.address();
  assert.ok(address && typeof address === "object");
  const url = `http://127.0.0.1:${address.port}`;

  const health = await (await fetch(`${url}/health`)).json();
  // A Minecraft client is sent only another player's six equipment slots, so
  // the worn helmet and the carried stack can come only from this endpoint.
  assert.deepEqual(health.minecraft.inventory, [
    // A worn stack is a prismarine Item, as the real window holds: its maximum is the 1.21.4 data's
    // (`prismarine-item` index.js:41, 50-51) and a new helmet has used none. No contract check covers armour yet.
    { slot: 5, location: "head", name: "iron_helmet", count: 1, held: false, durability: { remaining: 165, maximum: 165 } },
    { slot: 36, location: "hotbar", name: "cobblestone", count: 12, held: true, durability: null },
  ]);
  assert.deepEqual(health.minecraft.recentCalls, []);
});
