import minecraftData from "minecraft-data";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { ActionRunner } from "../../session/action-runner.js";
import { Budgets } from "../../survival/state/budgets.js";
import { SurvivalPolicyState } from "../../survival/state/survival-policy.js";
import { createDiscardedItems } from "../../world/discarded-items.js";
import { mobSourcesOf } from "../../world/mob-drops.js";
import { engagingCombat } from "../../test-support/combat.js";
import { type FakeClock, type FakeServerOptions, createFakeBot, createFakeClock, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { exactBlockGoal } from "../../navigation/goals/index.js";
import { createMovementPolicy } from "../../navigation/movements/policy.js";
import { createNavigationRuntime } from "../../navigation/runtime.js";
import { huntCheckpointSchema } from "../checkpoint-schemas.js";
import { huntMobOutcomes, parseHuntMobRequest } from "./contract.js";
import { createCollectMobDropAction, engageTarget, formatHuntMobResult, fruitlessKillLimit, huntMob, HUNT_FRUITLESS_KILLS, type HuntMobDependencies } from "./hunt-mob.js";
import { died, outcome, dependencies, fakeCombat, harnesses, huntBot, EntitySpec, mob, fakeNavigation, unseen, droppedItem } from "./hunt-mob-fixtures.test.js";

/** A harness whose bot sees `targets` and nothing else of the hunt (engagement tests). */
function engagementHarness(targets: readonly EntitySpec[]) {
  return createFakeBot({ groundY: null, entities: Object.fromEntries(targets.map((target) => [target.id, target])) });
}

test("a hunt delegates health recovery to combat and preserves its terminal evidence", async () => {
  const { bot, combat: scene } = engagementHarness([mob(7, 1, "blaze", 2, "Hostile mobs")]);
  const target = bot.entities[7]!;
  const combat = engagingCombat(bot, async (_id, signal) => {
    scene.setHealth(11);
    assert.equal(signal.aborted, false, "the hunt does not independently cancel combat recovery");
    return outcome("capability_blocked", 2, { reason: "recovery", observation: "No food remains." });
  });
  const result = await engageTarget(bot, combat, target, {});
  assert.equal(result.outcome.kind, "capability_blocked");
  assert.equal(result.outcome.attacks, 2);
  if (result.outcome.kind === "capability_blocked") assert.equal(result.outcome.reason, "recovery");
  assert.equal(bot.listenerCount("health"), 0);
  assert.equal(bot.listenerCount("entityDead"), 0);
});

test("the hostile fight boundary does not cancel a passive quarry engagement", async () => {
  const { bot, combat: scene } = engagementHarness([mob(7, 1, "cow", 2)]);
  const combat = engagingCombat(bot, async (_id, signal) => {
    scene.setHealth(11);
    assert.equal(signal.aborted, false);
    return outcome("died", 2);
  });
  const result = await engageTarget(bot, combat, bot.entities[7]!, {});
  assert.equal(result.outcome.kind, "died");
});

test("quota attainment waits for handoff and cannot report success when withdrawal is unsafe", async () => {
  const inventory = { count: 0 };
  const bot = huntBot([], inventory);
  const effects = dependencies(bot, inventory, []);
  let release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let returned = false;
  const pending = huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 1 },
    {},
    {
      ...effects,
      gatherLoadedDrops: async () => {
        inventory.count = 1;
        return 1;
      },
      finish: async () => {
        await waiting;
        return {
          observedAt: 1,
          kind: "unsafe",
          reason: "No withdrawal route or closed shelter was observed.",
          position: { x: 0, y: 64, z: 0 },
        };
      },
    },
  ).then((result) => {
    returned = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(returned, false);
  release!();
  const result = await pending;
  assert.equal(result.status, "partial");
  assert.equal(result.termination, "quantity_collected");
  assert.equal(result.hunt.gained, 1);
  assert.equal(result.handoff.kind, "unsafe");
  assert.match(result.error ?? "", /HUNT_UNSAFE_HANDOFF/);
});

test("a completed quantity is checked again after handoff consumes it", async () => {
  const inventory = { count: 0 };
  const bot = huntBot([], inventory);
  const result = await huntMob(
    bot,
    { mobName: "sheep", dropName: "white_wool", count: 1, campSpawner: false, allowWithoutShield: false, observeForMs: 0 },
    {},
    {
      ...dependencies(bot, inventory, []),
      gatherLoadedDrops: async () => {
        inventory.count = 1;
        return 1;
      },
      finish: async () => {
        inventory.count = 0;
        return fakeCombat.finish(new AbortController().signal);
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.equal(result.termination, "inventory_changed");
  assert.equal(result.hunt.gained, 0);
});

for (const gainedDuringReflex of [false, true])
  test(`quarry observation retains its deadline and baseline through a reflex (gain: ${gainedDuringReflex})`, async () => {
    const inventory = { count: 4 };
    // The observation window reads Date.now and waits on the global timers: a mocked clock moves both.
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    const bot = huntBot([], inventory, 20, { clock });
    const budgets = new Budgets();
    const action = createCollectMobDropAction(
      bot,
      fakeNavigation,
      fakeCombat,
      createDiscardedItems(),
      dependencies(bot, inventory, []),
      budgets,
    );
    const runner = new ActionRunner();
    const pending = runner.run(
      { ...action, execution: { kind: "resumable_task" } },
      { mob_name: "sheep", drop_name: "white_wool", count: 1, observe_for_ms: 300 },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const original = runner.request();
    assert.equal(budgets.snapshot()[0]?.name, "quarry_observation");
    const claim = runner.claim("hunger_reflex", "Eating while awaiting quarry", async () => {
      await new Promise<void>((resolve) => clock.after(350, resolve));
      if (gainedDuringReflex) inventory.count++;
      return { value: null, continuation: { kind: "resume" as const } };
    });
    assert.equal(claim.kind, "claimed");
    const output = await clock.settle(pending, 2_000);
    assert.equal(output.request?.id, original?.id);
    assert.ok("hunt" in output.result);
    if (!("hunt" in output.result)) return;
    assert.equal(output.result.hunt.inventoryBefore, 4);
    assert.equal(output.result.termination, gainedDuringReflex ? "quantity_collected" : "observation_exhausted");
    assert.deepEqual(budgets.snapshot(), []);
    assert.equal(bot.listenerCount("entitySpawn"), 0);
  });

for (const { reflexGain, dropName, arrows } of [
  { reflexGain: 0, dropName: "white_wool", arrows: false },
  { reflexGain: 1, dropName: "white_wool", arrows: false },
  { reflexGain: 0, dropName: "arrow", arrows: true },
  { reflexGain: 1, dropName: "arrow", arrows: true },
  // Any member of the item family `arrow` (tag `arrows`) is hunted as arrows: the bow is reserved the same way.
  { reflexGain: 0, dropName: "tipped_arrow", arrows: true },
]) {
  test(`a resumed ${dropName} hunt counts prior drops and ${reflexGain} drops gained during the reflex`, async () => {
    const inventory = { count: 0 };
    const bot = huntBot([], inventory, 20, { dropName });
    const combat = { ...fakeCombat, policy: new SurvivalPolicyState(bot) };
    let runs = 0;
    let entered!: () => void;
    const firstRun = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pursue: HuntMobDependencies["pursue"] = async (pursuit) => {
      assert.equal(combat.policy.combat.bow, !arrows);
      runs += 1;
      if (runs === 1) {
        inventory.count += 1;
        entered();
        await new Promise<void>((resolve) =>
          pursuit.signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        return { status: "stopped", reason: "reflex" };
      }
      while (!pursuit.isSatisfied()) inventory.count += 1;
      return { status: "satisfied", reason: null };
    };
    const action = createCollectMobDropAction(bot, fakeNavigation, combat, createDiscardedItems(), {
      ...dependencies(bot, inventory, []),
      pursue,
    });
    const runner = new ActionRunner();
    const pending = runner.run(
      { ...action, execution: { kind: "resumable_task" } },
      {
        mob_name: arrows ? "skeleton" : "sheep",
        drop_name: dropName,
        count: 2,
        // The subject here is the arrow hunt's bow reserve, not the shield gate
        // a shieldless skeleton hunt would otherwise be refused by.
        allow_without_shield: true,
      },
    );
    await firstRun;
    const claim = runner.claim("hunger_reflex", "ate bread", async () => {
      assert.equal(combat.policy.snapshot().effective.combat.bow, !arrows);
      inventory.count += reflexGain;
      return { value: null, continuation: { kind: "resume" as const } };
    });
    assert.equal(claim.kind, "claimed");
    const output = await pending;
    assert.equal(output.result.status, "succeeded");
    assert.equal(inventory.count, 2, "a count of two must not become three after one drop and a resumption");
    if (!("hunt" in output.result)) throw new Error("expected hunt evidence");
    assert.equal(output.result.hunt.inventoryBefore, 0);
    assert.equal(output.result.hunt.gained, 2);
    assert.equal(formatHuntMobResult(output.result).includes("Bow policy:"), arrows);
    assert.equal(combat.policy.combat.bow, true, "request settlement releases the arrow reservation");
    assert.deepEqual(combat.policy.snapshot().overrides, [], "the hunt does not replace model policy");
  });
}

test("a terminal reflex interruption returns the hunt's uncollected drop sightings", async () => {
  const inventory = { count: 0 };
  const bot = huntBot([droppedItem(99, "white_wool", 2, new Vec3(8, 63, 2))], inventory);
  const entity = unseen(bot, 99);
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const action = createCollectMobDropAction(bot, fakeNavigation, fakeCombat, createDiscardedItems(), {
    ...dependencies(bot, inventory, []),
    pursue: async (pursuit) => {
      bot.entities[entity.id] = entity;
      bot.emit("itemDrop", entity);
      entered();
      await new Promise<void>((_resolve, reject) =>
        pursuit.signal!.addEventListener("abort", () => reject(pursuit.signal!.reason), { once: true }),
      );
      throw new Error("unreachable");
    },
  });
  const runner = new ActionRunner();
  const pending = runner.run(
    { ...action, execution: { kind: "resumable_task" } },
    { mob_name: "sheep", drop_name: "white_wool", count: 2 },
  );
  await ready;
  const claim = runner.claim("hostile_reflex", "withdrew from contact", async () => ({
    value: null,
    continuation: { kind: "return" as const, reason: null },
  }));
  assert.equal(claim.kind, "claimed");
  const output = await pending;
  if (!("hunt" in output.result)) throw new Error("expected hunt evidence after interruption");
  assert.equal(output.result.status, "failed");
  assert.equal(output.result.hunt.gained, 0);
  assert.equal(output.result.hunt.drops[0]?.observedCount, 2);
  assert.equal(output.result.hunt.drops[0]?.collectedByBot, false);
  assert.equal(output.result.hunt.drops[0]?.state, "loaded");
  assert.equal(bot.listenerCount("itemDrop"), 0);
});

test("normalizes exact registry names and defaults to one requested drop", () => {
  assert.deepEqual(parseHuntMobRequest({ mob_name: "Minecraft:Sheep", drop_name: "White Wool" }), {
    campSpawner: false,
    allowWithoutShield: false,
    observeForMs: 0,
    mobName: "sheep",
    dropName: "white_wool",
    count: 1,
  });
});

test("hunts loaded targets until the requested inventory gain is observed", async () => {
  const inventory = { count: 4 };
  const registry = minecraftData("1.21.4");
  const bot = huntBot(
    [mob(7, registry.entitiesByName.sheep.id, "sheep", 3), mob(8, registry.entitiesByName.sheep.id, "sheep", 5)],
    inventory,
  );
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 2 },
    {},
    dependencies(bot, inventory, [died(4, 3), died(5, 5)], 1),
  );

  assert.deepEqual(result, {
    status: "succeeded",
    termination: "quantity_collected",
    handoff: { observedAt: 1, kind: "safe", basis: "clear", position: { x: 0, y: 64, z: 0 } },
    hunt: {
      mob: "sheep",
      drop: "white_wool",
      requested: 2,
      gained: 2,
      inventoryBefore: 4,
      inventoryAfter: 6,
      targetsEngaged: 2,
      retargets: 1,
      targetChanges: [
        {
          fromTargetId: 7,
          toTargetId: 8,
          position: { x: 5, y: 64, z: 0 },
          distance: 5,
          reason: "The previous engagement was completed.",
        },
      ],
      targetDeathsObserved: 2,
      attacks: 9,
      combatStyles: ["melee"],
      projectileGuards: 0,
      otherDropsCollected: 2,
      drops: [],
      targets: [
        { species: "sheep", id: 7, x: 3, y: 64, z: 0, distance: 3 },
        { species: "sheep", id: 8, x: 5, y: 64, z: 0, distance: 5 },
      ],
    },
  });
  assert.match(formatHuntMobResult(result), /white_wool 2\/2/);
  assert.match(formatHuntMobResult(result), /Loaded sheep at return: #7 at 3,64,0 \(3 blocks\); #8 at 5,64,0/);
});

for (const missed of ["item_gone", "not_collected"] as const)
test(`a ${missed} drop retires its kill and the hunt continues to the next loaded target`, async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const bot = huntBot(
    [mob(7, registry.entitiesByName.sheep.id, "sheep", 3), mob(8, registry.entitiesByName.sheep.id, "sheep", 5)],
    inventory,
  );
  let pickups = 0;
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "white_wool", count: 1 },
    {},
    {
      ...dependencies(bot, inventory, [died(2, 3), died(2, 5)]),
      collectDropAfterDeath: async () => {
        if (++pickups === 1) return missed === "item_gone" ? { kind: "item_gone" } :
          { kind: "not_collected", route: { status: "stopped", reason: "Placement cell occupied by Enderman", elapsedMs: 10 } };
        inventory.count++;
        return { kind: "collected" };
      },
    },
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.gained, 1);
  assert.equal(result.hunt.targetDeathsObserved, 2);
  assert.equal(pickups, 2);
});

test("a hunt stops after the fruitless-kill limit and says the drop needs the mob to burn, or cooking the raw drop", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const sheep = Array.from({ length: HUNT_FRUITLESS_KILLS + 3 }, (_, i) => mob(7 + i, registry.entitiesByName.sheep.id, "sheep", 3 + i));
  const bot = huntBot(sheep, inventory);
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "sheep", dropName: "cooked_mutton", count: 5 },
    {},
    {
      ...dependencies(bot, inventory, sheep.map((s) => died(2, s.position.x))),
      collectDropAfterDeath: async () => ({ kind: "item_gone" }),
    },
  );
  if (result.status === "succeeded") throw new Error("expected the hunt to stop");
  assert.equal(result.hunt.targetDeathsObserved, HUNT_FRUITLESS_KILLS);
  assert.match(result.error, /HUNT_DROP_NOT_GIVEN/);
  assert.match(result.error, new RegExp(`${HUNT_FRUITLESS_KILLS} sheep`));
  assert.match(result.error, /burn/);
  assert.match(result.error, /cook/);
});

test("the fruitless-kill limit is the kills after which getting nothing has under 1 % chance, 8 when the chance is unknown", () => {
  assert.equal(fruitlessKillLimit(0.5), 7);
  assert.equal(fruitlessKillLimit(0.025), 182);
  assert.equal(fruitlessKillLimit(0.1), 44);
  assert.equal(fruitlessKillLimit(1), HUNT_FRUITLESS_KILLS);
  assert.equal(fruitlessKillLimit(null), HUNT_FRUITLESS_KILLS);
  assert.equal(fruitlessKillLimit(0), HUNT_FRUITLESS_KILLS);
});

test("a drop with a known chance stops the hunt at that chance's limit and the message names the kills and the chance", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const chance = mobSourcesOf("rabbit_foot", "1.21.4").find((source) => source.mob === "rabbit")?.chance;
  assert.ok(chance !== undefined && chance < 1, "rabbit drops rabbit_foot at a chance in the shipped data");
  const limit = fruitlessKillLimit(chance);
  const rabbits = Array.from({ length: limit + 3 }, (_, i) => mob(7 + i, registry.entitiesByName.rabbit.id, "rabbit", 3 + i));
  const bot = huntBot(rabbits, inventory);
  const result = await huntMob(
    bot,
    { campSpawner: false, allowWithoutShield: false, observeForMs: 0, mobName: "rabbit", dropName: "rabbit_foot", count: 1 },
    {},
    {
      ...dependencies(bot, inventory, rabbits.map((r) => died(2, r.position.x))),
      collectDropAfterDeath: async () => ({ kind: "item_gone" }),
    },
  );
  if (result.status === "succeeded") throw new Error("expected the hunt to stop");
  assert.equal(result.hunt.targetDeathsObserved, limit);
  assert.match(result.error, /HUNT_DROP_NOT_GIVEN/);
  assert.match(result.error, new RegExp(`${limit} rabbit killed`));
  assert.match(result.error, new RegExp(`chance of ${chance * 100} % per kill`));
});

test("the fruitless-kill message of a sure drop calls it not picked up, not luck", () => {
  const text = huntMobOutcomes.dropNotGiven("cow", "leather", 8, 1);
  assert.doesNotMatch(text, /luck|chance|smelt/);
  assert.match(text, /not picked up/);
});

test("the fruitless-kill message of an unknown chance does not state one", () => {
  assert.doesNotMatch(huntMobOutcomes.dropNotGiven("sheep", "cooked_mutton", 8), /chance/);
  assert.match(huntMobOutcomes.dropNotGiven("sheep", "cooked_mutton", 8, 0.025), /2\.5 % per kill/);
});

// Plan 2026-10-27-p1-monotonic-clock T5: the observation window is a deadline (monotonic) kept across a reflex; the
// checkpoint keeps epoch times. One wait cannot tell the clocks apart (its timer is set once): the reflex re-enters it.
// Plan 2026-11-18-scenario-reds-part2-a3 T13f: the 3 s window (60 ticks) is game time: it ends at the packet 80 ticks
// after its start, 4 000 ms at 20 tps and 8 000 ms at 10 tps; the wall step moves `Date.now` only, never the window.
for (const row of [
  { name: "a 0.8 s wall step back", wallStepMs: -800, ticksPerSecond: 20, msPerTick: 50 },
  { name: "a 1.2 s wall step forward", wallStepMs: 1_200, ticksPerSecond: 20, msPerTick: 50 },
  { name: "a 0.8 s wall step back", wallStepMs: -800, ticksPerSecond: 10, msPerTick: 100 },
  { name: "a 1.2 s wall step forward", wallStepMs: 1_200, ticksPerSecond: 10, msPerTick: 100 },
]) test(`a 3 s quarry observation resumed after a reflex ends at the packet 80 ticks on, ${80 * row.msPerTick} ms, across ${row.name} (${row.ticksPerSecond} tps)`, async () => {
  const inventory = { count: 0 };
  const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
  using _installed = clock.install();
  // Live the two clocks read unrelated values (uptime vs epoch): a start taken on the wrong one cannot pass.
  clock.stepWallClock(5_000);
  const bot = huntBot([], inventory, 20, { clock, server: { ticksPerSecond: row.ticksPerSecond } });
  const action = createCollectMobDropAction(bot, fakeNavigation, fakeCombat, createDiscardedItems(), dependencies(bot, inventory, []), new Budgets());
  const runner = new ActionRunner();
  let finished = false;
  const pending = runner
    .run({ ...action, execution: { kind: "resumable_task" } }, { mob_name: "sheep", drop_name: "white_wool", count: 1, observe_for_ms: 3_000 })
    .then((output) => { finished = true; return output; });
  await clock.advance(1_000);
  const claim = runner.claim("hunger_reflex", "Eating while awaiting quarry", async () => {
    await clock.sleep(500);
    clock.stepWallClock(row.wallStepMs);
    return { value: null, continuation: { kind: "resume" as const } };
  });
  assert.equal(claim.kind, "claimed");
  await clock.advance(80 * row.msPerTick - 1_000 - 100);
  assert.equal(finished, false, "100 ms before the packet at +80 ticks: still observing");
  await clock.advance(200);
  assert.equal(finished, true, "100 ms after it: over");
  const output = await pending;
  assert.ok("hunt" in output.result && output.result.termination === "observation_exhausted");
});

test("the quarry observation's checkpoint reports epoch times of day", async () => {
  const inventory = { count: 0 };
  const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
  using _installed = clock.install();
  clock.stepWallClock(5_000);
  const bot = huntBot([], inventory, 20, { clock });
  const action = createCollectMobDropAction(bot, fakeNavigation, fakeCombat, createDiscardedItems(), dependencies(bot, inventory, []), new Budgets());
  let checkpoint: (() => { checkpoint: Record<string, unknown> }) | undefined;
  const lifetime = new AbortController();
  const run = action.begin(
    parseHuntMobRequest({ mob_name: "sheep", drop_name: "white_wool", count: 1, observe_for_ms: 3_000 }),
    lifetime.signal,
    (read) => { checkpoint = read as typeof checkpoint; },
  );
  const cancel = new AbortController();
  const pending = run({ signal: cancel.signal }).catch(() => undefined);
  await clock.advance(1_000);
  assert.equal(checkpoint?.().checkpoint.observationStartedAt, Date.now() - 1_000);
  assert.equal(checkpoint?.().checkpoint.observationUntil, Date.now() + 2_000);
  cancel.abort(new Error("test over"));
  await pending;
  lifetime.abort();
});

// Plan 2026-11-18-scenario-reds-part2-a3 T13f (D32): `observe_for_ms` is game time at 20 ticks a second. The window of
// `t` ticks ends at the first look at or after the time packet `ceil((t + 20) / 20) * 20` ticks after the age cached at
// its start (packet origin), so 2 000 ms (40 ticks) ends at +60 ticks; a stopped server ends it at
// `serverPacedWallMs(t)` = 3 * (t + 20) * 50 ms. The server's packets come every 20 ticks: each 1 000 ms at 20 tps,
// each 2 000 ms at 10 tps (`world-age-per-second` contract).
const WINDOW_RATES = [
  { ticksPerSecond: 20, msPerTick: 50 },
  { ticksPerSecond: 10, msPerTick: 100 },
] as const;

const SLICE_MS = 50;
const SHEEP_ID = 7;

/** A bot at the given server rate with one sheep out of sight (`appear` brings it in), and the hunt that waits for it. */
function observing(clock: FakeClock, ticksPerSecond: number, server: FakeServerOptions = {}) {
  const inventory = { count: 0 };
  const sheepType = minecraftData("1.21.4").entitiesByName.sheep!.id;
  const bot = huntBot([mob(SHEEP_ID, sheepType, "sheep", 3)], inventory, 20, { clock, server: { ticksPerSecond, ...server } });
  const quarry = unseen(bot, SHEEP_ID);
  const run = (observeForMs: number, signal?: AbortSignal) =>
    huntMob(
      bot,
      { campSpawner: false, allowWithoutShield: false, observeForMs, mobName: "sheep", dropName: "white_wool", count: 1 },
      signal ? { signal } : {},
      dependencies(bot, inventory, [died(1, 3)]),
    );
  const appear = () => {
    bot.entities[SHEEP_ID] = quarry;
    bot.emit("entitySpawn", quarry);
  };
  return { bot, inventory, run, appear, server: harnesses.get(bot)!.server, startAge: bot.time.age };
}

/** The clock reading when `pending` settled, moving the clock on in `SLICE_MS` slices for at most `maxMs`. */
function settledAtMs(clock: FakeClock, pending: Promise<unknown>, maxMs: number): Promise<number> {
  return clock.settle(pending.then(() => clock.now()), maxMs, SLICE_MS);
}

for (const { ticksPerSecond, msPerTick } of WINDOW_RATES) {
  test(`a 2 s observation (40 ticks) is still open at +40 ticks and ends at the packet 60 ticks after its start: ${60 * msPerTick} ms (${ticksPerSecond} tps)`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    const f = observing(clock, ticksPerSecond);
    const added = listenersAddedSince(f.bot);
    const pending = f.run(2_000);
    const over = { yet: false };
    void pending.then(() => { over.yet = true; });
    await clock.advance(40 * msPerTick + SLICE_MS);
    assert.equal(f.bot.time.age, f.startAge + 40, "the packet of +40 ticks was heard");
    assert.ok(!over.yet, "+40 ticks: the window is not over");
    const endedAt = await settledAtMs(clock, pending, 10_000);
    assert.equal(f.bot.time.age, f.startAge + 60);
    assert.ok(endedAt >= 60 * msPerTick && endedAt <= 60 * msPerTick + SLICE_MS, `ended at ${endedAt} ms`);
    const result = await pending;
    assert.equal(result.termination, "observation_exhausted");
    assert.match(result.status === "succeeded" ? "" : result.error, /HUNT_OBSERVATION_EXHAUSTED/);
    assert.equal(added("time"), 0);
    assert.equal(clock.pendingGlobalTimers(), 0);
  });

  test(`a window started 10 ticks after a packet ends at the same packet 60 ticks after the cached age (${ticksPerSecond} tps)`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    const f = observing(clock, ticksPerSecond);
    await clock.advance(10 * msPerTick);
    const pending = f.run(2_000);
    const endedAt = await settledAtMs(clock, pending, 10_000);
    assert.equal(f.bot.time.age, f.startAge + 60, "the cached age is the packet at +0: its +60 ends the window");
    assert.ok(endedAt >= 60 * msPerTick && endedAt <= 60 * msPerTick + SLICE_MS, `ended at ${endedAt} ms`);
  });

  test(`quarry that appears at +40 ticks is hunted, and quarry that appears on the +60 packet wins over the expiry (${ticksPerSecond} tps)`, async () => {
    for (const appearsAtTicks of [40, 60]) {
      const clock = createFakeClock({ mode: "mocked" });
      using _installed = clock.install();
      const f = observing(clock, ticksPerSecond);
      const pending = f.run(2_000);
      await clock.advance(SLICE_MS);
      // Registered after the hunt's own `time` listener: the quarry shows on the packet that also ends the window.
      f.bot.on("time", () => {
        if (f.bot.time.age >= f.startAge + appearsAtTicks) f.appear();
      });
      const result = await clock.settle(pending, 10_000, SLICE_MS);
      assert.equal(result.termination, "quantity_collected", `appears at +${appearsAtTicks}`);
      assert.equal(result.status, "succeeded");
    }
  });

  test(`a stopped server ends the 2 s window at its wall backstop of 9 000 ms (${ticksPerSecond} tps)`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    const f = observing(clock, ticksPerSecond);
    const pending = f.run(2_000);
    await clock.advance(SLICE_MS);
    f.server.stop();
    const endedAt = await settledAtMs(clock, pending, 20_000);
    assert.ok(endedAt >= 9_000 && endedAt <= 9_000 + SLICE_MS, `3 * (40 + 20) * 50 = 9 000 ms, ended at ${endedAt}`);
  });

  // A 1-tick window's packet (+40 ticks) is 4 000 ms at 10 tps, past its 3 150 ms backstop (`serverPacedWallMs` doc: the
  // wall ends windows of 18 ticks or fewer first at 10 tps): the shorter of the two ends it.
  for (const stopped of [false, true]) test(`a 1 ms window is 1 tick: it ends at the +40 packet or its 3 150 ms backstop, whichever is first, ${stopped ? "on a stopped server" : "on a running one"} (${ticksPerSecond} tps)`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    const f = observing(clock, ticksPerSecond);
    if (stopped) f.server.stop();
    const endedAt = await settledAtMs(clock, f.run(1), 10_000);
    const expectedMs = stopped ? 3_150 : Math.min(40 * msPerTick, 3_150);
    assert.ok(endedAt >= expectedMs && endedAt <= expectedMs + SLICE_MS, `3 * (1 + 20) * 50 = 3 150 ms; ended at ${endedAt} ms, expected ${expectedMs}`);
  });

  test(`an exhausted observation leaves the next action free: a one-block navigate completes (${ticksPerSecond} tps)`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    const { bot } = createFakeBot({ clock, simulatePhysics: true, position: new Vec3(0.5, 64, 0.5), groundY: 63, server: { ticksPerSecond } });
    const inventory = { count: 0 };
    const navigation = createNavigationRuntime(bot);
    try {
      const hunt = huntMob(
        bot,
        { campSpawner: false, allowWithoutShield: false, observeForMs: 2_000, mobName: "sheep", dropName: "white_wool", count: 1 },
        {},
        dependencies(bot, inventory, []),
      );
      const result = await clock.settle(hunt, 10_000, SLICE_MS);
      assert.equal(result.termination, "observation_exhausted");
      const next = await clock.settle(navigation.navigate({ movements: createMovementPolicy(), goal: exactBlockGoal({ x: 1, y: 64, z: 0 }) }), 20_000, SLICE_MS);
      assert.equal(next.status, "completed", JSON.stringify(next));
    } finally {
      await clock.settle(navigation.close(), 5_000, SLICE_MS);
    }
  });
}

test("a window with no server age at its start and none after ends at its 2 000 ms on-time wall; a first age at 1 000 ms does not extend it", async () => {
  for (const stopped of [true, false]) {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    const f = observing(clock, 20, { timePacketYet: false });
    assert.equal(f.bot.time.age, null, "no packet yet");
    if (stopped) f.server.stop();
    const endedAt = await settledAtMs(clock, f.run(2_000), 10_000);
    assert.ok(endedAt >= 2_000 && endedAt <= 2_000 + SLICE_MS, `${stopped ? "no age at all" : "first age at 1 000 ms"}: ended at ${endedAt} ms`);
  }
});

test("a window of 0 returns at once, as before", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const f = observing(clock, 10);
  const result = await f.run(0);
  assert.equal(result.termination, "no_loaded_targets");
  assert.equal(clock.now(), 0);
});

// One table over a normal window and an accepted long one (`Number.MAX_SAFE_INTEGER`, its sleep chunked by `wakeMs`):
// a cancel ends either at once with the reason as the interruption and leaves no listener or timer.
for (const row of [
  { name: "a window cancelled mid-way", observeForMs: 2_000, ticksPerSecond: 10, advanceMs: 1_000, reason: "reflex takeover" },
  { name: "an accepted long window", observeForMs: Number.MAX_SAFE_INTEGER, ticksPerSecond: 20, advanceMs: 5_000, reason: "owner cancelled" },
]) test(`${row.name} returns the reason as the interruption and leaves no listener or timer`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const f = observing(clock, row.ticksPerSecond);
  const added = listenersAddedSince(f.bot);
  const cancel = new AbortController();
  const pending = f.run(row.observeForMs, cancel.signal);
  await clock.advance(row.advanceMs);
  cancel.abort(new Error(row.reason));
  const result = await clock.settle(pending, 100, SLICE_MS);
  assert.equal(result.termination, "interrupted");
  assert.match(result.status === "succeeded" ? "" : result.error, new RegExp(row.reason));
  for (const event of ["time", "entitySpawn", "entityUpdate", "physicsTick"]) assert.equal(added(event), 0, event);
  assert.equal(clock.pendingGlobalTimers(), 0);
});

// The chunk limit itself (2^31 - 1 ms per sleep) is asserted on `wakeMs` in `spawner-camp.test.ts`: advancing the fake
// clock past 2^31 ms takes over 30 s (measured 2026-11-21), so no end-to-end case sleeps through it.

for (const { ticksPerSecond, msPerTick } of WINDOW_RATES) {
  test(`a reflex that holds the body from +20 to +100 ticks finds the 2 s window over on resume: no new window, the result kept (${ticksPerSecond} tps)`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    const f = observing(clock, ticksPerSecond);
    const budgets = new Budgets();
    const action = createCollectMobDropAction(f.bot, fakeNavigation, fakeCombat, createDiscardedItems(), dependencies(f.bot, f.inventory, []), budgets);
    const runner = new ActionRunner();
    const pending = runner.run({ ...action, execution: { kind: "resumable_task" } }, { mob_name: "sheep", drop_name: "white_wool", count: 1, observe_for_ms: 2_000 });
    await clock.advance(20 * msPerTick);
    assert.equal(budgets.snapshot()[0]?.unit, "ticks", "the budget entry shows ticks");
    assert.equal(budgets.snapshot()[0]?.limit, 40);
    const claim = runner.claim("hunger_reflex", "Eating while awaiting quarry", async () => {
      await clock.sleep(80 * msPerTick);
      return { value: null, continuation: { kind: "resume" as const } };
    });
    assert.equal(claim.kind, "claimed");
    const endedAt = await settledAtMs(clock, pending, 20_000);
    const output = await pending;
    assert.ok("hunt" in output.result && output.result.termination === "observation_exhausted");
    assert.ok(endedAt >= 100 * msPerTick && endedAt <= 100 * msPerTick + 2 * SLICE_MS, `the reflex ended at ${100 * msPerTick} ms; resumed at ${endedAt} ms`);
    assert.deepEqual(budgets.snapshot(), []);
  });
}

test("a terminal observation result held while a reflex interrupts the handoff is kept on resume: it does not open a new window", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const f = observing(clock, 20);
  const budgets = new Budgets();
  let finishes = 0;
  const effects: HuntMobDependencies = {
    ...dependencies(f.bot, f.inventory, []),
    finish: async (signal) => {
      finishes += 1;
      if (finishes === 1) await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return fakeCombat.finish(signal);
    },
  };
  const action = createCollectMobDropAction(f.bot, fakeNavigation, fakeCombat, createDiscardedItems(), effects, budgets);
  const runner = new ActionRunner();
  const pending = runner.run({ ...action, execution: { kind: "resumable_task" } }, { mob_name: "sheep", drop_name: "white_wool", count: 1, observe_for_ms: 2_000 });
  await clock.advance(3_000 + SLICE_MS);
  assert.equal(finishes, 1, "the window ended at +60 ticks and the handoff began");
  const claim = runner.claim("hunger_reflex", "Eating during the handoff", async () => {
    await clock.sleep(500);
    return { value: null, continuation: { kind: "resume" as const } };
  });
  assert.equal(claim.kind, "claimed");
  const output = await clock.settle(pending, 10_000, SLICE_MS);
  assert.equal(finishes, 2);
  assert.ok("hunt" in output.result && output.result.termination === "observation_exhausted");
  assert.deepEqual(budgets.snapshot(), []);
});

test("the checkpoint shows the window in game ticks: 0 of 40 at the start, then the ticks since the cached age", async () => {
  const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
  using _installed = clock.install();
  const f = observing(clock, 20);
  const action = createCollectMobDropAction(f.bot, fakeNavigation, fakeCombat, createDiscardedItems(), dependencies(f.bot, f.inventory, []), new Budgets());
  let read: (() => { checkpoint: Record<string, unknown> }) | undefined;
  const lifetime = new AbortController();
  const run = action.begin(
    parseHuntMobRequest({ mob_name: "sheep", drop_name: "white_wool", count: 1, observe_for_ms: 2_000 }),
    lifetime.signal,
    (observed) => { read = observed as typeof read; },
  );
  const cancel = new AbortController();
  const pending = run({ signal: cancel.signal }).catch(() => undefined);
  await clock.advance(SLICE_MS);
  assert.deepEqual(read?.().checkpoint.observationTicks, { elapsed: 0, limit: 40 });
  await clock.advance(1_000);
  assert.deepEqual(read?.().checkpoint.observationTicks, { elapsed: 20, limit: 40 });
  cancel.abort(new Error("test over"));
  await pending;
  lifetime.abort();
});

test("the checkpoint schema reads a payload with observationTicks and an old one without it", () => {
  const old = {
    phase: "observing", selectedTargetId: null, attacks: 0, targetDeathsObserved: 0, inventory: 0, gained: 0, requested: 1,
    observationStartedAt: 1, observationUntil: 3_001, camp: null,
  };
  assert.deepEqual(huntCheckpointSchema.parse(old), old);
  const current = { ...old, observationTicks: { elapsed: null, limit: 40 } };
  assert.deepEqual(huntCheckpointSchema.parse(current), current);
  assert.throws(() => huntCheckpointSchema.parse({ ...old, observationTicks: { elapsed: "20", limit: 40 } }));
});
