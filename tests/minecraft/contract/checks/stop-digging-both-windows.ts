/**
 * `stopDigging` has two windows (`digging.js:139-169`, review #12): while the dig's look is pending it does nothing and
 * the dig goes on to the end; once the dig packet is out it aborts (`Digging aborted`) and the block stays.
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { ANSWER_WALL_MS, answerArrives, serverQuiet } from "../server-answer.ts";
import { settleWithin } from "../subject.ts";

const BEFORE_PACKET_TARGET = [1, -60, 0] as const;
const AFTER_PACKET_TARGET = [-1, -60, 0] as const;

export const stopDiggingBothWindows: ContractCheck = {
  name: "stop-digging-both-windows",
  fixture: {
    cells: { "1,-60,0": "dirt", "-1,-60,0": "dirt" },
    carried: {},
    position: [0.5, -60, 0.5],
  },
  async run(subject) {
    const { bot } = subject;
    const beforePacketTarget = subject.world(BEFORE_PACKET_TARGET);
    const afterPacketTarget = subject.world(AFTER_PACKET_TARGET);
    // Look away first, so the dig's own look must wait for a client tick.
    await bot.look(Math.PI / 2, 0, true);
    const first = bot.dig(bot.blockAt(beforePacketTarget)!);
    bot.stopDigging();
    const ended = await settleWithin(subject, first, ANSWER_WALL_MS);
    assert.ok(ended !== null && ended.error === undefined, `a stop during the look ended the dig: ${ended?.error?.message ?? "it never ended"}`);
    assert.equal(bot.blockAt(beforePacketTarget)?.name, "air");

    // A forced look: the start packet goes out at once, whatever the turn would take.
    const second = bot.dig(bot.blockAt(afterPacketTarget)!, true);
    second.catch(() => undefined); // read below; an early failure must not go unhandled meanwhile
    // Mineflayer sets `targetDigBlock` in the call that writes the start packet: the stop below is the first moment after it, not a wall time into the dig.
    await answerArrives(subject, () => bot.targetDigBlock !== null, "the dig packet is not out (targetDigBlock not set)");
    bot.stopDigging();
    const aborted = await settleWithin(subject, second, ANSWER_WALL_MS);
    assert.equal(aborted?.error?.message, "Digging aborted");
    // A server that broke the block anyway sends the air within its ticks.
    await serverQuiet(subject, "after the aborted dig");
    assert.equal(bot.blockAt(afterPacketTarget)?.name, "dirt", "the aborted dig left the block");
  },
};
