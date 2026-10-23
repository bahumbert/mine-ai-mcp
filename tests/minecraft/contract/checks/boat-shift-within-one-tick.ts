/**
 * The shift read at a server tick (50 ms), not at its packet (Mine Labs 1.21.4, 2026-10-23): pressed and released with
 * no tick between (5 of 5 in one go, 5 of 5 10 ms apart, 7 of 8 25 ms apart) the seat is kept on both sides and nothing
 * is heard; held 40 ms (1 of 5 kept) or 60 ms, the server lets her off as `boat-get-off-by-shift` measured. A run 14b
 * server behind by seconds reads both packets in one tick, so a short press leaves her seated while her client walks.
 */
import assert from "node:assert/strict";
import { writeShiftKey } from "../../../../src/navigation/mineflayer/sneak.ts";
import type { ContractCheck } from "../checks.ts";
import { BOAT_FIXTURE, getOffAndStand, listenWhileSeated, mountBoat } from "./boat-seat.ts";

/** Presses and releases written in one go, with no wait between them. */
const QUICK_PRESSES = 5;
/** A press held this long reaches two ticks of the server (60 ms measured: let off every time). */
const HELD_MS = 100;

export const boatShiftWithinOneTick: ContractCheck = {
  name: "boat-shift-within-one-tick",
  fixture: BOAT_FIXTURE,
  // Bare bot: our runtime acts on the passenger list itself (`vehicle-sync.ts`), the check measures the server.
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    const boat = await mountBoat(subject);
    for (let press = 0; press < QUICK_PRESSES; press += 1) {
      writeShiftKey(bot, true);
      writeShiftKey(bot, false);
    }
    const heard = await listenWhileSeated(subject, boat);
    assert.equal(await subject.seatedOnServer(boat), true, "the server let her off a shift pressed and released with no tick between");
    assert.deepEqual(heard, { positions: 0, listsWithoutHer: 0, physicsTicks: 0 }, `the client heard of a get-off: ${JSON.stringify(heard)}`);
    assert.equal(bot.vehicle?.id, boat.id);
    const listeningAfterHold = listenWhileSeated(subject, boat);
    writeShiftKey(bot, true);
    await subject.wait(HELD_MS);
    writeShiftKey(bot, false);
    const afterHold = await listeningAfterHold;
    assert.equal(await subject.seatedOnServer(boat), false, `the server kept her seated after a shift held ${HELD_MS} ms`);
    assert.ok(afterHold.positions >= 1 && afterHold.listsWithoutHer >= 1, `the get-off was not answered: ${JSON.stringify(afterHold)}`);
    // Next action from here: the runtime's get-off still ends with her free and physics running.
    await getOffAndStand(subject, boat);
  },
};
