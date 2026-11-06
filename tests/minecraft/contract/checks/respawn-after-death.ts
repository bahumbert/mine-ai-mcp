/**
 * A player killed on the server (`/kill`) and the respawn Mineflayer asks for by itself (`health.js`: a `client_command` as the zero health is
 * heard): the server answers with `respawn`, then `position` (absolute, at the world's spawn: 8.5 blocks from the world's origin in 3 runs, not
 * where she died), then about one tick later `update_health` at full health, which is what makes her alive again for the client. Physics
 * restarts 1.5 s after the position (Mineflayer's own delay after a death). Measured on the real 1.21.4 server, 2026-11-06 (task 7 of plan
 * p4-01b), the order of the packets the fake sends and the events the client files from them:
 * `death_combat_event`, `update_health` 0, `respawn`, `position`, `update_health` 20; `death`, `respawn`, `spawn`, `forcedMove`.
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { answerArrives } from "../server-answer.ts";
import { namesOf, positionsOf, recordDeath, untilPhysicsAgain } from "./respawn-scene.ts";

/** More than this from the death spot is not "where she died": the lane's spawn is 8.5 blocks from the origin at the nearest, the fake's is 8. */
const MOVED_AWAY_BLOCKS = 2;

export const respawnAfterDeath: ContractCheck = {
  name: "respawn-after-death",
  // Our runtime would act on the death: the check reads the bare client.
  withoutRuntime: true,
  fixture: { cells: {}, carried: { iron_sword: 1 }, position: [0.5, -60, 0.5] },
  async run(subject) {
    const { bot } = subject;
    const diedAt = bot.entity.position.clone();
    const recorded = recordDeath(subject);
    try {
      await subject.killBot();
      await answerArrives(subject, () => recorded.heard.some(({ name }) => name === "update_health:20"), "no update_health at full health after the death", () => namesOf(recorded.heard).join(", "));
      await untilPhysicsAgain(subject, recorded.heard);
    } finally {
      recorded.stop();
    }
    // The kill's own `damage_event` comes first on the real server; the fake's `setHealth` sends none, so the checks compare the packets after it. Packets and events are
    // compared apart: where an event falls between two packets depends on whose listener was added first.
    const names = namesOf(recorded.heard);
    assert.deepEqual(
      names.filter((name) => !name.startsWith("event:") && name !== "damage_event"),
      ["death_combat_event", "entity_status:3", "update_health:0", "respawn", "position", "update_health:20"],
      "the packets of the death and the respawn",
    );
    assert.deepEqual(
      names.filter((name) => name.startsWith("event:")),
      ["event:death", "event:respawn", "event:spawn", "event:forcedMove"],
      "the events the client files",
    );
    assert.equal(bot.isSleeping, false);
    // The one `position` is the world's spawn, not the place she died: 8.5 blocks from the origin on the server (512 from a lane's death spot).
    const places = positionsOf(recorded.heard);
    assert.equal(places.length, 1, `one position for the respawn: ${JSON.stringify(places)}`);
    const awayBlocks = Math.hypot(places[0]!.x - diedAt.x, places[0]!.y - diedAt.y, places[0]!.z - diedAt.z);
    assert.ok(awayBlocks > MOVED_AWAY_BLOCKS, `she came back ${awayBlocks.toFixed(1)} blocks from where she died: the server respawns her at the world's spawn`);
    const gapMs = Math.round(recorded.heard.find(({ name }) => name === "update_health:20")!.atMs - recorded.heard.find(({ name }) => name === "respawn")!.atMs);
    return `full health came ${gapMs} ms after the respawn packet: ${names.join(", ")}`;
  },
};
