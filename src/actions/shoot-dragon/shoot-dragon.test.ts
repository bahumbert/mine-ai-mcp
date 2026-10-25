import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { carriedCountField } from "../../test-support/carried-counts.js";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { TestEndCombat, engagingCombat, unexpectedEngage } from "../../test-support/combat.js";
import { DragonShotObservation } from "../../survival/perception/combat/dragon-shot.js";
import type { FootingRecovery } from "../../survival/responses/footing.js";
import type { NavigationRuntime } from "../../navigation/index.js";
import { ActionRunner } from "../../session/action-runner.js";
import type { CombatController } from "../../survival/control/combat/contract.js";
import { createShootDragonAction } from "./index.js";
import { shootDragonInputSchema } from "./contract.js";

/** The selected dragon's id, and the id of a second dragon the server later hands the same number. */
const DRAGON_ID = 42;
const REUSED_ID = 43;
/** Every shot settles within the code's 200 aiming ticks plus the arrow's flight: 30 s of clock is ample. */
const SHOT_MS = 30_000;

/**
 * A bot in the End with a bow and 3 arrows and a flying dragon in range. Its physics ticks come from the harness
 * clock: a test settles the shot on it. Drawing is `activateItem`, release is `deactivateItem` while drawing, and a
 * hotbar switch cancels the draw without releasing: the fixture counts them around the fake's own answers (a bow
 * released after 3 ticks of draw shoots and spends an arrow, `bow-draw-and-release`).
 */
function fixture() {
  let drawing = false, releases = 0;
  const dragon = () => ({ name: "ender_dragon", position: new Vec3(30, 84, 0), velocity: new Vec3(0, 0, 0), yaw: 0,
    metadata: { 9: 190, 16: 1 } });
  const harness = createFakeBot({ dimension: "the_end", entities: { [DRAGON_ID]: dragon(), [REUSED_ID]: dragon() },
    carried: { bow: 1, arrow: 3 } });
  const { bot, clock } = harness;
  const draw = bot.activateItem.bind(bot), release = bot.deactivateItem.bind(bot);
  bot.activateItem = (offHand) => { drawing = true; draw(offHand); };
  bot.deactivateItem = () => { if (drawing) releases++; drawing = false; release(); };
  const switchSlot = bot.setQuickBarSlot;
  bot.setQuickBarSlot = (slot) => { drawing = false; switchSlot(slot); };
  const reused = bot.entities[REUSED_ID]!;
  delete bot.entities[REUSED_ID];
  const arrows = carriedCountField(harness, "arrow");
  const end = new TestEndCombat(bot, {} as NavigationRuntime, { needed: false } as FootingRecovery);
  return { bot, clock, combat: harness.combat, dragon: bot.entities[DRAGON_ID]!, reused, arrows, end, releases: () => releases };
}

test("shoot_dragon refuses absent arrows and arrow-immune perches without releasing", async () => {
  const f = fixture();
  f.arrows.count = 0;
  using missing = new DragonShotObservation(f.bot, 42);
  assert.equal((await f.clock.settle(f.end.shootDragon(new AbortController().signal, missing), SHOT_MS)).outcome, "weapon_unavailable");
  f.arrows.count = 1;
  Reflect.set(f.dragon.metadata, 16, 5);
  using perched = new DragonShotObservation(f.bot, 42);
  assert.match((await f.clock.settle(f.end.shootDragon(new AbortController().signal, perched), SHOT_MS)).reason!, /DRAGON_PERCHED/);
  assert.equal(f.releases(), 0);
});

test("caller cancellation during the draw does not release an arrow", async () => {
  const f = fixture(), stop = new AbortController();
  f.bot.activateItem = () => { stop.abort("cancelled while drawing"); };
  using observation = new DragonShotObservation(f.bot, 42);
  await assert.rejects(f.clock.settle(f.end.shootDragon(stop.signal, observation), SHOT_MS));
  assert.equal(observation.attacks, 0);
  assert.equal(f.releases(), 0);
});

test("a released shot survives takeover, reports health loss, and is never fired twice", async () => {
  const f = fixture(), runner = new ActionRunner();
  let first: DragonShotObservation | undefined, attempts = 0;
  const runEnd: CombatController["runEnd"] = async (request, signal) => {
    if (request.kind !== "dragon_bow") throw Error("wrong request");
    attempts++;
    if (attempts === 1) {
      first = request.observation;
      first.released(10);
      const cancelled = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      assert.equal(runner.claim("hostile", "Incoming hostile", async () => {
        Reflect.set(f.dragon.metadata, 9, 187);
        f.bot.emit("entityUpdate", f.dragon);
        return { value: null, continuation: { kind: "resume" as const } };
      }).kind, "claimed");
      await cancelled;
      signal.throwIfAborted();
    }
    assert.equal(request.observation, first);
    return f.end.shootDragon(signal, request.observation);
  };
  const combat = engagingCombat(f.bot, unexpectedEngage, { runEnd });
  const result = await f.clock.settle(runner.run(createShootDragonAction(f.bot, combat), { entity_id: 42 }), SHOT_MS);
  assert.equal(result.result.status, "succeeded");
  assert.equal(first!.attacks, 1);
  assert.equal(first!.damageObserved, 3);
  assert.equal(f.releases(), 0);
  assert.equal(f.bot.listenerCount("entityDead"), 0);
});

test("disappearance and numeric entity-id reuse do not manufacture a bow hit", () => {
  const f = fixture();
  using observation = new DragonShotObservation(f.bot, 42);
  observation.released(10);
  f.bot.entities[42] = Object.assign(f.reused, { id: 42, metadata: { 9: 0, 16: 9 } });
  f.bot.emit("entityUpdate", f.bot.entities[42]);
  assert.equal(observation.loaded, false);
  assert.equal(observation.damageObserved, 0);
  assert.equal(observation.died, false);
  assert.equal(shootDragonInputSchema.parse({ entity_id: 42 }).hitbox_margin, 0.5);
  assert.equal(shootDragonInputSchema.safeParse({ entity_id: 42, hitbox_margin: 2 }).success, false);
  using deadDragon = new DragonShotObservation(f.bot, 42);
  assert.equal(deadDragon.died, true, "already observed zero health survives the gap between requests");
  f.bot.entities[42]!.name = "cow";
  using wrongSpecies = new DragonShotObservation(f.bot, 42);
  assert.equal(wrongSpecies.died, false);
});

test("native death remains terminal when its health metadata packet is still stale", () => {
  const f = fixture();
  using observation = new DragonShotObservation(f.bot, 42);
  observation.released(10);
  f.combat.kill(DRAGON_ID);
  f.bot.emit("physicsTick");
  assert.equal(observation.died, true);
  assert.equal(observation.healthAfter, 0);
});

test("a released arrow without health loss is a miss and is not retried", async () => {
  const f = fixture();
  using observation = new DragonShotObservation(f.bot, 42);
  const result = await f.clock.settle(f.end.shootDragon(new AbortController().signal, observation), SHOT_MS);
  assert.equal(result.outcome, "shot_missed");
  assert.equal(result.attacks, 1);
  assert.equal(f.releases(), 1);
  assert.equal(observation.damageObserved, 0);
});

test("a perch update during the final aim cancels the charged arrow", async () => {
  const f = fixture();
  let looks = 0;
  f.bot.look = async () => { if (++looks === 22) Reflect.set(f.dragon.metadata, 16, 5); };
  using observation = new DragonShotObservation(f.bot, 42);
  const result = await f.clock.settle(f.end.shootDragon(new AbortController().signal, observation), SHOT_MS);
  assert.match(result.reason!, /DRAGON_PERCHED/);
  assert.equal(looks, 22);
  assert.equal(f.releases(), 0);
});

test("even the strictest shot margin yields the charged bow to dragon evasion", async () => {
  const f = fixture(), stop = new AbortController();
  let danger = false, looks = 0, evasions = 0;
  Object.defineProperty(f.end, "danger", { get: () => danger });
  f.bot.look = async () => { if (++looks === 22) danger = true; };
  f.end.evade = async () => {
    evasions++;
    assert.equal(f.releases(), 0);
    stop.abort("evasion owns the body");
    return { outcome: "evaded", attacks: 0, healthBefore: null, healthAfter: null, reason: null };
  };
  using observation = new DragonShotObservation(f.bot, 42, 1.25);
  await assert.rejects(f.clock.settle(f.end.shootDragon(stop.signal, observation), SHOT_MS));
  assert.equal(evasions, 1);
  assert.equal(f.releases(), 0);
});
