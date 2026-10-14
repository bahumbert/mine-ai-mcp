import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { waterFixture } from "../../test-support/water.js";
import { type SurvivalTransition } from "../control/contract.js";
import { attachBreathReflex } from "./breath.js";

test("an owned dive uses its escape floor and preserves the failed budget after ownership transfers", async (t) => {
  const fixture = waterFixture(t);
  Object.assign(fixture.bot, { oxygenLevel: 10, health: 20, username: "Diver", blockAt: () => null });
  fixture.entity.isInWater = true;
  let floor: number | null = 70;
  const outcomes: SurvivalTransition[] = [];
  fixture.reflex.onTransition((event) => { if (event.kind === "outcome") outcomes.push(event); });
  const control = attachBreathReflex(fixture.bot, fixture.reflex, () => floor);
  for (let tick = 0; tick < 10; tick++) fixture.bot.emit("physicsTick");
  assert.equal(fixture.reflex.runner.status().owner, "idle");
  fixture.bot.oxygenLevel = 4;
  for (let tick = 0; tick < 5; tick++) fixture.bot.emit("physicsTick");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.reflex.runner.status().owner, "takeover");
  floor = null;
  // Navigation releases its declaration on takeover. Further sensing must not
  // turn this failed planned dive into an ordinary resumable breath response.
  for (let tick = 0; tick < 5; tick++) fixture.bot.emit("physicsTick");
  fixture.bot.oxygenLevel = 20;
  fixture.bot.emit("physicsTick");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(JSON.stringify(outcomes[0]?.evidence)).outcome.ownedDive, true);
  await control[Symbol.asyncDispose]();
});

test("missing own air cannot claim the body using stale oxygenLevel", async (t) => {
  const fixture = waterFixture(t);
  Object.defineProperty(fixture.bot, "oxygenLevel", { value: -1 });
  fixture.entity.isInWater = true;
  const control = attachBreathReflex(fixture.bot, fixture.reflex);
  for (let tick = 0; tick < 10; tick++) fixture.bot.emit("physicsTick");
  assert.equal(fixture.reflex.runner.status().owner, "idle");
  await control[Symbol.asyncDispose]();
});

test("closing a breath takeover releases it even after physics stops", async (t) => {
  const fixture = waterFixture(t);
  Object.assign(fixture.bot, { oxygenLevel: 8, health: 20, username: "Diver", blockAt: () => null });
  fixture.entity.isInWater = true;
  const control = attachBreathReflex(fixture.bot, fixture.reflex);
  for (let tick = 0; tick < 5; tick++) fixture.bot.emit("physicsTick");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.reflex.runner.status().owner, "takeover");
  await control[Symbol.asyncDispose]();
  assert.equal(fixture.reflex.runner.status().owner, "idle");
});

test("lost own-air metadata ends surfacing without resuming the interrupted action", async (t) => {
  const fixture = waterFixture(t);
  Object.assign(fixture.bot, { oxygenLevel: 8, health: 20, username: "Diver", blockAt: () => null });
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
  for (let tick = 0; tick < 5; tick++) fixture.bot.emit("physicsTick");
  Object.assign(fixture.bot.entity, { metadata: [] });
  fixture.bot.emit("physicsTick");
  assert.ok(decision);
  assert.notEqual((await decision).continuation.kind, "resume");
  await control[Symbol.asyncDispose]();
});

test("close cancels roof digging and waits for its controls to settle", async (t) => {
  const fixture = waterFixture(t);
  let stopDig!: (cause: Error) => void;
  const digging = new Promise<void>((_resolve, reject) => {
    stopDig = reject;
  });
  let announceDig!: () => void;
  const started = new Promise<void>((resolve) => {
    announceDig = resolve;
  });
  let stops = 0;
  Object.assign(fixture.entity, { isInWater: true, position: new Vec3(0.5, -59, 0.5) });
  const roof = { boundingBox: "block", diggable: true, shapes: [[0, 0, 0, 1, 1, 1]], digTime: () => 1000 };
  Object.assign(fixture.bot, {
    oxygenLevel: 8,
    health: 20,
    username: "Diver",
    blockAt: () => roof,
    game: { gameMode: "survival" },
    inventory: { items: () => [] },
    targetDigBlock: roof,
    dig: () => {
      announceDig();
      return digging;
    },
    stopDigging: () => {
      stops += 1;
    },
  });
  const control = attachBreathReflex(fixture.bot, fixture.reflex);
  for (let tick = 0; tick < 5; tick += 1) fixture.bot.emit("physicsTick");
  await started;
  let closed = false;
  const closing = control[Symbol.asyncDispose]().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stops, 1);
  assert.equal(closed, false, "shutdown must wait for the outstanding dig");
  stopDig(new Error("dig stopped"));
  await closing;
  const writesAtClose = fixture.controls.length;
  fixture.bot.emit("physicsTick");
  assert.equal(fixture.controls.length, writesAtClose);
  assert.deepEqual(fixture.controls.filter(([control]) => control === "jump").at(-1), ["jump", false]);
});

test("claims the body at half air and records the surfacing", async (t) => {
  const fixture = waterFixture(t);
  Object.assign(fixture.entity, { position: new Vec3(0.5, -59, 0.5) });
  Object.assign(fixture.bot, {
    oxygenLevel: 8,
    health: 20,
    username: "Diver",
    blockAt: () => null,
  });
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
  for (let tick = 0; tick < 5; tick += 1) fixture.bot.emit("physicsTick");
  assert.deepEqual(claims, ["breath_reflex [BREATH] surface at air 8."]);
  Object.assign(fixture.bot, { oxygenLevel: 20 });
  fixture.bot.emit("physicsTick");
  await outcome;
  await new Promise((resolve) => setImmediate(resolve));

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

/** A sealed pocket: every cell around the bot is the roof block, so no swim reaches open air. */
function sealedPocket(fixture: ReturnType<typeof waterFixture>, inWater: boolean) {
  const digs: string[] = [];
  const equipped: string[] = [];
  const pickaxe = { name: "stone_pickaxe", type: 1, count: 1 };
  const roof = {
    boundingBox: "block",
    diggable: true,
    shapes: [[0, 0, 0, 1, 1, 1]],
    // Only the pickaxe breaks it fast; a bare hand is slow.
    digTime: (item: number | null) => (item === pickaxe.type ? 300 : 3000),
  };
  Object.assign(fixture.entity, { isInWater: inWater, position: new Vec3(0.5, -59, 0.5) });
  Object.assign(fixture.bot, {
    oxygenLevel: 8,
    health: 20,
    username: "Diver",
    blockAt: () => roof,
    heldItem: null,
    game: { gameMode: "survival" },
    inventory: { items: () => [pickaxe] },
    equip: async (item: { name: string }) => {
      equipped.push(item.name);
    },
    dig: async () => {
      digs.push("roof");
      Object.assign(fixture.bot, { oxygenLevel: 20 });
    },
  });
  return { digs, equipped };
}

test("a swimmer sealed under a roof digs it with the best tool it carries", async (t) => {
  const fixture = waterFixture(t);
  const { digs, equipped } = sealedPocket(fixture, true);
  const control = attachBreathReflex(fixture.bot, fixture.reflex);
  for (let tick = 0; tick < 6; tick += 1) fixture.bot.emit("physicsTick");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(digs, ["roof"]);
  assert.deepEqual(equipped, ["stone_pickaxe"]);
  await control[Symbol.asyncDispose]();
});

test("a dry bot under the same roof is left alone by the breath reflex", async (t) => {
  const fixture = waterFixture(t);
  const { digs } = sealedPocket(fixture, false);
  const control = attachBreathReflex(fixture.bot, fixture.reflex);
  for (let tick = 0; tick < 6; tick += 1) fixture.bot.emit("physicsTick");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(digs, []);
  await control[Symbol.asyncDispose]();
});

/** The reflex's continuation after a full-air surfacing, driven at chosen positions and times. */
function breathContinuations(t: Parameters<typeof waterFixture>[0]) {
  const fixture = waterFixture(t);
  let definition: { continuation: (outcome: unknown) => { kind: string; reason?: string } } | undefined;
  let clock = 0;
  const driver = { register: (captured: typeof definition) => { definition = captured; return { [Symbol.asyncDispose]: async () => {} }; } };
  attachBreathReflex(fixture.bot, driver as never, () => null, () => clock);
  return {
    surfaceAt: (x: number, atMs: number) => {
      clock = atMs;
      Object.assign(fixture.entity, { position: new Vec3(x + 0.5, 50, 0.5) });
      return definition!.continuation({ kind: "air_full", ownedDive: false });
    },
  };
}

const MINUTE = 60_000;

test("the third breath reflex at the same place within three minutes ends the action instead of resuming it", (t) => {
  const { surfaceAt } = breathContinuations(t);
  assert.equal(surfaceAt(0, 0).kind, "resume");
  assert.equal(surfaceAt(1, 19_000).kind, "resume");
  const third = surfaceAt(2, 38_000);
  assert.equal(third.kind, "return");
  assert.match(third.reason ?? "", /Out of air three times here/);
});

test("three breath reflexes ten blocks apart all resume", (t) => {
  const { surfaceAt } = breathContinuations(t);
  assert.equal(surfaceAt(0, 0).kind, "resume");
  assert.equal(surfaceAt(10, 19_000).kind, "resume");
  assert.equal(surfaceAt(20, 38_000).kind, "resume");
});

test("a third breath reflex after three minutes starts the count again and resumes", (t) => {
  const { surfaceAt } = breathContinuations(t);
  assert.equal(surfaceAt(0, 0).kind, "resume");
  assert.equal(surfaceAt(0, 19_000).kind, "resume");
  assert.equal(surfaceAt(0, 3 * MINUTE + 1).kind, "resume");
});
