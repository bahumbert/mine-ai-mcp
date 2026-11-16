// Measure the held-shooter command and its stored readback on the server.
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { SERVER_CLOCK_STOPPED_MS, STALE_AGE_TICKS } from "../../../../src/world/world-age.ts";
import { waitForCommandReply } from "./combat-data-measure.ts";
import { markNow, tickOf, type Mark } from "./server-tick-marks.ts";

export const heldShooter: ContractCheck = {
  name: "held-shooter",
  withoutRuntime: true,
  fixture: { cells: {}, carried: {}, position: [0.5, -60, 0.5], timeOfDay: 18000,
    entities: [{ name: "skeleton", position: [0.5, -60, 3.5], nbt: "{NoAI:1b,PersistenceRequired:1b}" }] },
  async run(subject) {
    const { bot } = subject;
    const samples: { text: string; ticks: number }[] = [];
    for (let i = 0; i < 10; i++) {
      const prefix = `held-measure-${i} `;
      let answer: { text: string; mark: Mark } | undefined;
      const listener = (text: string) => {
        if (text.startsWith(prefix)) answer = { text: text.slice(prefix.length), mark: markNow(subject) };
      };
      bot.on("messagestr", listener);
      const start = markNow(subject);
      try {
        bot.chat("/attribute @e[type=minecraft:skeleton,limit=1,sort=nearest] minecraft:movement_speed base set 0");
        bot.chat(`/execute store success storage mine_ai:evade hold_${bot.username}_ok int 1 store result storage mine_ai:evade hold_${bot.username}_value int 1 run attribute @e[type=minecraft:skeleton,limit=1,sort=nearest] minecraft:movement_speed get 100000`);
        bot.chat(`/tellraw @s ${JSON.stringify({ text: prefix, extra: [{ nbt: `hold_${bot.username}_ok`, storage: "mine_ai:evade" }, { text: " " }, { nbt: `hold_${bot.username}_value`, storage: "mine_ai:evade" }] })}`);
        await waitForCommandReply(bot, () => answer !== undefined, { observedTicks: 2 + STALE_AGE_TICKS,
          stallMs: SERVER_CLOCK_STOPPED_MS, now: subject.now, sleep: subject.wait });
      } finally { bot.off("messagestr", listener); }
      assert.ok(answer);
      samples.push({ text: answer.text, ticks: (await tickOf(subject, answer.mark)) - (await tickOf(subject, start)) });
    }
    assert.deepEqual(samples.map(({ text }) => text), Array(10).fill("1 0"));
    assert.ok(samples.every(({ ticks }) => ticks >= 0 && ticks <= 2), JSON.stringify(samples));
    return `MEASURED ${JSON.stringify(samples)}`;
  },
};
