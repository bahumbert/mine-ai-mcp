// The runner resuming a real inventory action (eat_food) after a reflex took the body: one success, or the interrupted result.
import assert from "node:assert/strict";
import test from "node:test";
import { createEatFoodAction } from "../actions/eat-food/index.js";
import { botFixture, type FakeStack } from "../test-support/bot.js";
import { ActionRunner } from "./action-runner.js";

/** A hungry bot whose first `hanging` bites hang until the runner takes the body; later bites complete and lose one item. */
function bitingBot(hanging = 1) {
  const items: FakeStack[] = [{ name: "cooked_beef", count: 2 }];
  const bites = { started: 0 };
  const bot = botFixture({ items }, { food: 10, foodSaturation: 2, equip: async () => {}, usingHeldItem: false });
  bot.consume = async () => {
    bites.started += 1;
    if (bites.started <= hanging) await new Promise<never>(() => {});
    items[0]!.count -= 1;
    bot.food = 18;
  };
  return { bot, items, bites };
}

async function untilBite(bites: { started: number }, number: number): Promise<void> {
  for (let turn = 0; turn < 100 && bites.started < number; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bites.started, number);
}

test("an eat_food a hunger reflex interrupted ends as one success naming the reflex, with one item eaten", async () => {
  const { bot, items, bites } = bitingBot();
  const runner = new ActionRunner();
  const outcome = runner.run(createEatFoodAction(bot), { food_name: "cooked_beef" });
  await untilBite(bites, 1);

  runner.claim("hunger_reflex", "[HUNGER] food 10.", async () => ({
    value: "ate",
    continuation: { kind: "resume" as const },
  }));
  const output = await outcome;

  assert.equal(output.result.status, "succeeded");
  assert.deepEqual(output.interruptions, ["[HUNGER] food 10."]);
  assert.equal(items[0]!.count, 1);
  assert.equal(bites.started, 2);
  assert.deepEqual(runner.status(), { busy: false, activeAction: null, owner: "idle" });
});

test("an eat_food whose reflex says return ends cancelled and takes no second bite", async () => {
  const { bot, items, bites } = bitingBot();
  const runner = new ActionRunner();
  const outcome = runner.run(createEatFoodAction(bot), { food_name: "cooked_beef" });
  await untilBite(bites, 1);

  runner.claim("hostile_reflex", "[HOSTILE_CONTACT] fight response.", async () => ({
    value: "evaded",
    continuation: { kind: "return" as const, reason: null },
  }));
  const output = await outcome;

  assert.equal(output.result.status, "cancelled");
  assert.equal(output.interruptions, undefined);
  assert.equal(bites.started, 1);
  assert.equal(items[0]!.count, 2);
});

test("an eat_food a reflex interrupts twice in a row still eats one item and names both reflexes", async () => {
  const { bot, items, bites } = bitingBot(2);
  const runner = new ActionRunner();
  const outcome = runner.run(createEatFoodAction(bot), { food_name: "cooked_beef" });
  const resume = async () => ({ value: "ok", continuation: { kind: "resume" as const } });
  await untilBite(bites, 1);

  runner.claim("fall_reflex", "[FALL] landing.", resume);
  await untilBite(bites, 2);
  runner.claim("hunger_reflex", "[HUNGER] food 10.", resume);
  const output = await outcome;

  assert.equal(output.result.status, "succeeded");
  assert.deepEqual(output.interruptions, ["[FALL] landing.", "[HUNGER] food 10."]);
  assert.equal(items[0]!.count, 1);
  assert.equal(bites.started, 3);
});

test("a model cancel while the reflex holds the body is final: the eat_food is not resumed", async () => {
  const { bot, items, bites } = bitingBot();
  const runner = new ActionRunner();
  const model = new AbortController();
  const outcome = runner.run(createEatFoodAction(bot), { food_name: "cooked_beef" }, model.signal);
  await untilBite(bites, 1);

  runner.claim("hunger_reflex", "[HUNGER] food 10.", async () => {
    model.abort(new Error("model changed its mind"));
    return { value: "ate", continuation: { kind: "resume" as const } };
  });
  const output = await outcome;

  assert.equal(output.result.status, "cancelled");
  assert.equal(bites.started, 1);
  assert.equal(items[0]!.count, 2);
});
