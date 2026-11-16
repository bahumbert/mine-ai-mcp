/** Record the inventory answers around a partial and a whole-stack toss. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import type { Entity } from "prismarine-entity";
import type { ContractCheck } from "../checks.ts";
import { afterServerTicks } from "../server-answer.ts";
import type { ContractSubject } from "../subject.ts";
import { stackOf } from "../window-packets.ts";
import { markNow, tickOf } from "./server-tick-marks.ts";

async function measureToss(subject: ContractSubject, path: "part" | "stack", predicted: number) {
  const { bot } = subject;
  const id = bot.registry.itemsByName.cobblestone!.id;
  const ItemClass = createRequire(import.meta.url)("prismarine-item")(bot.registry) as { fromNotch(value: unknown): Parameters<typeof stackOf>[0] };
  const log: Record<string, unknown>[] = [];
  const heldSlots = new Set<number>();
  const stamp = (event: string, extra: Record<string, unknown> = {}) => log.push({ event, ...extra, ms: subject.now(), age: bot.time.age, count: bot.inventory.count(id, null) });
  const onSlot = (packet: { windowId: number; slot: number; item: unknown }) => {
    if (packet.windowId === 0) stamp("set_slot", { slot: packet.slot, stack: stackOf(ItemClass.fromNotch(packet.item)) });
  };
  const onItems = (packet: { windowId: number; items: unknown[] }) => {
    if (packet.windowId !== 0) return;
    packet.items.forEach((item, slot) => {
      const decoded = ItemClass.fromNotch(item);
      if (decoded?.name === "cobblestone" || heldSlots.has(slot)) stamp("window_items", { slot, stack: stackOf(decoded) });
      if (decoded?.name === "cobblestone") heldSlots.add(slot);
    });
  };
  const onUpdate = (slot: number, old: Parameters<typeof stackOf>[0], item: Parameters<typeof stackOf>[0]) => {
    if (old?.name === "cobblestone" || item?.name === "cobblestone") heldSlots.add(slot);
    stamp("updateSlot", { slot, old: old?.count ?? 0, new: item?.count ?? 0 });
  };
  const onCollect = (collector: Entity, collected: Entity) => { if (collector.id === bot.entity.id) stamp("playerCollect", { entity: collected.id }); };
  bot._client.on("set_slot", onSlot);
  bot._client.on("window_items", onItems);
  bot.inventory.on("updateSlot", onUpdate);
  bot.on("playerCollect", onCollect);
  try {
    bot.inventory.items().filter((item) => item.type === id).forEach((item) => heldSlots.add(item.slot));
    const start = markNow(subject);
    stamp("send");
    if (path === "part") await bot.toss(id, null, 10);
    else await bot.tossStack(bot.inventory.items().find((item) => item.type === id)!);
    stamp("promise");
    assert.equal(bot.inventory.count(id, null), predicted, `${path}: count at promise`);
    await afterServerTicks(subject, 41, path);
    const end = markNow(subject);
    stamp("window-end", { startTick: await tickOf(subject, start), endTick: await tickOf(subject, end) });
    let pickup = false;
    for (const entry of log) {
      if (entry.event === "playerCollect") pickup = true;
      if (entry.event === "updateSlot" && Number(entry.new) > Number(entry.old) && Number(entry.count) > predicted && !pickup) assert.fail(`${path}: non-pickup raise ${JSON.stringify(log)}`);
    }
    return { path, log };
  } finally {
    bot._client.off("set_slot", onSlot);
    bot._client.off("window_items", onItems);
    bot.inventory.off("updateSlot", onUpdate);
    bot.off("playerCollect", onCollect);
  }
}

export const tossCorrectedInventoryAnswer: ContractCheck = {
  name: "toss-corrected-inventory-answer",
  withoutRuntime: true,
  fixture: { cells: {}, carried: { cobblestone: 20 }, position: [0.5, -60, 0.5] },
  async run(subject) {
    const measurements = [await measureToss(subject, "part", 10), await measureToss(subject, "stack", 0)];
    return `MEASURED ${JSON.stringify(measurements)}`;
  },
};
