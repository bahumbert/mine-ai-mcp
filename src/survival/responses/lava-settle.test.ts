import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture, registry } from "../../test-support/bot.js";
import { awaitLavaSettled, LAVA_SETTLE_MAXIMUM_MS, type LavaSettle } from "./lava-settle.js";

const airSupplyIndex = registry.entitiesByName.player.metadataKeys!.indexOf("air_supply");
const sharedFlagsIndex = registry.entitiesByName.player.metadataKeys!.indexOf("shared_flags");

/** A bot standing on dry ground; `lastChange` is the world age of the last lava change the reflex heard of. */
function settleScene(options: { dimension?: string; lavaBeside?: boolean } = {}) {
  const bot = botFixture({ dimension: options.dimension, groundY: 63, time: { age: 1000 } });
  if (options.lavaBeside) {
    const dry = bot.blockAt.bind(bot);
    bot.blockAt = (cell) =>
      cell.equals(new Vec3(-1, 64, 0))
        ? ({ name: "lava", boundingBox: "empty", getProperties: () => ({ level: "0" }) } as unknown as ReturnType<typeof dry>)
        : dry(cell);
  }
  const metadata: number[] = [];
  metadata[airSupplyIndex] = 300;
  metadata[sharedFlagsIndex] = 0;
  Object.assign(bot.entity, { metadata });
  const scene = {
    bot,
    metadata,
    lastChange: null as number | null,
    abort: new AbortController(),
    result: undefined as LavaSettle | undefined,
    error: undefined as unknown,
    /** Move the world age by `ticks` in steps of 20, as the server does, one physics tick per step. */
    async advance(ticks: number) {
      for (let moved = 0; moved < ticks; moved += 20) {
        bot.time.age += 20;
        bot.emit("physicsTick");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
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
  assert.equal(scene.result, "settled", "no physics tick was emitted");
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

test("still changing after 10 s is spreading", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const scene = settleScene();
  scene.lastChange = 1000;
  await scene.start();
  for (let step = 0; step < 4; step++) {
    await scene.advance(20);
    scene.lastChange = scene.bot.time.age;
  }
  assert.equal(scene.result, undefined);
  context.mock.timers.tick(LAVA_SETTLE_MAXIMUM_MS);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(scene.result, "spreading");
});

test("the wall clock ends the wait when physics ticks stop", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const scene = settleScene();
  scene.lastChange = 1000;
  await scene.start();
  context.mock.timers.tick(LAVA_SETTLE_MAXIMUM_MS);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(scene.result, "spreading", "no physicsTick was emitted at all");
  assert.equal(scene.bot.listenerCount("physicsTick"), 0, "the tick listener is gone");
  assert.equal(scene.bot.listenerCount("death"), 0);
  assert.equal(scene.bot.listenerCount("respawn"), 0);
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
  scene.metadata[sharedFlagsIndex] = 1;
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
  const scene = settleScene();
  scene.lastChange = 1000;
  scene.metadata[sharedFlagsIndex] = 1;
  await scene.start();
  scene.bot.health = 19;
  await scene.advance(20);
  assert.equal(scene.result, undefined, "the burn tick alone does not end it");
  scene.bot.health = 15;
  scene.bot.emit("entityHurt", scene.bot.entity, { id: 9, name: "zombie" } as never);
  await scene.advance(20);
  assert.equal(scene.result, "endangered", "a hit with a source entity is not the burn");
});

test("health lost after the fire is out is endangered", async () => {
  const scene = settleScene();
  scene.lastChange = 1000;
  scene.metadata[sharedFlagsIndex] = 1;
  await scene.start();
  scene.bot.health = 19;
  await scene.advance(20);
  scene.metadata[sharedFlagsIndex] = 0;
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
  scene.metadata[airSupplyIndex] = 150;
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
  assert.equal(scene.bot.listenerCount("physicsTick"), 0);
});

test("an aborted signal rejects and leaves no listeners", async () => {
  const scene = settleScene();
  scene.lastChange = 1000;
  await scene.start();
  scene.abort.abort(new Error("cancelled"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(String(scene.error), /cancelled/);
  assert.equal(scene.bot.listenerCount("physicsTick"), 0);
  assert.equal(scene.bot.listenerCount("death"), 0);
});
