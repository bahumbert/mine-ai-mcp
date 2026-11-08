import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { setProtectedRegionsProvider } from "../../world/protected-regions.js";
import { placeCarriedBed } from "./bed-placement.js";

/** Protected regions at the carried bed (plan 2026-11-07-p4-06a-threat T5b, ADR-012): the placement core refuses a footprint of another's region. */
function bedScene(owner: string | "own") {
  const harness = createFakeBot({ position: new Vec3(0.5, 64, 0.5), carried: { white_bed: 1 } });
  const regionOwner = owner === "own" ? harness.bot.username : owner;
  setProtectedRegionsProvider(harness.bot, () => [
    { regionId: 5, dimension: "overworld", owner: regionOwner, label: "Tom's yard", min: { x: -10, y: 60, z: -10 }, max: { x: 10, y: 70, z: 10 } },
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
  assert.equal(placePackets(harness), 0);
});

test("a bed is placed in the bot's own region", async () => {
  const harness = bedScene("own");
  const result = await harness.clock.settle(placeCarriedBed(harness.bot), 20_000);
  assert.equal(result.kind, "placed", JSON.stringify(result));
  assert.equal(placePackets(harness), 1);
});
