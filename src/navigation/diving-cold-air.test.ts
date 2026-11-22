import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeBotOptions, createFakeBot, createFakeClock, listenersAddedSince } from "../test-support/fake-bot/index.js";
import { watchAirHistory } from "../world/air-supply.js";
import { Diving } from "./diving.js";
import { MemoryWorld } from "./world/memory-world.js";
import { createMovementPolicy } from "./movements/policy.js";
import { exactBlockGoal } from "./goals/index.js";
import type { NavigateOptions } from "./navigate.js";

// A bot that never went under water has full air the server never sent (plan 2026-11-18-scenario-reds-part5 T31a): `air-supply.ts`
// infers it, and a dive from a dry start is admitted. These cases run the dive code on the shared fake with the tracker installed.

type Kind = "stone" | "air" | "water";
type Place = "pond" | "tunnel";
const RATES = [20, 10] as const;

/**
 * A pond (water x 0, y 60-63, stone floor y 59, air beside and above) or a roofed tunnel (air pocket x -2..0, water x 1..8, y 60-61,
 * floor y 59, roof y 62), the bot dry in the air beside the water, its metadata empty and the tracker installed.
 */
function dryScene(place: Place, ticksPerSecond: number, status: "dry" | "wet" = "dry") {
  const options: FakeBotOptions = { position: new Vec3(place === "pond" ? -1.5 : 0.5, 60, 0.5), groundY: null, server: { ticksPerSecond },
    clock: createFakeClock({ mode: "mocked" }) };
  const harness = createFakeBot(options);
  const { bot } = harness;
  Object.assign(bot.entity, { onGround: true });
  const world = new MemoryWorld();
  const load = (x: number, y: number, kind: Kind) => {
    world.load({ x, y, z: 0 }, kind === "stone" ? { stateId: 1 } : kind === "air" ? { stateId: 0 }
      : { stateId: 2, traits: { empty: true, liquid: "water", liquidSource: true } });
    harness.world.setCell(new Vec3(x, y, 0), kind);
  };
  for (let x = -2; x <= 8; x++) for (let y = 59; y <= (place === "pond" ? 65 : 62); y++) {
    if (place === "pond") load(x, y, y === 59 ? "stone" : x === 0 && y <= 63 ? "water" : "air");
    else load(x, y, y === 59 || y === 62 ? "stone" : x <= 0 ? "air" : "water");
  }
  Reflect.set(bot.entity, "metadata", []);
  watchAirHistory(bot);
  if (status === "wet") bot.entity.position.set(place === "pond" ? 0.5 : 5.5, place === "pond" ? 61.2 : 60, 0.5);
  /** The wall ms of one time packet: 20 server ticks. */
  const packetMs = 20_000 / ticksPerSecond;
  const goal = exactBlockGoal(place === "pond" ? { x: 0, y: 61, z: 0 } : { x: 5, y: 60, z: 0 });
  return { ...harness, world, packetMs, goal, left: listenersAddedSince(bot) };
}

/**
 * The head under water for a physics tick, with the server reporting nothing of it: the fake holds the meter and its report is
 * cleared, as the existing cases of `diving.test.ts` do ("the server omits unchanged default air on login").
 */
async function wetThenSilent(scene: ReturnType<typeof dryScene>) {
  scene.breath.hold(300);
  await scene.clock.advance(50);
  scene.bot.emit("physicsTick");
  Reflect.set(scene.bot.entity, "metadata", []);
}

/** One run of the dive code that stops at its first route: the dive budget its route was asked with, and how many routes. */
async function admission(scene: ReturnType<typeof dryScene>, run: (promise: Promise<unknown>) => Promise<unknown>) {
  const diving = new Diving(scene.bot, scene.world);
  const requests: NavigateOptions["movements"]["dive"][] = [];
  await run(diving.run({ movements: createMovementPolicy(), goal: scene.goal }, async (request) => {
    requests.push(request.movements.dive);
    return { status: "completed", elapsedMs: 0 };
  }));
  return requests;
}

for (const place of ["pond", "tunnel"] as const) for (const rate of RATES)
  test(`a dry start beside a ${place} is admitted as a dive with 300 air once 40 server ticks passed after its first time packet, at ${rate} tps`, async () => {
    const scene = dryScene(place, rate);
    using _timers = scene.clock.install();
    scene.bot.emit("login");
    await scene.clock.advance(3 * scene.packetMs);
    assert.equal(scene.bot.time.age, 24_060, "the first packet heard was 24020: 40 ticks later");
    const requests = await admission(scene, (promise) => scene.clock.settle(promise, 0));
    assert.equal(requests.length, 1, "one route, no wait before it");
    assert.equal(requests[0]?.airTicks, 300);
    assert.equal(scene.clock.now(), 3 * scene.packetMs, `${rate} tps: the run waited no wall time`);
    assert.equal(scene.left("physicsTick"), 0);
    assert.equal(scene.clock.pendingGlobalTimers(), 0);
  });

for (const place of ["pond", "tunnel"] as const) for (const end of [20, 10, "stopped"] as const)
  test(`a dry start beside a ${place} has no dive budget before the 40 ticks: ${end === "stopped" ? "a stopped server" : `${end} tps, run at +20 ticks`}`, async () => {
    const scene = dryScene(place, end === "stopped" ? 20 : end);
    using _timers = scene.clock.install();
    scene.bot.emit("login");
    await scene.clock.advance(2 * scene.packetMs);
    assert.equal(scene.bot.time.age, 24_040, "the first packet was 24020: 20 ticks later");
    if (end === "stopped") scene.server.stop();
    if (end === "stopped") await scene.clock.advance(60_000);
    const requests = await admission(scene, (promise) => scene.clock.settle(promise, 0));
    assert.equal(requests.length, 1);
    assert.equal(requests[0], undefined, "unknown air: the route is asked without a dive budget, as before");
    assert.equal(scene.bot.time.age, 24_040, "the world age is what the run saw");
  });

for (const place of ["pond", "tunnel"] as const) for (const rate of RATES)
  test(`a bot that was under water keeps observing before a budget, ${place}, at ${rate} tps: the tracker adds no full air`, async () => {
    const scene = dryScene(place, rate, "wet");
    using _timers = scene.clock.install();
    scene.bot.emit("login");
    await wetThenSilent(scene);
    // The pond bot floats at y 61.2 (head in water); it then bobs up to the surface (y 63.5), as the existing shallow cases do.
    if (place === "pond") scene.bot.entity.position.y = 63.5;
    await scene.clock.advance(3 * scene.packetMs);
    const ticks = place === "pond" ? 100 : 60;
    const diving = new Diving(scene.bot, scene.world);
    const requests: NavigateOptions["movements"]["dive"][] = [];
    const start = scene.clock.now();
    const run = diving.run({ movements: createMovementPolicy(), goal: scene.goal }, async (request) => {
      requests.push(request.movements.dive);
      return { status: "completed", elapsedMs: 0 };
    });
    await scene.clock.advance(ticks * 1_000 / rate - 50 - 1);
    assert.equal(requests.length, 0, `${rate} tps: no route before ${ticks} server ticks of observation`);
    await scene.clock.settle(run, 51, 1);
    assert.equal(requests.length, 1);
    assert.equal(scene.clock.now() - start, ticks * 1_000 / rate, `${ticks} server ticks of observation, ${rate} tps`);
    assert.equal(requests[0]?.airTicks, place === "pond" ? undefined : 300, "as the observation without a tracker ends today");
    assert.equal(scene.left("physicsTick"), 0);
  });

test("a respawn that clears the metadata of a bot with its head in water leaves it observing, not inferred full", async () => {
  const scene = dryScene("tunnel", 20, "wet");
  using _timers = scene.clock.install();
  scene.bot.emit("login");
  await wetThenSilent(scene);
  scene.bot.emit("respawn");
  await scene.clock.advance(5 * scene.packetMs);
  const diving = new Diving(scene.bot, scene.world);
  const requests: NavigateOptions["movements"]["dive"][] = [];
  const run = diving.run({ movements: createMovementPolicy(), goal: scene.goal }, async (request) => {
    requests.push(request.movements.dive);
    return { status: "completed", elapsedMs: 0 };
  });
  await scene.clock.advance(59 * 50);
  assert.equal(requests.length, 0, "the head is in water at the call: unknown, so observed for 60 ticks");
  await scene.clock.settle(run, 3_000, 1);
  assert.equal(requests.length, 1);
  assert.equal(scene.left("physicsTick"), 0);
});
