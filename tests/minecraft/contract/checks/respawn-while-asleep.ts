/**
 * A player asleep in a night bed who is hurt: the server wakes her first (`animation` 2, the leave-bed animation, and a `position` beside the bed),
 * then the damage follows, a fatal one with the same death and respawn as a player awake (check `respawn-after-death`). So `isSleeping` is false
 * from the wake on and the bed shows free; the respawn after a night in a bed is beside that bed (the bed is her spawn point), not at the world's spawn.
 * Measured on the real 1.21.4 server, 2026-11-06 (task 7 of plan p4-01b): a hit of 100 on a sleeper sent `animation` 2, `position`, `damage_event`,
 * `death_combat_event`, `update_health` 0, `respawn`, `position`, `update_health` 20.
 * Seen in 3 exploration runs of this check before the wait below was added, and held by no check: a lethal hit about 1 s after a hit of 3 (inside the server's 20 ticks of
 * hurt window) killed her with no `damage_event` at all. So the two hits are `HURT_WINDOW_PROOF_TICKS` apart, and a reader of `damage_event` must not wait for it inside a window.
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { ABSENCE_TICKS, afterServerTicks, answerArrives } from "../server-answer.ts";
import type { ContractSubject } from "../subject.ts";
import { BED_FIXTURE, BED_HEAD, bedOccupied, trySleep, untilBedOccupied } from "./bed-scene.ts";
import { type Heard, namesOf, positionsOf, recordDeath, samePlace, untilPhysicsAgain } from "./respawn-scene.ts";

/** Night: past the 12541 Mineflayer's `sleep` allows. */
const NIGHT_TICK = 14_000;
/** From the head cell's corner to where the server stands her: the cell's centre and one block along the side (measured with the bed facing east, head at +x: x + 0.5, z + 1.5, 3 runs). */
const STAND_BESIDE_HEAD = { x: 0.5, z: 1.5 };
const WOUND = 3;
const LETHAL = 100;
/** Server ticks proven after the first hit: past the hurt window's 20 (`ABSENCE_TICKS` is 21 proven). */
const HURT_WINDOW_PROOF_TICKS = ABSENCE_TICKS;

/** The packets (not the events) one hit on a sleeper brings, in order, up to `until`. */
async function hitSleeper(subject: ContractSubject, amount: number, until: string): Promise<Heard[]> {
  const recorded = recordDeath(subject);
  try {
    await subject.hurtBot(amount, null).catch((error: Error) => {
      throw new Error(`${error.message}; heard ${namesOf(recorded.heard).join(", ") || "nothing"}; isSleeping ${subject.bot.isSleeping}, health ${subject.bot.health}`);
    });
    await answerArrives(subject, () => recorded.heard.some(({ name }) => name === until), `no ${until} after the hit of ${amount}`, () => namesOf(recorded.heard).join(", "));
    if (until === "update_health:20") await untilPhysicsAgain(subject, recorded.heard);
  } finally {
    recorded.stop();
  }
  return recorded.heard.filter(({ name }) => !name.startsWith("event:"));
}

export const respawnWhileAsleep: ContractCheck = {
  name: "respawn-while-asleep",
  // Our runtime would walk to or sleep in the bed.
  withoutRuntime: true,
  fixture: { ...BED_FIXTURE, timeOfDay: NIGHT_TICK },
  async run(subject) {
    const { bot } = subject;
    assert.equal((await trySleep(subject)).slept, true, "the night bed accepts the sleep");
    await untilBedOccupied(subject, true);

    // A hit that does not kill wakes her too.
    const besideHead = subject.world(BED_HEAD).offset(STAND_BESIDE_HEAD.x, 0, STAND_BESIDE_HEAD.z);
    const wounded = namesOf(await hitSleeper(subject, WOUND, "damage_event"));
    // The health packet of the wound follows the `damage_event` (a few ms on a server, in the same call on the fake): the wake is what comes before it.
    assert.deepEqual(wounded.slice(0, wounded.indexOf("damage_event") + 1), ["animation:2", "position", "damage_event"], "the wake, then the damage");
    assert.equal(bot.isSleeping, false, "hurt, she is awake");
    await untilBedOccupied(subject, false);
    await afterServerTicks(subject, HURT_WINDOW_PROOF_TICKS, "the hurt window of the first hit");

    // A hit that kills: the wake, the damage, the death, then the respawn.
    assert.equal((await trySleep(subject)).slept, true, "the bed takes her again after the wake");
    await untilBedOccupied(subject, true);
    const fatalHeard = await hitSleeper(subject, LETHAL, "update_health:20");
    const fatal = namesOf(fatalHeard);
    assert.deepEqual(fatal, ["animation:2", "position", "damage_event", "death_combat_event", "entity_status:3", "update_health:0", "respawn", "position", "update_health:20"], "the wake, the death and the respawn");
    // Both positions, the wake's and the respawn's, are the cell beside the bed's head: the bed became her spawn.
    const places = positionsOf(fatalHeard);
    assert.equal(places.length, 2, `a position at the wake and one at the respawn: ${JSON.stringify(places)}`);
    for (const place of places) assert.ok(samePlace(place, besideHead), `a position ${JSON.stringify(place)}, not beside the head at ${besideHead}`);
    assert.equal(bot.isSleeping, false, "asleep when hit, awake in the second life");
    assert.equal(bedOccupied(subject), false, "the bed is free again");
    return `a hit on a sleeper: ${wounded.join(", ")}; a fatal one: ${fatal.join(", ")}`;
  },
};
