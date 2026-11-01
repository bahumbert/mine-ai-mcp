import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { CombatResourceObservation } from "../session/progress.js";
import { type FakeClock, type FakeHarness, createFakeBot, createFakeClock, itemOf } from "../test-support/fake-bot/index.js";
import { observeCombatResourceEvents } from "./combat-resource-events.js";
import { recordCombatResourceReceipt } from "./combat-resource-receipts.js";

/** A bow in hand and three arrows carried; `arm` changes the slots before the observer starts. */
function fixture(arm: (harness: FakeHarness) => void = () => undefined, clock?: FakeClock) {
  const harness = createFakeBot({
    ...(clock && { clock }),
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

// Plan 2026-10-27-p1-monotonic-clock T5: the 1.5 s shot window and the 0.5 s durability window are durations.
const worn = (bot: FakeHarness["bot"], name: string, durabilityUsed: number) =>
  Object.assign(itemOf(bot.registry, name), { durabilityUsed });

for (const row of [
  { name: "a wall step forward of 1.2 s does not close the 1.5 s shot window early", advanceMs: 1_000, wallStepMs: 1_200, fired: true },
  { name: "a wall step back of 0.8 s does not hold the shot window open", advanceMs: 1_600, wallStepMs: -800, fired: false },
]) {
  test(`an arrow release confirms inside its window on monotonic time: ${row.name}`, async () => {
    const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
    using _installed = clock.install();
    // Live the two clocks read unrelated values (uptime vs epoch): a start taken on the wrong one cannot pass.
    clock.stepWallClock(5_000);
    const f = fixture(() => undefined, clock);
    try {
      recordCombatResourceReceipt(f.bot, { kind: "arrow_release_command" });
      await clock.advance(row.advanceMs);
      clock.stepWallClock(row.wallStepMs);
      f.inventory.updateSlot(10, f.arrows(2));
      assert.deepEqual(f.observed.map((event) => event.kind), row.fired ? ["arrow_fired"] : []);
    } finally { f.stop(); }
  });
}

for (const row of [
  { name: "a wall step forward of 1.2 s does not close the 0.5 s window early", advanceMs: 300, wallStepMs: 1_200, counted: true },
  { name: "a wall step back of 0.8 s does not hold the window open", advanceMs: 600, wallStepMs: -800, counted: false },
]) {
  test(`a durability change counts inside the damage window on monotonic time: ${row.name}`, async () => {
    const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
    using _installed = clock.install();
    clock.stepWallClock(5_000);
    const f = fixture(({ bot, inventory }) => inventory.updateSlot(36, worn(bot, "iron_sword", 4)), clock);
    try {
      f.client.emit("damage_event", { entityId: 7, sourceCauseId: f.bot.entity.id + 1 });
      await clock.advance(row.advanceMs);
      clock.stepWallClock(row.wallStepMs);
      f.inventory.updateSlot(36, worn(f.bot, "iron_sword", 5));
      assert.deepEqual(f.observed.map((event) => event.kind), row.counted ? ["durability_used"] : []);
    } finally { f.stop(); }
  });
}
