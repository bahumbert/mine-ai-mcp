// Construction progress under repeated contact, and the next response from an open shelter.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createNavigationRuntime, installNativeDigClock, type NavigationRuntime } from "../../navigation/index.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { combatTestContext, onAttack } from "../../test-support/combat.js";
import { createFakeBot, createFakeClock, type FakeBot, type FakeBotOptions, type FakeCell, type FakeClock, type FakeServer } from "../../test-support/fake-bot/index.js";
import { SEALED_BOX } from "../../test-support/shelter-shell.js";
import { countCapBlocks } from "../positioning/combat/hide-blocks.js";
import { waitForServerTicks } from "../../world/world-age.js";
import { serverTickPace } from "../../world/server-tick-pace.js";
import { recoverCombatHealth } from "../control/combat/recovery.js";
import { CombatItemUse } from "../weapons/item-use.js";
import { hideInPlace, enclosedInPlace } from "./hide.js";
import { centerShelterCell, type ShelterBuild } from "./shelter-build.js";
import { constructShelterPass, sealMarginCells } from "./shelter-construction.js";

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

for (const cause of ["hazard", "constrained"] as const) test(`construction records ${cause} and the open shell`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot } = createFakeBot({ clock, health: 7 });
  using _installed = clock.install();
  const base = createTestShelterBuild(bot, clock);
  const build = { ...base, options: { ...base.options,
    ...(cause === "hazard" ? { unsafe: () => "danger" } : {
      threatContext: { ...base.options.threatContext, policy: { ...base.options.threatContext.policy, hide: "never" as const } },
    }) } };
  const result = await clock.settle(constructShelterPass(build), 6_000);
  assert.equal(typeof result, "object");
  if (typeof result !== "object") throw new Error("expected refusal");
  assert.equal(result.refusal?.cause, cause);
  assert.equal(result.refusal?.hazard, cause === "hazard" ? "danger" : null);
  assert.ok(result.refusal?.shell.some((entry) => entry.block === "air"));
});

for (const ticksPerSecond of [20, 10]) for (const change of ["depart", "move", "replace"] as const)
test(`deadline snapshot records current occupancy after ${change} at ${ticksPerSecond} tps`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot } = createFakeBot({ clock, server: { ticksPerSecond }, health: 7, carried: { cobblestone: 32 },
    cells: { "1,65,0": "stone" }, entities: { 61: { name: "blaze", position: new Vec3(1.5, 64, 0.5) },
      62: { name: "zombie", position: new Vec3(30, 64, 30) } } });
  using _installed = clock.install();
  const build = createTestShelterBuild(bot, clock);
  assert.equal(await clock.settle(constructShelterPass(build), 6_000), "again");
  bot.entities[61]!.position = new Vec3(change === "move" ? 1.7 : 30, 64, 0.5);
  if (change === "replace") bot.entities[62]!.position = new Vec3(1.5, 64, 0.5);
  const result = await clock.settle(constructShelterPass({ ...build, constructionDeadline: clock.now() }), 6_000);
  if (typeof result !== "object") throw new Error("expected deadline refusal");
  assert.equal(result.refusal?.cause, "deadline");
  const occupied = result.refusal?.occupied ?? [];
  if (change === "depart") assert.equal(occupied.length, 0);
  else {
    assert.equal(occupied[0]?.intruderId, change === "move" ? 61 : 62);
    assert.equal(occupied[0]?.box.min.x, (change === "move" ? 1.7 : 1.5) - bot.entities[change === "move" ? 61 : 62]!.width / 2);
  }
});

test("shaft construction reserves the native dig answer before opening its first cell", async () => {
  for (const leftMs of [1_750, 1_700]) {
    const clock = createFakeClock({ mode: "mocked" });
    const { bot } = createFakeBot({ clock, simulatePhysics: true, cells: { "0,63,0": "dirt" } });
    using _installed = clock.install();
    installNativeDigClock(bot);
    bot.entity.onGround = false;
    await clock.settle(waitForServerTicks(bot, 40, { until: () => bot.entity.onGround }), 1_000);
    // Centring observes one stationary physics tick before pricing the first shaft cell.
    const build = { ...createTestShelterBuild(bot, clock), constructionDeadline: clock.now() + 50 + leftMs };
    const result = await clock.settle(constructShelterPass(build), 5_000);
    assert.equal(typeof result, "object", `${leftMs} ms: ${JSON.stringify(result)}, dug ${build.dug}, at ${bot.entity.position}`);
    if (typeof result === "object") assert.match(result.error, /shaft cell .* digs in/);
    assert.equal(build.dug, leftMs === 1_750 ? 1 : 0);
    assert.equal(bot.blockAt(new Vec3(0, 63, 0))?.name, leftMs === 1_750 ? "air" : "dirt");
  }
});

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
        : variant === "server fence" ? /server did not confirm breaking the block/
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
  using _pace = serverTickPace(bot);
  await clock.advance(2_000); // Established time-packet pace before judging the construction's 5 s budget.
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
    if (!leaves) {
      assert.match(result.error ?? "", /not finished within/, variant);
      if (result.kind !== "failed") throw new Error("expected failed hide");
      assert.equal(result.refusal?.cause, "deadline");
      assert.ok(result.refusal?.shell.some((entry) => entry.cell.x === 1 && entry.cell.y === 64 && entry.block === "air"));
      assert.equal(result.refusal?.margin.length, 25, "a deadline refusal carries the margin record too");
    }
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

/**
 * The deadline failure after one construction pass that found a cow standing in the open wall cell `1,64,0`. The moves
 * come between that pass and the failing one: the cow or the bot moves, and `laterPass` advances the pass counter so the
 * record still carries the earlier pass.
 */
async function expiredPassError(moves: { readonly cowAt?: Vec3; readonly botAt?: Vec3; readonly laterPass?: boolean }): Promise<string> {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot } = createFakeBot({
    clock, health: 7, carried: { cobblestone: 32 }, cells: { "1,65,0": "stone" },
    entities: { 2: { name: "cow", position: new Vec3(1.5, 64, 0.5) } },
  });
  using _installed = clock.install();
  let build = createTestShelterBuild(bot, clock);
  assert.equal(await clock.settle(constructShelterPass(build), 6_000), "again");
  if (moves.cowAt) bot.entities[2]!.position = moves.cowAt;
  if (moves.botAt) bot.entity.position = moves.botAt;
  build = { ...build, pass: build.pass + (moves.laterPass ? 1 : 0), constructionDeadline: clock.now() };
  const result = await clock.settle(constructShelterPass(build), 6_000);
  if (typeof result !== "object") assert.fail(`expected the deadline failure, got ${result}`);
  return result.error;
}

test("a deadline failure names the cow in the open cell, from any earlier pass, while it stays, and not after it leaves or the bot moves", async () => {
  // Positive control first: the cow in the cell is named (red on the code before the change).
  assert.match(await expiredPassError({}),
    /not finished within 5 s; still open: 1,64,0 \(Placement cell \(1, 64, 0\) overlaps cow #2 at \(1\.5, 64, 0\.5\)\.\)$/);
  assert.match(await expiredPassError({ laterPass: true }), /still open: 1,64,0 \(Placement cell \(1, 64, 0\) overlaps cow #2/);
  const gone = await expiredPassError({ cowAt: new Vec3(30, 64, 30) });
  assert.match(gone, /not finished within 5 s$/);
  assert.doesNotMatch(gone, /still open/);
  const moved = await expiredPassError({ botAt: new Vec3(5.5, 64, 0.5) });
  assert.match(moved, /not finished within 5 s$/);
  assert.doesNotMatch(moved, /1,64,0/);
});

test("an open shell that ends with no refusal names the cow still standing in its wall cell", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot } = createFakeBot({
    clock, health: 7, carried: { cobblestone: 32 }, cells: { "1,65,0": "stone" },
    entities: { 2: { name: "cow", position: new Vec3(1.5, 64, 0.5) } },
  });
  using _installed = clock.install();
  // Scripted: a hazard appears once every wall cell but the cow's is solid, so the last pass ends at its hold check, open.
  const wallsButCow = ["-1,64,0", "-1,65,0", "0,64,-1", "0,65,-1", "0,64,1", "0,65,1", "0,66,0"];
  const result = await clock.settle(hideInPlace(bot, {
    threatContext: combatTestContext(bot), signal: new AbortController().signal, recoverTo: 18, maximumMs: 5_000,
    unsafe: () => (wallsButCow.every((key) => solidAt(bot, key)) ? "a hazard appeared" : null),
  }), 150_000);
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /^The shelter is still open: 1,64,0 \(Placement cell \(1, 64, 0\) overlaps cow #2 at \(1\.5, 64, 0\.5\)\.\)$/, result.error);
  assert.equal(result.refusal?.cause, "open");
  assert.ok(result.refusal?.shell.some((entry) => entry.cell.x === 1 && entry.cell.y === 64 && entry.block === "air"));
});

function solidAt(bot: FakeBot, key: string): boolean {
  const [x, y, z] = key.split(",").map(Number) as [number, number, number];
  return bot.blockAt(new Vec3(x, y, z))?.name === "cobblestone";
}

for (const [offCenter, name, id] of [[false, "zombie", 2], [true, "zombie", 2], [false, "blaze", 61]] as const)
test(`three blocked passes leave a named open cell and hand recovery to withdrawal (off center ${offCenter}, ${name})`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot } = createFakeBot({
    clock, health: 7, carried: { cobblestone: 32 },
    position: new Vec3(offCenter ? 0.15 : 0.5, 64, 0.5), simulatePhysics: offCenter,
    // The solid head-height cell hides the intruder from melee; its body blocks the missing lower wall.
    cells: { "1,65,0": "stone" },
    entities: { [id]: { name, position: new Vec3(1.5, 64, 0.5) } },
  });
  using _installed = clock.install();
  using _pace = serverTickPace(bot);
  await clock.advance(2_000); // The construction limit starts after the connection learned its tick pace.
  const context = combatTestContext(bot);
  const result = await clock.settle(hideInPlace(bot, {
    signal: new AbortController().signal, threatContext: context, maximumMs: 5_000, recoverTo: 7,
    holdWhile: () => true,
  }), 6_000);
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /still open.*1,64,0/);
  assert.equal(result.refusal?.cause, "occupied");
  assert.equal(result.refusal?.occupied[0]?.intruderId, id);
  assert.equal(result.refusal?.occupied[0]?.intruderName, name);
  assert.deepEqual(result.refusal?.occupied[0]?.cell, { x: 1, y: 64, z: 0 });
  assert.deepEqual(result.refusal?.occupied[0]?.box, {
    min: { x: 1.5 - bot.entities[id]!.width / 2, y: 64, z: 0.5 - bot.entities[id]!.width / 2 },
    max: { x: 1.5 + bot.entities[id]!.width / 2, y: 64 + bot.entities[id]!.height, z: 0.5 + bot.entities[id]!.width / 2 },
  });
  assert.doesNotMatch(result.error ?? "", /not finished within/);
  assert.equal(result.capped, true, "other cells are completed despite the blocked wall");
  assert.equal(enclosedInPlace(bot), false);
  // Read after the call: an assertion inside this double would be caught by the evade as its failure, which also blocks recovery.
  const routeTimeouts: number[] = [];
  const navigation = {
    world: new MemoryWorld(),
    navigate: async ({ timeoutMs }: { timeoutMs: number }) => {
      routeTimeouts.push(timeoutMs);
      return { status: "stopped", reason: "withdrawal route unavailable", elapsedMs: 0 };
    },
  } as unknown as NavigationRuntime;
  const responses: unknown[] = [];
  const started = clock.now();
  const next = await clock.settle(recoverCombatHealth(bot, navigation, context, new AbortController().signal,
    (facts) => responses.push(facts)), context.policy.recovery_timeout_ms + 3 * context.policy.evade_timeout_ms);
  assert.equal(next.kind, "blocked");
  assert.deepEqual(routeTimeouts.length, 1, "the withdrawal route was asked for");
  assert.ok(routeTimeouts[0]! <= 3 * context.policy.evade_timeout_ms, "its timeout is the evade clock's wall: 3x the budget's game time");
  assert.match(JSON.stringify(responses), /evade/);
  assert.match(next.kind === "blocked" ? next.observation : "", /withdrawal route unavailable/, "the evade ended on the route's own answer, not on an assertion failure");
  assert.ok(clock.now() - started < context.policy.recovery_timeout_ms + 3 * context.policy.evade_timeout_ms);
  assert.equal(bot.usingHeldItem, false);
});

// ---- The margin pass (plan 2026-11-18-scenario-reds-part2-a5 T13o) ----

/** The 16 margin cells of a bot at the centre of (0, 64, 0), in the order the pass takes them (`shelter-cells.test.ts`). */
const MARGIN_ORDER = [
  "-1,64,-1", "-1,64,1", "1,64,-1", "1,64,1", "-1,65,-1", "-1,65,1", "1,65,-1", "1,65,1",
  "-1,66,0", "0,66,-1", "0,66,1", "1,66,0", "-1,66,-1", "-1,66,1", "1,66,-1", "1,66,1",
];
const cellOf = (text: string) => new Vec3(...(text.split(",").map(Number) as [number, number, number]));
const placements = (server: FakeServer) => server.packets.filter(({ name }) => name === "block_place");

/** A bot in the 9-cell shell of `SEALED_BOX`, carrying `carried` cobblestone, and the build a hide would hold for it. */
function marginScene(options: { readonly carried: number; readonly ticksPerSecond: number; readonly cells?: Record<string, FakeCell>;
  readonly groundY?: null; readonly entities?: FakeBotOptions["entities"]; readonly overrides?: FakeBotOptions["overrides"] }) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, server: { ticksPerSecond: options.ticksPerSecond ?? 20 }, carried: { cobblestone: options.carried },
    cells: { ...SEALED_BOX, ...options.cells }, groundY: options.groundY, entities: options.entities, overrides: options.overrides });
  return { ...harness, clock, build: createTestShelterBuild(harness.bot, clock) };
}

/** What a margin pass must leave alone: the shell's own record (`walled`, `capped`, `refusal`, `blockedCells`). */
const shellRecord = (build: ShelterBuild) => ({ walled: build.walled, capped: build.capped, refusal: build.refusal, blocked: build.blockedCells.size });

for (const ticksPerSecond of [20, 10])
  test(`a whole shell with a spare shell carried gets its 16 margin cells, one shell stays, the shell's record is untouched (${ticksPerSecond} tps)`, async () => {
    const { bot, clock, build } = marginScene({ ticksPerSecond, carried: 26 });
    using _installed = clock.install();
    const record = shellRecord(build);
    const pass = await clock.settle(sealMarginCells(build), 60_000);
    assert.equal(pass.placed, 16);
    assert.deepEqual(pass.skipped, []);
    // `pass.ticks` is not asserted: the fake answers a placement without moving the world age (0 at both rates); the real
    // server's span is measured in the scenarios (the hide receipt's `margin.ticks`).
    for (const cell of MARGIN_ORDER) assert.equal(bot.blockAt(cellOf(cell))?.name, "cobblestone", cell);
    assert.equal(countCapBlocks(bot), 10);
    assert.deepEqual(shellRecord(build), record);
  });

for (const ticksPerSecond of [20, 10]) test(`the reserve: a margin cell is placed only while more than one shell is carried (${ticksPerSecond} tps)`, async () => {
  for (const [carried, placed] of [[26, 16], [13, 3], [11, 1], [10, 0]] as const) {
    const { bot, clock, build } = marginScene({ ticksPerSecond, carried });
    using _installed = clock.install();
    const record = shellRecord(build);
    const pass = await clock.settle(sealMarginCells(build), 60_000);
    assert.equal(pass.placed, placed, `${carried} carried`);
    assert.deepEqual(pass.skipped.map(({ reason }) => reason), Array(16 - placed).fill("reserve"), `${carried} carried`);
    assert.deepEqual(pass.skipped.map(({ cell }) => `${cell.x},${cell.y},${cell.z}`), MARGIN_ORDER.slice(placed));
    for (const cell of MARGIN_ORDER.slice(0, placed)) assert.equal(bot.blockAt(cellOf(cell))?.name, "cobblestone", `${carried}: ${cell}`);
    assert.equal(countCapBlocks(bot), carried - placed, `${carried} carried: one shell is left`);
    assert.deepEqual(shellRecord(build), record, `${carried} carried`);
  }
});

for (const ticksPerSecond of [20, 10]) test(`a threat's side goes first, whatever the wall direction the caller named (${ticksPerSecond} tps)`, async () => {
  for (const firstWallDirection of [undefined, new Vec3(-1, 0, 0)]) {
    const { bot, clock, build } = marginScene({ ticksPerSecond, carried: 12, entities: { 70: { name: "blaze", position: new Vec3(8.5, 64, 0.5) } } });
    using _installed = clock.install();
    const pass = await clock.settle(sealMarginCells({ ...build, options: { ...build.options, firstWallDirection } }), 60_000);
    assert.equal(pass.placed, 2);
    assert.deepEqual(["1,64,-1", "1,64,1"].map((cell) => bot.blockAt(cellOf(cell))?.name), ["cobblestone", "cobblestone"]);
    assert.deepEqual(["-1,64,-1", "-1,64,1"].map((cell) => bot.blockAt(cellOf(cell))?.name), ["air", "air"]);
  }
});

// A fire in a margin cell cannot be dug from inside the closed shell, whatever the dig permission: `extinguishFireAt`'s
// ray from the eye to the cell meets the shell's corner (`clearCombatRay`), so the plan's "extinguished, then placed" case
// does not happen; the pass ends at the fire, with the cells before it placed.
for (const ticksPerSecond of [20, 10]) for (const dig of [true, false]) test(`a fire in a margin cell ends the pass there and names it (dig ${dig ? "allowed" : "prohibited"}, ${ticksPerSecond} tps)`, async () => {
  const { clock, build, bot } = marginScene({ ticksPerSecond, carried: 26, cells: { "1,64,1": "fire" } });
  using _installed = clock.install();
  const policy = build.options.threatContext.policy;
  const options = { ...build.options, threatContext: { ...build.options.threatContext, policy: { ...policy, terrain: { ...policy.terrain, dig } } } };
  const pass = await clock.settle(sealMarginCells({ ...build, options }), 60_000);
  assert.equal(pass.placed, 3, "the three diagonals before the fire");
  assert.match(pass.skipped[0]!.reason, /^refused: Fire could not be cleared/);
  assert.deepEqual(pass.skipped[0]!.cell, { x: 1, y: 64, z: 1 });
  assert.deepEqual(pass.skipped.slice(1).map(({ reason }) => reason), Array(12).fill("stopped: refused"));
  assert.equal(bot.blockAt(new Vec3(1, 64, 1))?.name, "fire", "nothing was dug");
});

for (const ticksPerSecond of [20, 10]) test(`a bottom slab in a margin cell is refused with the placement's reason and ends the pass (${ticksPerSecond} tps)`, async () => {
  const { clock, build } = marginScene({ ticksPerSecond, carried: 26, cells: { "-1,65,1": "stone_slab" } });
  using _installed = clock.install();
  const pass = await clock.settle(sealMarginCells(build), 60_000);
  assert.equal(pass.placed, 5, "four diagonals at feet height and the first at head height");
  assert.match(pass.skipped[0]!.reason, /^refused: .*stone_slab/);
  assert.deepEqual(pass.skipped.slice(1).map(({ reason }) => reason), Array(10).fill("stopped: refused"));
});

for (const ticksPerSecond of [20, 10]) test(`an occupied margin cell is skipped and the pass goes on; a cell with no support is skipped too (${ticksPerSecond} tps)`, async () => {
  const cow = marginScene({ ticksPerSecond, carried: 26, entities: { 5: { name: "cow", position: new Vec3(1.5, 64, 1.5) } } });
  {
    using _installed = cow.clock.install();
    const pass = await cow.clock.settle(sealMarginCells(cow.build), 60_000);
    // A cow is 1.4 high: it stands in the diagonal at feet height and the one above it.
    assert.equal(pass.placed, 14);
    assert.deepEqual(pass.skipped.map(({ reason }) => reason), ["occupied", "occupied"]);
    assert.deepEqual(pass.skipped.map(({ cell }) => `${cell.x},${cell.y},${cell.z}`), ["1,64,1", "1,65,1"]);
    assert.equal(cow.bot.blockAt(new Vec3(1, 64, 1))?.name, "air");
  }
  // No shell and no ground but the feet cell's floor: only the floor layer has a neighbour to be placed against.
  const bare = marginScene({ ticksPerSecond, carried: 34, groundY: null, cells: { "0,63,0": "stone" } });
  using _installed = bare.clock.install();
  for (const cell of Object.keys(SEALED_BOX)) bare.world.setCell(cellOf(cell), "air");
  const pass = await bare.clock.settle(sealMarginCells(bare.build), 60_000);
  assert.equal(pass.placed, 8);
  assert.deepEqual(pass.skipped.map(({ reason }) => reason), Array(16).fill("no_support"));
});

for (const ticksPerSecond of [20, 10]) test(`over a drop the floor layer goes last, and the reserve still caps the pass (${ticksPerSecond} tps)`, async () => {
  const air = Object.fromEntries([-1, 0, 1].flatMap((x) => [-1, 0, 1].map((z) => [`${x},63,${z}`, "air" as FakeCell])));
  const bridge = { groundY: null, cells: { ...air, "0,63,0": "stone" } } as const;
  const wide = marginScene({ ticksPerSecond, carried: 34, ...bridge });
  {
    using _installed = wide.clock.install();
    const pass = await wide.clock.settle(sealMarginCells(wide.build), 60_000);
    assert.equal(pass.placed, 24);
    assert.equal(wide.bot.blockAt(new Vec3(1, 63, 1))?.name, "cobblestone");
  }
  const short = marginScene({ ticksPerSecond, carried: 13, ...bridge });
  using _installed = short.clock.install();
  const pass = await short.clock.settle(sealMarginCells(short.build), 60_000);
  assert.equal(pass.placed, 3);
  assert.equal(short.bot.blockAt(new Vec3(1, 63, 0))?.name, "air", "the floor layer is not reached");
});

// The cancel of a margin placement is tested through the hide (`hide.test.ts`), which asserts the pass's abort path too.
for (const ticksPerSecond of [20, 10]) test(`death after the second placement stops the pass: no third placement, every later cell skipped as stopped (${ticksPerSecond} tps)`, async () => {
  const { bot, clock, build, server } = marginScene({ ticksPerSecond, carried: 26 });
  using _installed = clock.install();
  let seen = 0;
  const stop = server.onPacket("block_place", () => { if (++seen === 2) bot.health = 0; });
  const pass = await clock.settle(sealMarginCells(build), 60_000);
  stop();
  assert.equal(placements(server).length, 2);
  assert.equal(pass.placed, 2);
  assert.deepEqual(pass.skipped.map(({ reason }) => reason), Array(14).fill("stopped: dead"));
});

// The expired construction deadline is asserted through the hide (`hide.test.ts`).
for (const ticksPerSecond of [20, 10]) test(`fire in the body or a hazard places nothing and names why (${ticksPerSecond} tps)`, async () => {
  const burning = marginScene({ ticksPerSecond, carried: 26, cells: { "0,64,0": "fire" } });
  {
    using _installed = burning.clock.install();
    const pass = await burning.clock.settle(sealMarginCells(burning.build), 60_000);
    assert.equal(pass.placed, 0);
    assert.deepEqual(pass.skipped.map(({ reason }) => reason), Array(16).fill("stopped: fire"));
  }
  const unsafe = marginScene({ ticksPerSecond, carried: 26 });
  using _installed = unsafe.clock.install();
  const hazard = { ...unsafe.build, options: { ...unsafe.build.options, unsafe: () => "a creeper is hissing" } };
  const pass = await unsafe.clock.settle(sealMarginCells(hazard), 60_000);
  assert.equal(pass.placed, 0);
  assert.deepEqual(pass.skipped.map(({ reason }) => reason), Array(16).fill("stopped: a creeper is hissing"));
});

for (const ticksPerSecond of [20, 10]) test(`a placement the server refuses ends the pass with its message and no second placement call (${ticksPerSecond} tps)`, async () => {
  let equips = 0;
  const { clock, build } = marginScene({ ticksPerSecond, carried: 26, overrides: { equip: async () => { equips += 1; throw new Error("the server would not equip cobblestone"); } } });
  using _installed = clock.install();
  const pass = await clock.settle(sealMarginCells(build), 60_000);
  assert.equal(equips, 1);
  assert.equal(pass.placed, 0);
  assert.match(pass.skipped[0]!.reason, /^refused: .*the server would not equip cobblestone/);
  assert.deepEqual(pass.skipped.slice(1).map(({ reason }) => reason), Array(15).fill("stopped: refused"));
});

for (const ticksPerSecond of [20, 10]) test(`a server that stops answering mid-pass ends the pass within its bound while the world age stands still (${ticksPerSecond} tps)`, async () => {
  const { bot, clock, build, server } = marginScene({ ticksPerSecond, carried: 26 });
  using _installed = clock.install();
  const stop = server.onPacket("block_place", () => server.stop());
  const pass = await clock.settle(sealMarginCells(build), 120_000);
  stop();
  const age = bot.time.age;
  await clock.advance(30_000);
  assert.equal(bot.time.age, age, "the world age stood still");
  assert.ok(pass.placed < 16);
  assert.ok(pass.skipped.length > 0);
  assert.equal(placements(server).length, pass.placed + 1, "one placement call went unanswered, none after it");
});
