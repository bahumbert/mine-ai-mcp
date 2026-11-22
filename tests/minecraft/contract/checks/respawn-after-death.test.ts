/**
 * `respawn-after-death` on the fake, where the respawn lands is the point (plan 2026-11-15-p4-32-33-red-fixes T1): vanilla puts her at a random point of the
 * spawn area, the world's spawn plus or minus `spawnRadius` 10 (219 logins, x and z -9.5 to 10.5, `~/mcp/p4-31-t11-logs/round1-vanilla-contract.log`), so lane 0
 * (death spot in the area) can see a respawn 1 block from where she died. The fake's spawn is 8 blocks east of her feet; each case moves the world's spawn the
 * subject reports and the point the fake respawns her at.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { respawnAfterDeath } from "./respawn-after-death.ts";
import { runOnFake } from "./run-on-fake.ts";

/** The death spot of the check's fixture, lane 0. */
const DEATH_SPOT = new Vec3(...respawnAfterDeath.fixture.position);
/** A world spawn this far from the death spot has the death spot outside its area (a lane's is 512 away; the fake's world is loaded this far only). */
const SPAWN_FAR_BLOCKS = 30;
const NEAR_SPAWN = DEATH_SPOT.offset(8, 0, 0);
const FAR_SPAWN = DEATH_SPOT.offset(SPAWN_FAR_BLOCKS, 0, 0);

/** Run the check with the world's spawn at `spawn` and the fake putting her at `respawnAt` (a random point of the area on a real server). */
function runWithRespawn(spawn: Vec3, respawnAt: Vec3) {
  return runOnFake(respawnAfterDeath, {}, (subject, harness) => {
    harness.server.setRespawnPoint(respawnAt);
    return { ...subject, worldSpawn: () => spawn.clone() };
  });
}

const CASES: readonly { readonly name: string; readonly spawn: Vec3; readonly respawnAt: Vec3; readonly fails?: RegExp }[] = [
  { name: "passes a respawn 1 block from her death spot inside the spawn area (lane 0)", spawn: NEAR_SPAWN, respawnAt: DEATH_SPOT.offset(1, 0, 0) },
  { name: "passes the area's far corner (-9.5, +10.5 from the spawn), far from a death spot outside it (lane 1 and up)", spawn: FAR_SPAWN, respawnAt: FAR_SPAWN.offset(-9.5, 0, 10.5) },
  { name: "fails naming the position when the respawn is outside the spawn area", spawn: NEAR_SPAWN, respawnAt: DEATH_SPOT.offset(8 + 12, 0, 0), fails: /x 20\.5.*outside the spawn area/ },
  { name: "fails a respawn that stays at a death spot outside the spawn area", spawn: FAR_SPAWN, respawnAt: DEATH_SPOT.offset(1, 0, 0), fails: /spawn area/ },
];

for (const { name, spawn, respawnAt, fails } of CASES) {
  test(`respawn-after-death ${name}`, async () => {
    if (fails) await assert.rejects(runWithRespawn(spawn, respawnAt), fails);
    else await runWithRespawn(spawn, respawnAt);
  });
}
