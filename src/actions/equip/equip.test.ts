import assert from "node:assert/strict";
import test from "node:test";
import { botFixture, EQUIPMENT_SLOTS } from "../../test-support/bot.js";
import { beginEquip, formatEquipResult, equip } from "./equip.js";
import { inferEquipmentDestination, parseEquipRequest } from "./contract.js";

/** A bot whose equip moves the named item into the destination slot, or throws for one named item. */
function equipBot(carried: readonly string[], rejects: string | null = null) {
  const slots: Record<number, { name: string } | null> = {};
  const bot = botFixture(
    { items: carried.map((name) => ({ name, count: 1 })), slots },
    {
      quickBarSlot: 0,
      clickWindow: async (source: number, button: number, mode: number) => {
        assert.equal(mode, 2);
        const hotbar = 36 + button;
        [slots[source], slots[hotbar]] = [slots[hotbar] ?? null, slots[source] ?? null];
      },
      equip: async (item: { name: string }, destination: string) => {
        if (item.name === rejects) throw new Error("server refused");
        slots[EQUIPMENT_SLOTS[destination]!] = item;
        if (destination === "hand") bot.heldItem = item as never;
      },
    },
  );
  return bot;
}

test("infers armor, shield, and hand destinations from item names", () => {
  assert.equal(inferEquipmentDestination("iron_helmet"), "head");
  assert.equal(inferEquipmentDestination("diamond_chestplate"), "torso");
  assert.equal(inferEquipmentDestination("elytra"), "torso");
  assert.equal(inferEquipmentDestination("golden_leggings"), "legs");
  assert.equal(inferEquipmentDestination("netherite_boots"), "feet");
  assert.equal(inferEquipmentDestination("shield"), "off-hand");
  assert.equal(inferEquipmentDestination("iron_sword"), "hand");
  assert.deepEqual(
    parseEquipRequest({ items: [{ item_name: "Shield" }, { item_name: "torch", destination: "off-hand" }] }),
    {
      items: [
        { itemName: "shield", destination: "off-hand" },
        { itemName: "torch", destination: "off-hand" },
      ],
    },
  );
});

test("equips a full set and reports every slot afterwards", async () => {
  const bot = equipBot(["iron_helmet", "iron_chestplate", "shield", "iron_sword"]);
  const result = await equip(
    bot,
    parseEquipRequest({
      items: [
        { item_name: "iron_helmet" },
        { item_name: "iron_chestplate" },
        { item_name: "shield" },
        { item_name: "iron_sword" },
      ],
    }),
    {},
  );
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.equip.equipment, {
    hand: "iron_sword",
    offHand: "shield",
    head: "iron_helmet",
    torso: "iron_chestplate",
    legs: null,
    feet: null,
  });
  assert.match(formatEquipResult(result), /Now holding `iron_sword`; off-hand `shield`/);
});

test("reports each item that is not carried or was refused, and the rest as equipped", async () => {
  const bot = equipBot(["iron_sword", "shield"], "shield");
  const result = await equip(
    bot,
    parseEquipRequest({
      items: [{ item_name: "iron_sword" }, { item_name: "shield" }, { item_name: "iron_boots" }],
    }),
    {},
  );
  assert.equal(result.status, "partial");
  assert.match(result.error, /EQUIP_INCOMPLETE\] 2 of 3/);
  assert.deepEqual(
    result.equip.equipped.map((entry) => [entry.item, entry.equipped]),
    [
      ["iron_sword", true],
      ["shield", false],
      ["iron_boots", false],
    ],
  );
  assert.match(result.equip.equipped[1]!.error ?? "", /EQUIP_REJECTED/);
  assert.match(result.equip.equipped[2]!.error ?? "", /EQUIP_NOT_CARRIED/);
});

test("already equipped armor and shield succeed when absent from carried inventory", async () => {
  const bot = equipBot(["iron_helmet", "shield"]);
  const request = parseEquipRequest({ items: [{ item_name: "iron_helmet" }, { item_name: "shield" }] });
  await equip(bot, request, {});
  bot.inventory.items = () => [];
  bot.equip = async () => {
    throw new Error("already equipped items must not move");
  };
  const result = await equip(bot, request, {});
  assert.equal(result.status, "succeeded");
  assert.ok(result.equip.equipped.every((entry) => entry.equipped));
  assert.equal(result.equip.equipment.offHand, "shield");
});

test("an explicit source slot replaces a worn shield with the selected copy", async () => {
  const bot = equipBot(["shield"]);
  const worn = { name: "shield", durabilityUsed: 319 };
  const fresh = { name: "shield", durabilityUsed: 0 };
  bot.inventory.slots[45] = worn as never;
  bot.inventory.slots[24] = fresh as never;
  const result = await equip(bot, parseEquipRequest({ items: [{ item_name: "shield", source_slot: 24 }] }), {});
  assert.equal(result.status, "succeeded");
  assert.equal(bot.inventory.slots[45], fresh);
  assert.equal(result.equip.equipped[0]!.sourceSlot, 24);
  assert.equal(result.equip.equipped[0]!.durabilityUsed, 0);
});

test("a stale source slot refuses rather than choosing another matching shield", async () => {
  const bot = equipBot(["shield"]);
  bot.inventory.slots[24] = { name: "torch" } as never;
  const result = await equip(bot, parseEquipRequest({ items: [{ item_name: "shield", source_slot: 24 }] }), {});
  assert.equal(result.status, "failed");
  assert.match(result.equip.equipped[0]!.error!, /EQUIP_SOURCE_MISMATCH/);
  assert.equal(result.equip.equipment.offHand, null);
});

test("a matching name alone cannot confirm an explicitly selected item's equip", async () => {
  const bot = equipBot(["shield"]);
  bot.inventory.slots[45] = { name: "shield", durabilityUsed: 319 } as never;
  bot.inventory.slots[24] = { name: "shield", durabilityUsed: 0 } as never;
  bot.clickWindow = async () => {};
  const result = await equip(bot, parseEquipRequest({ items: [{ item_name: "shield", source_slot: 24 }] }), {});
  assert.equal(result.status, "failed");
  assert.match(result.equip.equipped[0]!.error!, /EQUIP_NOT_OBSERVED/);
  assert.throws(() => parseEquipRequest({ items: [{ item_name: "shield", source_slot: 0 }] }));
});

/** One request's attempts: `begin` once, then an executor call per attempt with its own signal. */
function equipAttempts(bot: ReturnType<typeof equipBot>, items: readonly object[]) {
  const run = beginEquip(bot, parseEquipRequest({ items }), () => {});
  return (signal?: AbortSignal) => run({ signal });
}

/** Aborts the request once the named item is equipped (a reflex took the body); returns the names equipped so far. */
function abortAfterEquipping(bot: ReturnType<typeof equipBot>, owner: AbortController, itemName: string): string[] {
  const equips: string[] = [];
  const equipSlot = bot.equip.bind(bot);
  bot.equip = (async (item: { name: string }, destination: string) => {
    equips.push(item.name);
    await equipSlot(item as never, destination as never);
    if (item.name === itemName) owner.abort(new Error("hunger reflex"));
  }) as typeof bot.equip;
  return equips;
}

test("an equip aborted after the helmet resumes with the rest and equips the helmet once", async () => {
  const bot = equipBot(["iron_helmet", "iron_chestplate"]);
  const owner = new AbortController();
  const equips = abortAfterEquipping(bot, owner, "iron_helmet");
  const attempt = equipAttempts(bot, [{ item_name: "iron_helmet" }, { item_name: "iron_chestplate" }]);

  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "succeeded");
  assert.deepEqual(equips, ["iron_helmet", "iron_chestplate"]);
  assert.deepEqual(result.equip.equipped.map((entry) => entry.item), ["iron_helmet", "iron_chestplate"]);
});

test("a source-slot swap finished before the abort is kept as done and not swapped back", async () => {
  const bot = equipBot(["shield"]);
  const worn = { name: "shield", durabilityUsed: 319 };
  const fresh = { name: "shield", durabilityUsed: 0 };
  bot.inventory.slots[45] = worn as never;
  bot.inventory.slots[24] = fresh as never;
  const owner = new AbortController();
  const click = bot.clickWindow.bind(bot);
  let clicks = 0;
  bot.clickWindow = async (...args: Parameters<typeof click>) => {
    await click(...args);
    clicks += 1;
    if (clicks === 3) owner.abort(new Error("fall reflex"));
  };
  const attempt = equipAttempts(bot, [{ item_name: "shield", source_slot: 24 }, { item_name: "iron_sword" }]);
  bot.inventory.items = () => [{ name: "iron_sword", count: 1 }] as never;

  await assert.rejects(attempt(owner.signal), /fall reflex/);
  const result = await attempt(new AbortController().signal);

  assert.equal(clicks, 3, "the resumed attempt must not click the shield again");
  assert.equal(bot.inventory.slots[45], fresh);
  assert.equal(result.equip.equipped[0]!.equipped, true);
  assert.equal(result.equip.equipped[0]!.sourceSlot, 24);
});

test("a source-slot swap whose abort came before it was observed is recognised in its destination", async () => {
  const bot = equipBot(["shield"]);
  const fresh = { name: "shield", durabilityUsed: 0 };
  bot.inventory.slots[24] = fresh as never;
  const owner = new AbortController();
  const click = bot.clickWindow.bind(bot);
  let clicks = 0;
  bot.clickWindow = async (...args: Parameters<typeof click>) => {
    await click(...args);
    clicks += 1;
    if (clicks === 2) { owner.abort(new Error("fall reflex")); throw owner.signal.reason; }
  };
  const attempt = equipAttempts(bot, [{ item_name: "shield", source_slot: 24 }]);

  await assert.rejects(attempt(owner.signal), /fall reflex/);
  const result = await attempt(new AbortController().signal);

  assert.equal(clicks, 3, "attempt 1 clicked three times (its hand restore included); the resumed attempt none");
  assert.equal(result.status, "succeeded");
  assert.equal(bot.inventory.slots[45], fresh);
});

test("armor taken off between attempts is equipped again from the inventory, or reported missing", async () => {
  const bot = equipBot(["iron_helmet", "iron_chestplate"]);
  const owner = new AbortController();
  abortAfterEquipping(bot, owner, "iron_helmet");
  const attempt = equipAttempts(bot, [{ item_name: "iron_helmet" }, { item_name: "iron_chestplate" }]);
  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  bot.inventory.slots[EQUIPMENT_SLOTS.head!] = null;
  bot.inventory.items = () => [{ name: "iron_chestplate", count: 1 }] as never;

  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "partial");
  assert.match(result.equip.equipped[0]!.error ?? "", /EQUIP_NOT_CARRIED/);
  assert.equal(result.equip.equipped[1]!.equipped, true);
});

test("a second call after a completed equip succeeds without touching the inventory", async () => {
  const bot = equipBot(["iron_sword"]);
  const attempt = equipAttempts(bot, [{ item_name: "iron_sword" }]);
  const first = await attempt();
  bot.equip = async () => { throw new Error("a finished equip must not move anything"); };

  const second = await attempt();

  assert.equal(first.status, "succeeded");
  assert.equal(second.status, "succeeded");
  assert.deepEqual(second.equip.equipped, first.equip.equipped);
});
