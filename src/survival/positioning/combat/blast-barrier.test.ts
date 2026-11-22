import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../../test-support/fake-bot/index.js";
import { setProtectedRegionsProvider, type ProtectedRegion } from "../../../world/protected-regions.js";
import { protectedRegion } from "../../../test-support/protected-region.js";
import { blastBarrierCells } from "./blast-barrier.js";
import { blastBarrierScope } from "../../control/combat/scopes/blast-barrier.js";
import { DEFAULT_COMBAT_POLICY } from "../../policy/combat/contract.js";
import { Answered } from "../../state/answered.js";

test("a blast barrier needs an exposed segment, attachment and an unoccupied cell", () => {
  const threats = [{ id: 7, position: new Vec3(3.5, 64, 0.5), distance: 3, swelling: true, observed: true }];
  const { bot, world } = createFakeBot({ position: new Vec3(0.5, 64, 0.5), entities: { 7: { name: "creeper", position: threats[0]!.position } } });
  const cells = blastBarrierCells(bot, threats);
  assert.ok(cells.some(cell => cell.equals(new Vec3(1, 64, 0))));
  assert.ok(cells.every(cell => cell.x >= 1 && cell.x < 3), "never place into the player's body");
  world.setCell(new Vec3(1, 64, 0), "stone");
  world.setCell(new Vec3(1, 65, 0), "stone");
  assert.deepEqual(blastBarrierCells(bot, threats), [], "existing protection is not thickened");
});

/** A creeper 3 blocks east: the barrier candidates lie on x 1 and 2 (the test above). Regions are boxes over those columns. */
function barrierBot(regions: readonly ProtectedRegion[]) {
  const threats = [{ id: 7, position: new Vec3(3.5, 64, 0.5), distance: 3, swelling: true, observed: true }];
  const { bot } = createFakeBot({
    username: "Ayla", position: new Vec3(0.5, 64, 0.5), entities: { 7: { name: "creeper", position: threats[0]!.position } },
  });
  setProtectedRegionsProvider(bot, () => regions);
  return { bot, threats };
}
const column = (x: number, owner: string): ProtectedRegion => protectedRegion({
  regionId: 3, dimension: "overworld", min: { x, y: 60, z: -5 }, max: { x, y: 70, z: 5 }, owner, label: "a build",
});

test("a blast barrier is never placed in another owner's region (plan 06a T5a)", () => {
  const { bot, threats } = barrierBot([column(1, "Tom")]);
  const cells = blastBarrierCells(bot, threats);
  assert.ok(cells.length > 0, "cells outside the region remain");
  assert.ok(cells.every((cell) => cell.x !== 1));
  const all = barrierBot([{ ...column(1, "Tom"), max: { x: 3, y: 70, z: 5 } }]);
  assert.deepEqual(blastBarrierCells(all.bot, all.threats), [], "no cell outside every foreign region: no barrier");
});

test("a blast barrier prefers cells outside every region and takes the bot's own region's only when none is outside", () => {
  const some = barrierBot([column(1, "Ayla")]);
  const cells = blastBarrierCells(some.bot, some.threats);
  assert.ok(cells.some((cell) => cell.x === 1), "an own-region cell is still a candidate");
  assert.notEqual(cells[0]!.x, 1, "an outside cell comes first");
  const all = barrierBot([{ ...column(1, "Ayla"), max: { x: 3, y: 70, z: 5 } }]);
  assert.ok(blastBarrierCells(all.bot, all.threats).length > 0, "only own-region cells exist: one is offered");
});

test("a refused blast barrier is reopened by its placement facts, not quarry or player movement", () => {
  const { bot, world } = createFakeBot({ carried: { cobblestone: 8 } });
  const scope = blastBarrierScope(bot, new Vec3(1, 64, 0), () => DEFAULT_COMBAT_POLICY);
  const answered = new Answered();
  answered.remember(scope, { kind: "placement_failed", why: "fixture server refused placement" });
  // Away from the cell: the bot's own body is an entity of the game, so stepping into the cell would occupy it.
  bot.entity.position.x -= 1;
  assert.ok(answered.find(scope.capability, scope.scope));
  world.setCell(new Vec3(1, 63, 0), "air");
  assert.equal(answered.find(scope.capability, scope.scope), null);
});
