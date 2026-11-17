import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { HostileContext } from "../control/combat/context.js";
import { type FakeEntitySpec, createFakeBot, createFakeClock, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { serverTickPace } from "../../world/server-tick-pace.js";
import { swingReadiness } from "./swing-readiness.js";
import { addItemsToServerTag } from "../../test-support/datapack-tags.js";
import { defendWhileRetreating } from "./retreat-melee.js";

/** A wall between the bot's eye and the magma cube, which a raycast meets. */
const COVER_CELLS = [new Vec3(1, 64, 0), new Vec3(1, 65, 0)];

for (const rate of [20, 10]) test(`retreat swings deal full sword damage at ${rate} tps`, async () => {
  const { bot, clock, server } = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond: rate },
    carried: { iron_sword: 1 },
    entities: { 7: { name: "zombie", position: new Vec3(0.5, 64, 2.5) } },
  });
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  using _readiness = swingReadiness(bot);
  await clock.advance(4_000); // Two time packets establish the server's pace.
  const started = server.gameTime;
  const target = bot.entities[7]!;
  const healthKey = bot.registry.entitiesByName.zombie!.metadataKeys!.indexOf("health");
  const hits: number[] = [];
  bot.on("entityHurt", entity => {
    if (entity.id !== 7) return;
    hits.push(clock.now() - 4_000);
  });
  bot.on("entityUpdate", entity => {
    if (entity.id !== 7) return;
    assert.equal(target.metadata[healthKey], 20 - 6 * hits.length, "every retreat hit deals 6 x 1.0");
    target.position.set(0.5, 64, 2.5);
  });
  using _defence = defendWhileRetreating(bot, { resolvedIds: new Set(), attackerIds: new Set() }, new AbortController().signal);
  await clock.advance(rate === 20 ? 1_450 : 2_800);
  assert.deepEqual(hits, rate === 20 ? [100, 750, 1_400] : [100, 1_400, 2_700]);
  assert.equal(server.gameTime - started, rate === 20 ? 29 : 28);
});

for (const exit of ["abort", "death", "target death", "stopped"] as const) test(`retreat recovery stops cleanly on ${exit}`, async () => {
  const { bot, clock, server, combat } = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond: 10 }, carried: { iron_sword: 1 },
    entities: { 7: { name: "zombie", position: new Vec3(0.5, 64, 2.5) } },
  });
  using _timers = clock.install();
  using _pace = serverTickPace(bot);
  using readiness = swingReadiness(bot);
  readiness.restart();
  const stop = new AbortController();
  const added = listenersAddedSince(bot);
  const resolvedIds = new Set<number>();
  const defence = defendWhileRetreating(bot, { resolvedIds, attackerIds: new Set() }, stop.signal);
  if (exit === "stopped") server.stop();
  await clock.advance(100);
  if (exit === "abort") stop.abort();
  if (exit === "death") bot.health = 0;
  if (exit === "target death") {
    combat.kill(7);
    resolvedIds.add(7);
  }
  const age = bot.time.age;
  await clock.advance(5_000);
  assert.equal(defence.evidence().attacks, 0);
  if (exit === "stopped") assert.equal(bot.time.age, age);
  defence[Symbol.dispose]();
  defence[Symbol.dispose]();
  await clock.advance(5_000);
  assert.equal(added("physicsTick"), 0);
  assert.equal(added("entityDead"), 0);
  assert.equal(clock.pendingGlobalTimers(), 0);
});

/** Retreat defence must not steal the route's equip, look or control operations: each fails the test. */
function stolen(operation: string) {
  return () => assert.fail(`retreat defence used ${operation}, which belongs to the route`);
}

/** A size-2 magma cube two blocks from a bot holding a diamond sword, and with `neutral`, a piglin beside it. */
function fixture(options: { neutral?: boolean; weapon?: string; datapackSwords?: readonly string[] } = {}) {
  const metadata: unknown[] = [];
  const cube = { width: 1.04, height: 1.04 };
  const entities: Record<number, FakeEntitySpec> = {
    7: { name: "magma_cube", position: new Vec3(2, 64, 0), metadata, ...cube },
  };
  if (options.neutral) entities[8] = { name: "piglin", position: new Vec3(1, 64, 1), metadata, ...cube };
  const harness = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }),
    position: new Vec3(0, 64, 0),
    health: 11,
    carried: { [options.weapon ?? "diamond_sword"]: 1 },
    entities,
    overrides: {
      attack: () => {
        attacks.push(ticks);
      },
      equip: stolen("equip"),
      look: stolen("look"),
      lookAt: stolen("lookAt"),
      setControlState: stolen("setControlState"),
      clearControlStates: stolen("clearControlStates"),
    },
  });
  const { bot, clock, combat, world } = harness;
  if (options.datapackSwords) addItemsToServerTag(harness, "swords", options.datapackSwords);
  metadata[bot.registry.entitiesByName.magma_cube!.metadataKeys!.indexOf("size")] = 2;
  const target = bot.entities[7]!;
  const attacks: number[] = [];
  let ticks = 0;
  bot.on("physicsTick", () => {
    ticks += 1;
  });
  const resolvedIds = new Set<number>();
  const context: HostileContext = {
    resolvedIds,
    attackerIds: new Set(),
  };
  return {
    bot,
    combat,
    clock,
    entities: harness.entities,
    target,
    context,
    resolvedIds,
    attacks,
    advance: (count = 1) => clock.advance(50 * count),
    cover: (value: boolean) => {
      for (const cell of COVER_CELLS) world.setCell(cell, value ? "stone" : "air");
    },
  };
}

test("retreat strikes respect sword cooldown, observed death, and observer disposal without steering", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  using _pace = serverTickPace(f.bot);
  using _readiness = swingReadiness(f.bot);
  await f.advance(80); // Establish pace before the retreat, as the runtime's time observer does.
  const added = listenersAddedSince(f.bot);
  const defence = defendWhileRetreating(f.bot, f.context, new AbortController().signal);
  await f.advance(14);
  // The hostile observer owns the shared record of dead threats.
  f.resolvedIds.add(f.target.id);
  f.combat.kill(f.target.id);
  await f.advance(20);
  assert.deepEqual(defence.evidence(), { attacks: 2, weaponsUsed: ["diamond_sword"], killedTargetIds: [7] });
  defence[Symbol.dispose]();
  assert.equal(added("physicsTick"), 0);
  assert.equal(added("entityDead"), 0);
});

test("retreat does not strike through cover, beyond reach, during a dig, or after cancellation", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  const controller = new AbortController();
  using defence = defendWhileRetreating(f.bot, f.context, controller.signal);
  f.cover(true);
  await f.advance();
  f.cover(false);
  f.target.position.x = 4;
  await f.advance();
  f.target.position.x = 2;
  f.bot.targetDigBlock = f.bot.blockAt(new Vec3(0, 63, 0))!;
  await f.advance();
  Object.assign(f.bot, { targetDigBlock: null });
  f.bot.usingHeldItem = true;
  await f.advance();
  f.bot.usingHeldItem = false;
  assert.deepEqual(f.attacks, []);
  await f.advance();
  assert.deepEqual(f.attacks, [5]);
  controller.abort();
  await f.advance(20);
  assert.deepEqual(f.attacks, [5]);
  assert.equal(defence.evidence().attacks, 1);
});

test("retreat preserves nearby neutrals from sword sweep and never selects them as targets", async () => {
  const f = fixture({ neutral: true });
  using _timers = f.clock.install();
  const neutral = f.bot.entities[8]!;
  using defence = defendWhileRetreating(f.bot, f.context, new AbortController().signal);
  await f.advance();
  assert.deepEqual(f.attacks, []);
  neutral.position.x = 10;
  await f.advance();
  assert.deepEqual(f.attacks, [2]);
  f.entities.remove(7);
  neutral.position.x = 1;
  await f.advance(20);
  assert.deepEqual(f.attacks, [2]);
  assert.equal(defence.evidence().attacks, 1);
});

test("retreat withholds vanilla and datapack swords beside a neutral", async () => {
  for (const { weapon, datapackSwords } of [
    ...["wooden_sword", "stone_sword", "golden_sword", "iron_sword", "diamond_sword", "netherite_sword"]
      .map(weapon => ({ weapon, datapackSwords: undefined })),
    { weapon: "stick", datapackSwords: ["stick"] },
  ]) {
    const f = fixture({ neutral: true, weapon, datapackSwords });
    using _timers = f.clock.install();
    assert.equal(f.bot.heldItem?.name, weapon);
    using _defence = defendWhileRetreating(f.bot, f.context, new AbortController().signal);
    await f.advance(20);
    assert.deepEqual(f.attacks, [], weapon);
  }
});

test("retreat swings a held item outside the swords family beside a neutral", async () => {
  const f = fixture({ neutral: true, weapon: "stick" });
  using _timers = f.clock.install();
  using _defence = defendWhileRetreating(f.bot, f.context, new AbortController().signal);
  await f.advance(20);
  assert.ok(f.attacks.length > 0);
});
