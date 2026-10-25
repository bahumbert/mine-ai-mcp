import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { z } from "zod";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { createFakeBot, type FakeBot, type FakeHarness } from "../../test-support/fake-bot/index.js";
import { executeRawAction } from "./raw-action.js";
import { parseRawActionRequest, rawActionInputSchema } from "./contract.js";

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
