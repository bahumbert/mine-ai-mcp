import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Vec3 } from "vec3";
import { installNativeDigClock, longestBreakDurationMs } from "../../navigation/index.js";
import type { ActionRunnerOptions } from "../../session/action-runner.js";
import { type FakeClock, type FakeWorld, createFakeClock, itemOf } from "../../test-support/fake-bot/index.js";
import { type WaterFixtureOptions, waterFixture } from "../../test-support/water.js";
import { LETHAL_REFLEX_RETRY_TICKS, type SurvivalTransition } from "../control/contract.js";
import { watchAirHistory } from "../../world/air-supply.js";
import { attachBreathReflex } from "./breath.js";

/** One bubble of the air bar is this many ticks on the server's meter. */
const AIR_TICKS_PER_POINT = 15;

/**
 * The server's air meter: the player's `air_supply` metadata, at the index of the version's entity metadata. Written
 * raw: the bot stands in no real water here, so the fake's own air (`harness.breath.setAirSupply`) would be refilled
 * at once and the client would hear it.
 */
function setAirTicks(bot: Bot, ticks: number): void {
  const index = bot.registry.entitiesByName.player?.metadataKeys?.indexOf("air_supply") ?? -1;
  if (index < 0) throw new Error("no air_supply metadata for a player");
  Reflect.set(bot.entity.metadata, index, ticks);
}

/** The air bar at `points` of 20. */
const setAir = (bot: Bot, points: number) => setAirTicks(bot, points * AIR_TICKS_PER_POINT);

/** A bot at (0, 64, 0) in the shared fake with a reflex driver, its clock and the controls it set in order. */
function diver(t: TestContext, runnerOptions: ActionRunnerOptions = {}, clock: FakeClock = createFakeClock({ mode: "manual" }), server?: WaterFixtureOptions["server"]) {
  const fixture = waterFixture(t, {}, runnerOptions, { clock, server });
  return { ...fixture, clock };
}

test("an owned dive uses its escape floor and preserves the failed budget after ownership transfers", async (t) => {
  const fixture = diver(t);
  setAir(fixture.bot, 10);
  fixture.entity.isInWater = true;
  let floor: number | null = 70;
  const outcomes: SurvivalTransition[] = [];
  fixture.reflex.onTransition((event) => { if (event.kind === "outcome") outcomes.push(event); });
  const control = attachBreathReflex(fixture.bot, fixture.reflex, () => floor);
  await fixture.clock.advance(500);
  assert.equal(fixture.reflex.runner.status().owner, "idle");
  setAir(fixture.bot, 4);
  await fixture.clock.advance(250);
  assert.equal(fixture.reflex.runner.status().owner, "takeover");
  floor = null;
  // Navigation releases its declaration on takeover. Further sensing must not
  // turn this failed planned dive into an ordinary resumable breath response.
  await fixture.clock.advance(250);
  setAir(fixture.bot, 20);
  await fixture.clock.advance(50);
  assert.equal(JSON.parse(JSON.stringify(outcomes[0]?.evidence)).outcome.ownedDive, true);
  await control[Symbol.asyncDispose]();
});

test("missing own air cannot claim the body using stale oxygenLevel", async (t) => {
  const fixture = diver(t);
  Object.defineProperty(fixture.bot, "oxygenLevel", { value: -1 });
  fixture.entity.isInWater = true;
  const control = attachBreathReflex(fixture.bot, fixture.reflex);
  await fixture.clock.advance(500);
  assert.equal(fixture.reflex.runner.status().owner, "idle");
  await control[Symbol.asyncDispose]();
});

test("closing a breath takeover releases it even after physics stops", async (t) => {
  const fixture = diver(t);
  setAir(fixture.bot, 8);
  fixture.entity.isInWater = true;
  const control = attachBreathReflex(fixture.bot, fixture.reflex);
  await fixture.clock.advance(250);
  assert.equal(fixture.reflex.runner.status().owner, "takeover");
  await control[Symbol.asyncDispose]();
  assert.equal(fixture.reflex.runner.status().owner, "idle");
});

test("lost own-air metadata ends surfacing without resuming the interrupted action", async (t) => {
  const fixture = diver(t);
  setAir(fixture.bot, 8);
  fixture.entity.isInWater = true;
  let decision: Promise<{ value: unknown; continuation: import("../../session/abort.js").Continuation }> | undefined;
  const runner = fixture.reflex.runner;
  const claim = runner.claim;
  Object.assign(runner, {
    claim: (
      _owner: string,
      _description: string,
      work: (
        signal: AbortSignal,
      ) => Promise<{ value: unknown; continuation: import("../../session/abort.js").Continuation }>,
    ) => {
      return claim(_owner, _description, (signal) => {
        decision = work(signal);
        return decision;
      });
    },
  });
  const control = attachBreathReflex(fixture.bot, fixture.reflex);
  await fixture.clock.advance(250);
  fixture.entity.metadata = [];
  await fixture.clock.advance(50);
  assert.ok(decision);
  assert.notEqual((await decision).continuation.kind, "resume");
  await control[Symbol.asyncDispose]();
});

test("close cancels roof digging and waits for its controls to settle", async (t) => {
  const fixture = diver(t);
  const { bot, clock } = fixture;
  let aborted = 0;
  bot.on("diggingAborted", () => void (aborted += 1));
  fixture.entity.isInWater = true;
  fixture.entity.position.set(0.5, 64, 0.5);
  // A leaf roof over the head, which a bare hand digs within a breath.
  fill(fixture.harness.world, "oak_leaves", new Vec3(-2, 62, -2), new Vec3(3, 75, 3));
  setAir(bot, 8);
  const control = attachBreathReflex(bot, fixture.reflex);
  await clock.advance(250);
  for (let waited = 0; waited < 40 && !bot.targetDigBlock; waited += 1) await clock.advance(50);
  assert.ok(bot.targetDigBlock, "the roof dig is under way");
  await control[Symbol.asyncDispose]();
  // The game answers a stopped dig at once (Mineflayer's `stopDigging` rejects it), so the shutdown has no dig left to
  // wait for: it ends with the dig aborted once and none outstanding.
  assert.equal(aborted, 1);
  assert.equal(bot.targetDigBlock, null);
  const writesAtClose = fixture.controls.length;
  await clock.advance(50);
  assert.equal(fixture.controls.length, writesAtClose);
  assert.deepEqual(fixture.controls.filter(([control]) => control === "jump").at(-1), ["jump", false]);
});

test("claims the body at half air and records the surfacing", async (t) => {
  const fixture = diver(t);
  setAir(fixture.bot, 8);
  const recorded: SurvivalTransition[] = [];
  fixture.reflex.onTransition((transition) => {
    if (transition.kind === "outcome") recorded.push(transition);
  });
  const claims: string[] = [];
  let outcome: Promise<unknown> | null = null;
  const runner = fixture.reflex.runner;
  const claim = runner.claim;
  Object.assign(runner, {
    claim: (
      owner: string,
      description: string,
      work: (
        signal: AbortSignal,
      ) => Promise<{ value: unknown; continuation: import("../../session/abort.js").Continuation }>,
    ) => {
      claims.push(`${owner} ${description}`);
      const admission = claim(owner, description, work);
      if (admission.kind === "claimed") outcome = admission.outcome;
      return admission;
    },
  });
  const control = attachBreathReflex(fixture.bot, fixture.reflex);

  fixture.entity.isInWater = true;
  await fixture.clock.advance(250);
  assert.deepEqual(claims, ["breath_reflex [BREATH] surface at air 8 of 20: the bot rises to breathe; work that keeps its head under water here is cut again each time the air runs short, so do it from a spot with air above the head."]);
  setAir(fixture.bot, 20);
  await fixture.clock.advance(50);
  await outcome;

  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]?.reflex, "breath_reflex");
  assert.equal(JSON.parse(JSON.stringify(recorded[0]?.evidence)).outcome.airAfter, 20);
  assert.deepEqual(
    fixture.controls.filter(([control]) => control === "jump"),
    [
      ["jump", true],
      ["jump", false],
    ],
  );

  await control[Symbol.asyncDispose]();
});

/** `block` in every cell of the box from `from` to `to`, both included. */
function fill(world: FakeWorld, block: string, from: Vec3, to: Vec3): void {
  for (let x = from.x; x <= to.x; x++)
    for (let y = from.y; y <= to.y; y++) for (let z = from.z; z <= to.z; z++) world.setCell(new Vec3(x, y, z), block);
}

/**
 * A sealed pocket: every cell around the bot is the roof block, so no swim reaches open air. Only the pickaxe in the
 * bag breaks it fast: netherrack takes a stone pickaxe a moment and a bare hand far longer than a breath. The
 * undiggable roof is bedrock.
 */
function sealedPocket(fixture: ReturnType<typeof diver>, inWater: boolean, diggable = true) {
  const { bot, entity, harness } = fixture;
  const digs: string[] = [];
  // Hotbar slot 1: the hand starts empty, so the equip is the reflex's.
  harness.inventory.updateSlot(37, itemOf(bot.registry, "stone_pickaxe"));
  entity.isInWater = inWater;
  entity.position.set(0.5, 64, 0.5);
  fill(harness.world, diggable ? "netherrack" : "bedrock", new Vec3(-2, 62, -2), new Vec3(3, 75, 3));
  // The pocket's water cells are not built, so the server's air is held at 8 bubbles (as a bot under water that lost them) until the roof is through.
  harness.breath.hold(8 * AIR_TICKS_PER_POINT);
  bot.on("diggingCompleted", () => {
    digs.push("roof");
    if (!diggable) return;
    // The way through the roof opens the pocket to the open air: the next breath comes in, at the server's rate.
    fill(harness.world, "air", new Vec3(0, 64, 0), new Vec3(0, 75, 0));
    harness.breath.release();
  });
  return { digs };
}

test("a swimmer sealed under a roof digs it with the best tool it carries", async (t) => {
  const fixture = diver(t);
  const { digs } = sealedPocket(fixture, true);
  const control = attachBreathReflex(fixture.bot, fixture.reflex);
  await fixture.clock.advance(2_000);
  assert.deepEqual(digs, ["roof"]);
  assert.equal(fixture.bot.heldItem?.name, "stone_pickaxe");
  await control[Symbol.asyncDispose]();
});

// The roof dig inside the claim (plan 2026-11-16-reflex-limits-ticks C5), with the production dig clock (`installNativeDigClock`).
// The swimmer's eyes are in water and she is off the ground, so her stone pickaxe takes the game's own 25 times longer on
// netherrack (`digging.js` digTime: x5 in water, x5 airborne; `roofDigFits` prices the same flags): the server mines the roof
// for the ticks of that digTime (about 80) and answers the removal then, 4 s at 20 tps and 8 s at 10 tps. The 5 s no-progress
// window counts world ticks now (100, ended at A + 120), so the slower server's 8 s dig is not cut at 5 s, and its end
// (`diggingCompleted`) is the claim's progress; the old wall window cut it at 5 s and left a `no_progress` receipt.
for (const ticksPerSecond of [20, 10]) {
  test(`a roof dig the server mines for about 80 ticks finishes inside the surfacing's window (${ticksPerSecond} tps)`, async (t) => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const fixture = diver(t, {}, clock, { ticksPerSecond });
    const { bot, harness, entity } = fixture;
    installNativeDigClock(bot);
    const { digs } = sealedPocket(fixture, true);
    fill(harness.world, "water", new Vec3(0, 64, 0), new Vec3(0, 65, 0)); // the head is under water, the roof (0, 66, 0) above it
    Object.assign(entity, { onGround: false });
    // The dig the reflex prices (`roofDigFits`), with the pickaxe it will equip; the fake server's own digTime must agree once it is held.
    const digTicks = Math.ceil(longestBreakDurationMs(bot, new Vec3(0, 66, 0), itemOf(bot.registry, "stone_pickaxe").type)! / 50);
    assert.ok(digTicks >= 70 && digTicks <= 90, `the pickaxe's game-data dig of the roof is ${digTicks} server ticks`);
    const outcomes: Array<{ outcome: { kind?: string; limit?: string } }> = [];
    let startedTick: number | undefined;
    let dugTick: number | undefined;
    let dugAtMs: number | undefined;
    fixture.reflex.onTransition((event) => {
      if (event.kind === "outcome") outcomes.push(event.evidence as never);
    });
    harness.server.onPacket("block_dig", (packet) => void ((packet as { status: number }).status === 0 && (startedTick ??= harness.server.gameTime)));
    bot.on("diggingCompleted", () => {
      dugTick ??= harness.server.gameTime;
      dugAtMs ??= clock.now();
    });
    const control = attachBreathReflex(bot, fixture.reflex);
    await clock.advance(digTicks * (1_000 / ticksPerSecond) + 3_000);
    assert.deepEqual(digs, ["roof"], "the dig ended");
    assert.ok(dugTick! - startedTick! >= digTicks, `the server mined the roof ${dugTick! - startedTick!} ticks, its digTime of ${digTicks}`);
    assert.ok(dugAtMs! >= digTicks * (1_000 / ticksPerSecond), `the dig ended ${dugAtMs} ms in: ${ticksPerSecond === 10 ? "past" : "inside"} the old 5 000 ms window`);
    assert.deepEqual(outcomes.filter((outcome) => outcome.outcome.kind === "limit"), [], "no limit receipt");
    await control[Symbol.asyncDispose]();
  });
}

test("a dry bot under the same roof is left alone by the breath reflex", async (t) => {
  const fixture = diver(t);
  const { digs } = sealedPocket(fixture, false);
  const control = attachBreathReflex(fixture.bot, fixture.reflex);
  await fixture.clock.advance(300);
  assert.deepEqual(digs, []);
  await control[Symbol.asyncDispose]();
});

/** The reflex's continuation after a full-air surfacing, driven at chosen positions and times. */
function breathContinuations(t: TestContext, installedClock?: FakeClock) {
  const fixture = diver(t, {}, installedClock);
  let definition: { continuation: (outcome: unknown) => { kind: string; reason?: string } } | undefined;
  const driver = { register: (captured: typeof definition) => { definition = captured; return { [Symbol.asyncDispose]: async () => {} }; } };
  // An installed mocked clock drives the global monotonic clock the reflex reads by default: production passes no `now`.
  attachBreathReflex(fixture.bot, driver as never, () => null, installedClock ? undefined : fixture.clock.now);
  return {
    surfaceAt: async (x: number, atMs: number, ownedDive = false, kind = "air_full") => {
      const gap = atMs - fixture.clock.now();
      if (gap > 0) await fixture.clock.advance(gap, gap);
      fixture.entity.position.set(x + 0.5, 50, 0.5);
      return definition!.continuation({ kind, ownedDive });
    },
  };
}

const MINUTE = 60_000;

test("the third breath reflex at the same place within three minutes ends the action instead of resuming it", async (t) => {
  const { surfaceAt } = breathContinuations(t);
  assert.equal((await surfaceAt(0, 0)).kind, "resume");
  assert.equal((await surfaceAt(1, 19_000)).kind, "resume");
  const third = await surfaceAt(2, 38_000);
  assert.equal(third.kind, "return");
  assert.match(third.reason ?? "", /Out of air three times here/);
});

test("an owned-dive rescue that reached full air resumes the action", async (t) => {
  const { surfaceAt } = breathContinuations(t);
  assert.equal((await surfaceAt(0, 0, true)).kind, "resume");
});

test("the third owned-dive rescue at one place within three minutes ends the action", async (t) => {
  const { surfaceAt } = breathContinuations(t);
  assert.equal((await surfaceAt(0, 0, true)).kind, "resume");
  assert.equal((await surfaceAt(1, 19_000, true)).kind, "resume");
  const third = await surfaceAt(2, 38_000, true);
  assert.equal(third.kind, "return");
  assert.match(third.reason ?? "", /Out of air three times here/);
});

test("owned and unowned rescues at one place count together", async (t) => {
  const { surfaceAt } = breathContinuations(t);
  assert.equal((await surfaceAt(0, 0, true)).kind, "resume");
  assert.equal((await surfaceAt(1, 19_000, false)).kind, "resume");
  assert.match((await surfaceAt(2, 38_000, true)).reason ?? "", /Out of air three times here/);
});

test("a rescue that did not observe full air still returns, owned or not", async (t) => {
  const { surfaceAt } = breathContinuations(t);
  for (const ownedDive of [true, false]) {
    const rescue = await surfaceAt(0, 0, ownedDive, "stuck");
    assert.equal(rescue.kind, "return");
    assert.match(rescue.reason ?? "", /Full air was not observed/);
  }
  assert.match((await surfaceAt(0, 0, true, "air_unknown")).reason ?? "", /air metadata is unavailable/);
});

test("three breath reflexes ten blocks apart all resume", async (t) => {
  const { surfaceAt } = breathContinuations(t);
  assert.equal((await surfaceAt(0, 0)).kind, "resume");
  assert.equal((await surfaceAt(10, 19_000)).kind, "resume");
  assert.equal((await surfaceAt(20, 38_000)).kind, "resume");
});

test("a third breath reflex after three minutes starts the count again and resumes", async (t) => {
  const { surfaceAt } = breathContinuations(t);
  assert.equal((await surfaceAt(0, 0)).kind, "resume");
  assert.equal((await surfaceAt(0, 19_000)).kind, "resume");
  assert.equal((await surfaceAt(0, 3 * MINUTE + 1)).kind, "resume");
});

/** The third rescue at one place, `thirdAfterMs` of monotonic time after the first, with the wall clock stepped by `wallStepMs` between the second and the third. */
async function thirdRescueAcrossWallStep(t: TestContext, wallStepMs: number, thirdAfterMs: number) {
  const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
  using _installed = clock.install();
  // Live the wall clock and the monotonic one read unrelated values (epoch vs uptime): a window on the wrong one cannot pass.
  clock.stepWallClock(5_000);
  const { surfaceAt } = breathContinuations(t, clock);
  const first = clock.now();
  assert.equal((await surfaceAt(0, first)).kind, "resume");
  assert.equal((await surfaceAt(1, first + 85_000)).kind, "resume");
  clock.stepWallClock(wallStepMs);
  // Awaited here: returning the promise would dispose the installed clock before the rescue reads it.
  return await surfaceAt(2, first + thirdAfterMs);
}

const REPEAT_WINDOW_ROWS: ReadonlyArray<readonly [wallStepMs: number, thirdAfterMs: number, kind: string, why: string]> = [
  [20_000, 170_000, "return", "three rescues in 170 s of play, 190 s on the wall clock"],
  [-20_000, 190_000, "resume", "190 s of play is outside the window, 170 s on the wall clock"],
];
for (const [wallStepMs, thirdAfterMs, kind, why] of REPEAT_WINDOW_ROWS)
  test(`the repeat window counts monotonic time: wall step ${wallStepMs} ms, third rescue ${thirdAfterMs} ms after the first ${kind}s (${why})`, async (t) => {
    assert.equal((await thirdRescueAcrossWallStep(t, wallStepMs, thirdAfterMs)).kind, kind);
  });

/** "takeover" when the breath reflex fired within 10 ticks, else "idle": an owned dive whose backstop asks `floor` ticks, `air` ticks on the server's meter. */
async function reflexOutcome(t: TestContext, floor: number | null, air: number) {
  const fixture = diver(t);
  setAirTicks(fixture.bot, air);
  fixture.entity.isInWater = true;
  const fired: string[] = [];
  fixture.reflex.onTransition((event) => { if (event.kind === "claim") fired.push(event.kind); });
  const control = attachBreathReflex(fixture.bot, fixture.reflex, () => floor);
  await fixture.clock.advance(500);
  await control[Symbol.asyncDispose]();
  return fired.length === 0 ? "idle" : "takeover";
}

test("an owned dive whose backstop asks an immediate rescue does not fire while the server's air is full", async (t) => {
  assert.equal(await reflexOutcome(t, 300, 300), "idle");
});

test("the same backstop fires from the first tick of air lost", async (t) => {
  assert.equal(await reflexOutcome(t, 300, 299), "takeover");
});

test("an unowned bot at 12 of 20 air fires as before", async (t) => {
  assert.equal(await reflexOutcome(t, null, 12 * 15), "takeover");
});

test("an owned dive with the air metadata missing reports unknown and does not fire", async (t) => {
  const fixture = diver(t);
  fixture.entity.metadata = [];
  fixture.entity.isInWater = true;
  const control = attachBreathReflex(fixture.bot, fixture.reflex, () => 300);
  await fixture.clock.advance(500);
  assert.equal(fixture.reflex.runner.status().owner, "idle");
  await control[Symbol.asyncDispose]();
});

// A pause counts world ticks (plan 2026-11-16-reflex-limits-ticks T3): the packet of the age `A + ticks + 20` after the age
// cached when the pause was remembered. The server's first packet is at 0 ms, one per 20 ticks after it.
const START_AGE = 1_000;
const RATES = [
  { ticksPerSecond: 20, msPerTick: 50 },
  { ticksPerSecond: 10, msPerTick: 100 },
] as const;

/** Move the clock 50 ms at a time until the world age reaches `age`, asserting `before` at each step that still lies short of it. */
async function advanceToAge(fixture: ReturnType<typeof diver>, age: number, before: () => void): Promise<void> {
  while (fixture.bot.time.age < age) {
    before();
    await fixture.clock.advance(50);
  }
}

// A failed surfacing in still water cannot be reached with real progress here: under bedrock nothing is dug (the fake's
// `diggingCompleted` follows only an active dig's air update, `fake-bot-digging.ts`), and a surfacing without progress is cut
// by its no-progress window first. So the 40-tick retry pause is tested where it is built: `driver.test.ts` "retried after the
// packet of age A + 60" (both rates, stopped server) on a failing definition, and here only that the breath reflex declares it.
test("the breath reflex declares the 40-tick retry pause of a failed surfacing", async (t) => {
  const fixture = diver(t);
  let declared: number | undefined;
  const register = fixture.reflex.register.bind(fixture.reflex);
  Object.defineProperty(fixture.reflex, "register", {
    value: (definition: { retryAfterFailureTicks?: number }) => {
      declared = definition.retryAfterFailureTicks;
      return register(definition as never);
    },
  });
  const control = attachBreathReflex(fixture.bot, fixture.reflex);
  assert.equal(declared, LETHAL_REFLEX_RETRY_TICKS);
  assert.equal(LETHAL_REFLEX_RETRY_TICKS, 40);
  await control[Symbol.asyncDispose]();
});

for (const { ticksPerSecond, msPerTick } of RATES) {

  test(`under an undiggable roof the surfacing is released after 100 ticks without progress and tried again 60 ticks later (${ticksPerSecond} tps)`, async (t) => {
    const fixture = diver(t, { cancelGraceMs: 500 }, undefined, { startAge: START_AGE, ticksPerSecond });
    const { clock } = fixture;
    sealedPocket(fixture, true, false);
    const outcomes: Array<{ outcome: { kind?: string; limit?: string } }> = [];
    const claims: number[] = [];
    let releasedAt: number | undefined;
    let releasedAge: number | undefined;
    let claimAge: number | undefined;
    fixture.reflex.onTransition((event) => {
      if (event.kind === "claim") {
        claims.push(clock.now());
        claimAge ??= fixture.bot.time.age;
      }
      if (event.kind === "outcome") {
        outcomes.push(event.evidence as never);
        releasedAt ??= clock.now();
        releasedAge ??= fixture.bot.time.age;
      }
    });
    const control = attachBreathReflex(fixture.bot, fixture.reflex);
    await clock.advance(250);
    assert.equal(claims.length, 1);
    // The 100-tick window ends at the packet of age A + 120 (A the age cached at the claim), read at the first check after it.
    const windowEnd = claimAge! + 120;
    await advanceToAge(fixture, claimAge! + 100, () => assert.equal(outcomes.length, 0, `age ${fixture.bot.time.age} at ${clock.now()} ms (old code: its 5 000 ms ended it)`));
    await advanceToAge(fixture, windowEnd, () => assert.equal(outcomes.length, 0, "the last packet before the window's end"));
    await clock.advance(400);
    assert.equal(outcomes[0]?.outcome.limit, "no_progress", "the 600-tick budget would have held it 30 s");
    assert.equal(fixture.reflex.runner.status().owner, "idle");
    const released = releasedAt!;
    const readAge = releasedAge!;
    assert.equal(readAge, windowEnd);
    await advanceToAge(fixture, readAge + 60, () => assert.equal(claims.length, 1, `within the stand-down at age ${fixture.bot.time.age}`));
    await clock.advance(250);
    assert.equal(claims.length, 2, "the bot is still drowning: it surfaces again");
    assert.ok(claims[1]! - released >= 40 * msPerTick);
    await control[Symbol.asyncDispose]();
  });
}

test("a rising swimmer keeps the surfacing alive past the 5 s window", async (t) => {
  const fixture = diver(t, { cancelGraceMs: 500 });
  const { clock } = fixture;
  sealedPocket(fixture, true, false);
  const outcomes: unknown[] = [];
  fixture.reflex.onTransition((event) => {
    if (event.kind === "outcome") outcomes.push(event.evidence);
  });
  const control = attachBreathReflex(fixture.bot, fixture.reflex);
  for (let tick = 0; tick < 240; tick++) {
    // A block of climb every 2 s, as a swimmer working up through a long shaft.
    if (tick > 0 && tick % 40 === 0) fixture.entity.position.translate(0, 1, 0);
    await clock.advance(50);
  }
  assert.equal(outcomes.length, 0, "12 s of steady climbing: no limit");
  await control[Symbol.asyncDispose]();
});

test("the air rising is progress, and a dug block is progress", async (t) => {
  const fixture = diver(t, { cancelGraceMs: 500 });
  const { clock } = fixture;
  sealedPocket(fixture, true, false);
  const outcomes: unknown[] = [];
  fixture.reflex.onTransition((event) => {
    if (event.kind === "outcome") outcomes.push(event.evidence);
  });
  const control = attachBreathReflex(fixture.bot, fixture.reflex);
  for (let tick = 0; tick < 240; tick++) {
    if (tick === 60) setAir(fixture.bot, 9);
    if (tick === 140) fixture.bot.emit("diggingCompleted", {} as never);
    await clock.advance(50);
  }
  assert.equal(outcomes.length, 0, "a rise at 3 s and a dug block at 7 s keep a 5 s window open for 12 s");
  await control[Symbol.asyncDispose]();
});

// A bot that never went under water has full air the server never sent (plan 2026-11-18-scenario-reds-part5 T31a): the reflex senses
// it as a breathing body, while the same absent metadata on a bot that was wet stays unknown.
for (const body of ["untracked", "tracked dry", "tracked wet"] as const) test(`absent own air is ${body === "tracked dry" ? "full" : "unknown"} to the reflex: ${body}`, async (t) => {
  const fixture = diver(t);
  const { bot, clock, harness } = fixture;
  Reflect.set(bot.entity, "metadata", []);
  if (body !== "untracked") watchAirHistory(bot);
  bot.emit("login");
  if (body === "tracked wet") {
    // The server holds the meter and sends nothing of it (the fake's own loss is reported at once, so it is held and cleared).
    harness.breath.hold(300);
    harness.world.setCell(new Vec3(0, 65, 0), "water");
    await clock.advance(50);
    bot.emit("physicsTick");
    harness.world.setCell(new Vec3(0, 65, 0), "air");
    Reflect.set(bot.entity, "metadata", []);
  }
  await clock.advance(3_000);
  const control = attachBreathReflex(bot, fixture.reflex);
  await clock.advance(500);
  assert.equal(fixture.reflex.snapshot()[0]?.missing, body === "tracked dry" ? null : "own_air_metadata");
  assert.equal(fixture.reflex.runner.status().owner, "idle", "no response from a body that is not in water");
  await control[Symbol.asyncDispose]();
});
