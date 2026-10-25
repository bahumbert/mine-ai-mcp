/**
 * The shift (`entity_action` 0, `writeShiftKey`) lets her off the boat, and the server tells her: `position` packets
 * (physics restarts) and the boat's passenger list without her, which Mineflayer reads without clearing `bot.vehicle`
 * (Mine Labs 2026-10-21: the run 14b belief "the server tells her nothing" was never measured on a shift; review #2).
 */
import assert from "node:assert/strict";
import { writeShiftKey } from "../../../../src/navigation/mineflayer/sneak.ts";
import type { ContractCheck } from "../checks.ts";
import { BOAT_FIXTURE, getOffAndStand, listenWhileSeated, mountBoat } from "./boat-seat.ts";

export const boatGetOffByShift: ContractCheck = {
  name: "boat-get-off-by-shift",
  fixture: BOAT_FIXTURE,
  // Bare bot: our runtime acts on the passenger list itself (`vehicle-sync.ts`), the check measures the server.
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    const boat = await mountBoat(subject);
    writeShiftKey(bot, true);
    let heard: Awaited<ReturnType<typeof listenWhileSeated>>;
    try {
      heard = await listenWhileSeated(subject, boat);
    } finally {
      writeShiftKey(bot, false);
    }
    assert.equal(await subject.seatedOnServer(boat), false, "the server kept her seated after the shift");
    const answered = heard.positions >= 1 && heard.listsWithoutHer >= 1 && heard.physicsTicks > 0;
    assert.ok(answered, `the server's answer to the get-off: ${JSON.stringify(heard)}, not a position, a list without her and physics back`);
    assert.equal(bot.vehicle?.id, boat.id, "Mineflayer cleared bot.vehicle on a list that does not name her");
    await getOffAndStand(subject, boat);
  },
};
