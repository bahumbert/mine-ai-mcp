/**
 * `stopDigging` has two windows (`digging.js:139-169`, review #12): while the dig's look is pending it does nothing and
 * the dig goes on to the end; once the dig packet is out it aborts (`Digging aborted`) and the block stays.
 */
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";
import { settleWithin } from "../subject.ts";

const BEFORE_PACKET_TARGET = new Vec3(1, -60, 0);
const AFTER_PACKET_TARGET = new Vec3(-1, -60, 0);
/** Well after the look's tick and the start packet, well before dirt's 750 ms by hand. */
const MID_DIG_MS = 300;
const DIG_WALL_MS = 3_000;
/** Long enough for a server that broke the block anyway to send the air. */
const SERVER_KEEPS_MS = 1_500;

export const stopDiggingBothWindows: ContractCheck = {
  name: "stop-digging-both-windows",
  fixture: {
    cells: { "1,-60,0": "dirt", "-1,-60,0": "dirt" },
    carried: {},
    position: [0.5, -60, 0.5],
  },
  async run(subject) {
    const { bot } = subject;
    // Look away first, so the dig's own look must wait for a client tick.
    await bot.look(Math.PI / 2, 0, true);
    const first = bot.dig(bot.blockAt(BEFORE_PACKET_TARGET)!);
    bot.stopDigging();
    const ended = await settleWithin(subject, first, DIG_WALL_MS);
    assert.ok(ended !== null && ended.error === undefined, `a stop during the look ended the dig: ${ended?.error?.message ?? "it never ended"}`);
    assert.equal(bot.blockAt(BEFORE_PACKET_TARGET)?.name, "air");

    // A forced look: the start packet goes out at once, whatever the turn would take.
    const second = bot.dig(bot.blockAt(AFTER_PACKET_TARGET)!, true);
    second.catch(() => undefined); // read below; an early failure must not go unhandled meanwhile
    await subject.wait(MID_DIG_MS);
    assert.ok(bot.targetDigBlock, "the dig packet is out (targetDigBlock set)");
    bot.stopDigging();
    const aborted = await settleWithin(subject, second, DIG_WALL_MS);
    assert.equal(aborted?.error?.message, "Digging aborted");
    await subject.wait(SERVER_KEEPS_MS);
    assert.equal(bot.blockAt(AFTER_PACKET_TARGET)?.name, "dirt", "the aborted dig left the block");
  },
};
