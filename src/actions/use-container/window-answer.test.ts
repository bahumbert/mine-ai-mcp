import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, stackText } from "../../test-support/fake-bot/index.js";
import { OpenedContainer } from "./opened-container.js";

const CELL = "1,64,1";
const TICK_MS = 50;
type ItemClass = new (type: number, count: number) => { readonly name: string };
const Item = (registry: unknown) => (createRequire(import.meta.url)("prismarine-item") as (registry: unknown) => ItemClass & { toNotch(item: unknown): unknown })(registry);

/** The bot beside a chest at CELL holding `stacks`, its server answering every click `lagMs` late. */
async function chestWithLag(lagMs: number, stacks: readonly { slot: number; name: string; count: number }[]) {
  const harness = createFakeBot({ position: new Vec3(0, 64, 0), cells: { [CELL]: "chest" }, containers: { [CELL]: {} }, lagMs });
  harness.windows.setContainerStacks(CELL, stacks);
  // The state id the server last sent: a packet made up by a test carries it, so the click in flight stays current.
  let stateId = 0;
  for (const name of ["set_slot", "window_items"]) harness.bot._client.on(name, (packet: { stateId: number }) => void (stateId = packet.stateId));
  const container = await harness.clock.settle(OpenedContainer.open(harness.bot, harness.bot.blockAt(new Vec3(1, 64, 1))!, harness.clock), 5_000);
  return { ...harness, container, stateId: () => stateId, window: harness.bot.currentWindow!, cursor: () => stackText(harness.bot.currentWindow?.selectedItem) };
}

test("a slot packet of another player's click heard before the server's answer to ours does not end the wait: the late cursor is applied", async () => {
  const scene = await chestWithLag(3 * TICK_MS, [{ slot: 0, name: "renamed_first_cobblestone", count: 5 }, { slot: 1, name: "cobblestone", count: 4 }]);
  await scene.container.clickStack(0);
  const plain = Item(scene.bot.registry);
  // The `set_slot` of another player's change in a slot we did not touch reaches the bot as our click is written (made up here with the current state id: the game
  // would also move the state id on); the server's answer to ours comes 3 ticks later.
  scene.windows.onClickReceived(() => scene.bot._client.emit("set_slot", { windowId: scene.window.id, stateId: scene.stateId(), slot: 20, item: plain.toNotch(null) }));
  await scene.clock.settle(scene.container.clickStack(1), 20_000);
  assert.equal(scene.cursor(), "cobblestone x4", "the server's set_cursor_item, heard after the foreign set_slot, is the cursor the bot reads");
});

// The packets are made up (no server answers a same-variant merge this way): the test proves the timing, that a cursor packet well behind the slot packet is applied.
test("a set_cursor_item heard 3 ticks after the set_slot that came with it, inside the 40 ticks of the wait, is applied", async () => {
  const scene = await chestWithLag(0, [{ slot: 0, name: "renamed_first_cobblestone", count: 5 }, { slot: 1, name: "renamed_first_cobblestone", count: 7 }]);
  await scene.container.clickStack(0);
  const plain = Item(scene.bot.registry);
  const held = new plain(scene.bot.registry.itemsByName.cobblestone!.id, 3);
  scene.windows.onClickReceived(() =>
    scene.server.answer(() => {
      scene.bot._client.emit("set_slot", { windowId: scene.window.id, stateId: scene.stateId(), slot: 1, item: plain.toNotch(null) });
      scene.clock.after(3 * TICK_MS, () => scene.bot._client.emit("set_cursor_item", { contents: plain.toNotch(held) }));
    }),
  );
  await scene.clock.settle(scene.container.clickStack(1), 20_000);
  assert.equal(scene.cursor(), "cobblestone x3");
});
