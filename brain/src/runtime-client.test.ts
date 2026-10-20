import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { sameDimensionSql } from "./bot-data-sql.ts";
import { McpBotRuntime, type ToolClient } from "./runtime-client.js";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

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

function queryClient(rows: readonly (readonly (string | number | null)[])[]): ToolClient & { readonly queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    callTool: async (call) => {
      queries.push(String((call.arguments as { sql: string }).sql));
      return { structuredContent: { response: { format: "json", data: { result: { status: "succeeded", query: { rows } } } } } };
    },
    close: async () => {},
  };
}

const AT = { x: 8, y: 64, z: 0 };

test("knownContainers reads only containers the bot placed (placed_containers), with the observed slots when opened", async () => {
  // Review 2026-10-19 #8: a chest the bot only opened (a village chest, another bot's) took the deposit.
  const client = queryClient([[10, 64, -3, "chest", 27, 4], [12, 64, 5, "barrel", null, null]]);
  const found = await McpBotRuntime.over(client).knownContainers("Tester", AT, 32, "overworld");
  assert.deepEqual(found, [
    { x: 10, y: 64, z: -3, blockName: "chest", slotCount: 27, usedSlots: 4 },
    { x: 12, y: 64, z: 5, blockName: "barrel", slotCount: null, usedSlots: 0 },
  ]);
  assert.match(client.queries[0]!, /FROM placed_containers p LEFT JOIN observed_containers c ON c\.container_key = p\.container_key/u);
  assert.match(client.queries[0]!, /p\.placed_by_bot_id = 'Tester'/u);
  assert.doesNotMatch(client.queries[0]!, /observed_by_bot_id/u);
});

test("knownContainers also takes a container the bot opened inside a protected region it owns (owner 2026-10-19)", async () => {
  const client = queryClient([]);
  await McpBotRuntime.over(client).knownContainers("Tester", AT, 32, "overworld");
  assert.match(client.queries[0]!, /JOIN protected_regions r ON .*lower\(r\.owner\) = lower\('Tester'\)/u);
  assert.match(client.queries[0]!, /c\.block_x BETWEEN r\.min_x AND r\.max_x AND c\.block_y BETWEEN r\.min_y AND r\.max_y AND c\.block_z BETWEEN r\.min_z AND r\.max_z/u);
});

test("knownContainers reads the rows of a real Minecraft username (letters, digits, underscore, 1-16)", async () => {
  // Review 2026-10-18 #4: the check was /^w{1,16}$/ (the letter w), so every real name got [] and the chest deposit never ran live.
  const client = queryClient([[10, 64, -3, "chest", 27, 4]]);
  const runtime = McpBotRuntime.over(client);
  for (const owner of ["Tester", "Dirk_77", "a", "x".repeat(16)]) {
    assert.deepEqual(await runtime.knownContainers(owner, AT, 32, "overworld"), [{ x: 10, y: 64, z: -3, blockName: "chest", slotCount: 27, usedSlots: 4 }], owner);
  }
  assert.equal(client.queries.length, 4);
  assert.match(client.queries[0]!, /placed_by_bot_id = 'Tester'/u);
});

test("knownContainers refuses a name or a dimension that could break the SQL literal, without querying", async () => {
  const client = queryClient([[10, 64, -3, "chest", 27, 4]]);
  const runtime = McpBotRuntime.over(client);
  for (const owner of ["O'Neil", "x'; DROP TABLE observed_containers; --", "", "x".repeat(17), "two words", "a\"b", "a\b"]) {
    assert.deepEqual(await runtime.knownContainers(owner, AT, 32, "overworld"), [], JSON.stringify(owner));
  }
  for (const dimension of ["", "over'world", "x".repeat(65), "a b"]) {
    assert.deepEqual(await runtime.knownContainers("Tester", AT, 32, dimension), [], JSON.stringify(dimension));
  }
  assert.deepEqual(client.queries, []);
});

test("knownContainers in the Nether asks the Nether: an overworld row is never matched", async () => {
  const client = queryClient([]);
  const runtime = McpBotRuntime.over(client);
  await runtime.knownContainers("Tester", AT, 32, "the_nether");
  await runtime.knownContainers("Tester", AT, 32, "minecraft:overworld");
  assert.match(client.queries[0]!, /replace\(p\.dimension, 'minecraft:', ''\) = 'the_nether'/u);
  assert.doesNotMatch(client.queries[0]!, /overworld/u);
  // Either spelling the server reports for the overworld asks for the same rows.
  assert.match(client.queries[1]!, /replace\(p\.dimension, 'minecraft:', ''\) = 'overworld'/u);
});

test("sameDimensionSql strips minecraft: on both sides and refuses a value that could break the literal", () => {
  assert.equal(sameDimensionSql("p.dimension", "minecraft:the_nether"), "replace(p.dimension, 'minecraft:', '') = 'the_nether'");
  assert.equal(sameDimensionSql("dimension", "overworld"), "replace(dimension, 'minecraft:', '') = 'overworld'");
  for (const value of ["", "o'x", "a;b", "x".repeat(65), "a b", "\"x\""]) assert.equal(sameDimensionSql("dimension", value), null, JSON.stringify(value));
  assert.equal(sameDimensionSql("dimension", "custom:the_deep-1.5/x"), "replace(dimension, 'minecraft:', '') = 'custom:the_deep-1.5/x'");
});

function statusClient(situation: Record<string, unknown>): ToolClient {
  const data = { result: { situation: { position: { x: 0, y: 64, z: 0 }, vitals: { health: 20, food: 20 }, inventory: { stacks: [] }, nearby: { players: [] }, ...situation } } };
  return { callTool: async () => ({ structuredContent: { response: { format: "json", data } } }), close: async () => {} };
}

test("status carries the dimension view_status names; a runtime that names none is the overworld", async () => {
  assert.equal((await McpBotRuntime.over(statusClient({ dimension: "the_nether" })).status()).dimension, "the_nether");
  assert.equal((await McpBotRuntime.over(statusClient({})).status()).dimension, "minecraft:overworld");
});

test("knownContainers' SQL runs on the real bot-data schema: placed, never opened, another bot's, opened only, in an own region, other dimension", async () => {
  // A stub `call` cannot see a typo in the SQL (review 2026-10-18 #4: a regex typo passed every test and killed the deposit live).
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../../src/bot-data/bot-data.sql", import.meta.url), "utf8"));
  const placed = (dimension: string, x: number, bot: string) => database.prepare("INSERT INTO placed_containers VALUES (?, ?, ?, 64, 0, 'chest', ?, 'now')").run(`${dimension}|${x}|64|0`, dimension, x, bot);
  const opened = (dimension: string, x: number, used: number) => database.prepare("INSERT INTO observed_containers VALUES (?, ?, ?, 64, 0, 'chest', 27, ?, 'Tester', 'now')").run(`${dimension}|${x}|64|0`, dimension, x, JSON.stringify(Array.from({ length: used }, () => ({}))));
  placed("minecraft:overworld", 10, "Tester");
  opened("minecraft:overworld", 10, 4);
  placed("overworld", 12, "Tester");
  placed("overworld", 14, "Mira");
  opened("overworld", 16, 2);
  opened("overworld", 20, 5);
  placed("the_nether", 11, "Tester");
  database.exec("INSERT INTO protected_regions (dimension, min_x, min_y, min_z, max_x, max_y, max_z, owner, label, reason, created_by_bot_id, created_at) VALUES ('overworld', 18, 60, -3, 24, 70, 3, 'tester', 'house', 'x', 'Tester', 'now')");
  const client: ToolClient = {
    callTool: async (call) => {
      const rows = database.prepare(String((call.arguments as { sql: string }).sql)).all().map((row) => Object.values(row));
      return { structuredContent: { response: { format: "json", data: { result: { status: "succeeded", query: { rows } } } } } };
    },
    close: async () => {},
  };
  const runtime = McpBotRuntime.over(client);
  const near = { x: 8, y: 64, z: 0 };
  const overworld = await runtime.knownContainers("Tester", near, 32, "overworld");
  assert.deepEqual(overworld.map(({ x, slotCount, usedSlots }) => [x, slotCount, usedSlots]), [[10, 27, 4], [12, null, 0], [20, 27, 5]]);
  assert.deepEqual((await runtime.knownContainers("Tester", near, 32, "minecraft:overworld")).map(({ x }) => x), [10, 12, 20], "either spelling of the overworld asks the same rows");
  assert.deepEqual((await runtime.knownContainers("Tester", near, 32, "the_nether")).map(({ x }) => x), [11]);
  assert.deepEqual((await runtime.knownContainers("Tester", near, 5, "overworld")).map(({ x }) => x), [10, 12], "the reach bounds it, nearest first");
  assert.deepEqual(await runtime.knownContainers("Mira", near, 32, "overworld"), [{ x: 14, y: 64, z: 0, blockName: "chest", slotCount: null, usedSlots: 0 }]);
});

/** A client answering `view_status` with a bot in `dimension` and `query_bot_data` with `answer(sql)`, recording the SQL. */
function worldClient(dimension: string, answer: (sql: string) => readonly (readonly (string | number | null)[])[]): ToolClient & { readonly queries: string[] } {
  const queries: string[] = [];
  const situation = { position: { x: 0, y: 64, z: 0 }, dimension, vitals: { health: 20, food: 20 }, inventory: { stacks: [] }, nearby: { players: [] } };
  return {
    queries,
    callTool: async (call) => {
      if (call.name === "view_status") return { structuredContent: { response: { format: "json", data: { result: { situation } } } } };
      const sql = String((call.arguments as { sql: string }).sql);
      queries.push(sql);
      return { structuredContent: { response: { format: "json", data: { result: { status: "succeeded", query: { rows: answer(sql) } } } } } };
    },
    close: async () => {},
  };
}

const ORIGIN = { x: 0, y: 64, z: 0 };
const FAR = { x: 200, y: 64, z: 0 };

test("the five frontier-map queries ask the dimension the bot is in, never a literal overworld (T6 of the review #8 pattern)", async () => {
  for (const [dimension, bare] of [["the_nether", "the_nether"], ["minecraft:overworld", "overworld"], ["overworld", "overworld"]] as const) {
    const client = worldClient(dimension, () => []);
    const runtime = McpBotRuntime.over(client);
    await runtime.seenAt("oak_log", ORIGIN, 64);
    await runtime.seenPlaces("oak_log", ORIGIN, 64, 3);
    await runtime.waterAlong(ORIGIN, FAR);
    await runtime.unseenAlong(ORIGIN, FAR);
    await runtime.nearestLand(ORIGIN);
    assert.equal(client.queries.length, 5, dimension);
    for (const sql of client.queries) {
      const asksIt = sql.includes(`replace(c.dimension, 'minecraft:', '') = '${bare}'`) || sql.includes(`replace(dimension, 'minecraft:', '') = '${bare}'`);
      assert.ok(asksIt, `${dimension}: ${sql}`);
      if (bare !== "overworld") assert.doesNotMatch(sql, /overworld/u, sql);
    }
  }
});

test("seenPlaces names the dimension the places are in", async () => {
  const runtime = McpBotRuntime.over(worldClient("the_nether", () => [[24, 8]]));
  assert.deepEqual(await runtime.seenPlaces("nether_quartz_ore", ORIGIN, 0, 3), [{ dimension: "the_nether", x: 24, z: 8 }]);
});

test("the frontier-map queries run on the real bot-data schema, each in the dimension the bot is in", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(readFileSync(new URL("../../src/bot-data/bot-data.sql", import.meta.url), "utf8"));
  const chunk = (dimension: string, x: number, z: number, water: number, materials: readonly string[]) => {
    database.prepare("INSERT INTO frontier_chunks VALUES (?, ?, ?, ?, 'now', 'now', ?, 1)").run(`${dimension}|${x}|${z}`, dimension, x, z, water);
    for (const material of materials) database.prepare("INSERT INTO frontier_chunk_materials VALUES (?, ?)").run(`${dimension}|${x}|${z}`, material);
  };
  chunk("overworld", 5, 0, 0.9, ["oak_log"]);          // 88 blocks east: water, logs
  chunk("overworld", 6, 0, 0.9, []);
  chunk("minecraft:overworld", 12, 0, 0.1, ["oak_log"]); // stored with the prefix: land, logs
  chunk("the_nether", 3, 0, 0.0, ["nether_quartz_ore"]);
  chunk("the_nether", 4, 0, 0.0, []);
  const asked = (dimension: string) => McpBotRuntime.over(worldClient(dimension, (sql) => database.prepare(sql).all().map((row) => Object.values(row).map((cell) => (typeof cell === "bigint" ? Number(cell) : (cell as string | number | null))))));
  const overworld = asked("minecraft:overworld");
  assert.deepEqual((await overworld.seenPlaces("oak_log", ORIGIN, 0, 5)).map(({ x }) => x), [88, 200], "both spellings stored, nearest first");
  assert.deepEqual(await overworld.seenPlaces("nether_quartz_ore", ORIGIN, 0, 5), [], "a nether record is not an overworld place");
  assert.equal((await overworld.waterAlong(ORIGIN, { x: 120, y: 64, z: 8 }))?.share, 0.9);
  assert.equal(await overworld.waterAlong(ORIGIN, { x: 50, y: 64, z: 8 }), null, "chunks 0-3 of the overworld were never explored; the nether's are not counted");
  assert.deepEqual(await overworld.nearestLand(ORIGIN), { x: 200, z: 8 });
  assert.equal(await overworld.unseenAlong({ x: 90, y: 64, z: 8 }, { x: 150, y: 64, z: 8 }), 30, "chunk 7 of the overworld (30 blocks on) is the first one never seen");
  const nether = asked("the_nether");
  assert.deepEqual((await nether.seenPlaces("nether_quartz_ore", ORIGIN, 0, 5)).map(({ x }) => x), [56]);
  assert.deepEqual(await nether.seenPlaces("oak_log", ORIGIN, 0, 5), [], "an overworld record is not a nether place");
  assert.deepEqual(await nether.seenAt("oak_log", ORIGIN, 0), { dimension: "overworld", x: 88, z: 8 }, "seen only in another dimension: that one, named");
  assert.deepEqual(await nether.seenAt("nether_quartz_ore", ORIGIN, 0), { dimension: "the_nether", x: 56, z: 8 });
  assert.equal(await nether.seenAt("nether_quartz_ore", ORIGIN, 100), null, "inside the range already searched");
  assert.equal(await nether.waterAlong(ORIGIN, { x: 56, y: 64, z: 8 }).then((water) => water?.share), 0);
  assert.deepEqual(await nether.nearestLand(ORIGIN), { x: 56, z: 8 });
});
