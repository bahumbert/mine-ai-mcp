import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { z } from "zod";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { createFakeBot, type FakeBot, type FakeHarness } from "../../test-support/fake-bot/index.js";
import { setProtectedRegionsProvider, type ProtectedRegion } from "../../world/protected-regions.js";
import { executeRawAction } from "./raw-action.js";
import { parseRawActionRequest, rawActionInputSchema } from "./contract.js";
import { useBucketOutcomes } from "../use-bucket/contract.js";

test("use_item with a held lava bucket aimed at the bot's own feet cell is refused with the same message", async () => {
  const { bot, clock, server } = createFakeBot({
    position: new Vec3(0.5, 64, 0.5), groundY: 63,
    slots: { 36: { name: "lava_bucket" } },
  });
  await bot.look(0, -Math.PI / 2, true);
  const running = executeRawAction(bot, { operation: "use_item", hand: "hand" }, {});
  await clock.advance(100);
  const result = await running;
  assert.equal(result.status, "failed");
  if (result.status !== "failed") assert.fail("raw use must not bypass the pour guard");
  assert.ok(result.error.endsWith(useBucketOutcomes.pourReachesBody(bot.username, new Vec3(0, 64, 0))), result.error);
  assert.equal(result.attempted, false);
  assert.equal(server.packets.filter((packet) => packet.name === "use_item").length, 0);
});

test("parses each operation into a small discriminated request and rejects mixed fields", () => {
  assert.deepEqual(
    parseRawActionRequest({ operation: "control", state: "jump", ticks: 40 }),
    { operation: "control", state: "jump", ticks: 40 },
  );
  assert.deepEqual(
    parseRawActionRequest({ operation: "look", x: 1, y: 2, z: 3 }),
    { operation: "look", target: { x: 1, y: 2, z: 3 }, yaw: null, pitch: null },
  );
  assert.throws(
    () =>
      parseRawActionRequest({ operation: "dig", x: 1, y: 2, z: 3, ticks: 2 }),
    /ticks is not used by dig/,
  );
  assert.throws(
    () =>
      parseRawActionRequest({ operation: "control", state: "jump", ticks: 41 }),
    /<=40/,
  );
});

test("operation checks ignore server-owned metadata while standalone input stays strict", () => {
  const serverInput = rawActionInputSchema.safeExtend({
    submission_id: z.string(),
    rationale: z.string(),
    response_format: z.enum(["markdown", "json"]),
  });
  assert.deepEqual(
    serverInput.parse({
      operation: "look",
      yaw: 0,
      pitch: 0,
      submission_id: "raw-look-1",
      rationale: "Look toward the target",
      response_format: "json",
    }),
    {
      operation: "look",
      yaw: 0,
      pitch: 0,
      submission_id: "raw-look-1",
      rationale: "Look toward the target",
      response_format: "json",
    },
  );
  assert.throws(
    () =>
      serverInput.parse({
        operation: "look",
        yaw: 0,
        pitch: 0,
        ticks: 2,
        submission_id: "raw-look-2",
        rationale: "Look toward the target",
        response_format: "markdown",
      }),
    /ticks is not used by look/,
  );
  assert.throws(
    () =>
      rawActionInputSchema.parse({
        operation: "look",
        yaw: 0,
        pitch: 0,
        unknown: true,
      }),
    /Unrecognized key/,
  );
});

test("dig refuses beyond eye reach without calling Mineflayer", async () => {
  let digs = 0;
  const { bot } = createFakeBot({
    position: new Vec3(0.5, 64, 0.5),
    cells: { "8,64,0": "stone" },
    overrides: {
      dig: async () => {
        digs++;
      },
    },
  });
  const result = await executeRawAction(
    bot,
    { operation: "dig", target: { x: 8, y: 64, z: 0 } },
    {},
  );
  assert.equal(result.status, "failed");
  if (result.status !== "failed") assert.fail();
  assert.match(result.error, /RAW_OUT_OF_REACH/);
  assert.equal(digs, 0);
  assert.deepEqual(result.target, { x: 8, y: 64, z: 0 });
  assert.equal(result.beforeBlock, "stone");
  assert.equal(result.afterBlock, "stone");
});

test("dig success is based on the block observed after the native call", async () => {
  const { bot, clock } = createFakeBot({
    position: new Vec3(0.5, 64, 0.5),
    cells: { "1,64,0": "pointed_dripstone" },
  });
  const running = executeRawAction(
    bot,
    { operation: "dig", target: { x: 1, y: 64, z: 0 } },
    {},
  );
  await clock.advance(10_000);
  const result = await running;
  assert.equal(result.status, "succeeded");
  assert.equal(result.beforeBlock, "pointed_dripstone");
  assert.equal(result.afterBlock, "air");
  assert.equal(result.attempted, true);
  assert.equal(result.effectObserved, true);
});

test("dig cancellation calls stopDigging and drains the native operation before returning ownership", async () => {
  const stop = new AbortController();
  let stopped = 0;
  let settle!: () => void;
  const native = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const { bot } = createFakeBot({
    position: new Vec3(0.5, 64, 0.5),
    cells: { "1,64,0": "stone" },
    overrides: {
      dig: () => native,
      stopDigging: () => {
        stopped++;
        settle();
      },
    },
  });
  const running = executeRawAction(
    bot,
    { operation: "dig", target: { x: 1, y: 64, z: 0 } },
    { signal: stop.signal },
  );
  stop.abort(new Error("operator cancelled dig"));
  await assert.rejects(running, /operator cancelled dig/);
  assert.equal(stopped, 1);
});

test("a native call that synchronously aborts is stopped and drained", async () => {
  const stop = new AbortController();
  let stopped = 0;
  const { bot } = createFakeBot({
    position: new Vec3(0.5, 64, 0.5),
    cells: { "1,64,0": "stone" },
    overrides: {
      dig: () => { stop.abort(new Error("disconnect during dig start")); return Promise.resolve(); },
      stopDigging: () => { stopped++; },
    },
  });
  await assert.rejects(
    executeRawAction(bot, { operation: "dig", target: { x: 1, y: 64, z: 0 } }, { signal: stop.signal }),
    /disconnect during dig start/,
  );
  assert.equal(stopped, 1);
});

/** Protected regions at raw digs and placements (plan 2026-11-07-p4-06a-threat T5b, ADR-012). */
const regionAround = (owner: string, cell: { x: number; y: number; z: number }): ProtectedRegion => ({
  regionId: 9, dimension: "overworld", owner, label: "Tom's place",
  min: { x: cell.x - 1, y: cell.y - 1, z: cell.z - 1 }, max: { x: cell.x + 1, y: cell.y + 1, z: cell.z + 1 },
});
const digPackets = (harness: FakeHarness) => harness.server.packets.filter((packet) => packet.name === "block_dig").length;

test("raw_action dig of a cell in another owner's region is refused naming the region, with no dig packet", async () => {
  const harness = createFakeBot({ position: new Vec3(0.5, 64, 0.5), cells: { "1,64,0": "stone" } });
  setProtectedRegionsProvider(harness.bot, () => [regionAround("Tom", { x: 1, y: 64, z: 0 })]);
  const result = await executeRawAction(harness.bot, { operation: "dig", target: { x: 1, y: 64, z: 0 } }, {});
  assert.equal(result.status, "failed");
  if (result.status !== "failed") assert.fail();
  assert.match(result.error, /RAW_REGION_PROTECTED/);
  assert.ok(result.error.includes("inside protected region #9 'Tom's place' (owner Tom)"), result.error);
  assert.equal(result.attempted, false);
  assert.equal(digPackets(harness), 0);
  assert.equal(result.afterBlock, "stone");
});

test("raw_action dig of a cell in the bot's own region proceeds", async () => {
  const harness = createFakeBot({ position: new Vec3(0.5, 64, 0.5), cells: { "1,64,0": "pointed_dripstone" } });
  setProtectedRegionsProvider(harness.bot, () => [regionAround(harness.bot.username, { x: 1, y: 64, z: 0 })]);
  const running = executeRawAction(harness.bot, { operation: "dig", target: { x: 1, y: 64, z: 0 } }, {});
  await harness.clock.advance(10_000);
  const result = await running;
  assert.equal(result.status, "succeeded");
  assert.equal(result.afterBlock, "air");
});

test("raw_action place into another owner's region is refused naming the region, with no placement packet", async (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const harness = placingBot("barrel", { placement: "server" });
  setProtectedRegionsProvider(harness.bot, () => [regionAround("Tom", { x: 1, y: 65, z: 0 })]);
  const result = await runRawAction(harness, rawPlace("barrel"), data);
  assert.equal(result.status, "failed");
  if (result.status !== "failed") assert.fail();
  assert.match(result.error, /RAW_REGION_PROTECTED/);
  assert.ok(result.error.includes("inside protected region #9 'Tom's place' (owner Tom)"), result.error);
  assert.equal(result.attempted, false);
  assert.equal(harness.server.packets.filter((packet) => packet.name === "block_place").length, 0);
  assert.equal(harness.bot.blockAt(new Vec3(1, 65, 0))?.name, "air");
  assert.deepEqual(rawPlacedContainers(data), []);
});

test("raw_action place into the bot's own region proceeds", async (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const harness = placingBot("barrel", { placement: "server" });
  setProtectedRegionsProvider(harness.bot, () => [regionAround(harness.bot.username, { x: 1, y: 65, z: 0 })]);
  const result = await runRawAction(harness, rawPlace("barrel"), data);
  assert.equal(result.status, "succeeded");
});

/** Record every control the action sets, then let the fake apply it as before; `onSet` may react to one. */
function recordControls(bot: FakeBot, onSet: (state: string, active: boolean) => void = () => undefined) {
  const states: Array<[string, boolean]> = [];
  const own = bot.setControlState.bind(bot);
  bot.setControlState = (state, active) => {
    states.push([state, active]);
    onSet(state, active);
    own(state, active);
  };
  return states;
}

test("control releases when setting the state synchronously aborts", async () => {
  const stop = new AbortController();
  const { bot } = createFakeBot();
  const states = recordControls(bot, (_state, active) => {
    if (active) stop.abort(new Error("disconnect during control start"));
  });
  await assert.rejects(
    executeRawAction(bot, { operation: "control", state: "jump", ticks: 10 }, { signal: stop.signal }),
    /disconnect during control start/,
  );
  assert.deepEqual(states, [["jump", true], ["jump", false]]);
});

test("dig does not treat an unloaded after-state as an observed block change", async () => {
  const cell = new Vec3(1, 64, 0);
  const { bot, world } = createFakeBot({
    position: new Vec3(0.5, 64, 0.5),
    cells: { "1,64,0": "stone" },
    overrides: { dig: async () => world.setCell(cell, "void") },
  });
  const result = await executeRawAction(
    bot,
    { operation: "dig", target: { x: 1, y: 64, z: 0 } },
    {},
  );
  assert.equal(result.status, "failed");
  if (result.status !== "failed") assert.fail();
  assert.match(result.error, /RAW_DIG_NOT_OBSERVED/);
  assert.equal(result.effectObserved, false);
});

test("control releases only its owned state when cancellation interrupts the tick wait", async () => {
  const stop = new AbortController();
  const { bot } = createFakeBot();
  const states = recordControls(bot);
  const running = executeRawAction(
    bot,
    { operation: "control", state: "forward", ticks: 40 },
    { signal: stop.signal },
  );
  stop.abort(new Error("operator cancelled"));
  await assert.rejects(running, /operator cancelled/);
  assert.deepEqual(states, [
    ["forward", true],
    ["forward", false],
  ]);
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

/**
 * A bot beside a stone support, carrying `carried`, standing on a floor: the server answers its placement with the
 * held block on top of the support, or `placement: "never"` makes the native call do nothing; `onTop` is what is
 * already at the target.
 */
function placingBot(carried: string, options: { placement: "server" | "never"; onTop?: string }) {
  return createFakeBot({
    position: new Vec3(0.5, 65, 0.5),
    carried: { [carried]: 1 },
    cells: { "1,64,0": "stone", ...(options.onTop === undefined ? {} : { "1,65,0": options.onTop }) },
    overrides: options.placement === "never" ? { placeBlock: async () => {} } : {},
  });
}
const rawPlace = (blockName: string) => ({
  operation: "place" as const,
  blockName,
  support: { x: 1, y: 64, z: 0 },
  face: "up" as const,
});
const rawPlacedContainers = (data: ReturnType<typeof temporaryBotData>) =>
  data.read("SELECT container_key, block_name, placed_by_bot_id FROM placed_containers");
/** Run the action while the clock turns the look and carries the server's answer back. */
async function runRawAction(harness: FakeHarness, request: Parameters<typeof executeRawAction>[1], data: ReturnType<typeof temporaryBotData>) {
  const running = executeRawAction(harness.bot, request, {}, data);
  await harness.clock.advance(1_000);
  return running;
}

test("raw_action place of a barrel is recorded as a container the bot placed", async (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const harness = placingBot("barrel", { placement: "server" });

  const result = await runRawAction(harness, rawPlace("barrel"), data);

  assert.equal(result.status, "succeeded");
  assert.deepEqual(rawPlacedContainers(data), [
    { container_key: "overworld|1|65|0", block_name: "barrel", placed_by_bot_id: harness.bot.username },
  ]);
});

test("raw_action place of dirt records nothing", async (t) => {
  const data = temporaryBotData({ closeAfter: t });

  await runRawAction(placingBot("dirt", { placement: "server" }), rawPlace("dirt"), data);

  assert.deepEqual(rawPlacedContainers(data), []);
});

test("raw_action place whose block never appears at the target records nothing", async (t) => {
  const data = temporaryBotData({ closeAfter: t });

  const result = await runRawAction(placingBot("chest", { placement: "never" }), rawPlace("chest"), data);

  assert.equal(result.status, "failed");
  assert.deepEqual(rawPlacedContainers(data), []);
});

test("raw_action place onto a chest that was already at the target is not recorded as placed by the bot", async (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const harness = placingBot("chest", { placement: "never", onTop: "chest" });

  await runRawAction(harness, rawPlace("chest"), data);

  assert.deepEqual(rawPlacedContainers(data), []);
});
