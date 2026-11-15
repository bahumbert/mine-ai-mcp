/**
 * The wait a driver makes before its next `navigate` after fire or lava (plan 2026-11-15-p4-32-33-red-fixes T1): the fire reflex claims the body again
 * while the bot burns (`src/survival/reflexes/fire.ts:143-145`), and a `navigate` that lands on a claim is refused `ACTION_BUSY`, the design. Two reds of
 * `lava-pool-two-deep-foreign-region` called `navigate` 13.8 and 14.2 s after the lava, 18 and 27 ms after a claim began.
 * The burn is counted in world age (the server's ticks: a slow server takes more wall seconds for the same burn) with a wall guard for a server that stops.
 */
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { scenarioDefinitionSchema } from "mine-labs";
import { createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import { createViewStatusAction } from "../../../src/actions/view-status/view-status.ts";
import { temporaryBotData } from "../../../src/test-support/bot-data.ts";
import type { ScenarioCall } from "../scenario.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import { BODY_FREE_BOUND_TICKS, BODY_FREE_WALL_GUARD_MS, burnStartNow, waitUntilBodyFree } from "./wait-until-body-free.ts";

const TICKS_PER_SECOND = 20;
/** The world age comes one packet per 20 ticks: a tick count read from it is up to this far behind (`ContractSubject.serverTicks`). */
const AGE_STALENESS_TICKS = 19;

/**
 * A driver context on the fake bot, the clock installed, whose `view_status` is the real action: the owner and the burning flag are what the test sets as time passes.
 * `statusAnswer` replaces the answer (a refused call).
 */
function bodyOf(t: TestContext, server: { ticksPerSecond?: number } = {}, statusAnswer?: () => unknown) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, server });
  const { bot } = harness;
  const flagsIndex = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("shared_flags");
  const state = { owner: null as string | null };
  const action = createViewStatusAction(bot, temporaryBotData({ botId: "TestBot", closeAfter: t }), () =>
    state.owner === null ? { owner: "idle" as const, activeAction: null } : { owner: "takeover" as const, activeAction: { action: state.owner, startedAt: "2026-11-15T00:00:00.000Z" } },
  );
  const context = scenarioTestContext({
    bot,
    scenario: scenarioDefinitionSchema.parse({ goal: { kind: "completion" } }),
    call: async () => ({ action: "view_status", durationMs: 0, summary: "status", result: statusAnswer ? statusAnswer() : await action.execute({}, {}) }) as unknown as ScenarioCall,
  });
  const burn = (on: boolean) => Reflect.set(bot.entity.metadata, flagsIndex, on ? 1 : 0);
  return { clock, installed: clock.install(), harness, context, state, burn };
}

test("a bot that is free and not burning is waited for 0 ms", async (t) => {
  const { clock, installed, context } = bodyOf(t);
  using _installed = installed;
  const waited = await clock.settle(waitUntilBodyFree(context, burnStartNow(context.bot), clock.sleep), 1_000);
  assert.deepEqual(waited, { freed: true, reason: "free", waitedMs: 0, afterStartTicks: 0, fireOutAfterTicks: 0, burning: false, owners: [] });
});

test("the wait ends only when the fire is out and the reflex let go, whichever comes last, and names the owner and the ticks since the start", async (t) => {
  for (const { fireOutAtMs, releasedAtMs, freeAtMs } of [{ fireOutAtMs: 9_000, releasedAtMs: 6_000, freeAtMs: 9_000 }, { fireOutAtMs: 5_000, releasedAtMs: 7_000, freeAtMs: 7_000 }]) {
    const { clock, installed, context, state, burn } = bodyOf(t);
    using _installed = installed;
    burn(true);
    state.owner = "fire_reflex";
    clock.after(releasedAtMs, () => void (state.owner = null));
    clock.after(fireOutAtMs, () => burn(false));
    const waited = await clock.settle(waitUntilBodyFree(context, burnStartNow(context.bot), clock.sleep), 20_000);
    assert.equal(waited.freed, true, JSON.stringify(waited));
    assert.ok(waited.waitedMs >= freeAtMs && waited.waitedMs < freeAtMs + 300, JSON.stringify(waited));
    assert.deepEqual(waited.owners, ["fire_reflex"]);
    const fireOutTicks = (fireOutAtMs / 1_000) * TICKS_PER_SECOND;
    assert.ok(waited.fireOutAfterTicks !== null && Math.abs(waited.fireOutAfterTicks - fireOutTicks) <= AGE_STALENESS_TICKS + TICKS_PER_SECOND / 4, JSON.stringify(waited));
  }
});

test("a bot that burns to the bound ends the wait there, failed, with the owner seen, the burning flag and the reason; the bound counts from the start given", async (t) => {
  for (const alreadyElapsedTicks of [0, 240]) {
    const { clock, installed, context, state, burn } = bodyOf(t);
    using _installed = installed;
    burn(true);
    state.owner = "fire_reflex";
    const start = burnStartNow(context.bot);
    const waited = await clock.settle(waitUntilBodyFree(context, { atMs: start.atMs - (alreadyElapsedTicks / TICKS_PER_SECOND) * 1_000, age: start.age - alreadyElapsedTicks }, clock.sleep), BODY_FREE_WALL_GUARD_MS);
    const leftMs = ((BODY_FREE_BOUND_TICKS - alreadyElapsedTicks) / TICKS_PER_SECOND) * 1_000;
    assert.equal(waited.freed, false);
    assert.equal(waited.burning, true);
    assert.deepEqual(waited.owners, ["fire_reflex"]);
    assert.match(waited.reason, /still burning|held by fire_reflex/);
    assert.ok(waited.waitedMs >= leftMs - 1_100 && waited.waitedMs < leftMs + 1_100, `left ${leftMs} ms, waited ${JSON.stringify(waited)}`);
  }
});

test("a slow server takes more wall seconds for the same burn: 338 ticks at 15 ticks a second (22.5 s, past the old 20 s wall bound) still frees", async (t) => {
  const { clock, installed, harness, context, burn } = bodyOf(t, { ticksPerSecond: 15 });
  using _installed = installed;
  burn(true);
  const start = burnStartNow(context.bot);
  const MEASURED_BURN_TICKS = 338; // the longest burn of the 30 runs of `lava-pool-two-deep-foreign-region`: 16.906 s at 20 ticks a second
  context.bot.on("time", () => void (context.bot.time.age - start.age >= MEASURED_BURN_TICKS && burn(false)));
  const waited = await clock.settle(waitUntilBodyFree(context, start, clock.sleep), BODY_FREE_WALL_GUARD_MS);
  assert.equal(waited.freed, true, JSON.stringify({ waited, serverTicks: harness.server.gameTime }));
  assert.ok(waited.waitedMs > 20_000, `waited ${waited.waitedMs} ms`);
});

test("a server that stops ticking ends the wait at the wall guard, failed", async (t) => {
  const { clock, installed, harness, context, burn } = bodyOf(t);
  using _installed = installed;
  burn(true);
  harness.server.stop();
  const waited = await clock.settle(waitUntilBodyFree(context, burnStartNow(context.bot), clock.sleep), BODY_FREE_WALL_GUARD_MS + 1_000);
  assert.equal(waited.freed, false);
  assert.match(waited.reason, /wall/);
  assert.ok(waited.waitedMs >= BODY_FREE_WALL_GUARD_MS && waited.waitedMs < BODY_FREE_WALL_GUARD_MS + 500, JSON.stringify(waited));
});

test("a bot that died ends the wait at once, failed, naming the death", async (t) => {
  const { clock, installed, harness, context } = bodyOf(t);
  using _installed = installed;
  harness.combat.setHealth(0, 20);
  const waited = await clock.settle(waitUntilBodyFree(context, burnStartNow(context.bot), clock.sleep), 1_000);
  assert.equal(waited.freed, false);
  assert.match(waited.reason, /died/);
  assert.equal(waited.waitedMs, 0);
});

test("a status call that fails never reads as a free body", async (t) => {
  const { clock, installed, context } = bodyOf(t, {}, () => ({ kind: "runtime_failure", status: "failed", error: "refused" }));
  using _installed = installed;
  const start = burnStartNow(context.bot);
  const waited = await clock.settle(waitUntilBodyFree(context, { atMs: start.atMs - 15_000, age: start.age - 300 } /* 100 ticks left */, clock.sleep), 10_000);
  assert.equal(waited.freed, false);
  assert.match(waited.reason, /status/);
});
