/**
 * A player killed on the server (`/kill`) and the respawn Mineflayer asks for by itself (`health.js`: a `client_command` as the zero health is
 * heard): the server answers with `respawn`, then `position` (absolute, at a random point of the spawn area: the world's spawn plus or minus
 * `spawnRadius` 10, 219 logins on a 21x21 grid, x and z -9.5 to 10.5, not where she died), then about one tick later `update_health` at full health, which is what makes her alive again for the client. Physics
 * restarts 1.5 s after the position (Mineflayer's own delay after a death). Measured on the real 1.21.4 server, 2026-11-06 (task 7 of plan
 * p4-01b), the order of the packets the fake sends and the events the client files from them:
 * `death_combat_event`, `update_health` 0, `respawn`, `position`, `update_health` 20; `death`, `respawn`, `spawn`, `forcedMove`.
 */
import assert from "node:assert/strict";
import type { ContractCheck } from "../checks.ts";
import { answerArrives } from "../server-answer.ts";
import { namesOf, positionsOf, recordDeath, untilPhysicsAgain } from "./respawn-scene.ts";

/** More than this from the death spot is not "where she died" (asked only of a death spot outside the spawn area). */
const MOVED_AWAY_BLOCKS = 2;
/**
 * Vanilla's default `spawnRadius`: the server puts her at a random point of the world's spawn plus or minus this on x and z. Measured: 219 logins of
 * plan p4-31 task 11 on a 21x21 grid, x and z -9.5 to 10.5 (`~/mcp/p4-31-t11-logs/round1-vanilla-contract.log`).
 */
const SPAWN_RADIUS_BLOCKS = 10;

export const respawnAfterDeath: ContractCheck = {
  name: "respawn-after-death",
  // Our runtime would act on the death: the check reads the bare client.
  withoutRuntime: true,
  fixture: { cells: {}, carried: { iron_sword: 1 }, position: [0.5, -60, 0.5] },
  async run(subject) {
    const { bot } = subject;
    const diedAt = bot.entity.position.clone();
    const spawn = subject.worldSpawn();
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
    // The one `position` is a point of the spawn area, not the place she died: it lies in the square the world's spawn names (a lane's death spot is 512 blocks away from it).
    const places = positionsOf(recorded.heard);
    assert.equal(places.length, 1, `one position for the respawn: ${JSON.stringify(places)}`);
    const [respawnedAt] = places as [NonNullable<(typeof places)[number]>];
    const reach = SPAWN_RADIUS_BLOCKS + 1;
    const inSpawnArea = (point: { readonly x: number; readonly z: number }) => Math.abs(point.x - spawn.x) <= reach && Math.abs(point.z - spawn.z) <= reach;
    assert.ok(inSpawnArea(respawnedAt), `she respawned at x ${respawnedAt.x}, z ${respawnedAt.z}, outside the spawn area: the world's spawn x ${spawn.x}, z ${spawn.z} plus or minus ${reach}`);
    // Lane 0 dies inside the area, where a respawn 1 block away is a fair draw: it proves only "inside the spawn area". Lanes 1 and up die 512 blocks away: they prove she moved.
    if (!inSpawnArea(diedAt)) {
      const awayBlocks = Math.hypot(respawnedAt.x - diedAt.x, respawnedAt.y - diedAt.y, respawnedAt.z - diedAt.z);
      assert.ok(awayBlocks > MOVED_AWAY_BLOCKS, `she came back ${awayBlocks.toFixed(1)} blocks from where she died, outside the spawn area: the server respawns her in the spawn area`);
    }
    const gapMs = Math.round(recorded.heard.find(({ name }) => name === "update_health:20")!.atMs - recorded.heard.find(({ name }) => name === "respawn")!.atMs);
    const at = (point: { readonly x: number; readonly y: number; readonly z: number }) => `x ${point.x}, y ${point.y}, z ${point.z}`;
    // The world spawn's y is the proof the `spawn_position` packet arrived: Mineflayer's own default before it is (0, 0, 0) (`spawn_point.js:6`), the world's spawn is not at y 0.
    return `respawned at ${at(respawnedAt)}, died at ${at(diedAt)}, world spawn ${at(spawn)}; full health came ${gapMs} ms after the respawn packet: ${names.join(", ")}`;
  },
};
