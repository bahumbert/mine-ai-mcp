import assert from "node:assert/strict";
import test from "node:test";
import type { Item } from "prismarine-item";
import { type FakeBot, createFakeBot, itemOf } from "../../test-support/fake-bot/index.js";
import { beginEquip, formatEquipResult, equip } from "./equip.js";
import { inferEquipmentDestination, parseEquipRequest } from "./contract.js";

const HEAD = 5;
const OFF_HAND = 45;

/** Put `item` in a window slot, or empty it, as the server's set_slot does. */
function setSlot(bot: FakeBot, slot: number, item: Item | null): void {
  (bot.inventory.updateSlot as (slot: number, item: Item | null) => void).call(bot.inventory, slot, item);
}

/** The name of what `bot.equip` is handed: an item, or an item type id. */
function equippedName(bot: FakeBot, item: Item | number): string | undefined {
  return typeof item === "number" ? bot.registry.items[item]?.name : item.name;
}

/** A shield with its durability used, in the stack the server sends. */
function shieldWorn(bot: FakeBot, durabilityUsed: number): Item {
  const shield = itemOf(bot.registry, "shield");
  shield.durabilityUsed = durabilityUsed;
  return shield;
}

/**
 * A bot carrying `carried` in its main inventory, hand empty. Its `clickWindow` answers a number-key click (mode 2) as the
 * server does, swapping the clicked slot with hotbar slot `button`; its equip throws for the one item named in `rejects`.
 */
function equipBot(carried: readonly string[], rejects: string | null = null) {
  const { bot } = createFakeBot({ slots: Object.fromEntries(carried.map((name, index) => [9 + index, { name }])) });
  // Stopgap until the master adds the server's answer to a window click: the fake has no `clickWindow` (Mineflayer `inventory.js` `clickWindow`).
  bot.clickWindow = async (source, button, mode) => {
    assert.equal(mode, 2);
    const hotbar = 36 + button;
    const [moving, other] = [bot.inventory.slots[source] ?? null, bot.inventory.slots[hotbar] ?? null];
    setSlot(bot, source, other);
    setSlot(bot, hotbar, moving);
  };
  const equipOwn = bot.equip.bind(bot);
  bot.equip = async (item, destination) => {
    if (equippedName(bot, item) === rejects) throw new Error("server refused");
    await equipOwn(item, destination);
  };
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
  assert.deepEqual(bot.inventory.items(), [], "worn, the armor and the shield are out of the inventory's carried slots");
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
  const worn = shieldWorn(bot, 319);
  const fresh = shieldWorn(bot, 0);
  setSlot(bot, OFF_HAND, worn);
  setSlot(bot, 24, fresh);
  const result = await equip(bot, parseEquipRequest({ items: [{ item_name: "shield", source_slot: 24 }] }), {});
  assert.equal(result.status, "succeeded");
  assert.equal(bot.inventory.slots[OFF_HAND], fresh);
  assert.equal(result.equip.equipped[0]!.sourceSlot, 24);
  assert.equal(result.equip.equipped[0]!.durabilityUsed, 0);
});

test("a stale source slot refuses rather than choosing another matching shield", async () => {
  const bot = equipBot(["shield"]);
  setSlot(bot, 24, itemOf(bot.registry, "torch"));
  const result = await equip(bot, parseEquipRequest({ items: [{ item_name: "shield", source_slot: 24 }] }), {});
  assert.equal(result.status, "failed");
  assert.match(result.equip.equipped[0]!.error!, /EQUIP_SOURCE_MISMATCH/);
  assert.equal(result.equip.equipment.offHand, null);
});

test("a matching name alone cannot confirm an explicitly selected item's equip", async () => {
  const bot = equipBot(["shield"]);
  setSlot(bot, OFF_HAND, shieldWorn(bot, 319));
  setSlot(bot, 24, shieldWorn(bot, 0));
  bot.clickWindow = async () => {};
  const result = await equip(bot, parseEquipRequest({ items: [{ item_name: "shield", source_slot: 24 }] }), {});
  assert.equal(result.status, "failed");
  assert.match(result.equip.equipped[0]!.error!, /EQUIP_NOT_OBSERVED/);
  assert.throws(() => parseEquipRequest({ items: [{ item_name: "shield", source_slot: 0 }] }));
});

/** One request's attempts: `begin` once, then an executor call per attempt with its own signal. */
function equipAttempts(bot: FakeBot, items: readonly object[]) {
  const run = beginEquip(bot, parseEquipRequest({ items }), () => {});
  return (signal?: AbortSignal) => run({ signal });
}

/** Aborts the request once the named item is equipped (a reflex took the body); returns the names equipped so far. */
function abortAfterEquipping(bot: FakeBot, owner: AbortController, itemName: string): string[] {
  const equips: string[] = [];
  const equipSlot = bot.equip.bind(bot);
  bot.equip = async (item, destination) => {
    const name = equippedName(bot, item);
    equips.push(name!);
    await equipSlot(item, destination);
    if (name === itemName) owner.abort(new Error("hunger reflex"));
  };
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
  const bot = equipBot(["iron_sword"]);
  const worn = shieldWorn(bot, 319);
  const fresh = shieldWorn(bot, 0);
  setSlot(bot, OFF_HAND, worn);
  setSlot(bot, 24, fresh);
  const owner = new AbortController();
  const click = bot.clickWindow.bind(bot);
  let clicks = 0;
  bot.clickWindow = async (...args: Parameters<typeof click>) => {
    await click(...args);
    clicks += 1;
    if (clicks === 3) owner.abort(new Error("fall reflex"));
  };
  const attempt = equipAttempts(bot, [{ item_name: "shield", source_slot: 24 }, { item_name: "iron_sword" }]);

  await assert.rejects(attempt(owner.signal), /fall reflex/);
  const result = await attempt(new AbortController().signal);

  assert.equal(clicks, 3, "the resumed attempt must not click the shield again");
  assert.equal(bot.inventory.slots[OFF_HAND], fresh);
  assert.equal(result.equip.equipped[0]!.equipped, true);
  assert.equal(result.equip.equipped[0]!.sourceSlot, 24);
});

test("a source-slot swap whose abort came before it was observed is recognised in its destination", async () => {
  const bot = equipBot(["shield"]);
  const fresh = shieldWorn(bot, 0);
  setSlot(bot, 24, fresh);
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
  assert.equal(bot.inventory.slots[OFF_HAND], fresh);
});

test("armor taken off between attempts is equipped again from the inventory, or reported missing", async () => {
  const bot = equipBot(["iron_helmet", "iron_chestplate"]);
  const owner = new AbortController();
  abortAfterEquipping(bot, owner, "iron_helmet");
  const attempt = equipAttempts(bot, [{ item_name: "iron_helmet" }, { item_name: "iron_chestplate" }]);
  await assert.rejects(attempt(owner.signal), /hunger reflex/);
  setSlot(bot, HEAD, null);

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

/** Aborts the request on the first click, before the server could have seen it (a reflex took the body). */
function abortBeforeFirstClick(bot: FakeBot, owner: AbortController) {
  const click = bot.clickWindow.bind(bot);
  const clicked: number[] = [];
  let aborted = false;
  bot.clickWindow = async (...args: Parameters<typeof click>) => {
    if (!aborted) { aborted = true; owner.abort(new Error("fall reflex")); throw owner.signal.reason; }
    clicked.push(args[0]);
    await click(...args);
  };
  return clicked;
}

test("an identical item worn before the request does not mark an unsent swap done", async () => {
  const bot = equipBot(["shield"]);
  const worn = shieldWorn(bot, 0);
  const selected = shieldWorn(bot, 0);
  setSlot(bot, OFF_HAND, worn);
  setSlot(bot, 24, selected);
  const owner = new AbortController();
  const clicked = abortBeforeFirstClick(bot, owner);
  const attempt = equipAttempts(bot, [{ item_name: "shield", source_slot: 24 }]);

  await assert.rejects(attempt(owner.signal), /fall reflex/);
  const result = await attempt(new AbortController().signal);

  assert.equal(clicked.length, 3, "the resumed attempt makes the swap the first one never sent");
  assert.equal(bot.inventory.slots[OFF_HAND], selected);
  assert.equal(bot.inventory.slots[24], worn);
  assert.equal(result.status, "succeeded");
});

test("a swap of two identical items finished before the abort ends succeeded with both items in place", async () => {
  const bot = equipBot(["shield"]);
  const worn = shieldWorn(bot, 0);
  const selected = shieldWorn(bot, 0);
  setSlot(bot, OFF_HAND, worn);
  setSlot(bot, 24, selected);
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

  assert.equal(result.status, "succeeded");
  assert.equal(result.equip.equipped[0]!.equipped, true);
  assert.equal((bot.inventory.slots[OFF_HAND] as { name: string } | null)?.name, "shield");
  assert.equal((bot.inventory.slots[24] as { name: string } | null)?.name, "shield", "equal items swapped twice are where they were: neither is lost");
});

test("a death between attempts reports the items not carried", async () => {
  const bot = equipBot(["iron_helmet"]);
  const worn = shieldWorn(bot, 319);
  const fresh = shieldWorn(bot, 0);
  setSlot(bot, OFF_HAND, worn);
  setSlot(bot, 24, fresh);
  const owner = new AbortController();
  const click = bot.clickWindow.bind(bot);
  let clicks = 0;
  bot.clickWindow = async (...args: Parameters<typeof click>) => {
    await click(...args);
    clicks += 1;
    if (clicks === 3) owner.abort(new Error("lava reflex"));
  };
  const attempt = equipAttempts(bot, [{ item_name: "shield", source_slot: 24 }, { item_name: "iron_helmet" }]);
  await assert.rejects(attempt(owner.signal), /lava reflex/);

  for (const [index, stack] of bot.inventory.slots.entries()) if (stack) setSlot(bot, index, null);
  const result = await attempt(new AbortController().signal);

  assert.equal(result.status, "failed");
  assert.deepEqual(result.equip.equipped.map((entry) => entry.equipped), [false, false]);
  assert.match(result.equip.equipped[0]!.error ?? "", /EQUIP_SOURCE_MISMATCH/);
  assert.match(result.equip.equipped[1]!.error ?? "", /EQUIP_NOT_CARRIED/);
  assert.deepEqual(result.equip.equipment, { hand: null, offHand: null, head: null, torso: null, legs: null, feet: null });
});

test("two equip requests on two bots keep their own swaps", async () => {
  const bots = [equipBot(["shield"]), equipBot(["shield"])];
  const copies = bots.map((bot, index) => {
    const fresh = shieldWorn(bot, index);
    setSlot(bot, OFF_HAND, shieldWorn(bot, 300));
    setSlot(bot, 24, fresh);
    return fresh;
  });
  const owners = bots.map(() => new AbortController());
  const clicksSeen = bots.map((bot, index) => {
    const click = bot.clickWindow.bind(bot);
    const seen = { clicks: 0 };
    bot.clickWindow = async (...args: Parameters<typeof click>) => {
      await click(...args);
      seen.clicks += 1;
      if (seen.clicks === 2) { owners[index]!.abort(new Error("fall reflex")); throw owners[index]!.signal.reason; }
    };
    return seen;
  });
  const attempts = bots.map((bot) => equipAttempts(bot, [{ item_name: "shield", source_slot: 24 }]));

  await Promise.all(attempts.map((attempt, index) => assert.rejects(attempt(owners[index]!.signal), /fall reflex/)));
  const results = await Promise.all(attempts.map((attempt) => attempt(new AbortController().signal)));

  for (const [index, bot] of bots.entries()) {
    assert.equal(results[index]!.status, "succeeded");
    assert.equal(bot.inventory.slots[OFF_HAND], copies[index], "each bot wears the copy it selected");
    assert.equal(clicksSeen[index]!.clicks, 3);
  }
});
