import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { CombatResourceObservation } from "../session/progress.js";
import { type FakeHarness, createFakeBot, itemOf } from "../test-support/fake-bot/index.js";
import { observeCombatResourceEvents } from "./combat-resource-events.js";
import { recordCombatResourceReceipt } from "./combat-resource-receipts.js";

/** A bow in hand and three arrows carried; `arm` changes the slots before the observer starts. */
function fixture(arm: (harness: FakeHarness) => void = () => undefined) {
  const harness = createFakeBot({
    slots: { 36: { name: "bow" }, 10: { name: "arrow", count: 3 } },
    entities: { 9: { name: "item", position: new Vec3(0, 64, 0) }, 10: { name: "arrow", position: new Vec3(0, 64, 0) } },
  });
  arm(harness);
  const { bot, inventory } = harness;
  const client = bot._client;
  const arrows = (count: number) => itemOf(bot.registry, "arrow", count);
  const observed: CombatResourceObservation[] = [];
  let owner = "hostile_reflex";
  let scope = "request-1";
  let action = "navigate";
  const runner = {
    ownership: () => ({ current: owner }),
    status: () => ({ activeAction: { action, startedAt: "now" } }),
    recordCombatResource: (event: CombatResourceObservation) => observed.push(event),
    combatResourceScope: () => scope,
    recordScopedCombatResource: (candidate: string, event: CombatResourceObservation) => { if (candidate === scope) observed.push(event); },
  };
  const stop = observeCombatResourceEvents(bot, runner as never);
  return { bot, client, inventory, arrows, observed, stop, idle: () => { owner = null as never; },
    directHunt: () => { owner = "task"; action = "collect_mob_drop"; }, nextRequest: () => { scope = "request-2"; } };
}

test("recorded packet sequence requires confirmation before counting an arrow release", () => {
  const f = fixture();
  try {
    recordCombatResourceReceipt(f.bot, { kind: "arrow_release_command" });
    assert.deepEqual(f.observed, [], "a release command alone is not a fired projectile");
    f.inventory.updateSlot(10, f.arrows(2));
    assert.deepEqual(f.observed, [{ kind: "arrow_fired" }]);
    f.inventory.updateSlot(10, f.arrows(1));
    assert.equal(f.observed.length, 1, "inventory loss without another release is not another shot");
  } finally { f.stop(); }
});

test("a delayed arrow confirmation cannot bleed into a successor request", () => {
  const f = fixture();
  try {
    recordCombatResourceReceipt(f.bot, { kind: "arrow_release_command" });
    f.nextRequest();
    f.inventory.updateSlot(10, f.arrows(2));
    assert.deepEqual(f.observed, []);
  } finally { f.stop(); }
});

test("a direct collect mob drop request owns combat resource receipts", () => {
  const f = fixture();
  try {
    f.directHunt();
    f.client.emit("entity_status", { entityId: f.bot.entity.id, entityStatus: 29 });
    assert.deepEqual(f.observed, [{ kind: "shield_block" }]);
  } finally { f.stop(); }
});

test("native block, status, pickup and durability facts are attributed only during combat", () => {
  const worn = (bot: FakeHarness["bot"], name: string, durabilityUsed: number) =>
    Object.assign(itemOf(bot.registry, name), { durabilityUsed });
  const f = fixture(({ bot, inventory }) => {
    inventory.updateSlot(36, worn(bot, "iron_sword", 4));
    inventory.updateSlot(6, worn(bot, "iron_chestplate", 8));
    bot.entities[9]!.getDroppedItem = () => itemOf(bot.registry, "arrow", 2);
  });
  try {
    f.client.emit("damage_event", { entityId: 7, sourceCauseId: f.bot.entity.id + 1 });
    f.inventory.updateSlot(36, worn(f.bot, "iron_sword", 5));
    f.inventory.updateSlot(6, worn(f.bot, "iron_chestplate", 9));
    f.client.emit("entity_status", { entityId: f.bot.entity.id, entityStatus: 29 });
    f.bot.emit("playerCollect", f.bot.entity, f.bot.entities[9]!);
    assert.deepEqual(f.observed.map((event) => event.kind), ["durability_used", "durability_used", "shield_block", "arrow_recovered", "arrow_recovered"]);
    f.bot.emit("playerCollect", f.bot.entity, f.bot.entities[10]!);
    assert.equal(f.observed.at(-1)?.kind, "arrow_recovered", "a recoverable projectile entity counts without item-stack metadata");
    f.idle();
    f.client.emit("entity_status", { entityId: f.bot.entity.id, entityStatus: 29 });
    assert.equal(f.observed.length, 6, "idle facts do not bleed into the next request");
  } finally { f.stop(); }
});
