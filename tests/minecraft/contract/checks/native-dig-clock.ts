// A native hand dig must finish on the server clock and return only after authoritative removal.
import assert from "node:assert/strict";
import { changeCovers, subscribeServerBlockChanges } from "../../../../src/navigation/mineflayer/server-block-changes.ts";
import type { ContractCheck } from "../checks.ts";
import { answerArrivesWhileMoving } from "../server-answer.ts";
import { markNow, READING_TICKS, tickOf } from "./server-tick-marks.ts";

export const nativeDigClock: ContractCheck = {
  name: "native-dig-clock",
  withoutRuntime: true,
  fixture: { cells: { "1,-60,0": "deepslate" }, carried: {}, position: [0.5, -60, 0.5] },
  async run(subject) {
    const { bot } = subject;
    const target = subject.world([1, -60, 0]);
    const block = bot.blockAt(target)!;
    const expectedTicks = Math.ceil(bot.digTime(block) / 50);
    let authoritativeAir = false;
    const unsubscribe = subscribeServerBlockChanges(bot, change => {
      if (changeCovers(change, target) && bot.blockAt(target)?.type === 0) authoritativeAir = true;
    });
    let outcome: { error?: unknown; confirmed: boolean } | undefined;
    const start = markNow(subject);
    const digging = bot.dig(block, true).then(
      () => { outcome = { confirmed: authoritativeAir }; },
      error => { outcome = { error, confirmed: authoritativeAir }; },
    );
    try {
      await answerArrivesWhileMoving(subject, () => outcome !== undefined, () => bot.time.age, "native dig completion");
      await digging;
      assert.equal(outcome?.error, undefined, "native dig must complete successfully");
      assert.equal(outcome?.confirmed, true, "native dig returned before an authoritative air packet");
      const end = markNow(subject);
      const ran = (await tickOf(subject, end)) - (await tickOf(subject, start));
      assert.ok(ran >= expectedTicks - READING_TICKS, `native dig ran ${ran} server ticks, expected at least ${expectedTicks - READING_TICKS}`);
      assert.ok(ran <= expectedTicks + 20 + READING_TICKS, `native dig exceeded ${expectedTicks + 20 + READING_TICKS} server ticks: ${ran}`);
      assert.equal(bot.blockAt(target)?.type, 0);
      return `native dig: ${ran} server ticks for ${expectedTicks} required; authoritative air before return`;
    } finally {
      bot.stopDigging();
      unsubscribe();
    }
  },
};
