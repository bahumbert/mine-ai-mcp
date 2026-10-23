import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { TestEndCombat as EndCombat } from "../../../test-support/combat.js";
import { type FakeBotOptions, type FakeEntitySpec, createFakeBot, itemOf } from "../../../test-support/fake-bot/index.js";
import type { CombatController } from "../../control/combat/contract.js";
import { CrystalObservation } from "./crystal.js";

import { createDestroyEndCrystalAction } from "../../../actions/destroy-end-crystal/index.js";
import type { NavigationRuntime } from "../../../navigation/index.js";
import { ActionRunner } from "../../../session/action-runner.js";
import type { FootingRecovery } from "../../responses/footing.js";

/** A new body the server announces under `id`: the same kind as an earlier one, a different object. */
function bodyOf(id: number, spec: FakeEntitySpec): Bot["entity"] {
  return createFakeBot({ entities: { [id]: spec } }).bot.entities[id]!;
}

/** The selected crystal #42 above the bot; the scene's blocks and carried items are the test's. */
function fixture(options: Pick<FakeBotOptions, "carried" | "cells" | "groundY"> = {}) {
  const { bot, clock, server, world } = createFakeBot({
    ...options,
    server: { startAge: 100 },
    entities: { 42: { name: "end_crystal", position: new Vec3(30, 80, 0) } },
  });
  const target = bot.entities[42]!;
  // What the server does on each tick, numbered from the first, before the bot's own tick sees it.
  const script = { ticks: 0, onTick: (_tick: number) => {} };
  clock.onSlice("server", () => script.onTick(++script.ticks));
  const end = new EndCombat(bot, {} as NavigationRuntime, { needed: false } as FootingRecovery);
  const explode = () => bot._client.emit("explosion", { x: 30, y: 80, z: 0 });
  const run = <T>(action: Promise<T>) => clock.settle(action, 60_000);
  return { bot, server, world, target, end, explode, script, run };
}

/** A dragon's breath cloud where the bot stands. */
function breathCloud(bot: Bot): Bot["entity"] {
  return bodyOf(7, { name: "area_effect_cloud", position: bot.entity.position.clone(), metadata: { 8: 5, 10: { type: "dragon_breath" } } });
}

for (const change of ["identity", "dimension"] as const) {
  test(`a ${change} change cannot complete or reissue the selected crystal request`, async () => {
    const f = fixture();
    using observation = new CrystalObservation(f.bot, 42);
    observation.released(8);
    const replacement = bodyOf(42, { name: "end_crystal", position: f.target.position });
    if (change === "identity") f.bot.entities[42] = replacement;
    else f.bot.game.dimension = "the_nether";
    f.bot.emit("entityDead", change === "identity" ? replacement : f.target);
    f.explode();
    assert.equal(observation.destroyed, false);
    const result = await f.run(f.end.crystal(42, new AbortController().signal, observation));
    assert.equal(result.outcome, "stopped");
    assert.equal(result.attacks, 1);
    assert.match(result.reason ?? "", change === "identity" ? /identity/ : /Dimension changed/);
  });
}

test("crystal removal does not end observation before a delayed explosion receipt", async () => {
  const f = fixture();
  using observation = new CrystalObservation(f.bot, 42);
  observation.released(8);
  f.server.stop();
  f.script.onTick = (tick) => {
    if (tick === 1) {
      f.target.isValid = false;
      delete f.bot.entities[42];
    }
    // Far beyond the old ten client-tick window, but the server has not advanced.
    if (tick === 35) f.explode();
  };
  const result = await f.run(f.end.crystal(42, new AbortController().signal, observation));
  assert.equal(result.outcome, "crystal_destroyed");
  assert.equal(result.attacks, 1);
  assert.equal(f.script.ticks, 35);
});

for (const removed of [false, true])
  test(`settled shot distinguishes a loaded miss from lost observation: ${removed}`, async () => {
    const f = fixture();
    using observation = new CrystalObservation(f.bot, 42);
    observation.released(8);
    f.script.onTick = () => {
      if (removed) {
        f.target.isValid = false;
        delete f.bot.entities[42];
      }
    };
    const result = await f.run(f.end.crystal(42, new AbortController().signal, observation));
    // The server's 40 ticks of age arrive as two time packets a second apart: 40 client ticks (contract checks
    // world-age-per-second and wait-for-ticks-and-age; the old fake moved the age twice as fast, at 20 ticks).
    assert.equal(f.script.ticks, 40);
    assert.equal(result.outcome, removed ? "stopped" : "shot_missed");
  });

for (const reappears of [false, true]) test(`lost shot revisits the native site before settling; crystal reappears: ${reappears}`, async () => {
  const f = fixture({ groundY: null, cells: { "30,79,0": "bedrock" } });
  using observation = new CrystalObservation(f.bot, 42, "bow");
  observation.released(8);
  observation.shot!.settled = true;
  f.target.isValid = false;
  delete f.bot.entities[42];
  let visited = false;
  const navigation = { navigate: async () => {
    visited = true;
    f.bot.entity.position.set(10, 64, 0);
    return { status: "completed", elapsedMs: 1 } as const;
  } } as unknown as NavigationRuntime;
  f.script.onTick = () => {
    if (visited && reappears && f.bot.entities[42] === undefined) f.bot.entities[42] = bodyOf(42, { name: "end_crystal", position: f.target.position });
  };
  const result = await f.run(new EndCombat(f.bot, navigation, { needed: false } as FootingRecovery).crystal(42, new AbortController().signal, observation));
  assert.equal(visited, true);
  assert.equal(result.outcome, reappears ? "shot_missed" : "crystal_destroyed");
  assert.equal(observation.destroyed, !reappears);
  if (!reappears) assert.match(result.reason!, /verified it empty/);
});

test("a successful dragon takeover resumes the same crystal request and retains a shot's receipts", async () => {
  const f = fixture();
  const runner = new ActionRunner();
  let attempts = 0;
  let first: CrystalObservation | null = null;
  const combat = {
    async runEnd(request, signal) {
      assert.equal(request.kind, "crystal");
      if (request.kind !== "crystal") throw new Error("wrong request");
      attempts++;
      if (attempts === 1) {
        first = request.observation;
        first.released(8);
        const cancelled = new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        const claim = runner.claim("dragon_reflex", "Dragon breath", async () => {
          f.target.isValid = false;
          delete f.bot.entities[42];
          f.explode();
          return { value: null, continuation: { kind: "resume" as const } };
        });
        assert.equal(claim.kind, "claimed");
        await cancelled;
        signal.throwIfAborted();
      }
      assert.equal(request.observation, first);
      return f.end.crystal(42, signal, request.observation);
    },
  } as CombatController;
  const result = await f.run(runner.run(createDestroyEndCrystalAction(f.bot, combat), { entity_id: 42 }));
  assert.equal(result.result.status, "succeeded");
  assert.equal(attempts, 2);
  assert.deepEqual(result.interruptions, ["Dragon breath"]);
  assert.equal(first!.attacks, 1);
  assert.equal(f.bot.listenerCount("entityDead"), 0);
  assert.equal(f.bot.listenerCount("time"), 0);
  assert.equal(f.bot._client.listenerCount("explosion"), 0);
});

test("caller cancellation while waiting for server progress is final and releases receipts", async () => {
  const f = fixture();
  const caller = new AbortController();
  let attempts = 0;
  const combat = {
    async runEnd(request, signal) {
      if (request.kind !== "crystal") throw new Error("wrong request");
      attempts++;
      request.observation.released(8);
      f.script.onTick = () => caller.abort("cancelled by user");
      return f.end.crystal(42, signal, request.observation);
    },
  } as CombatController;
  const result = await f.run(new ActionRunner().run(
    createDestroyEndCrystalAction(f.bot, combat),
    { entity_id: 42 },
    caller.signal,
  ));
  assert.equal(result.result.status, "cancelled");
  assert.ok("combat" in result.result, "Cancellation preserves the released shot's evidence.");
  if ("combat" in result.result) assert.equal(result.result.combat.attacks, 1);
  assert.equal(attempts, 1);
  assert.equal(f.bot._client.listenerCount("explosion"), 0);
});

test("explicit bow refuses before movement when ammunition is unavailable", async () => {
  const f = fixture({ carried: { bow: 1 } });
  let moves = 0;
  const navigation = {
    navigate: async () => {
      moves++;
      return { status: "completed", elapsedMs: 1 } as const;
    },
  } as unknown as NavigationRuntime;
  using observation = new CrystalObservation(f.bot, 42, "bow");
  const result = await f.run(new EndCombat(f.bot, navigation, { needed: false } as FootingRecovery).crystal(
    42,
    new AbortController().signal,
    observation,
  ));
  assert.equal(result.outcome, "weapon_unavailable");
  assert.match(result.reason ?? "", /CRYSTAL_BOW_UNAVAILABLE/);
  assert.equal(result.crystal?.usedWeapon, null);
  assert.equal(moves, 0);
});

test("crystal bow search accepts distant clear shots without preferring a blocked closer stance", async () => {
  // A tower face between the near stance and the crystal; the far stance's ray passes above it.
  const tower = Object.fromEntries([71, 72, 73, 74, 75].flatMap((y) => [-2, -1, 0, 1, 2].map((z) => [`20,${y},${z}`, "obsidian"])));
  const f = fixture({ carried: { bow: 1, arrow: 8 }, cells: tower });
  f.bot.deactivateItem = () => {};
  f.bot.entity.position.set(100, 64, 0);
  f.bot.findBlocks = options => {
    const openingFloor = new Vec3(-15, 63, 0);
    assert.ok(options.maxDistance! >= f.bot.entity.position.distanceTo(openingFloor), "include shots on the far side of a tower across the island");
    return [openingFloor];
  };
  let checked = false;
  const navigation = { navigate: async ({ goal }: Parameters<NavigationRuntime["navigate"]>[0]) => {
    const resolved = goal.resolve({} as never);
    assert.equal(resolved.kind, "active");
    if (resolved.kind === "active") {
      const near = { feet: { x: 10, y: 64, z: 0 } } as never;
      const far = { feet: { x: -15, y: 64, z: 0 } } as never;
      assert.equal(resolved.isSatisfied(near, {} as never), false);
      assert.equal(resolved.isSatisfied(far, {} as never), true, "a clear shot over 30 horizontal blocks is eligible");
      assert.ok(resolved.heuristic(far) < resolved.heuristic(near), "guide toward the valid opening, even when it is farther from the tower");
      checked = true;
    }
    return { status: "failed", reason: "search checked", elapsedMs: 1 } as const;
  } } as unknown as NavigationRuntime;
  using observation = new CrystalObservation(f.bot, 42, "bow");
  await f.run(new EndCombat(f.bot, navigation, { needed: false } as FootingRecovery).crystal(42, new AbortController().signal, observation));
  assert.equal(checked, true);
});

test("explicit melee reports staircase supplies instead of falling back to a carried bow", async () => {
  const f = fixture({ cells: { "30,79,0": "bedrock", "32,76,0": "obsidian" }, carried: { bow: 1, arrow: 8, cobblestone: 32 } });
  f.target.position.set(30.5, 80, 0.5);
  let moves = 0;
  const navigation = {
    navigate: async () => {
      moves++;
      return { status: "failed", reason: "fixture has no pillar", elapsedMs: 1 } as const;
    },
  } as unknown as NavigationRuntime;
  using observation = new CrystalObservation(f.bot, 42, "melee");
  const result = await f.run(new EndCombat(f.bot, navigation, { needed: false } as FootingRecovery).crystal(
    42,
    new AbortController().signal,
    observation,
  ));
  assert.equal(result.outcome, "stopped");
  assert.equal(result.crystal?.usedWeapon, "melee");
  assert.match(result.reason ?? "", /CRYSTAL_STAIRCASE_SHORTFALL.*end_stone.*carrying 0/);
  assert.equal(observation.shot, null, "explicit melee never enters the bow release path");
  assert.equal(moves, 0, "resource preflight must run before starting the climb");
});

test("melee construction counts bot placements and recovered matching drops, not unrelated world changes", () => {
  const f = fixture();
  using observation = new CrystalObservation(f.bot, 42, "melee");
  observation.beginMelee();
  const air = f.bot.blockAt(new Vec3(2, 64, 0))!;
  f.world.setCell(air.position, "cobblestone");
  const otherStone = f.bot.blockAt(air.position)!;
  assert.equal(observation.scaffoldPlaced, 0, "another actor's observed world update is not our placement");

  f.bot.emit("blockPlaced" as "blockUpdate", air, otherStone);
  f.world.setCell(air.position, "air");
  assert.deepEqual(observation.meleeEvidence(), {
    ...observation.meleeEvidence(),
    scaffoldPlaced: 1,
    scaffoldRecovered: 0,
  });
  const cobblestone = () => itemOf(f.bot.registry, "cobblestone", 1);
  const farDrop = bodyOf(70, { name: "item", position: new Vec3(20, 64, 0), getDroppedItem: cobblestone });
  f.bot.emit("playerCollect", f.bot.entity, farDrop);
  assert.equal(observation.scaffoldRecovered, 0, "an unrelated pickup cannot recover the route scaffold");
  const routeDrop = bodyOf(71, { name: "item", position: air.position.offset(0.5, 0, 0.5), getDroppedItem: cobblestone });
  f.bot.emit("playerCollect", f.bot.entity, routeDrop);
  assert.equal(observation.scaffoldRecovered, 1);
});

test("cage digging matches a pre-observed iron-bar cell when completion reports replacement air", () => {
  const cage = new Vec3(30, 79, 1);
  const f = fixture({ groundY: null, cells: { "30,79,1": "iron_bars" } });
  using observation = new CrystalObservation(f.bot, 42, "melee");
  observation.beginMelee();
  // The dig's own update comes first, then Mineflayer's completion with the block now in the cell.
  f.world.setCell(cage, "air");
  const replacementAir = f.bot.blockAt(cage)!;
  f.bot.emit("diggingCompleted", replacementAir);
  f.bot.emit("diggingCompleted", replacementAir);
  assert.equal(observation.cageBlocksDug, 1, "one observed cage cell has only one completion receipt");
});

test("melee blast damage requires the selected crystal's damage packet and exact explosion receipt", () => {
  const f = fixture();
  using observation = new CrystalObservation(f.bot, 42, "melee");
  observation.beginMelee();
  f.explode();
  f.bot._client.emit("damage_event", {
    entityId: f.bot.entity.id,
    sourceTypeId: 0,
    sourceCauseId: 8,
    sourceDirectId: 8,
  });
  f.bot.health = 17;
  f.bot.emit("health");
  assert.equal(observation.explosionHealthLost, null, "mixed dragon damage remains unattributed");
  f.bot._client.emit("damage_event", {
    entityId: f.bot.entity.id,
    sourceTypeId: 0,
    sourceCauseId: 0,
    sourceDirectId: 43,
  });
  f.bot.health = 15;
  f.bot.emit("health");
  assert.equal(observation.explosionHealthLost, 2);
});

/**
 * A bow shot at the crystal with dragon breath arriving at tick 5: counts the draw's releases and the escapes, and
 * runs `onTick` (the crystal's fate) beside the server's own steps. The release is followed by the crystal's loss at
 * the next tick and its explosion two ticks after.
 */
async function shootThroughBreath(f: ReturnType<typeof fixture>, onTick: (ticks: number) => void) {
  const seen = { drawing: false, releases: 0, escapes: 0 };
  let releaseTick = -1;
  f.bot.activateItem = () => {
    seen.drawing = true;
  };
  const selectSlot = f.bot.setQuickBarSlot;
  f.bot.setQuickBarSlot = (slot) => {
    seen.drawing = false;
    selectSlot(slot);
  };
  f.bot.deactivateItem = () => {
    if (seen.drawing) {
      seen.releases++;
      releaseTick = f.script.ticks;
    }
    seen.drawing = false;
  };
  f.script.onTick = (ticks) => {
    onTick(ticks);
    if (ticks === 5) f.bot.entities[7] = breathCloud(f.bot);
    if (releaseTick >= 0 && ticks === releaseTick + 1) {
      f.target.isValid = false;
      delete f.bot.entities[42];
    }
    if (releaseTick >= 0 && ticks === releaseTick + 3) f.explode();
  };
  const navigation = {
    navigate: async () => {
      seen.escapes++;
      assert.equal(seen.drawing, false, "escape must not release a partial arrow");
      assert.equal(seen.releases, 0);
      delete f.bot.entities[7];
      return { status: "completed", elapsedMs: 1 };
    },
  } as unknown as NavigationRuntime;
  using observation = new CrystalObservation(f.bot, 42);
  const result = await f.run(new EndCombat(f.bot, navigation, { needed: false } as FootingRecovery).crystal(
    42,
    new AbortController().signal,
    observation,
  ));
  return { ...seen, result };
}

test("breath cancels only the bow draw, escapes, then destroys the same crystal with one arrow", async () => {
  const f = fixture({ carried: { bow: 1, arrow: 3 } });
  const { escapes, releases, result } = await shootThroughBreath(f, () => undefined);
  assert.equal(escapes, 1);
  assert.equal(releases, 1);
  assert.equal(result.outcome, "crystal_destroyed");
  assert.equal(result.attacks, 1);
});

test("a crystal destroyed during the resumed draw cancels the draw without firing at its old position", async () => {
  const f = fixture({ carried: { bow: 1, arrow: 3 } });
  const { escapes, releases, result } = await shootThroughBreath(f, (ticks) => {
    if (ticks !== 15) return;
    f.target.isValid = false;
    delete f.bot.entities[42];
    f.explode();
  });
  assert.equal(escapes, 1);
  assert.equal(releases, 0);
  assert.equal(result.outcome, "crystal_destroyed");
  assert.equal(result.attacks, 0);
});
