// Measure the metadata answer when water replaces lava around a burning body.
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { answerArrives } from "../server-answer.ts";
import { markNow, tickOf, type Mark } from "./server-tick-marks.ts";

export const waterExtinguishesBurning: ContractCheck = {
  name: "water-extinguishes-burning",
  withoutRuntime: true,
  fixture: { cells: {}, carried: {}, position: [0.5, -60, 0.5] },
  async run(subject) {
    const { bot } = subject;
    const index = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("shared_flags");
    const burning = () => (Number(bot.entity.metadata[index] ?? 0) & 1) !== 0;
    let cleared: Mark | null = null;
    let watered: Mark | null = null;
    let watching = false;
    const onUpdate = () => { if (watching && !burning() && cleared === null) cleared = markNow(subject); };
    const onBlock = (_before: unknown, after: { name?: string; position?: { x: number; y: number; z: number } } | null) => {
      const cell = subject.world([0, -60, 0]);
      if (watching && watered === null && after?.name === "water" && after.position?.x === cell.x && after.position.y === cell.y && after.position.z === cell.z) watered = markNow(subject);
    };
    bot.on("entityUpdate", onUpdate);
    bot.on("blockUpdate", onBlock);
    try {
      await subject.setBlock(subject.world([0, -60, 0]), "lava");
      await answerArrives(subject, burning, "lava did not ignite the bot");
      const before = markNow(subject);
      watching = true;
      await subject.setBlock(subject.world([0, -60, 0]), "water");
      await answerArrives(subject, () => cleared !== null, "water did not clear burning metadata");
      assert.ok(cleared);
      assert.ok(watered);
      const delta = (await tickOf(subject, cleared)) - (await tickOf(subject, before));
      const updateDelta = (await tickOf(subject, cleared)) - (await tickOf(subject, watered));
      assert.ok(updateDelta >= 0 && updateDelta <= 4, `water update to extinguish metadata took ${updateDelta} queried ticks`);
      return `MEASURED metadata clear ${delta} queried ticks after placement start; ${updateDelta} queried ticks after the water block update`;
    } finally {
      bot.off("entityUpdate", onUpdate);
      bot.off("blockUpdate", onBlock);
    }
  },
};
