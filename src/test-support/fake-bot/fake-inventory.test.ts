import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import { createFakeInventory } from "./fake-inventory.js";

const registry = minecraftData("1.21.4");
const id = (name: string) => registry.itemsByName[name]!.id;

/** What `items()` must equal: the non-empty slots 9-44, as Prismarine's window reads them. */
function filledSlots(inventory: ReturnType<typeof createFakeInventory>) {
  return inventory.slots.slice(9, 45).filter((item) => item !== null);
}

test("a carried 70 of one block fills two slots, 64 then 6, from the hotbar on", () => {
  const inventory = createFakeInventory(registry, { carried: { cobblestone: 70 } });
  assert.equal(inventory.slots[36]!.count, 64);
  assert.equal(inventory.slots[37]!.count, 6);
  assert.equal(inventory.count(id("cobblestone"), null), 70);
  assert.deepEqual(inventory.items(), filledSlots(inventory));
  assert.equal(inventory.emptySlotCount(), 34);
});

test("carried stacks fill the hotbar 36-44 first, then the main slots 9-35, split at each item's stack size", () => {
  const inventory = createFakeInventory(registry, { carried: { cobblestone: 64 * 9, ender_pearl: 20 } });
  assert.equal(inventory.slots[44]!.name, "cobblestone");
  assert.equal(inventory.slots[9]!.name, "ender_pearl");
  assert.equal(inventory.slots[9]!.count, registry.itemsByName.ender_pearl!.stackSize);
  assert.equal(inventory.slots[10]!.count, 20 - registry.itemsByName.ender_pearl!.stackSize);
});

test("items() equals the non-empty slots 9-44 after an equip and a toss", async () => {
  const inventory = createFakeInventory(registry, {
    slots: { 5: { name: "iron_helmet" }, 20: { name: "stone_pickaxe" } },
    carried: { cobblestone: 70 },
  });
  await inventory.equip(inventory.slots[20]!, "hand");
  inventory.toss(id("cobblestone"), 10);
  assert.deepEqual(inventory.items(), filledSlots(inventory));
  assert.equal(inventory.count(id("cobblestone"), null), 60);
  assert.ok(!inventory.items().some((item) => item.name === "iron_helmet"), "armour is not in items()");
});

test("heldItem follows quickBarSlot", () => {
  const inventory = createFakeInventory(registry, { slots: { 36: { name: "oak_log", count: 3 }, 38: { name: "torch" } } });
  assert.equal(inventory.heldItem!.name, "oak_log");
  inventory.setQuickBarSlot(2);
  assert.equal(inventory.heldItem!.name, "torch");
  inventory.setQuickBarSlot(1);
  assert.equal(inventory.heldItem, null);
});

test("equip into the hand from the main slots moves the stack to an empty hotbar slot and selects it", async () => {
  const inventory = createFakeInventory(registry, { slots: { 36: { name: "dirt" }, 20: { name: "stone_pickaxe" } } });
  const changes: (string | null)[] = [];
  inventory.onHeldItemChanged((item) => changes.push(item?.name ?? null));
  await inventory.equip(inventory.slots[20]!, "hand");
  assert.equal(inventory.quickBarSlot, 1);
  assert.equal(inventory.slots[37]!.name, "stone_pickaxe");
  assert.equal(inventory.slots[20], null);
  assert.equal(inventory.heldItem!.name, "stone_pickaxe");
  assert.equal(changes.at(-1), "stone_pickaxe");
});

test("equip to the off hand moves the stack to slot 45", async () => {
  const inventory = createFakeInventory(registry, { slots: { 36: { name: "shield" } } });
  await inventory.equip(inventory.slots[36]!, "off-hand");
  assert.equal(inventory.slots[45]!.name, "shield");
  assert.equal(inventory.slots[36], null);
});

test("equip of a missing item throws Mineflayer's error", async () => {
  const inventory = createFakeInventory(registry);
  await assert.rejects(inventory.equip(null, "hand"), /Invalid item object in equip/);
});

// Mineflayer's `transfer` to -999 (`inventory.js:363-367`) drops a whole slot with one left click and a part of one with
// a right click per item; the server spawned 3 drops for a toss of 3 (Mine Labs 2026-10-21, toss-count-and-entity).
test("a toss lowers the slot at once and announces it: a whole slot is one drop, a part of one is a drop per item", () => {
  const inventory = createFakeInventory(registry, { carried: { cobblestone: 70 } });
  const updated: number[] = [];
  inventory.on("updateSlot", (slot: number) => updated.push(slot));
  const tossed = inventory.toss(id("cobblestone"), 66);
  assert.equal(inventory.count(id("cobblestone"), null), 4);
  assert.deepEqual(tossed, [{ type: id("cobblestone"), count: 64 }, { type: id("cobblestone"), count: 1 }, { type: id("cobblestone"), count: 1 }]);
  assert.deepEqual(updated, [36, 37]);
});

test("a carried item unknown to the registry throws naming it", () => {
  assert.throws(() => createFakeInventory(registry, { carried: { cobblestnoe: 1 } }), /cobblestnoe/);
  assert.throws(() => createFakeInventory(registry, { slots: { 36: { name: "pickaxe" } } }), /pickaxe/);
});

test("more carried than 36 slots hold throws, instead of dropping the rest", () => {
  assert.throws(() => createFakeInventory(registry, { carried: { cobblestone: 64 * 37 } }), /room/);
});
