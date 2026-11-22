import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { setProtectedRegionsProvider } from "../../world/protected-regions.js";
import { protectedRegion } from "../../test-support/protected-region.js";
import { placeCarriedBed } from "./bed-placement.js";

/** Protected regions at the carried bed (plan 2026-11-07-p4-06a-threat T5b, ADR-012): the placement core refuses a footprint of another's region. */
function bedScene(owner: string | "own") {
  const harness = createFakeBot({ position: new Vec3(0.5, 64, 0.5), carried: { white_bed: 1 } });
  const regionOwner = owner === "own" ? harness.bot.username : owner;
  setProtectedRegionsProvider(harness.bot, () => [
    protectedRegion({ regionId: 5, dimension: "overworld", owner: regionOwner, label: "Tom's yard", min: { x: -10, y: 60, z: -10 }, max: { x: 10, y: 70, z: 10 } }),
  ]);
  return harness;
}

const placePackets = (harness: ReturnType<typeof bedScene>) => harness.server.packets.filter((packet) => packet.name === "block_place").length;

test("a bed is not placed in another owner's region: every footprint refused naming it, no placement packet", async () => {
  const harness = bedScene("Tom");
  const result = await harness.clock.settle(placeCarriedBed(harness.bot), 20_000);
  assert.equal(result.kind, "failed");
  if (result.kind !== "failed") return;
  assert.equal(result.reason, "placement_failed");
  assert.ok(result.error.includes("(owner Tom)"), result.error);
  assert.ok(result.error.endsWith("; go_to other flat ground and call sleep again."), result.error);
  assert.equal(placePackets(harness), 0);
});

/** Stone walls around a bot standing at the origin: every cell of x, z in -5..5 and y 64..66, but its own two cells. */
function walledCells(): Record<string, string> {
  const cells: Record<string, string> = {};
  for (let x = -5; x <= 5; x += 1) for (let z = -5; z <= 5; z += 1) for (const y of [64, 65, 66]) cells[`${x},${y},${z}`] = "stone";
  delete cells["0,64,0"];
  delete cells["0,65,0"];
  return cells;
}

test("no footprint in a walled pit: refused with the counts and the next action; moved to open ground, the next call places the bed", async () => {
  const harness = createFakeBot({ position: new Vec3(0.5, 64, 0.5), carried: { white_bed: 1 }, cells: walledCells() });
  const first = await harness.clock.settle(placeCarriedBed(harness.bot), 20_000);
  assert.equal(first.kind, "failed");
  if (first.kind !== "failed") return;
  assert.equal(first.reason, "no_footprint");
  assert.match(first.error, /of 960 footprints within 4 blocks/);
  assert.ok(first.error.includes("960 blocked"), first.error);
  assert.ok(
    first.error.endsWith("go_to open flat ground, two dry clear cells side by side on full blocks, and call sleep again."),
    first.error,
  );
  assert.equal(placePackets(harness), 0);

  harness.bot.entity.position = new Vec3(20.5, 64, 20.5);
  const second = await harness.clock.settle(placeCarriedBed(harness.bot), 20_000);
  assert.equal(second.kind, "placed", JSON.stringify(second));
  assert.equal(placePackets(harness), 1);
});

test("a bed is placed in the bot's own region", async () => {
  const harness = bedScene("own");
  const result = await harness.clock.settle(placeCarriedBed(harness.bot), 20_000);
  assert.equal(result.kind, "placed", JSON.stringify(result));
  assert.equal(placePackets(harness), 1);
});
