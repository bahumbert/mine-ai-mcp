import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import minecraftData from "minecraft-data";
import { ActionRunner } from "../../session/action-runner.js";
import { ReflexDriver } from "../control/driver.js";
import { SurvivalPolicyState } from "../state/survival-policy.js";
import { botFixture } from "../../test-support/bot.js";
import { attachHungerReflex } from "./hunger.js";

test("wounded hunger becomes eligible between fights without taking an active combat controller's body", async () => {
  let foodReads = 0;
  let activeEngagement: { kind: "mob"; targetId: number } | null = { kind: "mob", targetId: 7 };
  const bot = Object.assign(new EventEmitter(), {
    health: 14,
    food: 17,
    inventory: {
      items: () => {
        foodReads += 1;
        return [];
      },
    },
  }) as unknown as Bot;
  const driver = new ReflexDriver(bot, new ActionRunner());
  const reflex = attachHungerReflex(
    bot,
    driver,
    { activeEngagement: () => activeEngagement },
    new SurvivalPolicyState(bot),
  );
  const check = () => {
    for (let tick = 0; tick < 20; tick += 1) bot.emit("physicsTick");
  };
  try {
    check();
    assert.equal(foodReads, 0, "an active fight keeps its weapon and shield");
    assert.deepEqual(driver.snapshot()[0]?.decision, { kind: "handled", by: "combat" });
    assert.deepEqual(
      driver.snapshot()[0]?.danger,
      {
        food: 17,
        health: 14,
        selectedFood: null,
        withheldRaw: null,
        rawFoodRule: null,
        bodyBusy: false,
        combatActive: true,
      },
      "an occupied body does not erase observed hunger",
    );
    activeEngagement = null;
    check();
    assert.equal(foodReads, 1, "wounded hunger 17 is eligible immediately after the fight");
    assert.deepEqual(
      driver.snapshot()[0]?.decision,
      {
        kind: "stand_down",
        candidates: [{ response: "eat", excluded: { kind: "missing_equipment", item: "food" } }],
      },
      "missing food remains an explicit decision premise",
    );
    bot.food = 18;
    check();
    assert.equal(foodReads, 1, "regeneration is already possible at hunger 18");
    bot.food = 17;
    bot.health = 20;
    check();
    assert.equal(foodReads, 1, "a healthy bot keeps the ordinary eating threshold");
    bot.food = 14;
    check();
    assert.equal(foodReads, 2);
  } finally {
    await reflex[Symbol.asyncDispose]();
    await driver[Symbol.asyncDispose]();
  }
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

/**
 * A hunt for cows ended with the reflex eating every raw beef the moment it
 * dropped, so there was never anything to cook. At ordinary hunger the
 * reflex now stands down and says which policy floor would release the meat.
 */
test("a hunt's raw drops stand the reflex down with the policy's reason until an emergency", async () => {
  const bot = Object.assign(new EventEmitter(), {
    health: 20,
    food: 12,
    registry: minecraftData("1.21.4"),
    inventory: { items: () => [{ name: "beef", count: 3 }] },
  }) as unknown as Bot;
  const driver = new ReflexDriver(bot, new ActionRunner());
  const reflex = attachHungerReflex(bot, driver, { activeEngagement: () => null }, new SurvivalPolicyState(bot));
  try {
    for (let tick = 0; tick < 20; tick += 1) bot.emit("physicsTick");
    assert.deepEqual(driver.snapshot()[0]?.danger, {
      food: 12,
      health: 20,
      selectedFood: null,
      withheldRaw: "beef",
      rawFoodRule:
        "uncooked food is kept for cooking until hunger is at most 6 or health is below 10 with hunger under 18 (raw_food policy)",
      bodyBusy: false,
      combatActive: false,
    });
    assert.deepEqual(driver.snapshot()[0]?.decision, {
      kind: "stand_down",
      candidates: [
        {
          response: "eat",
          excluded: {
            kind: "infeasible_now",
            premise:
              "Only uncooked beef is carried and uncooked food is kept for cooking until hunger is at most 6 or health is below 10 with hunger under 18 (raw_food policy).",
          },
        },
      ],
    });
  } finally {
    await reflex[Symbol.asyncDispose]();
    await driver[Symbol.asyncDispose]();
  }
});

test("revoking raw food releases the active bite without waiting for its native timeout, preserving unrelated edits", async () => {
  const items = [{ name: "beef", count: 3 }];
  let began!: () => void;
  const biting = new Promise<void>((resolve) => { began = resolve; });
  let finish!: () => void;
  let deactivations = 0;
  const bot = botFixture({ items }, {
    health: 20, food: 6,
    consume: () => new Promise<void>((_resolve, reject) => {
      bot.usingHeldItem = true;
      finish = () => reject(new Error("bite released"));
      began();
    }),
    deactivateItem: () => { deactivations++; bot.usingHeldItem = false; },
  });
  const policy = new SurvivalPolicyState(bot);
  const driver = new ReflexDriver(bot, new ActionRunner());
  const reflex = attachHungerReflex(bot, driver, { activeEngagement: () => null }, policy);
  try {
    for (let tick = 0; tick < 20; tick++) bot.emit("physicsTick");
    await biting;
    await policy.edit({ operation: "set", expected_revision: policy.snapshot().revision,
      changes: { combat: { bow: false } }, lifetime: { kind: "session" }, reason: "keep arrows" });
    assert.equal(deactivations, 0, "an unrelated edit leaves the meal alone");
    const edit = policy.edit({ operation: "set", expected_revision: policy.snapshot().revision,
      changes: { food: { raw: { allow: "never" } } }, lifetime: { kind: "session" }, reason: "keep meat" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(deactivations, 1);
    // The released hand is what the edit waits on. Mineflayer leaves consume
    // pending until its own timeout, and that bookkeeping must not hold the
    // policy in settlement.
    await edit;
    assert.equal(policy.settling, false, "settled without the native consume releasing");
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(items[0]!.count, 3);
    assert.equal(driver.snapshot()[0]?.response, null);
    assert.deepEqual(driver.answered.snapshot(), [], "policy cancellation is not a failed capability");
  } finally {
    finish?.();
    await reflex[Symbol.asyncDispose]();
    await driver[Symbol.asyncDispose]();
  }
});

/** The probes of one meal, driven by hand: the reflex's definition is captured instead of run on a driver. */
function mealProbe(bot: Bot, food = "bread") {
  let definition: { progress: (food: string, mark: (reason: string) => void) => () => void; limits: (food: string) => unknown } | undefined;
  const driver = {
    bot,
    runner: { status: () => ({ owner: "idle" }) },
    register: (captured: typeof definition) => {
      definition = captured;
      return { [Symbol.asyncDispose]: async () => {} };
    },
  };
  attachHungerReflex(bot, driver as never, { activeEngagement: () => null }, new SurvivalPolicyState(bot));
  const marks: string[] = [];
  const detach = definition!.progress(food, (reason) => marks.push(reason));
  return { marks, detach, limits: definition!.limits(food), tick: () => bot.emit("physicsTick") };
}

function eatingBot(overrides: Record<string, unknown> = {}) {
  const items = [{ name: "bread", count: 3 }];
  return Object.assign(new EventEmitter(), {
    health: 20,
    food: 10,
    foodSaturation: 0,
    usingHeldItem: false,
    entity: { position: { x: 0, y: 64, z: 0 }, isInWater: false },
    registry: minecraftData("1.21.4"),
    inventory: { items: () => items },
    ...overrides,
  }) as unknown as Bot & { food: number; foodSaturation: number; usingHeldItem: boolean };
}

test("a bite in progress is progress", () => {
  const bot = eatingBot();
  const { marks, tick, detach } = mealProbe(bot);
  tick();
  assert.deepEqual(marks, []);
  bot.usingHeldItem = true;
  tick();
  tick();
  assert.deepEqual(marks, ["biting", "biting"], "every tick of the bite counts, so a 1.6 s meal never nears the 8 s window");
  detach();
});

test("food or saturation rising and a spent stack are progress", () => {
  const bot = eatingBot();
  const { marks, tick, detach } = mealProbe(bot);
  tick();
  bot.food = 14;
  tick();
  bot.foodSaturation = 2;
  tick();
  Reflect.set(bot, "inventory", { items: () => [{ name: "bread", count: 2 }] });
  tick();
  assert.deepEqual(marks, ["food_rose", "saturation_rose", "food_spent"]);
  detach();
});

test("a meal that does nothing for the window is not progress, and its limits are the owner's", () => {
  const bot = eatingBot();
  const { marks, tick, limits, detach } = mealProbe(bot);
  for (let count = 0; count < 100; count++) tick();
  assert.deepEqual(marks, []);
  assert.deepEqual(limits, { ceilingMs: 20_000, noProgressMs: 8_000, standDownMs: 2_000 });
  detach();
});
