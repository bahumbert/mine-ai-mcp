// Construction progress under repeated contact, and the next response from an open shelter.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { combatTestContext, onAttack } from "../../test-support/combat.js";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { recoverCombatHealth } from "../control/combat/recovery.js";
import { CombatItemUse } from "../weapons/item-use.js";
import { hideInPlace, enclosedInPlace } from "./hide.js";
import { centerShelterCell, type ShelterBuild } from "./shelter-build.js";

test("a known intruder cannot mask a new attacker arriving while the shelter recenters", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot } = createFakeBot({
    clock, simulatePhysics: true, position: new Vec3(0.15, 64, 0.5), carried: { cobblestone: 32 },
    entities: {
      2: { name: "zombie", position: new Vec3(1.5, 64, 0.5) },
      3: { name: "zombie", position: new Vec3(20, 64, 20) },
    },
  });
  using _installed = clock.install();
  clock.after(50, () => { bot.entities[3]!.position = new Vec3(0.5, 64, 1.2); });
  const build: ShelterBuild = {
    bot, options: { signal: new AbortController().signal, threatContext: combatTestContext(bot),
      maximumMs: 5_000, recoverTo: 7 },
    itemUse: new CombatItemUse(bot, (ticks) => clock.sleep(ticks * 50)),
    constructionDeadline: clock.now() + 5_000, enclosed: false,
    dug: 0, walled: 0, capped: false, ate: null, swings: 0, recovery: null, refusal: null,
    pass: 0, blockedCells: new Map(),
  };
  assert.equal(await clock.settle(centerShelterCell(build, new Vec3(0, 64, 0)), 6_000), false);
});

test("delayed walls keep progressing between repels of two-hit intruders at seven health", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, server } = createFakeBot({
    clock, health: 7, carried: { cobblestone: 32 },
    entities: { 2: { name: "zombie", position: new Vec3(20, 64, 20), metadata: { 9: 2 } },
      3: { name: "spider", position: new Vec3(20, 64, 20), metadata: { 9: 2 } } },
  });
  using _installed = clock.install();
  const resolvedIds = new Set<number>();
  const context = { ...combatTestContext(bot), resolvedIds };
  bot.on("entityDead", (entity) => { resolvedIds.add(entity.id); });
  const equip = bot.equip;
  bot.equip = async (item, destination) => {
    await clock.sleep(100);
    return equip(item, destination);
  };
  clock.after(50, () => {
    // Scripted arrival; damage, hurt windows and the two bare-hand hits use the shared server model.
    bot.entities[2]!.position = new Vec3(0.5, 64, 0.9);
    bot.entities[3]!.position = new Vec3(0.1, 64, 0.5);
  });
  const blocksAtSwings: number[] = [];
  onAttack(server, () => {
    blocksAtSwings.push(bot.inventory.items().find((item) => item.name === "cobblestone")?.count ?? 0);
  });
  const result = await clock.settle(hideInPlace(bot, {
    signal: new AbortController().signal, threatContext: context, maximumMs: 5_000, recoverTo: 7,
  }), 6_000);
  assert.equal(result.kind, "recovered", result.error ?? "");
  assert.equal(enclosedInPlace(bot), true);
  assert.equal(bot.health, 7);
  assert.ok(blocksAtSwings.length >= 2, "the first hit does not kill the intruder");
  assert.ok(blocksAtSwings[1]! < blocksAtSwings[0]!, "another wall completes before the second repel");
});

for (const offCenter of [false, true]) test(`three blocked passes leave a named open cell and hand recovery to withdrawal (off center ${offCenter})`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot } = createFakeBot({
    clock, health: 7, carried: { cobblestone: 32 },
    position: new Vec3(offCenter ? 0.15 : 0.5, 64, 0.5), simulatePhysics: offCenter,
    // The solid head-height cell hides the intruder from melee; its body blocks the missing lower wall.
    cells: { "1,65,0": "stone" },
    entities: { 2: { name: "zombie", position: new Vec3(1.5, 64, 0.5) } },
  });
  using _installed = clock.install();
  const context = combatTestContext(bot);
  const result = await clock.settle(hideInPlace(bot, {
    signal: new AbortController().signal, threatContext: context, maximumMs: 5_000, recoverTo: 7,
    holdWhile: () => true,
  }), 6_000);
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /still open.*1,64,0/);
  assert.doesNotMatch(result.error ?? "", /not finished within/);
  assert.equal(result.capped, true, "other cells are completed despite the blocked wall");
  assert.equal(enclosedInPlace(bot), false);
  const navigation = {
    world: new MemoryWorld(),
    navigate: async ({ timeoutMs }: { timeoutMs: number }) => {
      assert.ok(timeoutMs <= context.policy.evade_timeout_ms);
      return { status: "stopped", reason: "withdrawal route unavailable", elapsedMs: 0 };
    },
  } as unknown as NavigationRuntime;
  const responses: unknown[] = [];
  const started = clock.now();
  const next = await clock.settle(recoverCombatHealth(bot, navigation, context, new AbortController().signal,
    (facts) => responses.push(facts)), context.policy.recovery_timeout_ms + context.policy.evade_timeout_ms);
  assert.equal(next.kind, "blocked");
  assert.match(JSON.stringify(responses), /evade/);
  assert.ok(clock.now() - started < context.policy.recovery_timeout_ms + context.policy.evade_timeout_ms);
  assert.equal(bot.usingHeldItem, false);
});
