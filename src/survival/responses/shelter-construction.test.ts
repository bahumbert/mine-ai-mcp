// Construction progress under repeated contact, and the next response from an open shelter.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createNavigationRuntime, type NavigationRuntime } from "../../navigation/index.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { combatTestContext, onAttack } from "../../test-support/combat.js";
import { createFakeBot, createFakeClock, type FakeBot, type FakeClock } from "../../test-support/fake-bot/index.js";
import { recoverCombatHealth } from "../control/combat/recovery.js";
import { CombatItemUse } from "../weapons/item-use.js";
import { hideInPlace, enclosedInPlace } from "./hide.js";
import { centerShelterCell, type ShelterBuild } from "./shelter-build.js";
import { constructShelterPass } from "./shelter-construction.js";

/** A construction attempt shared by centering and pass-bound tests. */
function createTestShelterBuild(bot: FakeBot, clock: FakeClock): ShelterBuild {
  return {
    bot, options: { signal: new AbortController().signal, threatContext: combatTestContext(bot),
      maximumMs: 5_000, recoverTo: 7 },
    itemUse: new CombatItemUse(bot, (ticks) => clock.sleep(ticks * 50)),
    constructionDeadline: clock.now() + 5_000, enclosed: false,
    dug: 0, walled: 0, capped: false, ate: null, swings: 0, recovery: null, refusal: null,
    pass: 0, blockedCells: new Map(),
  };
}

test("a fence wall is broken with a server answer, closed, and recovery continues from the completed shelter", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, world, server } = createFakeBot({
    clock, health: 7, carried: { cobblestone: 32, iron_pickaxe: 1 },
    cells: { "1,65,0": "nether_brick_fence" },
  });
  using _installed = clock.install();
  await using navigation = createNavigationRuntime(bot);
  // The fork's dig predicts air; only the later server packet confirms removal (bot.ts #awaitServerBreak).
  const stop = server.onPacket("block_dig", (data) => {
    const packet = data as { status: number; location: Vec3 };
    if (packet.status === 2) clock.after(50, () => {
      world.setCell(packet.location, "air");
      bot._client.emit("block_change", { location: packet.location, type: 0 });
    });
  });
  try {
    const context = combatTestContext(bot);
    const hidden = await clock.settle(hideInPlace(bot, {
      navigation, signal: new AbortController().signal, threatContext: context, maximumMs: 5_000, recoverTo: 7,
    }), 6_000);
    assert.equal(hidden.kind, "recovered", hidden.error ?? "");
    assert.equal(bot.blockAt(new Vec3(1, 65, 0))?.name, "cobblestone");
    assert.equal(enclosedInPlace(bot), true);
    clock.after(100, () => { bot.health = 20; });
    const next = await clock.settle(recoverCombatHealth(bot, navigation, context, new AbortController().signal, () => {}), 6_000);
    assert.deepEqual(next, { kind: "recovered" });
  } finally { stop(); }
});

test("unsafe fence breaks leave the wall intact and name why the shelter is open", async () => {
  for (const variant of ["no navigation", "dig prohibited", "lava", "falling", "slow", "server silent", "server fence", "unloaded target"] as const) {
    const clock = createFakeClock({ mode: "mocked" });
    const { bot, world, server } = createFakeBot({
      clock, health: 7, carried: { cobblestone: 32, ...(variant === "slow" ? {} : { iron_pickaxe: 1 }) },
      cells: { "1,65,0": variant === "unloaded target" ? "void" : "nether_brick_fence",
        ...(variant === "lava" ? { "2,65,0": "lava" } : {}),
        ...(variant === "falling" ? { "1,66,0": "sand" } : {}) },
    });
    using _installed = clock.install();
    await using navigation = createNavigationRuntime(bot);
    const context = combatTestContext(bot);
    const stop = server.onPacket("block_dig", (data) => {
      const packet = data as { status: number; location: Vec3 };
      if (packet.status === 2) clock.after(50, () => {
        world.setCell(packet.location, "nether_brick_fence");
        if (variant === "server fence")
          bot._client.emit("block_change", { location: packet.location, type: bot.blockAt(packet.location)!.stateId });
      });
    });
    try {
      const result = await clock.settle(hideInPlace(bot, {
        ...(variant === "no navigation" ? {} : { navigation }),
        signal: new AbortController().signal,
        threatContext: variant === "dig prohibited"
          ? { ...context, policy: { ...context.policy, terrain: { ...context.policy.terrain, dig: false } } } : context,
        maximumMs: variant === "slow" ? 2_000 : 5_000, recoverTo: 7,
      }), 10_000);
      assert.equal(result.kind, "failed", variant);
      assert.match(result.error ?? "", /1,65,0/, variant);
      const reason = variant.startsWith("unloaded") ? /not loaded/ : variant === "slow" ? /digs in .* s, .* s left/
        : variant === "falling" ? /falling block/
        : variant === "lava" ? /liquid/
        : variant === "server silent" ? /server did not confirm/
        : variant === "server fence" ? /removal was not observed|block never changed/
        : /cannot be replaced by placement/;
      assert.match(result.error ?? "", reason, variant);
      assert.equal(bot.blockAt(new Vec3(1, 65, 0))?.name, variant === "unloaded target" ? undefined : "nether_brick_fence", variant);
      if (!["server silent", "server fence"].includes(variant))
        assert.equal(server.packets.some((packet) => packet.name === "block_dig" &&
          (packet.data as { status: number }).status === 0), false, variant);
    } finally { stop(); }
  }
});

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
  const build = createTestShelterBuild(bot, clock);
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

for (const occupant of ["cow", "ender_dragon"]) for (const leaves of [false, true])
  test(`a ${occupant} in a wall cell waits for ${leaves ? "departure" : "the deadline"} while the hazard holds`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    const { bot } = createFakeBot({
      clock, health: 7, carried: { cobblestone: 32 },
      cells: { "1,65,0": "stone" },
      entities: { 2: { name: occupant, position: new Vec3(occupant === "cow" ? 1.5 : 9.5, 64, 0.5) } },
    });
    using _installed = clock.install();
    if (leaves) clock.after(1_500, () => { bot.entities[2]!.position = new Vec3(30, 64, 30); });
    const started = clock.now();
    const result = await clock.settle(hideInPlace(bot, {
      signal: new AbortController().signal, threatContext: combatTestContext(bot), maximumMs: 5_000, recoverTo: 7,
      holdWhile: () => !enclosedInPlace(bot),
    }), 6_000);
    const variant = `${occupant}, leaves ${leaves}`;
    assert.equal(result.kind, leaves ? "recovered" : "failed", `${variant}: ${result.error ?? ""}`);
    assert.equal(enclosedInPlace(bot), leaves, variant);
    assert.equal(result.capped, true, variant);
    assert.equal(result.swings, 0, variant);
    assert.ok(clock.now() - started >= (leaves ? 1_500 : 5_000), variant);
    if (!leaves) assert.match(result.error ?? "", /not finished within/, variant);
  });

test("an intruder replacing a passive occupant in the same pass still stops construction on the third blocked pass", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot } = createFakeBot({
    clock, health: 7, carried: { cobblestone: 32 }, cells: { "1,65,0": "stone" },
    entities: {
      2: { name: "cow", position: new Vec3(1.5, 64, 0.5) },
      3: { name: "zombie", position: new Vec3(30, 64, 30) },
    },
  });
  using _installed = clock.install();
  const build = createTestShelterBuild(bot, clock);
  clock.after(50, () => {
    bot.entities[2]!.position = new Vec3(30, 64, 30);
    bot.entities[3]!.position = new Vec3(1.5, 64, 0.5);
  });
  for (let pass = 0; pass < 2; pass++)
    assert.equal(await clock.settle(constructShelterPass(build), 6_000), "again");
  const third = await clock.settle(constructShelterPass(build), 6_000);
  assert.notEqual(third, "again");
  assert.notEqual(third, "built");
  if (typeof third === "object") assert.match(third.error, /still open.*1,64,0/);
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
