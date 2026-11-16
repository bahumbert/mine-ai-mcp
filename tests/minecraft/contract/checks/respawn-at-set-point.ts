/** Measure a command-set personal spawn, its player-data keys and an obstructed point on the real server. */
import assert from "node:assert/strict";
import type { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";
import { answerArrives } from "../server-answer.ts";
import type { ContractSubject } from "../subject.ts";
import { namesOf, positionsOf, recordDeath, untilPhysicsAgain } from "./respawn-scene.ts";
import { createMeasureReader } from "./combat-data-measure.ts";

/** The world's spawn area, including the half-block position inside its outermost cells. */
const SPAWN_REACH = 11;

/** Whether a position lies in the world's spawn square (respawn-after-death, measured 1.21.4). */
function inSpawnArea(point: { x: number; z: number }, spawn: Vec3): boolean {
  return Math.abs(point.x - spawn.x) <= SPAWN_REACH && Math.abs(point.z - spawn.z) <= SPAWN_REACH;
}

/** Kill with a fresh recording and wait until the next life can move. */
async function killAndRecord(subject: ContractSubject) {
  const recorded = recordDeath(subject);
  try {
    await subject.killBot();
    await answerArrives(subject, () => recorded.heard.some(({ name }) => name === "update_health:20"), "no full health after the death", () => namesOf(recorded.heard).join(", "));
    await untilPhysicsAgain(subject, recorded.heard);
    return recorded.heard;
  } finally {
    recorded.stop();
  }
}

/** Measure fallback without teaching the fake an unmeasured obstruction rule (P4-25 T2). */
async function obstructAndRecord(subject: ContractSubject, cell: Vec3, spawn: Vec3): Promise<string> {
  if (subject.chunkPackets === "not-simulated") return "obstructed point: not simulated (P4-25 T2 fake follow-up)";
  let spawnReset = false;
  const onReset = () => { spawnReset = true; };
  subject.bot.on("spawnReset", onReset);
  try {
    await subject.setBlock(cell, "stone");
    await subject.setBlock(cell.offset(0, 1, 0), "stone");
    const heard = await killAndRecord(subject);
    assert.ok(namesOf(heard).includes("update_health:20"), "an obstructed respawn still starts a full-health life");
    return `obstructed point: positions ${JSON.stringify(positionsOf(heard))}, in world spawn area ${positionsOf(heard).some((point) => inSpawnArea(point, spawn))}, spawnReset ${spawnReset}`;
  } finally {
    subject.bot.off("spawnReset", onReset);
    // Fallback unloads the arena: return after recording, so both the server and client can see the cleanup edits (P4-25 T2, 2026-11-16).
    const [returned] = await createMeasureReader(subject).read([`run teleport ${subject.bot.username} ${cell.x + 0.5} ${cell.y + 3} ${cell.z + 0.5}`]);
    assert.ok(returned?.present, "returned to the arena to clear the obstruction");
    try {
      await subject.setBlock(cell, "air");
    } finally {
      await subject.setBlock(cell.offset(0, 1, 0), "air");
    }
  }
}

export const respawnAtSetPoint: ContractCheck = {
  name: "respawn-at-set-point",
  withoutRuntime: true,
  fixture: { cells: {}, carried: { iron_sword: 1 }, position: [0.5, -60, 0.5] },
  async run(subject) {
    const spawn = subject.worldSpawn().clone();
    const cell = subject.world([4, -60, 4]);
    await subject.setSpawnPoint(cell);
    const keys = await subject.spawnPointKeys();
    const expected = `SpawnX:${cell.x},SpawnY:${cell.y},SpawnZ:${cell.z}`;
    const compound = `respawn:{pos:[I;${cell.x},${cell.y},${cell.z}]}`;
    assert.ok(keys === expected || keys === compound, `player data holds the command-set cell: ${keys}`);
    const heard = await killAndRecord(subject);
    const places = positionsOf(heard);
    assert.equal(places.length, 1, `one position after respawn: ${JSON.stringify(places)}`);
    const woke = places[0]!;
    // The respawn packet starts 0.1 above the cell, before gravity settles it (real 1.21.4, P4-25 T2, 2026-11-16).
    assert.ok(Math.abs(woke.x - cell.x - 0.5) <= 0.6 && Math.abs(woke.z - cell.z - 0.5) <= 0.6 && Math.abs(woke.y - cell.y - 0.1) < 0.000_001,
      `respawn at the command-set cell ${cell}: ${JSON.stringify(woke)}`);
    if (!inSpawnArea(cell, spawn)) assert.equal(inSpawnArea(woke, spawn), false, "a shifted personal spawn is outside the world spawn area");
    const obstructed = await obstructAndRecord(subject, cell, spawn);
    return `player ${subject.bot.username}; keys {${keys}}; respawn offsets DX=${woke.x - cell.x}, DY=${woke.y - cell.y}, DZ=${woke.z - cell.z}; ${obstructed}`;
  },
};
