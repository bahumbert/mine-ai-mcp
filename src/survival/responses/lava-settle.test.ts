import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { awaitLavaSettled, LAVA_SETTLE_MAXIMUM_MS, type LavaSettle } from "./lava-settle.js";

/** A bot standing on dry ground; `lastChange` is the world age of the last lava change the reflex heard of. */
function settleScene(options: { dimension?: string; lavaBeside?: boolean; attacker?: boolean } = {}) {
  // A mocked clock: the two tests that wait on the wall clock install it, the others never touch the timers.
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, server } = createFakeBot({
    clock,
    dimension: options.dimension,
    server: { startAge: 1000 },
    cells: options.lavaBeside ? { "-1,64,0": { name: "lava", properties: { level: 0 } } } : {},
    entities: options.attacker ? { 9: { name: "zombie", position: new Vec3(5.5, 64, 0.5) } } : {},
  });
  const playerKeys = bot.registry.entitiesByName.player!.metadataKeys!;
  const airSupplyIndex = playerKeys.indexOf("air_supply");
  const sharedFlagsIndex = playerKeys.indexOf("shared_flags");
  const metadata: number[] = [];
  metadata[airSupplyIndex] = 300;
  metadata[sharedFlagsIndex] = 0;
  Object.assign(bot.entity, { metadata });
  const scene = {
    bot,
    clock,
    server,
    metadata,
    airSupplyIndex,
    sharedFlagsIndex,
    /** The fake's own physics plugin listens on these; a wait must leave exactly what it found. */
    listeners: { physicsTick: bot.listenerCount("physicsTick"), death: bot.listenerCount("death"), respawn: bot.listenerCount("respawn") },
    lastChange: null as number | null,
    abort: new AbortController(),
    result: undefined as LavaSettle | undefined,
    error: undefined as unknown,
    /** Let `ticks` of world age pass, 20 a second as the server's time packets bring them, with a physics tick every 50 ms. */
    async advance(ticks: number) {
      await clock.advance(ticks * 50);
    },
    start(maximumMs?: number) {
      awaitLavaSettled(bot, scene.abort.signal, () => scene.lastChange, { maximumMs }).then(
        (value) => (scene.result = value),
        (error) => (scene.error = error),
      );
      return new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
  return scene;
}

test("settled at once when no lava changed", async () => {
  const scene = settleScene();
  await scene.start();
  assert.equal(scene.result, "settled", "no physics tick has run");
});

test("settled at once when the last change is two flow steps old", async () => {
  const scene = settleScene();
  scene.lastChange = 1000 - 60;
  await scene.start();
  assert.equal(scene.result, "settled");
});

test("waits two overworld flow steps after the last change", async () => {
  const scene = settleScene();
  scene.lastChange = 1000;
  await scene.start();
  await scene.advance(20);
  await scene.advance(20);
  assert.equal(scene.result, undefined, "age 1040: one tick short of two steps");
  await scene.advance(20);
  assert.equal(scene.result, "settled", "age 1060: two flow steps of 30 ticks without a change");
});

test("nether lava settles after 20 ticks", async () => {
  const scene = settleScene({ dimension: "the_nether" });
  scene.lastChange = 1010;
  await scene.start();
  await scene.advance(20);
  assert.equal(scene.result, undefined);
  await scene.advance(20);
  assert.equal(scene.result, "settled", "age 1040: 30 ticks since the change, 20 needed");
});

test("a change during the wait restarts the quiet window", async () => {
  const scene = settleScene();
  scene.lastChange = 1000;
  await scene.start();
  await scene.advance(40);
  scene.lastChange = 1040;
  await scene.advance(40);
  assert.equal(scene.result, undefined, "age 1080 is only 40 ticks after the change at 1040");
  await scene.advance(20);
  assert.equal(scene.result, "settled", "age 1100 is 60 ticks after the change");
});

test("still changing after 10 s is spreading", async () => {
  const scene = settleScene();
  using _timers = scene.clock.install();
  scene.lastChange = 1000;
  await scene.start();
  // The lava goes on changing: each physics tick hears of a change at the current age.
  scene.bot.on("physicsTick", () => { scene.lastChange = scene.bot.time.age; });
  await scene.advance(80);
  assert.equal(scene.result, undefined);
  await scene.clock.advance(LAVA_SETTLE_MAXIMUM_MS);
  assert.equal(scene.result, "spreading");
});

test("the wall clock ends the wait when physics ticks stop", async () => {
  const scene = settleScene();
  using _timers = scene.clock.install();
  scene.lastChange = 1000;
  await scene.start();
  // A server that stopped answering: the world age stands still and the client runs no physics tick.
  scene.server.stop();
  scene.bot.physicsEnabled = false;
  await scene.clock.advance(LAVA_SETTLE_MAXIMUM_MS);
  assert.equal(scene.result, "spreading", "no physicsTick was emitted at all");
  assert.equal(scene.bot.listenerCount("physicsTick"), scene.listeners.physicsTick, "the tick listener is gone");
  assert.equal(scene.bot.listenerCount("death"), scene.listeners.death);
  assert.equal(scene.bot.listenerCount("respawn"), scene.listeners.respawn);
});

test("lava advancing into the body is advancing", async () => {
  const scene = settleScene({ lavaBeside: true });
  scene.lastChange = 1000;
  await scene.start();
  assert.equal(scene.result, "advancing", "lava level 0 beside the body can spread into it");
});

test("lava under the body is advancing", async () => {
  const scene = settleScene();
  scene.lastChange = 1000;
  await scene.start();
  Object.assign(scene.bot.entity, { isInLava: true });
  await scene.advance(20);
  assert.equal(scene.result, "advancing");
});

test("damage during the wait is endangered", async () => {
  const scene = settleScene();
  scene.lastChange = 1000;
  await scene.start();
  scene.bot.health = 16;
  await scene.advance(20);
  assert.equal(scene.result, "endangered");
});

test("a burn tick on dry ground while burning does not end the wait", async () => {
  const scene = settleScene();
  scene.lastChange = 1020;
  scene.metadata[scene.sharedFlagsIndex] = 1;
  await scene.start();
  for (const health of [19, 18, 17]) {
    scene.bot.health = health;
    await scene.advance(20);
  }
  assert.equal(scene.result, undefined, "burning ticks lost 3 HP by age 1060 and the wait goes on");
  await scene.advance(20);
  assert.equal(scene.result, "settled", "age 1080: two flow steps since the change at 1020");
});

test("a mob hit while burning is endangered", async () => {
  const scene = settleScene({ attacker: true });
  scene.lastChange = 1000;
  scene.metadata[scene.sharedFlagsIndex] = 1;
  await scene.start();
  scene.bot.health = 19;
  await scene.advance(20);
  assert.equal(scene.result, undefined, "the burn tick alone does not end it");
  scene.bot.health = 15;
  scene.bot.emit("entityHurt", scene.bot.entity, scene.bot.entities[9]!);
  await scene.advance(20);
  assert.equal(scene.result, "endangered", "a hit with a source entity is not the burn");
});

test("health lost after the fire is out is endangered", async () => {
  const scene = settleScene();
  scene.lastChange = 1000;
  scene.metadata[scene.sharedFlagsIndex] = 1;
  await scene.start();
  scene.bot.health = 19;
  await scene.advance(20);
  scene.metadata[scene.sharedFlagsIndex] = 0;
  await scene.advance(20);
  assert.equal(scene.result, undefined, "the fire went out in the same second as its last burn tick");
  scene.bot.health = 18;
  await scene.advance(20);
  assert.equal(scene.result, "endangered", "a loss with no fire on the body is something else");
});

test("an entity hurt listener is removed when the wait ends", async () => {
  const scene = settleScene();
  scene.lastChange = 1000;
  await scene.start();
  assert.equal(scene.bot.listenerCount("entityHurt"), 1);
  await scene.advance(60);
  assert.equal(scene.result, "settled");
  assert.equal(scene.bot.listenerCount("entityHurt"), 0);
});

test("air at 10 is endangered", async () => {
  const scene = settleScene();
  scene.lastChange = 1000;
  await scene.start();
  scene.metadata[scene.airSupplyIndex] = 150;
  await scene.advance(20);
  assert.equal(scene.result, "endangered", "150 ticks of air is 10 points of 20");
});

test("death during the wait is died", async () => {
  const scene = settleScene();
  scene.lastChange = 1000;
  await scene.start();
  scene.bot.health = 0;
  scene.bot.emit("death");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(scene.result, "died");
  assert.equal(scene.bot.listenerCount("physicsTick"), scene.listeners.physicsTick);
});

test("an aborted signal rejects and leaves no listeners", async () => {
  const scene = settleScene();
  scene.lastChange = 1000;
  await scene.start();
  scene.abort.abort(new Error("cancelled"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(String(scene.error), /cancelled/);
  assert.equal(scene.bot.listenerCount("physicsTick"), scene.listeners.physicsTick);
  assert.equal(scene.bot.listenerCount("death"), scene.listeners.death);
});
