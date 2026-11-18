// navigation run: a placement the route cut after its click went out is still told to `onPlacement` (Mine Labs 2026-11-17,
// template-roof-counted-scaffold-saltbox: the takedown's drop sweep set a step block, the item was collected 4 to 10 ms
// after the click, the walk was aborted, and the dirt stood after the build, in no scaffold map).
import assert from "node:assert/strict";
import test from "node:test";
import { exactBlockGoal } from "../goals/index.js";
import type { EffectHandle } from "../bot.js";
import type { PlannedOperation } from "../movements/movement.js";
import { createMovementPolicy } from "../movements/policy.js";
import { createNavigator } from "./navigator.js";
import { FakeNavigationBot, flatWorld, observation, settle } from "../../test-support/navigation.js";

type Placed = { readonly position: { readonly x: number; readonly y: number; readonly z: number }; readonly stateId: number };
type EffectOperation = Exclude<PlannedOperation, { kind: "move" }>;

/** A four-block chasm across the whole world: only a bridge crosses it, so the first placement is the run's first effect. */
function chasmWorld() {
  const world = flatWorld();
  for (const x of [1, 2, 3, 4])
    for (let z = -5; z <= 5; z += 1) for (const y of [59, 60, 61, 62]) world.load({ x, y, z }, { stateId: 0 });
  return world;
}

/**
 * A run over the chasm whose first placement the `cut` decides: `"before_click"` aborts the run before the click goes
 * out, `"after_click"` after it (the block stands by then), as the pickup's abort does.
 */
async function bridgeCutAtFirstPlacement(cut: "before_click" | "after_click") {
  const world = chasmWorld();
  const bot = new FakeNavigationBot();
  bot.current = { ...observation(), inventory: new Map([[2, 4]]) };
  const told: Placed[] = [];
  const effects: EffectOperation[] = [];
  const navigator = createNavigator({ world, bot, createId: () => "cut-placement" });
  bot.startEffect = (operation): EffectHandle => {
    effects.push(operation);
    let settleCompletion!: (value: Awaited<EffectHandle["completion"]>) => void;
    const completion = new Promise<Awaited<EffectHandle["completion"]>>((resolve) => (settleCompletion = resolve));
    setImmediate(() => {
      if (cut === "after_click" && operation.kind === "place") world.load(operation.placement.position, { stateId: operation.placement.stateId });
      navigator.cancelActive("pickup_observed");
    });
    return { issued: cut === "after_click", completion, cancel: () => settleCompletion({ kind: "failed", observation: "Completion arrived after cancellation." }) };
  };
  const outcome = await settle(navigator, {
    goal: exactBlockGoal({ x: 5, y: 63, z: 0 }),
    policy: { ...createMovementPolicy({ allowSprinting: false, allowParkour: false }), scaffold: { itemType: 2, stateId: 1, reserve: 0 } },
    onPlacement: (placed) => told.push(placed),
  });
  return { told, effects, outcome };
}

test("a placement cut before its click went out is not told to onPlacement", async () => {
  const { told, effects } = await bridgeCutAtFirstPlacement("before_click");
  assert.equal(effects[0]?.kind, "place", "the run's first effect is a placement");
  assert.deepEqual(told, []);
});

// Whether the block stands or the server dropped it makes no difference here (the takedown digs it or counts it removed:
// build-process.test.ts "a placement reported after a cut click that the server dropped is counted removed").
test("a placement cut after its click went out is told to onPlacement", async () => {
  const { told, effects } = await bridgeCutAtFirstPlacement("after_click");
  const first = effects[0];
  assert.equal(first?.kind, "place");
  if (first?.kind !== "place") return;
  assert.deepEqual(told, [{ position: first.placement.position, stateId: first.placement.stateId }]);
});
