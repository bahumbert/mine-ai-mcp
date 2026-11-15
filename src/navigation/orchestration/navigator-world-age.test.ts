// Confirmation reads server age through the navigator's scoped bot, including a later run after expiry.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock, flush, type FakeHarness } from "../../test-support/fake-bot/index.js";
import { FakeNavigationBot, flatWorld, onEvent } from "../../test-support/navigation.js";
import type { NavigationEvent } from "../telemetry/index.js";
import type { EffectHandle } from "../bot.js";
import { exactBlockGoal } from "../goals/index.js";
import type { PlannedOperation } from "../movements/movement.js";
import { createMovementPolicy } from "../movements/policy.js";
import type { MemoryWorld } from "../world/memory-world.js";
import { createNavigator } from "./navigator.js";

class SlowAnswerBot extends FakeNavigationBot {
  answer = true;
  constructor(readonly world: MemoryWorld, readonly fake: FakeHarness) { super(); }
  worldAge() { return this.fake.bot.time.age; }
  override startEffect(operation: Exclude<PlannedOperation, { kind: "move" }>): EffectHandle {
    let finish!: (result: { kind: "accepted" } | { kind: "failed"; observation: string }) => void;
    const completion = new Promise<Parameters<typeof finish>[0]>(resolve => { finish = resolve; });
    const clear = this.fake.clock.after(12_000, () => {
      if (!this.answer) return;
      if (operation.kind === "break") this.world.load(operation.position, { stateId: 0 });
      this.current = { ...this.current, worldRevision: this.world.revision };
      finish({ kind: "accepted" });
    });
    return { issued: true, completion, cancel: () => { clear(); finish({ kind: "failed", observation: "cancelled" }); } };
  }
}

function startNavigation() {
  const clock = createFakeClock({ mode: "mocked" });
  const fake = createFakeBot({ clock, server: { ticksPerSecond: 5 } });
  const world = flatWorld();
  for (let z = -5; z <= 5; z++)
    for (const y of [63, 64, 65]) world.load({ x: 1, y, z }, { stateId: 1, traits: { empty: false, safeToBreak: true } });
  const bot = new SlowAnswerBot(world, fake);
  fake.server.stop();
  bot.answer = false;
  const events: NavigationEvent[] = [];
  const navigator = createNavigator({ bot, world, telemetry: onEvent(event => events.push(event)) });
  const request = { goal: exactBlockGoal({ x: 2, y: 63, z: 0 }), policy: createMovementPolicy({
    evaluateBreak: () => ({ decision: { kind: "allowed" }, tool: { itemType: 42, expectedTicks: 10 } }),
  }) };
  return { clock, fake, world, bot, navigator, request, events };
}

test("after stopped-clock confirmation expiry the resumed bot completes its next navigation", async () => {
  const { clock, fake, world, bot, navigator, request, events } = startNavigation();
  using _timers = clock.install();
  const first = navigator.startRun(request);
  if (first.kind !== "started") assert.fail("busy");
  await flush();
  await clock.advance(20_050, 25);
  assert.ok(events.some(event => event.kind === "step_failed" && JSON.stringify(event).includes("Server confirmation deadline elapsed")),
    "the stopped clock expired a confirmation before cancellation ends the retry");
  first.handle.cancel();
  await first.handle.outcome;
  assert.equal(navigator.active, null);
  fake.server.resume();
  bot.answer = true;
  // The first run left the wall intact; the same bot must now clear it and walk through.
  const wall = world.blockAt(1, 63, 0);
  assert.equal(wall.kind === "loaded" && wall.stateId, 1);
  const next = navigator.startRun(request);
  if (next.kind !== "started") assert.fail("busy after expiry");
  try {
    assert.equal((await clock.settle(next.handle.outcome, 60_000)).kind, "completed");
    assert.equal(bot.current.position.x, 2.5);
    assert.equal(navigator.active, null);
  } finally { next.handle.cancel(); await next.handle.outcome; }
});
