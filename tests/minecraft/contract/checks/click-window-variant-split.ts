/**
 * The other clicks on a renamed stack, as Mineflayer predicts them (Prismarine rebuilds a split half or a put-down item
 * from `new Item(type, n, metadata, nbt)`, dropping the components; a merge or a shift goes by `nbt`) and the server
 * answers them (1.21.4, 2026-10-23): a right click that splits the stack, one that puts one item on an empty slot, a left
 * click that lays the cursor on a stack of its own variant, and a shift click toward a plain partial stack of the same item.
 * The server's halves and put-downs stay renamed and its shift click never joins the plain stack; it corrects the cursor
 * with `set_cursor_item` and each wrong slot with `set_slot`, and says nothing when the prediction was right.
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { answerSettled, serverQuiet } from "../server-answer.ts";
import { settleWithin } from "../subject.ts";
import { recordWindowPackets, variantStackOf, type WindowPacket } from "../window-packets.ts";

const OPEN_WALL_MS = 5_000;
/** The chest's cell in the fixture's frame; `subject.world` moves it to the lane. */
const CHEST = [0, -60, 0] as const;
const WINDOW_ID = 1;
const CURSOR_ID = -1;
/** The chest's first slot, an empty one, the player's hotbar slot 0 as the window numbers it (54) and the window's last slot. */
const STACK_SLOT = 0;
const EMPTY_SLOT = 4;
const PLAIN_SLOT = 54;
const LAST_SLOT = 62;
const WATCHED = [STACK_SLOT, EMPTY_SLOT, PLAIN_SLOT, LAST_SLOT] as const;

type Seen = Readonly<Record<number | "cursor", string | null>>;
const RENAMED = (count: number) => `cobblestone x${count} "first"`;
const slotPacket = (slot: number): WindowPacket => ({ name: "set_slot", windowId: WINDOW_ID, slot });
const CURSOR_PACKET: WindowPacket = { name: "set_cursor_item", windowId: CURSOR_ID };

/** What the client reads right after a click (the prediction), after the server answered, and the packets of the answer. */
interface Step {
  readonly label: string;
  readonly click: readonly [slot: number, mouseButton: number, mode: number];
  readonly predicted: Seen;
  readonly answered: Seen;
  readonly packets: readonly WindowPacket[];
}

const STEPS: readonly Step[] = [
  {
    label: "a right click on the renamed 5 splits it: the client's hand holds plain 3, the server's renamed 3",
    click: [STACK_SLOT, 1, 0],
    predicted: { 0: RENAMED(2), 4: null, 54: "cobblestone x10", 62: null, cursor: "cobblestone x3" },
    answered: { 0: RENAMED(2), 4: null, 54: "cobblestone x10", 62: null, cursor: "cobblestone x3" },
    packets: [CURSOR_PACKET],
  },
  {
    label: "a right click on an empty slot puts one item there: plain on the client, renamed on the server, whose hand is renamed 2",
    click: [EMPTY_SLOT, 1, 0],
    predicted: { 0: RENAMED(2), 4: "cobblestone x1", 54: "cobblestone x10", 62: null, cursor: "cobblestone x2" },
    answered: { 0: RENAMED(2), 4: RENAMED(1), 54: "cobblestone x10", 62: null, cursor: "cobblestone x2" },
    packets: [slotPacket(EMPTY_SLOT), CURSOR_PACKET],
  },
  {
    label: "a left click lays the hand on the renamed 2: both sides merge them and nothing is sent",
    click: [STACK_SLOT, 0, 0],
    predicted: { 0: RENAMED(4), 4: RENAMED(1), 54: "cobblestone x10", 62: null, cursor: null },
    answered: { 0: RENAMED(4), 4: RENAMED(1), 54: "cobblestone x10", 62: null, cursor: null },
    packets: [],
  },
  {
    label: "a shift click on the renamed 4 joins the plain 10 in Prismarine's prediction; the server puts it in the window's last slot and corrects both slots",
    click: [STACK_SLOT, 0, 1],
    predicted: { 0: null, 4: RENAMED(1), 54: "cobblestone x14", 62: null, cursor: null },
    answered: { 0: null, 4: RENAMED(1), 54: "cobblestone x10", 62: RENAMED(4), cursor: null },
    packets: [slotPacket(PLAIN_SLOT), slotPacket(LAST_SLOT)],
  },
];

export const clickWindowVariantSplit: ContractCheck = {
  name: "click-window-variant-split",
  // Bare bot: our runtime manages windows and would act on this one.
  withoutRuntime: true,
  fixture: {
    cells: { "0,-60,0": "chest" },
    carried: { cobblestone: 10 },
    containers: { "0,-60,0": { renamed_first_cobblestone: 5 } },
    position: [-4.5, -60, 0.5],
  },
  async run(subject) {
    const { bot } = subject;
    const opened = await settleWithin(subject, bot.openContainer(bot.blockAt(subject.world(CHEST))!), OPEN_WALL_MS);
    assert.ok(opened?.value !== undefined, `the chest opened: ${opened?.error?.message ?? "never"}`);
    const window = opened.value;
    const recording = recordWindowPackets(bot);
    const seen = (): Seen => ({ ...Object.fromEntries(WATCHED.map((slot) => [slot, variantStackOf(window.slots[slot])])), cursor: variantStackOf(window.selectedItem) });
    for (const { label, click, predicted, answered, packets } of STEPS) {
      await bot.clickWindow(...click);
      assert.deepEqual(seen(), predicted, `${label}: as predicted`);
      // A step the server answers waits for its packets; one it agrees with sends none, so the wait is for server ticks.
      if (packets.length > 0) await answerSettled(subject, () => recording.packets.length >= packets.length, `${label}: the packets of the answer`);
      else await serverQuiet(subject, label);
      assert.deepEqual(seen(), answered, `${label}: once the server answered`);
      assert.deepEqual(recording.packets.splice(0), packets, `${label}: the packets of the answer`);
    }
    recording.stop();
    window.close();
  },
};
