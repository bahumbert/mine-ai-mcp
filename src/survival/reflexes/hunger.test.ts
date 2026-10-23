import assert from "node:assert/strict";
import test from "node:test";
import { ActionRunner } from "../../session/action-runner.js";
import { ReflexDriver } from "../control/driver.js";
import { SurvivalPolicyState } from "../state/survival-policy.js";
import { type FakeHarness, createFakeBot, itemOf } from "../../test-support/fake-bot/index.js";
import { attachHungerReflex } from "./hunger.js";

test("wounded hunger becomes eligible between fights without taking an active combat controller's body", async () => {
  let foodReads = 0;
  let activeEngagement: { kind: "mob"; targetId: number } | null = { kind: "mob", targetId: 7 };
  const { bot, clock } = createFakeBot({ health: 14, food: 17 });
  // Counts each look at the carried food, then answers what the inventory holds.
  const carried = bot.inventory.items.bind(bot.inventory);
  bot.inventory.items = () => {
    foodReads += 1;
    return carried();
  };
  const driver = new ReflexDriver(bot, new ActionRunner({ clock }), { now: clock.now });
  const reflex = attachHungerReflex(
    bot,
    driver,
    { activeEngagement: () => activeEngagement },
    new SurvivalPolicyState(bot),
  );
  /** A second of client ticks. */
  const check = () => clock.advance(1_000);
  try {
    await check();
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
    await check();
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
    await check();
    assert.equal(foodReads, 1, "regeneration is already possible at hunger 18");
    bot.food = 17;
    bot.health = 20;
    await check();
    assert.equal(foodReads, 1, "a healthy bot keeps the ordinary eating threshold");
    bot.food = 14;
    await check();
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
  const { bot, clock } = createFakeBot({ food: 12, carried: { beef: 3 } });
  const driver = new ReflexDriver(bot, new ActionRunner({ clock }), { now: clock.now });
  const reflex = attachHungerReflex(bot, driver, { activeEngagement: () => null }, new SurvivalPolicyState(bot));
  try {
    await clock.advance(1_000);
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

/** How long Mineflayer's `consume` waits for the server's answer before it gives up (`inventory.js` CONSUME_TIMEOUT). */
const CONSUME_TIMEOUT_MS = 2_500;

test("revoking raw food releases the active bite without waiting for its native timeout, preserving unrelated edits", async () => {
  let began!: () => void;
  const biting = new Promise<void>((resolve) => { began = resolve; });
  const { bot, clock, server } = createFakeBot({ food: 6, carried: { beef: 3 } });
  server.onPacket("use_item", began);
  /** The releases of the hand the server received (`block_dig` status 5). */
  const deactivations = () => server.packets.filter(({ name, data }) => name === "block_dig" && (data as { status: number }).status === 5).length;
  const policy = new SurvivalPolicyState(bot);
  const driver = new ReflexDriver(bot, new ActionRunner({ clock }), { now: clock.now });
  const reflex = attachHungerReflex(bot, driver, { activeEngagement: () => null }, policy);
  try {
    await clock.advance(1_000);
    await biting;
    await policy.edit({ operation: "set", expected_revision: policy.snapshot().revision,
      changes: { combat: { bow: false } }, lifetime: { kind: "session" }, reason: "keep arrows" });
    assert.equal(deactivations(), 0, "an unrelated edit leaves the meal alone");
    const edit = policy.edit({ operation: "set", expected_revision: policy.snapshot().revision,
      changes: { food: { raw: { allow: "never" } } }, lifetime: { kind: "session" }, reason: "keep meat" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(deactivations(), 1);
    // The released hand is what the edit waits on. Mineflayer leaves consume
    // pending until its own timeout, and that bookkeeping must not hold the
    // policy in settlement.
    await edit;
    assert.equal(policy.settling, false, "settled without the native consume releasing");
    await clock.advance(CONSUME_TIMEOUT_MS);
    assert.equal(bot.inventory.count(bot.registry.itemsByName.beef!.id, null), 3);
    assert.equal(driver.snapshot()[0]?.response, null);
    assert.deepEqual(driver.answered.snapshot(), [], "policy cancellation is not a failed capability");
  } finally {
    await reflex[Symbol.asyncDispose]();
    await driver[Symbol.asyncDispose]();
  }
});

/** The probes of one meal, driven by hand: the reflex's definition is captured instead of run on a driver. */
function mealProbe({ bot, clock }: FakeHarness, food = "bread") {
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
  return { marks, detach, limits: definition!.limits(food), tick: () => clock.advance(50) };
}

/** A bot at hunger 10 with no saturation, carrying three bread. */
function eatingBot() {
  const harness = createFakeBot({ food: 10, carried: { bread: 3 } });
  harness.bot.foodSaturation = 0;
  return harness;
}

test("a bite in progress is progress", async () => {
  const meal = eatingBot();
  const bot = meal.bot;
  const { marks, tick, detach } = mealProbe(meal);
  await tick();
  assert.deepEqual(marks, []);
  bot.usingHeldItem = true;
  await tick();
  await tick();
  assert.deepEqual(marks, ["biting", "biting"], "every tick of the bite counts, so a 1.6 s meal never nears the 8 s window");
  detach();
});

test("food or saturation rising and a spent stack are progress", async () => {
  const meal = eatingBot();
  const bot = meal.bot;
  const { marks, tick, detach } = mealProbe(meal);
  await tick();
  bot.food = 14;
  await tick();
  bot.foodSaturation = 2;
  await tick();
  const bread = bot.inventory.items()[0]!;
  bot.inventory.updateSlot(bread.slot, itemOf(bot.registry, "bread", 2));
  await tick();
  assert.deepEqual(marks, ["food_rose", "saturation_rose", "food_spent"]);
  detach();
});

test("a meal that does nothing for the window is not progress, and its limits are the owner's", async () => {
  const meal = eatingBot();
  const { marks, tick, limits, detach } = mealProbe(meal);
  for (let count = 0; count < 100; count++) await tick();
  assert.deepEqual(marks, []);
  assert.deepEqual(limits, { ceilingMs: 20_000, noProgressMs: 8_000, standDownMs: 2_000 });
  detach();
});
