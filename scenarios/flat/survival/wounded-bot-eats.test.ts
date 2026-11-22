// The bot-eats judge and the hunger helper count server ticks, confirm the bread eaten and leave nothing behind.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { spyOn } from "bun:test";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import * as scenarioRuntime from "../../src/runtime.ts";
import { run as runHunger, starve } from "./hunger.ts";
import { admissionRefusal, awaitMeal, type MealStart } from "./wounded-bot-eats.ts";

/** Bread recovery reads this float at the saturation plateau and crosses 18 on the next slow heal (t00458, 20 tps). */
const PLATEAU = 17.999998092651367;
const CROSSED = 18.999998092651367;
const START: MealStart = { health: 14, food: 17, bread: 3 };
const RATES = [20, 10];

function fixture(rate: number, options: { food?: number; health?: number } = {}) {
  const clock = createFakeClock({ mode: "mocked" });
  const timers = clock.install();
  const harness = createFakeBot({
    clock, server: { startAge: 1_000, ticksPerSecond: rate }, carried: { bread: 3 },
    health: options.health ?? 14, food: options.food ?? 17,
  });
  const controller = new AbortController();
  const added = listenersAddedSince(harness.bot);
  const clientAdded = listenersAddedSince(harness.bot._client);
  const chat: string[] = [];
  harness.bot.chat = (line: string) => void chat.push(line);
  const offs: (() => void)[] = [];
  /** Run `action` on the first server tick `offset` ticks after now (server ticks, not clock time). */
  const at = (offset: number, action: () => void) => {
    const due = harness.server.gameTime + offset;
    let done = false;
    offs.push(harness.server.onTick(() => {
      if (done || harness.server.gameTime < due) return;
      done = true;
      action();
    }));
  };
  const breadId = harness.bot.registry.itemsByName.bread!.id;
  const eatBread = () => void harness.inventory.toss(breadId, 1);
  const context = { bot: harness.bot, signal: controller.signal, log: () => {}, progress: () => {},
    scenario: { params: { hungerTo: 12, waitTicks: 200 } } } as unknown as MineAiScenarioContext;
  return {
    ...harness, clock, controller, context, chat, at, eatBread, added,
    cleared: () => chat.filter((line) => line.startsWith("/effect clear")).length,
    given: () => chat.filter((line) => line.startsWith("/effect give")).length,
    /** Each exit leaves no timer, no listener on the bot, its client or the signal. */
    async assertClean() {
      offs.forEach((off) => off());
      const check = () => {
        for (const event of harness.bot.eventNames()) assert.equal(added(String(event)), 0, `bot ${String(event)}`);
        for (const event of harness.bot._client.eventNames()) assert.equal(clientAdded(String(event)), 0, `client ${String(event)}`);
        assert.equal(getEventListeners(controller.signal, "abort").length, 0, "abort listener");
        assert.equal(clock.pendingTimers(), 0, "clock timers");
        assert.equal(clock.pendingGlobalTimers(), 0, "global timers");
      };
      check();
      await clock.advance(60_000);
      check();
      timers[Symbol.dispose]();
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

/** Run the judge from the fixture's start state; the caller schedules the server's answers first. */
function judge(f: Fixture) {
  return awaitMeal(f.bot, START, f.controller.signal);
}

function msFor(rate: number, ticks: number) {
  return (ticks / rate) * 1_000;
}

for (const rate of RATES) {
  test(`bread recovery crosses 18 at +280 after the plateau at +60 and a bread eaten at +100, at ${rate} tps`, async () => {
    const f = fixture(rate);
    f.at(60, () => f.combat.setHealth(PLATEAU, 17));
    f.at(100, f.eatBread);
    f.at(280, () => f.combat.setHealth(CROSSED, 17));
    const result = await f.clock.settle(judge(f), msFor(rate, 600));
    assert.equal(result.status, "succeeded", String(result.detail));
    await f.assertClean();
  });

  test(`recovery inside the 400-tick window passes at +380 and past its end fails at +520, at ${rate} tps`, async () => {
    const inside = fixture(rate);
    inside.at(60, inside.eatBread);
    inside.at(380, () => inside.combat.setHealth(18, 17));
    assert.equal((await inside.clock.settle(judge(inside), msFor(rate, 800))).status, "succeeded");
    await inside.assertClean();
    const past = fixture(rate);
    past.at(60, past.eatBread);
    past.at(520, () => past.combat.setHealth(18, 17));
    assert.equal((await past.clock.settle(judge(past), msFor(rate, 1_000))).status, "failed");
    await past.assertClean();
  });

  test(`the meal's "healed" progress is declared while health rises, at ${rate} tps`, async () => {
    const f = fixture(rate);
    const reasons: string[] = [];
    f.at(60, () => f.combat.setHealth(PLATEAU, 17));
    f.at(100, f.eatBread);
    f.at(280, () => f.combat.setHealth(CROSSED, 17));
    const result = await f.clock.settle(awaitMeal(f.bot, START, f.controller.signal, (reason) => void reasons.push(reason)), msFor(rate, 600));
    assert.equal(result.status, "succeeded", String(result.detail));
    assert.deepEqual(reasons, ["healed", "healed"]);
    await f.assertClean();
  });

  test(`the plateau alone never passes: 17.999998092651367 is below 18 until the window ends, at ${rate} tps`, async () => {
    const f = fixture(rate);
    f.at(60, () => f.combat.setHealth(PLATEAU, 17));
    f.at(100, f.eatBread);
    const result = await f.clock.settle(judge(f), msFor(rate, 1_000));
    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /did not complete/u);
    await f.assertClean();
  });


  test(`health at 18 with no bread eaten fails after the server answer window, naming the bread, at ${rate} tps`, async () => {
    const f = fixture(rate);
    f.at(60, () => f.combat.setHealth(18, 17));
    const result = await f.clock.settle(judge(f), msFor(rate, 1_000));
    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /bread/u);
    assert.ok(f.server.gameTime >= 1_000 + 60 + 40, "the bread is waited for a whole server answer window");
    await f.assertClean();
  });

  for (const { name, breadAt } of [{ name: "exactly 18.0 with the bread eaten at once", breadAt: 60 }, { name: "a bread decrement 20 ticks after the health", breadAt: 80 }]) {
    test(`${name} passes, at ${rate} tps`, async () => {
      const f = fixture(rate);
      f.at(60, () => f.combat.setHealth(18, 17));
      f.at(breadAt, f.eatBread);
      const result = await f.clock.settle(judge(f), msFor(rate, 600));
      assert.equal(result.status, "succeeded", String(result.detail));
      await f.assertClean();
    });
  }

  test(`a death then a respawn at full health fails: the death is latched, at ${rate} tps`, async () => {
    const f = fixture(rate);
    f.at(50, () => f.combat.setHealth(0));
    f.at(60, () => f.combat.setHealth(20, 20));
    f.at(70, f.eatBread);
    const result = await f.clock.settle(judge(f), msFor(rate, 800));
    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /died/u);
    await f.assertClean();
  });

  test(`a stopped world age fails stalled, not recovered, at ${rate} tps`, async () => {
    const f = fixture(rate);
    f.server.stop();
    const result = await f.clock.settle(judge(f), 60_000);
    assert.equal(result.status, "failed");
    assert.match(result.detail ?? "", /stalled/u);
    await f.assertClean();
  });
}

test("an aborted signal rejects with its reason and leaves no listener or timer", async () => {
  const f = fixture(20);
  const reason = new Error("cancelled meal");
  const window = judge(f);
  const rejected = assert.rejects(window, (error) => error === reason);
  await f.clock.advance(5_000);
  f.controller.abort(reason);
  await f.clock.settle(rejected, 5_000);
  await f.assertClean();
});

for (const { food, health, refused } of [
  { food: 14, health: 14, refused: true }, { food: 15, health: 14, refused: false }, { food: 17, health: 14, refused: false },
  { food: 18, health: 14, refused: true }, { food: 17, health: 14.5, refused: true }, { food: 17, health: 8, refused: false },
]) {
  test(`admission: food ${food} and health ${health} ${refused ? "are refused" : "are admitted"}`, () => {
    const refusal = admissionRefusal({ health, food, bread: 3 });
    assert.equal(refusal !== null, refused, String(refusal));
  });
}

test("admission refuses a bot with no bread, which could never be seen eating", () => {
  assert.match(admissionRefusal({ health: 14, food: 17, bread: 0 }) ?? "", /bread/u);
});

/** hunger.ts: `starve` and `run` count server ticks and always take the hunger effect off. */
for (const rate of RATES) {
  test(`starve reaches its target at +300 server ticks and clears the effect once, at ${rate} tps`, async () => {
    const f = fixture(rate, { food: 20 });
    f.at(300, () => f.combat.setHealth(20, 17));
    const reached = await f.clock.settle(starve(f.context, 17), msFor(rate, 800));
    assert.equal(reached, true);
    assert.equal(f.given(), 1);
    assert.equal(f.cleared(), 1);
    await f.assertClean();
  });

  test(`starve gives up after 1200 server ticks with the effect cleared, at ${rate} tps`, async () => {
    const f = fixture(rate, { food: 20 });
    const reached = await f.clock.settle(starve(f.context, 17), msFor(rate, 2_400));
    assert.equal(reached, false);
    assert.ok(f.server.gameTime >= 1_000 + 1_200, "the 1200 ticks are server ticks");
    assert.equal(f.cleared(), 1);
    await f.assertClean();
  });

  test(`starve on a stopped world age gives up and clears the effect, at ${rate} tps`, async () => {
    const f = fixture(rate, { food: 20 });
    f.server.stop();
    const reached = await f.clock.settle(starve(f.context, 17), 60_000);
    assert.equal(reached, false);
    assert.equal(f.cleared(), 1);
    await f.assertClean();
  });
}

test("starve aborted rejects with the reason and still clears the effect", async () => {
  const f = fixture(20, { food: 20 });
  const reason = new Error("cancelled starve");
  const window = starve(f.context, 17);
  const rejected = assert.rejects(window, (error) => error === reason);
  await f.clock.advance(2_000);
  f.controller.abort(reason);
  await f.clock.settle(rejected, 5_000);
  assert.equal(f.cleared(), 1);
  await f.assertClean();
});

test("a clear that throws never masks starve's own result", async () => {
  const f = fixture(20, { food: 12 });
  f.bot.chat = (line: string) => {
    if (line.startsWith("/effect clear")) throw new Error("chat closed");
  };
  assert.equal(await f.clock.settle(starve(f.context, 17), 5_000), true);
  await f.assertClean();
});

function hungerRuntime() {
  const state = { closed: 0 };
  const attach = spyOn(scenarioRuntime, "openRuntime").mockResolvedValue({
    close: async () => void state.closed++,
  } as unknown as Awaited<ReturnType<typeof scenarioRuntime.openRuntime>>);
  return { state, attach };
}

async function runHungerAt(rate: number, arrange: (f: Fixture) => void, wallMs = 60_000) {
  const f = fixture(rate, { food: 12 });
  const { state, attach } = hungerRuntime();
  try {
    arrange(f);
    const settled = await f.clock.settle(runHunger(f.context).then((result) => ({ result }), (error: unknown) => ({ error })), wallMs);
    return { f, state, settled };
  } finally {
    attach.mockRestore();
  }
}

for (const rate of RATES) {
  test(`hunger run counts its 200 ticks as server ticks: food rising at +190 passes, at ${rate} tps`, async () => {
    const { f, state, settled } = await runHungerAt(rate, (f) => f.at(190, () => f.combat.setHealth(20, 16)));
    assert.equal("result" in settled && settled.result.status, "succeeded");
    assert.equal(state.closed, 1);
    assert.equal(f.cleared(), 1, "only starve's clear");
    await f.assertClean();
  });

  test(`hunger run fails when food never rises inside its server ticks, at ${rate} tps`, async () => {
    const { f, state, settled } = await runHungerAt(rate, () => {});
    assert.equal("result" in settled && settled.result.status, "failed");
    assert.match("result" in settled ? settled.result.detail ?? "" : "", /did not rise/u);
    assert.ok(f.server.gameTime >= 1_000 + 200);
    assert.equal(state.closed, 1);
    await f.assertClean();
  });

  test(`hunger run fails when food rises only after its 200 server ticks, at ${rate} tps`, async () => {
    const { f, state, settled } = await runHungerAt(rate, (f) => f.at(300, () => f.combat.setHealth(20, 16)));
    assert.equal("result" in settled && settled.result.status, "failed");
    assert.match("result" in settled ? settled.result.detail ?? "" : "", /did not rise/u);
    assert.equal(state.closed, 1);
    await f.assertClean();
  });

  test(`hunger run latches a death even when the respawn brings full food, at ${rate} tps`, async () => {
    const { f, state, settled } = await runHungerAt(rate, (f) => {
      f.at(60, () => f.combat.setHealth(0));
      f.at(70, () => f.combat.setHealth(20, 20));
    });
    assert.equal("result" in settled && settled.result.status, "failed");
    assert.match("result" in settled ? settled.result.detail ?? "" : "", /died true/u);
    assert.equal(state.closed, 1);
    await f.assertClean();
  });

  test(`hunger run on a stopped world age fails stalled and closes the runtime, at ${rate} tps`, async () => {
    const { f, state, settled } = await runHungerAt(rate, (f) => f.server.stop());
    assert.equal("result" in settled && settled.result.status, "failed");
    assert.match("result" in settled ? settled.result.detail ?? "" : "", /stalled/u);
    assert.equal(state.closed, 1);
    await f.assertClean();
  });
}

test("hunger run aborted rejects, closes the runtime and leaves no listener", async () => {
  const f = fixture(20, { food: 12 });
  const { state, attach } = hungerRuntime();
  try {
    const reason = new Error("cancelled hunger");
    const window = runHunger(f.context);
    const rejected = assert.rejects(window, (error) => error === reason);
    await f.clock.advance(2_000);
    f.controller.abort(reason);
    await f.clock.settle(rejected, 5_000);
    assert.equal(state.closed, 1);
    await f.assertClean();
  } finally {
    attach.mockRestore();
  }
});
