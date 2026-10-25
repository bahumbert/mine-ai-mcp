import assert from "node:assert/strict";
import test from "node:test";
import type { Item } from "prismarine-item";
import { type FakeBot, createFakeBot } from "../test-support/fake-bot/index.js";
import { WELL_FED, flatWorld, planningStart } from "../test-support/navigation.js";
import { createMovementCatalogue } from "../navigation/movements/catalogue.js";
import { createMovementPolicy } from "../navigation/movements/policy.js";
import { observeToolTierLoss } from "./tool-loss.js";

function select(bot: FakeBot, guard: ReturnType<typeof observeToolTierLoss>, item: string) {
  guard.select(bot.registry.itemsByName[item]!.id);
}

/** The server emptying a window slot, as a set_slot with no item does. */
function clearSlot(bot: FakeBot, slot: number): void {
  (bot.inventory.updateSlot as (slot: number, item: Item | null) => void).call(bot.inventory, slot, null);
}

test("stops only when a relevant best harvest capability drops", async () => {
  const { bot } = createFakeBot({ slots: { 36: { name: "diamond_pickaxe" }, 9: { name: "stone_pickaxe" }, 10: { name: "wooden_axe" } } });
  bot.inventory.slots[36]!.durabilityUsed = 1559;
  const guard = observeToolTierLoss(bot);
  select(bot, guard, "diamond_pickaxe");
  clearSlot(bot, 10); // unrelated axe loss
  await Promise.resolve();
  assert.equal(guard.loss(), null);
  clearSlot(bot, 36); // packet can skip the final one-durability observation
  await Promise.resolve();
  assert.equal(guard.signal.aborted, true);
  assert.equal(guard.loss()?.now.item, "stone_pickaxe");
  assert.match(guard.loss()?.reason ?? "", /diamond_pickaxe was lost.*stone pickaxe remains/);
  guard.close();
  assert.equal(bot.registry.itemsByName.diamond_pickaxe?.maxDurability, 1561);
});

test("gold replacement does not preserve stone harvest capability", async () => {
  const { bot } = createFakeBot({ slots: { 36: { name: "stone_pickaxe" }, 9: { name: "golden_pickaxe" } } });
  const guard = observeToolTierLoss(bot);
  select(bot, guard, "stone_pickaxe");
  clearSlot(bot, 36);
  await Promise.resolve();
  assert.equal(guard.loss()?.now.tier, "golden");
  guard.close();
});

test("material downgrade and loss of the last selected tool stop independently of harvest rank", async () => {
  for (const replacement of ["diamond_pickaxe", null] as const) {
    const { bot } = createFakeBot({ slots: { 36: { name: "netherite_pickaxe" }, 9: replacement && { name: replacement } } });
    const guard = observeToolTierLoss(bot);
    select(bot, guard, "netherite_pickaxe");
    clearSlot(bot, 36);
    await Promise.resolve();
    assert.equal(guard.signal.aborted, true);
    assert.equal(guard.loss()?.now.item, replacement);
    guard.close();
  }
});

test("a tool considered only by speculative search is not relevant", async () => {
  const { bot } = createFakeBot({ slots: { 36: { name: "diamond_pickaxe" }, 9: { name: "diamond_axe" } } });
  const guard = observeToolTierLoss(bot);
  const axe = bot.registry.itemsByName.diamond_axe!.id;
  const world = flatWorld();
  world.load({ x: 1, y: 63, z: 0 }, { stateId: 1, traits: { empty: false, safeToBreak: true } });
  const candidates = createMovementCatalogue().generate(planningStart({ x: 0, y: 63, z: 0 }, 0), {
    world,
    policy: createMovementPolicy({ priceBreak: () => ({ decision: { kind: "allowed" }, tool: { itemType: axe, expectedTicks: 1 } }) }),
    player: WELL_FED,
    stepField: null,
  }, { submergedAtEyes: false, onGround: true, aquaAffinity: false, effects: {} }).toArray();
  assert.equal(candidates.some((candidate) => candidate.step.operations.some(
    (operation) => operation.kind === "break" && operation.toolType === axe,
  )), true, "candidate generation must really consider the unused axe dig");
  // Only the route executor callback for its selected physical effect reaches the guard.
  guard.select(bot.registry.itemsByName.diamond_pickaxe!.id);
  clearSlot(bot, 9);
  await Promise.resolve();
  assert.equal(guard.loss(), null);
  guard.close();
});

test("a selected tool moving through Mineflayer's inventory cursor is not lost", async () => {
  const { bot } = createFakeBot({ slots: { 9: { name: "diamond_pickaxe" } } });
  const window = bot.inventory;
  const diamond = window.slots[9]!;
  const guard = observeToolTierLoss(bot);
  guard.select(bot.registry.itemsByName.diamond_pickaxe!.id);

  // Exercise the pinned prismarine-windows implementation: swapSelectedItem
  // emits updateSlot before it assigns selectedItem.
  const swapSelectedItem = Reflect.get(window, "swapSelectedItem") as (...args: unknown[]) => void;
  Reflect.apply(swapSelectedItem, window, [9, diamond]);
  await Promise.resolve();
  assert.equal(guard.loss(), null, "source-slot removal while the item is on the cursor is a transfer");

  Reflect.apply(swapSelectedItem, window, [36, null]);
  await Promise.resolve();
  assert.equal(guard.loss(), null, "destination-slot placement completes the normal equip");
  guard.close();
});
