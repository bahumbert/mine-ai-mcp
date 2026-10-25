import assert from "node:assert/strict";
import test from "node:test";
import { flatWorld, observation } from "../../test-support/navigation.js";
import type { CellResync } from "../bot.js";
import { LANDING_WALL_MS, awaitLanding } from "./landing-wait.js";

type Stabilize = (signal: AbortSignal) => Promise<{ kind: "stable" } | { kind: "failed"; observation: string }>;

/** A bot whose stabilize ends as the test says; a hung one settles only on its signal, as one with no physics tick does. */
function landingBot(stabilize: Stabilize) {
  return { stabilize, observe: () => ({ ...observation(2, 70), stance: "airborne" as const }) };
}

const hangUntilAborted: Stabilize = (signal) =>
  new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

test("a landing seen within the bound is stable", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const result = await awaitLanding(
    landingBot(async () => ({ kind: "stable" })),
    new AbortController().signal,
  );
  assert.deepEqual(result, { kind: "stable" });
});

test("no tick for the bound reads as unstable with the position", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const landing = awaitLanding(landingBot(hangUntilAborted), new AbortController().signal);
  context.mock.timers.tick(LANDING_WALL_MS);
  const result = await landing;
  assert.equal(result.kind, "failed");
  assert.match(result.kind === "failed" ? result.observation : "", /No physics tick for 2 s while airborne at 2\.50, 70\.00, 0\.50/);
});

test("the run's abort reads as stopped", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const run = new AbortController();
  const landing = awaitLanding(landingBot(hangUntilAborted), run.signal);
  run.abort(new Error("cancelled"));
  assert.deepEqual(await landing, { kind: "stopped" });
});

test("a null signal is bounded by the wall clock only", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const landing = awaitLanding(landingBot(hangUntilAborted), null);
  context.mock.timers.tick(LANDING_WALL_MS);
  assert.equal((await landing).kind, "failed");
});

/** The solid floor under cell (2, 63) is the flat world's y 62; ghost air is the client holding air there. */
function ghostAirWorld() {
  const world = flatWorld();
  world.load({ x: 2, y: 62, z: 0 }, { stateId: 0 });
  return world;
}

const unstable = (position: string) => ({ kind: "failed" as const, observation: `No stable stance was observed; last position ${position}, stance=airborne.` });

/** A bot held in the air at y 63: `stabilize` fails until the "server" has been asked for the cell, as run 16's four bots did. */
function heldBot(options: { resend?: CellResync; landsAfterResync?: boolean; fall?: boolean } = {}) {
  const calls = { stabilize: 0, resync: 0 };
  let resent = false;
  const bot = {
    observe: () => ({ ...observation(2, options.fall && calls.stabilize > 0 ? 40 : 63), stance: "airborne" as const }),
    stabilize: async (_signal: AbortSignal): Promise<{ kind: "stable" } | { kind: "failed"; observation: string }> => {
      calls.stabilize += 1;
      return resent && options.landsAfterResync !== false ? ({ kind: "stable" } as const) : unstable("2.50,63.00,0.50");
    },
    requestCellResync: async () => {
      calls.resync += 1;
      resent = true;
      return options.resend ?? "resent";
    },
  };
  return { bot, calls };
}

test("a body held in the air asks for the cell once and lands when the server resends it", async () => {
  const { bot, calls } = heldBot();
  const result = await awaitLanding(bot, new AbortController().signal, { world: ghostAirWorld() });
  assert.deepEqual(result, { kind: "stable" });
  assert.deepEqual(calls, { stabilize: 2, resync: 1 });
});

test("a real fall is not held: no resync, today's failure", async () => {
  const { bot, calls } = heldBot({ fall: true });
  const result = await awaitLanding(bot, new AbortController().signal, { world: ghostAirWorld() });
  assert.equal(result.kind, "failed");
  assert.equal(calls.resync, 0);
});

test("a body over a cell the client sees solid is not held: no resync", async () => {
  const { bot, calls } = heldBot();
  const result = await awaitLanding(bot, new AbortController().signal, { world: flatWorld() });
  assert.equal(result.kind, "failed");
  assert.equal(calls.resync, 0);
});

test("a resync that changes nothing fails with the held-in-air text and one ask only", async () => {
  const { bot, calls } = heldBot({ landsAfterResync: false });
  const result = await awaitLanding(bot, new AbortController().signal, { world: ghostAirWorld() });
  assert.equal(result.kind, "failed");
  assert.match(result.kind === "failed" ? result.observation : "", /server holds the bot at 2\.50, 63\.00, 0\.50 while its world shows air under the feet; a resend of the cell was asked and changed nothing/);
  assert.deepEqual(calls, { stabilize: 2, resync: 1 });
});

test("an off hand that cannot be used keeps today's failure, without a second wait", async () => {
  const { bot, calls } = heldBot({ resend: "unavailable", landsAfterResync: false });
  const result = await awaitLanding(bot, new AbortController().signal, { world: ghostAirWorld() });
  assert.match(result.kind === "failed" ? result.observation : "", /No stable stance was observed/);
  assert.deepEqual(calls, { stabilize: 1, resync: 1 });
});

test("a bot without the resync, or a call without the world, keeps today's failure", async () => {
  const { bot } = heldBot();
  const { requestCellResync: _unused, ...plain } = bot;
  assert.equal((await awaitLanding(plain, new AbortController().signal, { world: ghostAirWorld() })).kind, "failed");
  assert.equal((await awaitLanding(bot, new AbortController().signal)).kind, "failed");
});

test("the run's abort during the resync reads stopped", async () => {
  const run = new AbortController();
  const { bot } = heldBot();
  bot.requestCellResync = async () => {
    run.abort(new Error("cancelled"));
    throw run.signal.reason;
  };
  assert.deepEqual(await awaitLanding(bot, run.signal, { world: ghostAirWorld() }), { kind: "stopped" });
});

test("no physics tick for the bound is not a held body: the wall-clock failure asks for nothing", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const { bot, calls } = heldBot();
  bot.stabilize = hangUntilAborted;
  const landing = awaitLanding(bot, new AbortController().signal, { world: ghostAirWorld() });
  context.mock.timers.tick(LANDING_WALL_MS);
  assert.match((await landing as { observation: string }).observation, /No physics tick/);
  assert.equal(calls.resync, 0);
});

test("the wall timer is gone after a landing", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const clear = context.mock.method(globalThis, "clearTimeout");
  await awaitLanding(landingBot(async () => ({ kind: "stable" })), null);
  assert.equal(clear.mock.callCount(), 1);
});
