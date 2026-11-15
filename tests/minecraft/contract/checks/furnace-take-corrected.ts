/** Measure server answers to a stale furnace output prediction. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { ContractCheck } from "../checks.ts";
import { serverQuiet } from "../server-answer.ts";
import { recordWindowAnswers, recordWindowPackets, slotsOf, stackOf } from "../window-packets.ts";

export const furnaceTakeCorrected: ContractCheck = {
  name: "furnace-take-corrected",
  withoutRuntime: true,
  waitsForFake: "a corrected furnace take on the fake (amendment a4 B3a)",
  fixture: {
    cells: { "0,-60,0": "furnace" },
    containers: { "0,-60,0": { raw_iron: 64, coal: 64, iron_ingot: 2 } },
    carried: {},
    position: [-2.5, -60, 0.5],
  },
  async run(subject) {
    const { bot } = subject;
    const window = await bot.openFurnace(bot.blockAt(subject.world([0, -60, 0]))!);
    const output = window.outputItem()!;
    const outputCount = output.count;
    const input = window.inputItem()!;
    const fuel = window.fuelItem()!;
    const Item = createRequire(import.meta.url)("prismarine-item")(bot.registry);
    const staged = Item.fromNotch(Item.toNotch(output));
    staged.count = output.count - 1;
    window.updateSlot(output.slot, staged);
    const slots = Array.from({ length: window.inventoryEnd - window.inventoryStart }, (_, i) => window.inventoryStart + i);
    const log: { event: string; ms: number; age: number | null; [key: string]: unknown }[] = [];
    const stamp = (event: string, data: object = {}) => log.push({ event, ...data, ms: subject.now(), age: bot.time.age });
    const packets = recordWindowPackets(bot);
    const answers = recordWindowAnswers(bot);
    const onPacket = (name: string) => () => { stamp(name, { packet: packets.packets.at(-1), answer: answers.answers.at(-1) }); };
    const onSlot = onPacket("set_slot");
    const onItems = onPacket("window_items");
    const onCursor = onPacket("set_cursor_item");
    const onClose = onPacket("close_window");
    bot._client.on("set_slot", onSlot);
    bot._client.on("window_items", onItems);
    bot._client.on("set_cursor_item", onCursor);
    bot._client.on("close_window", onClose);
    const client = bot._client;
    const originalWrite = client.write;
    client.write = function (name, params) {
      if (name === "window_click" || name === "close_window") stamp("write", { name, slot: params.slot });
      return originalWrite.call(this, name, params);
    };
    try {
      stamp("before", { slots: slotsOf(window, slots), output: stackOf(output) });
      for (const slot of [output.slot, input.slot, fuel.slot]) await bot.clickWindow(slot, 0, 1);
      stamp("promises", { slots: slotsOf(window, slots) });
      await serverQuiet(subject, "after furnace clicks");
      stamp("quiet", { slots: slotsOf(window, slots) });
      window.close();
      await serverQuiet(subject, "after furnace close");
      stamp("closed", { inventory: bot.inventory.items().map(stackOf) });
      const click = log.find((entry) => entry.event === "write" && entry.name === "window_click")!;
      const correction = log.find((entry) => entry.event === "set_slot")!;
      assert.deepEqual(answers.answers, [{ name: "set_slot", windowId: window.id, slot: window.inventoryEnd - 1, stack: stackOf(output) }]);
      assert.deepEqual(packets.packets.map(({ name }) => name), ["set_slot", "window_items", "window_items"]);
      assert.ok(packets.packets.every(({ windowId }) => windowId === window.id));
      assert.ok(correction.ms >= click.ms && correction.age !== null && click.age !== null && correction.age - click.age <= 40);
      assert.equal(window.slots[window.inventoryEnd - 1]?.count, outputCount);
      assert.equal(bot.inventory.count(output.type, null), outputCount, "the server's full output survived close");
      return `MEASURED ${JSON.stringify(log)}`;
    } finally {
      client.write = originalWrite;
      bot._client.off("set_slot", onSlot);
      bot._client.off("window_items", onItems);
      bot._client.off("set_cursor_item", onCursor);
      bot._client.off("close_window", onClose);
      packets.stop();
      answers.stop();
    }
  },
};
