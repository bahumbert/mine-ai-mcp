// The runner resumes smelt_item and craft_item after a reflex hands the body back, and ends them when it does not.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createCraftItemAction } from "../actions/craft-item/index.js";
import { createSmeltItemAction, type SmeltItemDependencies } from "../actions/smelt-item/index.js";
import type { NavigationRuntime } from "../navigation/index.js";
import { craftingBot } from "../test-support/crafting.js";
import { observedFurnace } from "../test-support/furnace.js";
import { ActionRunner } from "./action-runner.js";

const navigation = { cancel: () => undefined } as unknown as NavigationRuntime;
const HUNGER = "[HUNGER] Ate cooked_beef at food 12.";
const NOTHING_EDIBLE = "[HUNGER] Nothing edible to eat.";
const SMELT_8 = { item_name: "raw_iron", count: 8, fuel_item_name: "stick", x: 2, y: 64, z: 0 };

type Continuation = { readonly kind: "resume" } | { readonly kind: "return"; readonly reason: string | null };

/** The fixture's cook, with a reflex claiming the body once the clock passes `at` (the hunger reflex: it always resumes). */
function smeltWithReflexAt(runner: ActionRunner, at: number, continuation: Continuation, duringReflex: () => void = () => undefined) {
  const fixture = observedFurnace({ cookMs: 10_000, raw: 8, coal: 40, fuel: "stick" });
  Object.assign(fixture.bot, { clearControlStates: () => undefined, deactivateItem: () => undefined, currentWindow: null, isSleeping: false });
  const loads: number[] = [];
  const putInput = fixture.furnace.putInput;
  fixture.furnace.putInput = async (type, metadata, count) => {
    loads.push(count);
    return putInput(type, metadata, count);
  };
  let claimed = false;
  const dependencies: SmeltItemDependencies = {
    ...fixture.dependencies,
    pause: async (milliseconds, signal) => {
      await fixture.dependencies.pause(milliseconds, signal);
      if (claimed || fixture.now < at) return;
      claimed = true;
      const claim = runner.claim("hunger_reflex", HUNGER, async () => {
        duringReflex();
        return { value: "ate", continuation };
      });
      assert.equal(claim.kind, "claimed");
    },
  };
  return { fixture, loads, action: createSmeltItemAction(fixture.bot, navigation, dependencies) };
}

test("a reflex that hands the body back resumes a smelt: one success covering the whole request, one interruption", async () => {
  const runner = new ActionRunner();
  const { fixture, loads, action } = smeltWithReflexAt(runner, 35_000, { kind: "resume" });

  const output = await runner.run(action, SMELT_8);

  assert.equal(output.result.status, "succeeded", "error" in output.result ? output.result.error : "");
  assert.equal("smelt" in output.result ? output.result.smelt.produced : -1, 8);
  assert.deepEqual(output.interruptions, [HUNGER]);
  assert.deepEqual(loads, [8, 5], "the second attempt loaded only what was left");
  assert.equal(fixture.bot.inventory.items().find((item) => item.name === "iron_ingot")?.count, 8);
  assert.deepEqual(runner.status(), { busy: false, activeAction: null, owner: "idle" });
});

test("a reflex that does not hand the body back ends the smelt with the interrupted result", async () => {
  const runner = new ActionRunner();
  const { fixture, loads, action } = smeltWithReflexAt(runner, 35_000, { kind: "return", reason: NOTHING_EDIBLE });

  const output = await runner.run(action, SMELT_8);

  assert.equal(output.result.status, "cancelled");
  assert.deepEqual(output.interruptions, [NOTHING_EDIBLE]);
  assert.deepEqual(loads, [8]);
  assert.equal(fixture.bot.inventory.items().find((item) => item.name === "raw_iron")?.count, 5, "the unsmelted input is back");
});

test("a model cancel while the reflex holds the body ends the smelt without a resume", async () => {
  const runner = new ActionRunner();
  const caller = new AbortController();
  const { loads, action } = smeltWithReflexAt(runner, 35_000, { kind: "resume" }, () =>
    caller.abort(new Error("model cancelled the smelt")),
  );

  const output = await runner.run(action, SMELT_8, caller.signal);

  assert.equal(output.result.status, "cancelled");
  assert.deepEqual(loads, [8]);
});

test("a reflex that hands the body back resumes a craft: the same one success, no recipe twice", async () => {
  const runner = new ActionRunner();
  const { bot, counts, craftCalls } = craftingBot({ oak_log: 2 });
  let claimed = false;
  const originalCraft = bot.craft.bind(bot);
  bot.craft = async (...argumentsValue) => {
    await originalCraft(...argumentsValue);
    if (claimed) return;
    claimed = true;
    assert.equal(runner.claim("hunger_reflex", HUNGER, async () => ({ value: "ate", continuation: { kind: "resume" as const } })).kind, "claimed");
  };
  Object.assign(bot, { entity: { position: new Vec3(0.5, 64, 0.5) } });

  const output = await runner.run(createCraftItemAction(bot, navigation), { items: [{ item_name: "oak_planks", count: 8 }] });

  assert.equal(output.result.status, "succeeded", "error" in output.result ? output.result.error : "");
  assert.deepEqual(output.interruptions, [HUNGER]);
  assert.deepEqual(craftCalls, ["oak_planks", "oak_planks"]);
  assert.equal(counts.get(bot.registry.itemsByName.oak_planks!.id), 8);
});

test("a reflex that does not hand the body back ends the craft with the interrupted result", async () => {
  const runner = new ActionRunner();
  const { bot, craftCalls } = craftingBot({ oak_log: 2 });
  let claimed = false;
  const originalCraft = bot.craft.bind(bot);
  bot.craft = async (...argumentsValue) => {
    await originalCraft(...argumentsValue);
    if (claimed) return;
    claimed = true;
    runner.claim("hunger_reflex", HUNGER, async () => ({ value: "ate", continuation: { kind: "return" as const, reason: NOTHING_EDIBLE } }));
  };
  Object.assign(bot, { entity: { position: new Vec3(0.5, 64, 0.5) } });

  const output = await runner.run(createCraftItemAction(bot, navigation), { items: [{ item_name: "oak_planks", count: 8 }] });

  assert.equal(output.result.status, "cancelled");
  assert.deepEqual(output.interruptions, [NOTHING_EDIBLE]);
  assert.deepEqual(craftCalls, ["oak_planks"]);
});
