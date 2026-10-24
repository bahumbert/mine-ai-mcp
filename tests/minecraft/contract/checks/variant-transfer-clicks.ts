/**
 * What a transfer between two variants of one item meets (1.21.4, 2026-10-23): a left click laying a plain hand on a
 * renamed partial stack swaps them (the server corrects the slot and the hand, `set_slot` then `set_cursor_item`), and so
 * does a right click laying a renamed hand on a plain partial stack (it never places one item on a stack of another
 * variant); a window closed with a stack in hand gives it back to the inventory's free slot (`set_slot` of that slot), and
 * to the ground as an item entity holding the stack when the inventory is full. Prismarine predicts both clicks as a merge
 * or a placed item, which is why our transfer places only onto an empty slot or a stack of the same variant. The client's
 * hand follows `set_cursor_item` here, as the transfer's own wait makes it (`watchClickAnswer`).
 */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import { holdsWithin, settleWithin } from "../subject.ts";
import { followServerCursor, recordWindowAnswers, variantStackOf, type WindowAnswer } from "../window-packets.ts";

const SERVER_ANSWER_MS = 1_000;
const OPEN_WALL_MS = 5_000;
const DROP_WALL_MS = 3_000;
/** The drop starts at the eye and falls in front of the bot: well inside this. */
const DROP_REACH = 4;
/** The chest's cell in the fixture's frame; `subject.world` moves it to the lane. */
const CHEST = [0, -60, 0] as const;
/** The chest's slots: renamed 5, plain 64 (full), plain 6 (partial), renamed "second" 3, and two empty ones (the check parks the hand on the second). */
const RENAMED_SLOT = 0;
const PLAIN_PARTIAL_SLOT = 2;
const SECOND_SLOT = 3;
const EMPTY_SLOT = 5;
const WATCHED = [0, 1, 2, 3, 4, 5] as const;
/** The inventory's last main slot, the only one left free by the 35 stacks the bot carries. */
const FREE_INVENTORY_SLOT = 35;
const RENAMED = (count: number) => `cobblestone x${count} "first"`;

/** 35 stacks of one item each: with the renamed stack that comes back, they fill the inventory's 36 slots. */
const FILLER = ["dirt", "sand", "gravel", "oak_log", "spruce_log", "birch_log", "jungle_log", "acacia_log", "dark_oak_log", "stick", "coal", "iron_ingot", "gold_ingot", "diamond", "emerald", "redstone", "lapis_lazuli", "bread", "apple", "carrot", "potato", "beetroot", "wheat", "sugar", "paper", "string", "feather", "flint", "bone", "leather", "clay_ball", "brick", "glowstone_dust", "snowball", "torch"];

type Seen = { readonly slots: readonly (string | null)[]; readonly cursor: string | null };
const CHEST_WINDOW_ID = 1;
const PLAYER_WINDOW_ID = 0;
const slotAnswer = (windowId: number, slot: number, stack: string | null): WindowAnswer => ({ name: "set_slot", windowId, slot, stack });
const cursorAnswer = (stack: string | null): WindowAnswer => ({ name: "set_cursor_item", stack });

export const variantTransferClicks: ContractCheck = {
  name: "variant-transfer-clicks",
  // Bare bot: our runtime manages windows and would act on these.
  withoutRuntime: true,
  fixture: {
    cells: { "0,-60,0": "chest" },
    carried: Object.fromEntries(FILLER.map((name) => [name, 1])),
    containers: { "0,-60,0": { renamed_first_cobblestone: 5, cobblestone: 70, renamed_second_cobblestone: 3 } },
    position: [-4.5, -60, 0.5],
  },
  async run(subject) {
    const { bot, wait } = subject;
    const open = async () => {
      const opened = await settleWithin(subject, bot.openContainer(bot.blockAt(subject.world(CHEST))!), OPEN_WALL_MS);
      assert.ok(opened?.value !== undefined, `the chest opened: ${opened?.error?.message ?? "never"}`);
      return opened.value;
    };
    const drops: Entity[] = [];
    const onSpawn = (entity: Entity) => void (entity.name === "item" && drops.push(entity));
    bot.on("entitySpawn", onSpawn);
    const window = await open();
    const recording = recordWindowAnswers(bot);
    const stopFollowing = followServerCursor(bot, window);
    const seen = (): Seen => ({ slots: WATCHED.map((slot) => variantStackOf(window.slots[slot])), cursor: variantStackOf(window.selectedItem) });
    const click = async (slot: number, mouseButton: number, answered: readonly WindowAnswer[]) => {
      await bot.clickWindow(slot, mouseButton, 0);
      const predicted = seen();
      await wait(SERVER_ANSWER_MS);
      assert.deepEqual(recording.answers.splice(0), answered, `the answer to the click on slot ${slot} (button ${mouseButton})`);
      return predicted;
    };

    assert.deepEqual(seen(), { slots: [RENAMED(5), "cobblestone x64", "cobblestone x6", 'cobblestone x3 "second"', null, null], cursor: null });
    await click(PLAIN_PARTIAL_SLOT, 0, []);
    const merged = await click(RENAMED_SLOT, 0, [slotAnswer(CHEST_WINDOW_ID, RENAMED_SLOT, "cobblestone x6"), cursorAnswer(RENAMED(5))]);
    assert.deepEqual(merged.slots[RENAMED_SLOT], 'cobblestone x11 "first"', "Prismarine predicts the plain hand merged into the renamed stack: nbt is null on both");
    assert.deepEqual(seen(), { slots: ["cobblestone x6", "cobblestone x64", null, 'cobblestone x3 "second"', null, null], cursor: RENAMED(5) }, "the server swapped: the plain 6 lies in the slot, the renamed 5 is in hand");

    const placed = await click(RENAMED_SLOT, 1, [slotAnswer(CHEST_WINDOW_ID, RENAMED_SLOT, RENAMED(5)), cursorAnswer("cobblestone x6")]);
    assert.deepEqual([placed.slots[RENAMED_SLOT], placed.cursor], ["cobblestone x7", RENAMED(4)], "Prismarine predicts one renamed item put on the plain stack");
    assert.deepEqual(seen(), { slots: [RENAMED(5), "cobblestone x64", null, 'cobblestone x3 "second"', null, null], cursor: "cobblestone x6" }, "the server swapped again: nothing was put down");

    await click(EMPTY_SLOT, 0, []);
    await click(RENAMED_SLOT, 0, []);
    assert.deepEqual(seen().cursor, RENAMED(5), "the renamed stack is in hand again, both sides agree");

    stopFollowing();
    window.close();
    await wait(SERVER_ANSWER_MS);
    assert.equal(bot.currentWindow, null);
    assert.deepEqual(recording.answers.splice(0), [slotAnswer(PLAYER_WINDOW_ID, FREE_INVENTORY_SLOT, RENAMED(5))], "the close gave the stack in hand to the inventory's free slot");
    assert.equal(variantStackOf(bot.inventory.slots[FREE_INVENTORY_SLOT]), RENAMED(5));
    assert.equal(bot.inventory.items().length, FILLER.length + 1, "36 stacks now: the inventory is full");
    assert.equal(drops.length, 0, "nothing was dropped while a slot was free");

    const again = await open();
    const stopAgain = followServerCursor(bot, again);
    await bot.clickWindow(SECOND_SLOT, 0, 0);
    await wait(SERVER_ANSWER_MS);
    recording.answers.splice(0);
    stopAgain();
    again.close();
    const live = () => drops.filter((entity) => bot.entities[entity.id] === entity && entity.position.distanceTo(bot.entity.position) <= DROP_REACH);
    const droppedStack = () => live().map((entity) => variantStackOf(entity.getDroppedItem()));
    assert.ok(await holdsWithin(subject, () => droppedStack().length > 0, DROP_WALL_MS), `an item entity near the bot within ${DROP_WALL_MS} ms`);
    assert.deepEqual(droppedStack(), ['cobblestone x3 "second"'], "the stack in hand fell to the ground as one item entity, renamed as it was");
    assert.equal(bot.inventory.items().length, FILLER.length + 1, "the full inventory took nothing");
    assert.deepEqual(recording.answers.splice(0), [], "no slot was corrected");
    bot.off("entitySpawn", onSpawn);
    recording.stop();
  },
};
