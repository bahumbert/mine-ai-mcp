import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../../test-support/fake-bot/index.js";
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
