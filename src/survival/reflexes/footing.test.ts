import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { ActionRunner } from "../../session/action-runner.js";
import { stubAction } from "../../session/action-runner-fixtures.test.js";
import { createMovements, createNavigationRuntime, exactBlockGoal } from "../../navigation/index.js";
import { createFakeBot, createFakeClock, flush, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { ReflexDriver } from "../control/driver.js";
import { attachFootingReflex } from "./footing.js";

/** A footing reflex over a recovery that waits for the landing, on the fake bot's clock, high in open air. */
function fallingScene() {
  const { bot, clock } = createFakeBot({ position: new Vec3(0.5, 200, 0.5), groundY: null });
  const entity = Object.assign(bot.entity, { onGround: false });
  const runner = new ActionRunner({ clock, cancelGraceMs: 500 });
  const driver = new ReflexDriver(bot, runner, { now: clock.now });
  const recovery = {
    needed: true,
    recover: (signal: AbortSignal) => new Promise<"landed" | "failed">((resolve) => signal.addEventListener("abort", () => resolve("failed"), { once: true })),
  };
  const reflex = attachFootingReflex(driver, { activeEngagement: () => null }, recovery, () => {});
  /** One 50 ms step: the body falls `drop` blocks, then a client tick. */
  const step = async (drop: number) => {
    entity.position = entity.position.offset(0, -drop, 0);
    await clock.advance(50);
  };
  return { entity, runner, step, dispose: async () => { await reflex[Symbol.asyncDispose](); await driver[Symbol.asyncDispose](); } };
}

test("a long fall keeps marking: 20 s in the air is not cut at the 5 s window", async () => {
  const scene = fallingScene();
  for (let tick = 0; tick < 400; tick++) await scene.step(1);
  assert.equal(scene.runner.status().activeAction?.action, "recover_footing", "falling a block per tick is progress");
  await scene.dispose();
});

test("a body that hangs in the air with no landing is released after 5 s of world ticks without progress", async () => {
  const scene = fallingScene();
  // The 5 s window is 100 world ticks and one packet: it ends at the packet of age A + 120, 6 s in at 20 tps.
  for (let tick = 0; tick < 80; tick++) await scene.step(0);
  assert.equal(scene.runner.status().activeAction?.action, "recover_footing", "4 s: the window is open");
  for (let tick = 0; tick < 60; tick++) await scene.step(0);
  assert.equal(scene.runner.status().owner, "idle");
  await scene.dispose();
});

test("the footing reflex on a never-safe support ends by its 30 s ceiling", async () => {
  const scene = fallingScene();
  for (let tick = 0; tick < 580; tick++) await scene.step(1);
  assert.equal(scene.runner.status().activeAction?.action, "recover_footing", "29 s of falling a block per tick: still marking");
  for (let tick = 0; tick < 60; tick++) await scene.step(1); // the ceiling is 600 world ticks and one packet: 31 s in at 20 tps
  assert.equal(scene.runner.status().owner, "idle", "the 30 s ceiling ends it although every tick marks progress");
  await scene.dispose();
});

test("landing marks, and so does entering water", async () => {
  const scene = fallingScene();
  for (let tick = 0; tick < 80; tick++) await scene.step(0);
  scene.entity.onGround = true;
  await scene.step(0);
  for (let tick = 0; tick < 80; tick++) await scene.step(0);
  assert.equal(scene.runner.status().activeAction?.action, "recover_footing", "the landing at 4 s reopened the window");
  Object.assign(scene.entity, { isInWater: true });
  await scene.step(0);
  for (let tick = 0; tick < 80; tick++) await scene.step(0);
  assert.equal(scene.runner.status().activeAction?.action, "recover_footing", "so did the splash at 8 s");
  await scene.dispose();
});

for (const ticksPerSecond of [20, 10]) {
  test(`a footing takeover of an airborne stationary search starts recovery within two physics ticks at ${ticksPerSecond} tps`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { bot, server } = createFakeBot({ clock, position: new Vec3(0.5, 63, 0.5), groundY: 62,
      server: { ticksPerSecond, startAge: 0 } });
    const added = listenersAddedSince(bot);
    const runner = new ActionRunner({ clock });
    const navigation = createNavigationRuntime(bot);
    const driver = new ReflexDriver(bot, runner, { now: clock.now });
    let needed = false;
    let claimedAt: number | null = null;
    let recoveredAt: number | null = null;
    let landed = false;
    let searching = false;
    driver.onTransition(event => {
      if (event.kind === "claim") claimedAt = clock.now();
    });
    navigation.onEvent(event => {
      if (event.kind === "search_started") {
        searching = true;
        bot.entity.onGround = false;
        bot.entity.position.y += 0.5;
        needed = true;
      }
    });
    const recovery = {
      get needed() { return needed; },
      async recover(): Promise<"landed"> {
        recoveredAt = clock.now();
        assert.equal(bot.entity.onGround, false, "the successor receives the released airborne body");
        bot.entity.position.y = 63;
        bot.entity.onGround = true;
        needed = false;
        landed = true;
        return "landed";
      },
    };
    const reflex = attachFootingReflex(driver, { activeEngagement: () => null }, recovery,
      reason => navigation.releaseForTakeover(reason));
    const action = stubAction(async (_request, context) => {
      await navigation.navigate({ movements: createMovements(bot), goal: exactBlockGoal({ x: 5, y: 63, z: 0 }), signal: context.signal });
      context.signal?.throwIfAborted();
      return { status: "succeeded" };
    });
    let pending: ReturnType<typeof runner.run> | undefined;
    try {
      await clock.advance(2_000);
      assert.equal(bot.time.age, ticksPerSecond === 20 ? 40 : 20, "at fake-clock 2000 ms: two/one time packets");
      pending = runner.run(action, { block_name: "stone" });
      await flush();
      assert.equal(searching, true);
      assert.equal(navigation.active, true);
      await clock.advance(50);
      assert.equal(claimedAt, 2_050, "the first physics tick after the airborne search claims footing");
      await clock.advance(100);
      assert.ok(recoveredAt !== null && recoveredAt - claimedAt! <= 100,
        `recovery at fake-clock ${recoveredAt} ms, claim ${claimedAt} ms, world age ${bot.time.age}`);
      assert.equal(bot.time.age, ticksPerSecond === 20 ? 40 : 20, "at fake-clock 2150 ms, no further time packet was needed");
      assert.equal(landed, true);
      assert.equal(navigation.active, false);
      await clock.settle(pending, 50);
      assert.equal(runner.status().owner, "idle");
      server.stop();
      await clock.advance(2_050);
      assert.equal(runner.status().owner, "idle", "the stopped server leaves the completed handoff settled");
      assert.equal(bot.time.age, ticksPerSecond === 20 ? 40 : 20);
    } finally {
      navigation.releaseForTakeover("test cleanup");
      await clock.settle(navigation.close(), 2_050);
      if (pending) await clock.settle(pending, 2_050);
      await reflex[Symbol.asyncDispose]();
      await driver[Symbol.asyncDispose]();
    }
    assert.equal(added("physicsTick"), 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
  });
}
