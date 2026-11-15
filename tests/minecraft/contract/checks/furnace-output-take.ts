/** Measure predicted furnace shift-clicks against the packets from a real server. */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { serverQuiet } from "../server-answer.ts";
import { recordWindowPackets, stackOf } from "../window-packets.ts";

export const furnaceOutputTake: ContractCheck = {
  name: "furnace-output-take",
  withoutRuntime: true,
  waitsForFake: "a furnace in the fake windows (amendment a3)",
  fixture: {
    cells: { "0,-60,0": "furnace" },
    containers: { "0,-60,0": { raw_iron: 64, coal: 64, iron_ingot: 2 } },
    carried: {},
    position: [-2.5, -60, 0.5],
  },
  async run(subject) {
    const { bot } = subject;
    const block = bot.blockAt(subject.world([0, -60, 0]))!;
    assert.equal(block.getProperties().lit, true, "the furnace is burning");
    const window = await bot.openFurnace(block);
    const writes: { name: string; slot?: number; ms: number; age: number | null }[] = [];
    const trace: unknown[] = [];
    const client = bot._client;
    const originalWrite = client.write;
    client.write = function (name, params) {
      if (name === "window_click" || name === "close_window") {
        writes.push({ name, ...(name === "window_click" ? { slot: params.slot } : {}), ms: subject.now(), age: bot.time.age });
      }
      return originalWrite.call(this, name, params);
    };
    const takes = [
      { name: "output", slot: 2, destination: 38, stack: "iron_ingot x2" },
      { name: "input", slot: 0, destination: 3, stack: "raw_iron x64" },
      { name: "fuel", slot: 1, destination: 4, stack: "coal x63" },
    ] as const;
    try {
      for (const take of takes) {
        const recording = recordWindowPackets(bot);
        const updates: { slot: number; stack: string | null }[] = [];
        const updateTimes: number[] = [];
        const onSlot = (slot: number, _old: unknown, item: Parameters<typeof stackOf>[0]) => {
          updates.push({ slot, stack: stackOf(item) });
          const ms = subject.now();
          updateTimes.push(ms);
          trace.push({ take: take.name, event: "updateSlot", slot, stack: stackOf(item), ms, age: bot.time.age });
        };
        window.on("updateSlot", onSlot);
        try {
          assert.equal(stackOf(window.slots[take.slot]), take.stack, `${take.name} before click`);
          assert.deepEqual(bot.inventory.items(), [], "inventory stays stale while open");
          await bot.clickWindow(take.slot, 0, 1);
          trace.push({ take: take.name, event: "promise", ms: subject.now(), age: bot.time.age, write: writes.at(-1) });
          assert.equal(writes.at(-1)?.name, "window_click");
          assert.equal(writes.at(-1)?.slot, take.slot);
          assert.ok(updateTimes.every((ms) => ms <= writes.at(-1)!.ms), `${take.name}: prediction before packet write`);
          assert.deepEqual(updates, [{ slot: take.destination, stack: take.stack }, { slot: take.slot, stack: null }], `${take.name}: prediction before promise`);
          assert.equal(stackOf(window.slots[take.destination]), take.stack);
          assert.deepEqual(bot.inventory.items(), []);
          await serverQuiet(subject, `after ${take.name}`);
          assert.deepEqual(recording.packets, [], `${take.name}: no server window packet`);
          assert.equal(stackOf(window.slots[take.destination]), take.stack);
          assert.deepEqual(bot.inventory.items(), []);
        } finally {
          window.off("updateSlot", onSlot);
          recording.stop();
        }
      }
    } finally {
      try {
        window.close();
      } finally {
        client.write = originalWrite;
      }
    }
    assert.equal(writes.at(-1)?.name, "close_window");
    await serverQuiet(subject, "after closing the furnace");
    assert.deepEqual(bot.inventory.items().map(stackOf).sort(), ["coal x63", "iron_ingot x2", "raw_iron x64"]);
    return `MEASURED ${JSON.stringify({ trace, close: writes.at(-1) })}`;
  },
};
