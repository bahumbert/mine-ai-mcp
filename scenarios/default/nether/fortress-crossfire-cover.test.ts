// P4-29 a6 T8: the crossfire cover's 400-tick protection window opens only after a recovered shelter whose residual burn
// is cleared and whose health is 18, counted in server ticks at 20 and 10 tps. A held, failed or dead shelter, a stopped
// server, a death or an abort in the window, and each left-over listener or timer are checked on the fake clock.
/// <reference types="bun" />
import assert from "node:assert/strict";
import test from "node:test";
import { mock } from "bun:test";
import { Vec3 } from "vec3";
import { type FakeHarness, createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import type { HideOptions, HideResult } from "../../../src/survival/responses/hide.ts";
import { isBurning } from "../../../src/survival/perception/body.ts";
import { type CoveredRecovery, recoverUnderCover } from "../../../src/survival/responses/recover.ts";
import { DEFAULT_SURVIVAL_POLICY } from "../../../src/survival/policy/contract.ts";
import { survivalResources } from "../../../src/survival/state/resources.ts";
import { createMovements, createNavigationRuntime, exactBlockGoal } from "../../../src/navigation/index.ts";
import { waitForServerTicks } from "../../../src/world/world-age.ts";
import * as originalCombat from "../../src/combat.ts";
import * as originalFortress from "./fortress-common.ts";

type ScriptedHide = (bot: FakeHarness["bot"], options: HideOptions) => Promise<HideResult>;
type HideConclusionFixture =
  | { readonly kind: "recovered"; readonly recovery: CoveredRecovery & { readonly kind: "recovered" } }
  | { readonly kind: "held" | "failed"; readonly error: string };
type Outcome = { readonly status: string } | { readonly error: unknown };

/** The scripted hide, its harness and abort controller, and the fireball release the mocked modules read. */
let scriptedHide: ScriptedHide = async () => {
  throw new Error("hide is not scripted");
};
let activeHarness: FakeHarness | undefined;
let activeController: AbortController | undefined;
let releaseFireball: () => void = () => {};
let stopScheduledTick: (() => void) | undefined;
function cancelScheduledTick(): void {
  stopScheduledTick?.();
  stopScheduledTick = undefined;
}
/** The bot's state and world age the moment the hide returned: the protection window starts from here. */
type ReturnedAt = { age: number; burning: boolean; health: number };
let returnedAt: ReturnedAt | undefined;

/** The residual burn metadata flag (`shared_flags` bit 0), set as the server sends it. */
function setBurning(bot: FakeHarness["bot"], on: boolean): void {
  const index = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("shared_flags");
  Reflect.set(bot.entity.metadata, index, on ? 1 : 0);
}

/** A hide result as the production hide returns it: the evidence fields as the shelter left them, then the conclusion. */
function hideResult(bot: FakeHarness["bot"], conclusion: HideConclusionFixture): HideResult {
  return {
    recovery: conclusion.kind === "recovered" ? conclusion.recovery : null, dug: 0, walled: 0, capped: false, enclosed: true,
    ate: null, swings: 0, healthAfter: bot.health, hungerAfter: bot.food, ...conclusion,
  } as HideResult;
}

function installMocks(): void {
  mock.module("../../src/combat.ts", () => ({
    ...originalCombat,
    ScenarioCombat: class {
      constructor(_bot: FakeHarness["bot"], _navigation: unknown) {}
      async hide(bot: FakeHarness["bot"], options: HideOptions): Promise<HideResult> {
        const result = await scriptedHide(bot, options);
        returnedAt = { age: bot.time.age!, burning: isBurning(bot), health: bot.health };
        return result;
      }
      [Symbol.dispose]() {}
    },
  }));
  mock.module("./fortress-common.ts", () => ({
    ...originalFortress,
    prepareFortress: async () => {},
    releaseThreats: async () => releaseFireball(),
  }));
}

function restoreMocks(): void {
  mock.restore();
  mock.module("../../src/combat.ts", () => ({ ...originalCombat }));
  mock.module("./fortress-common.ts", () => ({ ...originalFortress }));
}

/**
 * Runs the fixture on a fake bot with the server at `ticksPerSecond`, the bot burning or not at `health`, and `hide` as the
 * scripted shelter. The fixture's own window is the real `observeIdleWindow`, paced by the fake clock.
 */
async function runFixture(hide: ScriptedHide, options: { burning: boolean; health: number; ticksPerSecond?: number; navigateNext?: boolean }) {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const harness = createFakeBot({ clock, health: options.health, food: 20, simulatePhysics: options.navigateNext, server: { ticksPerSecond: options.ticksPerSecond ?? 20 } });
  const { bot, entities } = harness;
  const initialTimers = clock.pendingTimers();
  const initialGlobalTimers = clock.pendingGlobalTimers();
  setBurning(bot, options.burning);
  const controller = new AbortController();
  const added = listenersAddedSince(bot);
  scriptedHide = hide;
  activeHarness = harness;
  activeController = controller;
  returnedAt = undefined;
  stopScheduledTick = undefined;
  releaseFireball = () => {
    entities.spawn({ name: "small_fireball", position: new Vec3(-27.5, 85, 357.5) });
  };
  const context = {
    bot, signal: controller.signal, scenario: { params: {} }, log: () => {}, navigation: undefined,
  } as unknown as MineAiScenarioContext;
  installMocks();
  let outcome: Outcome;
  let settlements = 0;
  try {
    const { run } = await import("./fortress-crossfire-cover.ts");
    const trial = run(context);
    void trial.then(() => { settlements++; }, () => { settlements++; });
    outcome = { status: (await clock.settle(trial, 120_000)).status };
  } catch (error) {
    outcome = { error };
  } finally {
    restoreMocks();
  }
  const endAge = bot.time.age!;
  let nextNavigation: string | undefined;
  if (options.navigateNext) {
    const navigation = createNavigationRuntime(bot);
    try {
      const route = navigation.navigate({ movements: createMovements(bot, { allowDigging: false }),
        goal: exactBlockGoal({ x: -3, y: 64, z: 0 }) });
      nextNavigation = (await clock.settle(route, 20_000)).status;
    } finally {
      await clock.settle(navigation.close(), 20_000);
    }
  }
  cancelScheduledTick();
  assert.equal(settlements, 1, "the fixture settled once");
  assert.equal(added("entitySpawn"), 0, "no spawn listener left");
  assert.equal(added("entityHurt"), 0, "no hurt listener left");
  assert.equal(clock.pendingTimers(), initialTimers, "no local timer left");
  assert.equal(clock.pendingGlobalTimers(), initialGlobalTimers, "no global timer left");
  await clock.advance(31_000);
  assert.equal(settlements, 1, "the old deadline did not settle the fixture again");
  assert.equal(added("entitySpawn"), 0, "no spawn listener after the old deadline");
  assert.equal(added("entityHurt"), 0, "no hurt listener after the old deadline");
  assert.equal(clock.pendingTimers(), initialTimers, "no local timer after the old deadline");
  assert.equal(clock.pendingGlobalTimers(), initialGlobalTimers, "no global timer after the old deadline");
  const readReturned = (): ReturnedAt | undefined => returnedAt;
  return { outcome, clock, bot, added, endAge, nextNavigation, returnedAt: readReturned() };
}

/** The window's length in server ticks: the world age the run ended at, less the age the hide returned at. */
function windowTicks(run: Awaited<ReturnType<typeof runFixture>>): number {
  assert.ok(run.returnedAt, "the hide returned");
  return run.endAge - run.returnedAt.age;
}

/** Each exit leaves no clock timer and no listener of the fixture on the bot. */
function assertNothingLeft(run: Awaited<ReturnType<typeof runFixture>>): void {
  assert.equal(run.clock.pendingTimers(), 0, "no clock timer left");
  assert.equal(run.added("entitySpawn"), 0, "no spawn listener left");
  assert.equal(run.added("entityHurt"), 0, "no hurt listener left");
}

/** Real recovery under the shelter's own holdWhile: burn damage at 17, the burn clears, then health comes back to 18. */
async function recoversAfterBurn(bot: FakeHarness["bot"], options: HideOptions): Promise<HideResult> {
  let waits = 0;
  const recovery = await recoverUnderCover(bot, {
    signal: options.signal, recoverTo: options.recoverTo, maximumMs: options.maximumMs,
    isProtected: () => true, holdWhile: options.holdWhile,
    defendIntruder: async () => {}, releaseItemUse: () => {},
    wait: async () => {
      waits++;
      if (waits === 1) assert.equal(options.holdWhile?.(), true, "burn keeps healthy recovery pending");
      if (waits === 2) assert.deepEqual([bot.health, isBurning(bot)], [17, true]);
      if (waits === 3) assert.deepEqual([bot.health, isBurning(bot)], [17, false]);
      const age = bot.time.age!;
      const advanced = await waitForServerTicks(bot, 1, { signal: options.signal });
      assert.equal(advanced, "moved");
      assert.ok(bot.time.age! > age, "recovery waited for a server-age advance");
      if (bot.health <= 0) return;
      if (waits === 1) bot.health = 17;
      if (waits === 2) setBurning(bot, false);
      if (waits === 3) bot.health = 18;
    },
    survival: survivalResources(), policy: () => DEFAULT_SURVIVAL_POLICY,
  });
  return recovery.kind === "recovered"
    ? hideResult(bot, { kind: "recovered", recovery })
    : hideResult(bot, { kind: "held", error: `recovery ${recovery.kind}` });
}

/** Runs `action` once `ticks` server ticks have passed from now: the shelter's return is the "now" of the window. */
function afterTicks(bot: FakeHarness["bot"], ticks: number, action: () => void): void {
  const start = bot.time.age!;
  stopScheduledTick = activeHarness!.server.onTick(() => {
    if (bot.time.age! - start >= ticks) {
      cancelScheduledTick();
      action();
    }
  });
}

for (const ticksPerSecond of [20, 10]) {
  for (const health of [20]) {
    test(`at ${ticksPerSecond} tps burning at health ${health} stays in recovery until burn clears and health returns`, async () => {
      let startAge = 0;
      const run = await runFixture((bot, options) => {
        startAge = bot.time.age!;
        return recoversAfterBurn(bot, options);
      }, { burning: true, health, ticksPerSecond });
      assert.deepEqual(run.outcome, { status: "succeeded" });
      assert.deepEqual([run.returnedAt?.burning, run.returnedAt?.health], [false, 18]);
      assert.equal(run.returnedAt!.age - startAge, 60, "three recovery waits advanced 60 server ticks");
      assertNothingLeft(run);
    });
  }

  for (const interruption of ["death", "abort"] as const) {
    for (const phase of ["recovery", "handoff"] as const) {
      test(`at ${ticksPerSecond} tps ${interruption} during ${phase} prevents a protection window`, async () => {
        const run = await runFixture(async (bot, options) => {
          const interrupt = () => interruption === "death" ? void (bot.health = 0) : activeController!.abort();
          if (phase === "recovery") afterTicks(bot, 20, interrupt);
          const result = await recoversAfterBurn(bot, options);
          if (phase === "handoff") interrupt();
          return result;
        }, { burning: true, health: 18, ticksPerSecond });
        if (interruption === "abort") assert.ok("error" in run.outcome, "abort rejects the fixture");
        else assert.deepEqual(run.outcome, { status: "failed" });
        if (run.returnedAt) assert.equal(run.endAge, run.returnedAt.age, "no protection ticks elapsed");
        assertNothingLeft(run);
      });
    }
  }

  test(`at ${ticksPerSecond} tps a stopped server bounds a pending burn recovery`, async () => {
    let stoppedAt: number | undefined;
    const run = await runFixture(async (bot, options) => {
      stoppedAt = bot.time.age!;
      activeHarness!.server.stop();
      return recoversAfterBurn(bot, options);
    }, { burning: true, health: 18, ticksPerSecond });
    assert.ok("error" in run.outcome, "a stopped recovery fails rather than hanging");
    assert.match(String((run.outcome as { error: unknown }).error), /stalled/);
    assert.equal(run.endAge, stoppedAt, "world age did not advance");
    assertNothingLeft(run);
  });

  test(`at ${ticksPerSecond} tps the burn holds the shelter, and the 400-tick window opens only with no burn at health 18`, async () => {
    let receivedHold = false;
    const run = await runFixture(async (bot, options) => {
      assert.equal(typeof options.holdWhile, "function", "the hide must receive the burn as its holdWhile");
      receivedHold = options.holdWhile?.() === true;
      return recoversAfterBurn(bot, options);
    }, { burning: true, health: 18, ticksPerSecond, navigateNext: true });
    assert.equal(receivedHold, true, "while burning the hold is still on");
    assert.deepEqual(run.outcome, { status: "succeeded" });
    assert.deepEqual([run.returnedAt?.burning, run.returnedAt?.health], [false, 18], "no burn left at the window's start");
    // Time packets move the world age in jumps of 20 (`observeIdleWindow` stops at the first packet past 400).
    assert.ok(windowTicks(run) >= 400 && windowTicks(run) <= 420, `the window ran ${windowTicks(run)} server ticks, not 400`);
    assert.equal(run.nextNavigation, "completed", "the next navigation settles after the recovered fixture");
    assert.ok(run.bot.entity.position.x < -2, `walked west: ${run.bot.entity.position}`);
    assertNothingLeft(run);
  });

  test(`at ${ticksPerSecond} tps a stopped server fails the window with the stall text, and nothing is left`, async () => {
    const run = await runFixture(async (bot, options) => {
      const result = await recoversAfterBurn(bot, options);
      activeHarness!.server.stop();
      return result;
    }, { burning: false, health: 18, ticksPerSecond });
    assert.ok("error" in run.outcome, "the window must not settle on a stopped server");
    assert.match(String((run.outcome as { error: unknown }).error), /stood still for 30 s/);
    assertNothingLeft(run);
  });

  test(`at ${ticksPerSecond} tps a death 100 ticks into the window ends it without a successful observation`, async () => {
    const run = await runFixture(async (bot, options) => {
      const result = await recoversAfterBurn(bot, options);
      afterTicks(bot, 100, () => { bot.health = 0; });
      return result;
    }, { burning: false, health: 18, ticksPerSecond });
    assert.deepEqual(run.outcome, { status: "failed" });
    assert.ok(windowTicks(run) >= 100 && windowTicks(run) < 120, `the window ended at ${windowTicks(run)} ticks`);
    assertNothingLeft(run);
  });

  test(`at ${ticksPerSecond} tps an abort 100 ticks into the window rejects it, and nothing is left`, async () => {
    const run = await runFixture(async (bot, options) => {
      const result = await recoversAfterBurn(bot, options);
      afterTicks(bot, 100, () => activeController!.abort());
      return result;
    }, { burning: false, health: 18, ticksPerSecond });
    assert.ok("error" in run.outcome, "an abort in the window must reject it");
    assert.ok(windowTicks(run) >= 100 && windowTicks(run) < 120, `the window ended at ${windowTicks(run)} ticks`);
    assertNothingLeft(run);
  });
}

const notOpened: { name: string; hide: ScriptedHide }[] = [
  { name: "held", hide: async (bot) => hideResult(bot, { kind: "held", error: "the hold ran out" }) },
  { name: "failed", hide: async (bot) => hideResult(bot, { kind: "failed", error: "the shelter could not be closed" }) },
  {
    name: "dead",
    hide: async (bot) => {
      bot.health = 0;
      return hideResult(bot, { kind: "held", error: "The bot died during recovery." });
    },
  },
  {
    name: "recovered while still burning at 18",
    hide: async (bot) => hideResult(bot, { kind: "recovered", recovery: { kind: "recovered", ate: null } }),
  },
  {
    name: "recovered with the burn cleared at 17",
    hide: async (bot) => {
      setBurning(bot, false);
      bot.health = 17;
      return hideResult(bot, { kind: "recovered", recovery: { kind: "recovered", ate: null } });
    },
  },
];

for (const { name, hide } of notOpened) {
  test(`a ${name} shelter fails the trial and opens no protection window`, async () => {
    const run = await runFixture(hide, { burning: name.includes("burning"), health: 18 });
    assert.deepEqual(run.outcome, { status: "failed" });
    assert.equal(run.endAge, run.returnedAt?.age, "no server tick passed after the shelter returned");
    assertNothingLeft(run);
  });
}

test("a recovered shelter with no burn at health 18 keeps the 400-tick protection window (control)", async () => {
  const run = await runFixture(async (bot, options) => {
    const recovery = await recoverUnderCover(bot, {
      signal: options.signal, recoverTo: options.recoverTo, maximumMs: options.maximumMs,
      isProtected: () => true, holdWhile: options.holdWhile,
      defendIntruder: async () => {}, releaseItemUse: () => {}, wait: async () => {},
      survival: survivalResources(), policy: () => DEFAULT_SURVIVAL_POLICY,
    });
    assert.equal(recovery.kind, "recovered", "a bot at 18 with no burn and no hold is recovered at once");
    return hideResult(bot, { kind: "recovered", recovery });
  }, { burning: false, health: 18 });
  assert.deepEqual(run.outcome, { status: "succeeded" });
  assert.ok(windowTicks(run) >= 400 && windowTicks(run) <= 420, `the window ran ${windowTicks(run)} server ticks`);
});
