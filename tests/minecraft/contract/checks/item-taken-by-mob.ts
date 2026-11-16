/** A piglin takes one ingot at a time; the client sees the remainder before a later removal. */
import assert from "node:assert/strict";
import type { Entity } from "prismarine-entity";
import { droppedItemName } from "../../../../src/world/item-pickup.ts";
import type { ContractCheck } from "../checks.ts";
import { recordWindowPackets } from "../window-packets.ts";
import { markNow, tickOf, type Mark } from "./server-tick-marks.ts";

type Reading = { kind: string; id?: number; collector?: number; pickupCount?: number; name?: string | null; count?: number | null; listed?: boolean; valid?: boolean; mark: Mark };

export const itemTakenByMob: ContractCheck = {
  name: "item-taken-by-mob",
  withoutRuntime: true,
  fixture: {
    cells: Object.fromEntries([
      ...[3, 5].flatMap((x) => [-1, 0, 1].flatMap((z) => [-60, -59].map((y) => [`${x},${y},${z}`, "stone"]))),
      ...[-1, 1].flatMap((z) => [-60, -59].map((y) => [`4,${y},${z}`, "stone"])),
    ]),
    carried: {}, position: [0.5, -60, 0.5],
  },
  async run(subject) {
    const { bot } = subject;
    const readings: Reading[] = [];
    const snapshot = (kind: string, entity: Entity, collector?: number) => {
      readings.push({ kind, id: entity.id, collector, name: droppedItemName(entity), count: entity.getDroppedItem()?.count ?? null,
        listed: bot.entities[entity.id] === entity, valid: entity.isValid, mark: markNow(subject) });
    };
    const onCollect = (collector: Entity, entity: Entity) => {
      snapshot("playerCollect", entity, collector.id);
      queueMicrotask(() => snapshot("microtask", entity, collector.id));
    };
    const onGone = (entity: Entity) => { if (entity.name === "item") snapshot("entityGone", entity); };
    const onSlot = () => { readings.push({ kind: "updateSlot", mark: markNow(subject) }); };
    const onPacket = (packet: { collectedEntityId: number; collectorEntityId: number; pickupItemCount: number }) => {
      const entity = bot.entities[packet.collectedEntityId];
      readings.push({ kind: "collectPacket", id: packet.collectedEntityId, collector: packet.collectorEntityId,
        pickupCount: packet.pickupItemCount, name: entity ? droppedItemName(entity) : null,
        count: entity?.getDroppedItem()?.count ?? null, mark: markNow(subject) });
    };
    bot.on("playerCollect", onCollect);
    bot.on("entityGone", onGone);
    bot.inventory.on("updateSlot", onSlot);
    bot._client.on("collect", onPacket);
    const packets = recordWindowPackets(bot);
    try {
      const piglin = await subject.summonMob("piglin", subject.world([4.5, -60, 0.5]), "{IsImmuneToZombification:1b,PersistenceRequired:1b,CanPickUpLoot:1b}");
      const item = await subject.summonItem({ name: "gold_ingot", count: 2 }, subject.world([4.5, -60, 0.5]), 0);
      await subject.mobTakesItem(piglin, item, 1);
      await subject.mobTakesItem(piglin, item, 1);
      const measured = await Promise.all(readings.map(async ({ mark, ...reading }) => ({ ...reading, tick: await tickOf(subject, mark) })));
      const itemReadings = measured.filter((reading) => reading.id === item.id);
      const detail = JSON.stringify({ piglin: piglin.id, item: item.id, readings: measured, packets: packets.packets });
      assert.deepEqual(itemReadings.slice(0, 3).map(({ kind, collector, pickupCount, name, count, listed, valid }) =>
        ({ kind, collector, pickupCount, name, count, listed, valid })), [
        { kind: "playerCollect", collector: piglin.id, pickupCount: undefined, name: "gold_ingot", count: 2, listed: true, valid: true },
        { kind: "collectPacket", collector: piglin.id, pickupCount: 1, name: "gold_ingot", count: 1, listed: undefined, valid: undefined },
        { kind: "microtask", collector: piglin.id, pickupCount: undefined, name: "gold_ingot", count: 1, listed: true, valid: true },
      ], detail);
      assert.equal(measured.some(({ kind }) => kind === "updateSlot"), false, detail);
      const gone = itemReadings.find(({ kind }) => kind === "entityGone");
      const second = itemReadings.filter(({ kind }) => kind === "collectPacket")[1];
      assert.equal(second?.collector, piglin.id, detail);
      assert.equal(second?.pickupCount, 1, detail);
      assert.equal(second?.name, null, detail);
      assert.equal(second?.count, null, detail);
      assert.equal(gone?.name, null, detail);
      assert.equal(gone?.count, null, detail);
      assert.equal(gone?.listed, true, detail);
      assert.equal(gone?.valid, true, detail);
      assert.equal(bot.entities[item.id], undefined, detail);
    } finally {
      packets.stop();
      bot.off("playerCollect", onCollect);
      bot.off("entityGone", onGone);
      bot.inventory.off("updateSlot", onSlot);
      bot._client.off("collect", onPacket);
    }
  },
};
