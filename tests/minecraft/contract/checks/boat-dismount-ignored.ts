/** `dismount()` sends the jump input (`entities.js:902-916`), which a boat ignores: both sides still have her seated. */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { BOAT_FIXTURE, getOffAndStand, listenWhileSeated, mountBoat } from "./boat-seat.ts";

export const boatDismountIgnored: ContractCheck = {
  name: "boat-dismount-ignored",
  fixture: BOAT_FIXTURE,
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    const boat = await mountBoat(subject);
    bot.dismount();
    const heard = await listenWhileSeated(subject, boat);
    assert.equal(await subject.seatedOnServer(boat), true, "the server let her off on dismount()");
    assert.deepEqual(heard, { positions: 0, listsWithoutHer: 0, physicsTicks: 0 }, `the client heard of a get-off: ${JSON.stringify(heard)}`);
    assert.equal(bot.vehicle?.id, boat.id);
    await getOffAndStand(subject, boat);
  },
};
