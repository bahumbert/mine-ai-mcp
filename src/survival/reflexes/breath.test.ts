import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { Vec3 } from "vec3";
import type { StallClock } from "../../actions/stall-watch.js";
import type { ActionRunnerOptions } from "../../session/action-runner.js";
import { type FakeClock, type FakeWorld, itemOf } from "../../test-support/fake-bot/index.js";
import { waterFixture } from "../../test-support/water.js";
import { type SurvivalTransition } from "../control/contract.js";
import { SURFACE_MAXIMUM_TICKS } from "../policy/environment.js";
import { attachBreathReflex } from "./breath.js";

/** One bubble of the air bar is this many ticks on the server's meter. */
const AIR_TICKS_PER_POINT = 15;

/** The server's air meter: the player's `air_supply` metadata, at the index of the version's entity metadata. */
function setAirTicks(bot: Bot, ticks: number): void {
  const index = bot.registry.entitiesByName.player?.metadataKeys?.indexOf("air_supply") ?? -1;
  if (index < 0) throw new Error("no air_supply metadata for a player");
  Reflect.set(bot.entity.metadata, index, ticks);
}

/** The air bar at `points` of 20. */
const setAir = (bot: Bot, points: number) => setAirTicks(bot, points * AIR_TICKS_PER_POINT);

/** A bot at (0, 64, 0) in the shared fake with a reflex driver, its clock and the controls it set in order. */
function diver(t: TestContext, runnerOptions: ActionRunnerOptions = {}) {
  // Not on the shared fake until M2 merges: builder clocks. `waterFixture` builds the driver and the runner before it
  // has the harness, so both read the harness clock through this reference once it is there.
  let fake: FakeClock | undefined;
  const clock: StallClock = { now: () => fake?.now() ?? 0, every: (tick, ms) => fake!.every(tick, ms) };
  const fixture = waterFixture(t, { now: clock.now }, { ...runnerOptions, clock }, { onHarness: true });
  const { harness } = fixture;
  if (!harness) throw new Error("waterFixture did not build the shared fake");
  fake = harness.clock;
  return { ...fixture, harness, clock: harness.clock };
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
  setAir(bot, 8);
  bot.on("diggingCompleted", () => {
    digs.push("roof");
    // Not on the fake: the server's air once the roof is through (the dug cell lets the next breath in).
    if (diggable) setAir(bot, 20);
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

test("a dry bot under the same roof is left alone by the breath reflex", async (t) => {
  const fixture = diver(t);
  const { digs } = sealedPocket(fixture, false);
  const control = attachBreathReflex(fixture.bot, fixture.reflex);
  await fixture.clock.advance(300);
  assert.deepEqual(digs, []);
  await control[Symbol.asyncDispose]();
});

/** The reflex's continuation after a full-air surfacing, driven at chosen positions and times. */
function breathContinuations(t: TestContext) {
  const fixture = diver(t);
  let definition: { continuation: (outcome: unknown) => { kind: string; reason?: string } } | undefined;
  const driver = { register: (captured: typeof definition) => { definition = captured; return { [Symbol.asyncDispose]: async () => {} }; } };
  attachBreathReflex(fixture.bot, driver as never, () => null, fixture.clock.now);
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

test("a stuck surfacing in still water is tried again 2 s later", async (t) => {
  const fixture = diver(t);
  const { clock } = fixture;
  sealedPocket(fixture, true, false);
  const claims: number[] = [];
  fixture.reflex.onTransition((event) => {
    if (event.kind === "claim") claims.push(clock.now());
  });
  const control = attachBreathReflex(fixture.bot, fixture.reflex);
  let stuckAt: number | undefined;
  fixture.reflex.onTransition((event) => {
    if (event.kind === "outcome") stuckAt ??= clock.now();
  });
  const ticks = (count: number) => clock.advance(50 * count);
  await ticks(5);
  assert.equal(claims.length, 1);
  // The clock cannot stand still on the fake: a surfacing that makes no progress is cut by its 5 s window long before
  // its 600 ticks (the next test). A dug block every 4 s (the dig's event) keeps it alive until the tick budget ends it.
  for (let tick = 0; tick < SURFACE_MAXIMUM_TICKS + 5; tick++) {
    if (tick % 80 === 40) fixture.bot.emit("diggingCompleted", {} as never);
    await clock.advance(50);
  }
  assert.equal(fixture.reflex.answered.snapshot()[0]?.failure.kind, "stuck", "no way to air: the surfacing ended stuck");
  const failedAt = stuckAt!;
  await ticks(10);
  assert.equal(claims.length, 1, "the same cells within 2 s: still answered");
  await clock.advance(failedAt + 1_999 - clock.now());
  assert.equal(claims.length, 1);
  await clock.advance(2);
  await ticks(10);
  assert.equal(claims.length, 2, "the bot is still drowning in the same cells: it tries again");
  await control[Symbol.asyncDispose]();
});

test("under an undiggable roof the surfacing is released after 5 s without progress and tried again 2 s later", async (t) => {
  const fixture = diver(t, { cancelGraceMs: 500 });
  const { clock } = fixture;
  sealedPocket(fixture, true, false);
  const outcomes: Array<{ outcome: { kind?: string; limit?: string } }> = [];
  const claims: number[] = [];
  let releasedAt: number | undefined;
  fixture.reflex.onTransition((event) => {
    if (event.kind === "claim") claims.push(clock.now());
    if (event.kind === "outcome") {
      outcomes.push(event.evidence as never);
      releasedAt ??= clock.now();
    }
  });
  const control = attachBreathReflex(fixture.bot, fixture.reflex);
  await clock.advance(4_800);
  assert.equal(claims.length, 1, "claimed once, still within the 5 s window");
  assert.equal(outcomes.length, 0);
  await clock.advance(1_000);
  assert.equal(outcomes[0]?.outcome.limit, "no_progress", "the 600-tick budget would have held it 30 s");
  assert.equal(fixture.reflex.runner.status().owner, "idle");
  const released = releasedAt!;
  await clock.advance(Math.max(0, released + 1_900 - clock.now()));
  assert.equal(claims.length, 1, "within the 2 s stand-down");
  await clock.advance(400);
  assert.equal(claims.length, 2, "the bot is still drowning: it surfaces again");
  assert.ok(claims[1]! - released >= 2_000);
  await control[Symbol.asyncDispose]();
});

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
