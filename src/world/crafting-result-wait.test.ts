/**
 * A craft takes its result only once the server has answered every click and slot 0 holds the recipe's result
 * (`patches/mineflayer@...patch`, `craft.js` `settled` and `grabResult`). Mineflayer's own `inventory.js`, `chat.js` and
 * `craft.js` run on a scratch bot; the server is a script of the `set_slot` / `window_items` packets logged through a
 * complete craft in Mine Labs 1.21.4, `window_click` by `window_click` (probe `~/mcp/p4-32-t2-logs/probe-src/zzprobe-craft.ts`,
 * logs in `~/mcp/p4-32-t2-logs/`, 2026-11-15; a reply's delay is the log's gap in ms after the click):
 *   - vanilla (`vanilla-probe.log`, `vanilla-table.log`): one packet per change; slot 0 is
 *     answered after each grid click with the result of what the grid then holds, and once more per ingredient taken;
 *   - Paper 1.21.4 build 232 (`paper-craft-final.log`, `paper-table-final.log`; before the patch `paper-probe.log`):
 *     slot 0 is first sent EMPTY after the first grid click, and each click is answered by several packets with a new
 *     stateId each (planks: st12, st13, st14 `set_slot` then st15 `window_items` after the take). `clickWindow` returns on
 *     the first one (`inventory.js:519-538`), so the unpatched craft read an empty slot 0 ("Server did not supply the
 *     expected crafting result") or wrote its next click with a stateId the server had moved past: the server ignores
 *     such a click and the client's model drifts (`paper-between.log`: the second application of planks failed).
 * The scratch server answers a `tab_complete` after every packet it had queued, as the real one does (it handles packets
 * in order, `chat.js:148`), and the scene refuses a click written while answers to earlier clicks are on their way.
 * What the tests hold: the craft completes and no click is written on a stale stateId. The client's inventory against
 * the server's is checked live (workshop on Paper, `zz-between` probes), not here.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { createFakeClock } from "../test-support/fake-bot/index.js";

const require = createRequire(import.meta.url);
const MC_VERSION = "1.21.4";
const registry = require("prismarine-registry")(MC_VERSION);
const Item = require("prismarine-item")(registry);
type Plugin = (bot: object, options: { hideErrors: boolean }) => void;
type Recipe = unknown;
interface ClickWrite {
  slot: number;
  mouseButton: number;
  stateId: number;
}
type StackNotch = unknown;
interface CraftApi {
  craft(recipe: Recipe, count: number): Promise<void>;
  recipesFor(itemType: number, metadata: null, minResultCount: number, craftingTable: null): Recipe[];
  inventory: { count(itemType: number, metadata: null): number };
}
type Stack = readonly [name: string, count: number];

/** The server's packets after one `window_click`, in order, each `delayMs` after the click was written. */
interface Reply {
  delayMs: number;
  packet: "set_slot" | "window_items";
  stateId: number;
  /** `set_slot`: the slot; `window_items`: unused. */
  slot?: number;
  /** `set_slot`: the slot's item (none = empty). */
  item?: Stack;
  /** `window_items`: every non-empty slot. */
  contents?: Readonly<Record<number, Stack>>;
  /** `window_items`: the server's cursor stack (`carriedItem`); the client takes it as its own. */
  cursor?: Stack;
  /** Not measured on any server: the packet is sent in a later tick than the one that answers a `tab_complete`, so the round trip does not cover it. */
  afterTheRoundTrip?: boolean;
}
interface SceneOptions {
  /** false: the server never answers a `tab_complete` (a plugin that blocks it, a proxy); the scene still counts them. */
  answersTabComplete: boolean;
}
interface ClickStep {
  expect: Pick<ClickWrite, "slot" | "mouseButton">;
  replies: readonly Reply[];
}

const WINDOW_SLOT_COUNT = 46;
const notch = (item?: Stack): StackNotch => Item.toNotch(item === undefined ? null : new Item(registry.itemsByName[item[0]].id, item[1]));

const setSlot = (stateId: number, slot: number, item?: Stack, delayMs = 0): Reply => ({ delayMs, packet: "set_slot", stateId, slot, item });
const windowItems = (stateId: number, contents: Reply["contents"], cursor?: Stack, delayMs = 0): Reply => ({ delayMs, packet: "window_items", stateId, contents, cursor });
const click = (slot: number, mouseButton: number, ...replies: Reply[]): ClickStep => ({ expect: { slot, mouseButton }, replies });

// Stopgap until the master adds a crafting-click contract check on the shared fake and real server: the shared window
// server does not produce the crafting result and its ordered slot-0 / tab_complete answers (probe logs above, 2026-11-15).
/** Mineflayer's inventory and craft plugins on a scratch bot whose server is `script`; the bot starts with `carried`. */
function craftingScene(carried: Readonly<Record<number, Stack>>, script: readonly ClickStep[], options: SceneOptions) {
  const client = Object.assign(new EventEmitter(), {
    write(name: string, payload: ClickWrite) {
      if (name === "tab_complete") {
        tabCompletes += 1;
        if (options.answersTabComplete) answerAfterEverythingSent();
        return;
      }
      if (name !== "window_click") return;
      const step = script[clicks.length];
      assert.ok(step, `the client wrote a click beyond the logged ${script.length}: slot ${payload.slot} button ${payload.mouseButton}`);
      assert.deepEqual({ slot: payload.slot, mouseButton: payload.mouseButton }, { slot: step.expect.slot, mouseButton: step.expect.mouseButton }, `click #${clicks.length} differs from the logged one`);
      // The click carries the last stateId received. One written while answers to the earlier clicks are still to come is
      // one the server ignores (it is further along) and answers with a resync. Without a round trip nothing waits for them.
      assert.equal(payload.stateId, lastStateId, `click #${clicks.length} (slot ${payload.slot}) carries stateId ${payload.stateId}, the last received is ${lastStateId}`);
      if (options.answersTabComplete) assert.equal(onTheirWay, 0, `click #${clicks.length} (slot ${payload.slot}) was written while ${onTheirWay} answers to the earlier clicks were still on their way`);
      clicks.push(payload);
      for (const reply of step.replies) deliver(reply.delayMs, () => emitReply(reply), reply.afterTheRoundTrip !== true);
    },
  });
  const clicks: ClickWrite[] = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  let tabCompletes = 0;
  const INITIAL_STATE_ID = 2;
  let lastStateId = INITIAL_STATE_ID;
  let onTheirWay = 0;
  let lastDueAt = 0;
  const deliver = (delayMs: number, send: () => void, ordered = true) => {
    if (ordered) {
      onTheirWay += 1;
      lastDueAt = Math.max(lastDueAt, performance.now() + delayMs);
    }
    timers.push(setTimeout(() => { if (ordered) onTheirWay -= 1; send(); }, delayMs));
  };
  /** The server handles packets in order: its `tab_complete` reply comes after every packet it had already queued. */
  const answerAfterEverythingSent = () => deliver(Math.max(0, lastDueAt - performance.now()) + 1, () => client.emit("tab_complete", { matches: [] }));
  const emitReply = (reply: Reply) => {
    lastStateId = reply.stateId;
    if (reply.packet === "set_slot") client.emit("set_slot", { windowId: 0, stateId: reply.stateId, slot: reply.slot, item: notch(reply.item) });
    else {
      const items = Array.from({ length: WINDOW_SLOT_COUNT }, (_, slot) => notch(reply.contents?.[slot]));
      client.emit("window_items", { windowId: 0, stateId: reply.stateId, items, carriedItem: notch(reply.cursor) });
    }
  };
  const bot = Object.assign(new EventEmitter(), {
    registry,
    version: MC_VERSION,
    supportFeature: registry.supportFeature,
    _client: client,
    entity: { yaw: 0, pitch: 0 },
    game: { gameMode: "survival" },
    food: 20,
  });
  (require("mineflayer/lib/plugins/inventory.js") as Plugin)(bot, { hideErrors: true });
  (require("mineflayer/lib/plugins/chat.js") as Plugin)(bot, { hideErrors: true });
  (require("mineflayer/lib/plugins/craft.js") as Plugin)(bot, { hideErrors: true });
  client.emit("window_items", { windowId: 0, stateId: INITIAL_STATE_ID, items: Array.from({ length: WINDOW_SLOT_COUNT }, (_, slot) => notch(carried[slot])), carriedItem: notch() });
  return { bot: bot as unknown as CraftApi, clicks, tabCompletes: () => tabCompletes, stop: () => timers.forEach(clearTimeout) };
}

const ANSWERING: SceneOptions = { answersTabComplete: true };
/** The craft runs on the shared fake clock, 1 ms slices, so the logged gaps between packets and clicks are replayed without real waiting. */
const MAX_CRAFT_MS = 30_000;
async function craftOnce(resultName: string, carried: Readonly<Record<number, Stack>>, script: readonly ClickStep[], options: SceneOptions = ANSWERING) {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const scene = craftingScene(carried, script, options);
  try {
    const recipe = scene.bot.recipesFor(registry.itemsByName[resultName].id, null, 1, null)[0];
    assert.ok(recipe, `no ${resultName} recipe for what the bot carries`);
    await clock.settle(scene.bot.craft(recipe, 1), MAX_CRAFT_MS, 1);
    return scene;
  } finally {
    scene.stop();
  }
}

const planks = (count: number): Stack => ["oak_planks", count];
const logs = (count: number): Stack => ["oak_log", count];
const table: Stack = ["crafting_table", 1];
const button: Stack = ["oak_button", 1];
const plate: Stack = ["oak_pressure_plate", 1];

/** `vanilla-probe.log`: 4 logs in the hotbar, planks from one log. */
const vanillaPlanks = [
  click(36, 0),
  click(4, 1, setSlot(4, 0, planks(4))),
  click(9, 0),
  click(0, 0, setSlot(5, 0)),
  click(10, 0),
];
/** `paper-craft-final.log`: the empty slot-0 update st6 first, the result st7 3 ms after the grid click, and a burst after the take. */
const paperPlanks = [
  click(36, 0, setSlot(5, 36, undefined, 4), setSlot(6, 0, undefined, 4)),
  click(4, 1, setSlot(7, 0, planks(4), 3), setSlot(8, 4, logs(1), 3), setSlot(9, 0, planks(4), 3)),
  click(9, 0, setSlot(10, 9, logs(3), 1), setSlot(11, 0, planks(4), 1)),
  click(0, 0, setSlot(12, 0, undefined, 3), setSlot(13, 0, undefined, 3), setSlot(14, 0, undefined, 3), windowItems(15, { 9: logs(3) }, planks(4), 4), setSlot(16, 45, undefined, 5)),
  click(10, 0, setSlot(17, 10, planks(4)), setSlot(18, 0, undefined, 1)),
];
/** `vanilla-table.log`: 6 planks in the hotbar, a crafting_table (4 grid clicks) in the 2x2 grid. */
const vanillaTable = [
  click(36, 0),
  click(1, 1, setSlot(4, 0, button, 3)),
  click(2, 1, setSlot(5, 0, plate, 5)),
  click(3, 1, setSlot(6, 0, undefined, 1)),
  click(4, 1, setSlot(7, 0, table)),
  click(9, 0),
  click(0, 0, setSlot(8, 0, undefined, 1), setSlot(9, 0, plate, 1), setSlot(10, 0, button, 1), setSlot(11, 0, undefined, 1)),
  click(10, 0),
];
/** `paper-table-final.log`: the same craft; every grid click answered by the result, the slot and the result again, the take by six slot-0 updates and a snapshot. */
const paperTable = [
  click(36, 0, setSlot(5, 36, undefined, 4), setSlot(6, 0, undefined, 4)),
  click(1, 1, setSlot(7, 0, button, 4), setSlot(8, 1, planks(1), 4), setSlot(9, 0, button, 4)),
  click(2, 1, setSlot(10, 0, plate, 9), setSlot(11, 2, planks(1), 10), setSlot(12, 0, plate, 10)),
  click(3, 1, setSlot(13, 0, undefined, 1), setSlot(14, 3, planks(1), 2), setSlot(15, 0, undefined, 2)),
  click(4, 1, setSlot(16, 0, table, 1), setSlot(17, 4, planks(1), 1), setSlot(18, 0, table, 1)),
  click(9, 0, setSlot(19, 9, planks(2), 1), setSlot(20, 0, table, 1)),
  click(
    0,
    0,
    setSlot(21, 0, undefined, 6),
    setSlot(22, 0, plate, 9),
    setSlot(23, 0, button, 9),
    setSlot(24, 0, undefined, 9),
    setSlot(25, 0, undefined, 9),
    setSlot(26, 0, undefined, 9),
    windowItems(27, { 9: planks(2) }, table, 10),
    setSlot(28, 45, undefined, 10),
  ),
  click(10, 0, setSlot(29, 10, table, 1), setSlot(30, 0, undefined, 1)),
];

const LOGS_IN_HOTBAR = { 36: logs(4) };
const PLANKS_IN_HOTBAR = { 36: planks(6) };
const count = (bot: CraftApi, name: string) => bot.inventory.count(registry.itemsByName[name].id, null);

const logged: ReadonlyArray<{ name: string; result: string; carried: Readonly<Record<number, Stack>>; script: readonly ClickStep[]; resultCount: number }> = [
  { name: "planks from one log, vanilla: slot 0 answered after the grid click", result: "oak_planks", carried: LOGS_IN_HOTBAR, script: vanillaPlanks, resultCount: 4 },
  { name: "planks from one log, Paper: slot 0 empty first, several packets per click", result: "oak_planks", carried: LOGS_IN_HOTBAR, script: paperPlanks, resultCount: 4 },
  { name: "a crafting_table, vanilla: each of the four grid clicks answered", result: "crafting_table", carried: PLANKS_IN_HOTBAR, script: vanillaTable, resultCount: 1 },
  { name: "a crafting_table, Paper: empty first update, resent results, a snapshot after the take", result: "crafting_table", carried: PLANKS_IN_HOTBAR, script: paperTable, resultCount: 1 },
];
for (const row of logged) {
  test(`${row.name}: every logged click is written once the answers to the last one are in, and the craft completes`, async () => {
    const { bot } = await craftOnce(row.result, row.carried, row.script);
    assert.equal(count(bot, row.result), row.resultCount);
  });
}

/** Waits for: a probe of where the server's `tab_complete` answer sits against its slot-0 packets. Not measured: a result sent in a later tick (Paper sent it inside the burst). */
test("a result that reaches slot 0 after the server's round trip: the craft waits for it and completes", async () => {
  const late = [
    click(36, 0, setSlot(5, 36, undefined, 4), setSlot(6, 0, undefined, 4)),
    click(4, 1, setSlot(7, 0, undefined, 3)),
    click(9, 0, { ...setSlot(8, 0, planks(4), 80), afterTheRoundTrip: true }),
    click(0, 0, setSlot(9, 0, undefined, 2)),
    click(10, 0),
  ];
  const { bot } = await craftOnce("oak_planks", LOGS_IN_HOTBAR, late);
  assert.equal(count(bot, "oak_planks"), 4);
});

test("a server that never answers tab_complete: one round trip is lost to its bound, the rest of the craft goes without, every click is written", async () => {
  const { bot, clicks, tabCompletes } = await craftOnce("oak_planks", LOGS_IN_HOTBAR, vanillaPlanks, { answersTabComplete: false });
  assert.equal(tabCompletes(), 1);
  assert.equal(clicks.length, vanillaPlanks.length);
  assert.equal(count(bot, "oak_planks"), 4);
});

/** The wait's bound is mineflayer's 5000 ms `WINDOW_TIMEOUT` (`craft.js` `CRAFTING_RESULT_TIMEOUT`), on the fake clock. */
test("a result slot that never holds the recipe's result: the craft fails with the existing message once the wait is over", async () => {
  const neverResult = [click(36, 0, setSlot(5, 36, undefined, 4), setSlot(6, 0, undefined, 4)), click(4, 1, setSlot(7, 0, undefined, 3)), click(9, 0)];
  await assert.rejects(craftOnce("oak_planks", LOGS_IN_HOTBAR, neverResult), /Server did not supply the expected crafting result/);
});
