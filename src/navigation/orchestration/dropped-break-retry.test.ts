/**
 * A break the server drops (ghost air, run 16): the dig timer ends and the client writes air, the server keeps the block
 * and says nothing. The port then reports the break failed (it waited for the server's packet and asked for the cell
 * again), the block is still there, and the run plans the step again and digs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { FakeNavigationBot, flatWorld, observation, settle } from "../../test-support/navigation.js";
import type { EffectHandle } from "../bot.js";
import { exactBlockGoal } from "../goals/index.js";
import type { PlannedOperation, PlannedStep } from "../movements/movement.js";
import { createMovementPolicy } from "../movements/policy.js";
import type { MemoryWorld } from "../world/memory-world.js";
import { createNavigator } from "./navigator.js";

const WALL = { x: 1, y: 63, z: 0 };
const DROPPED = "The server did not confirm breaking the block at 1,63,0 (no packet for that cell arrived in time); the bot asked it to resend the cell. Give the order again.";

class DroppingBot extends FakeNavigationBot {
  readonly breaks: PlannedOperation[] = [];
  constructor(private readonly world: MemoryWorld, private readonly dropped: number) {
    super();
    this.current = observation(0, 63, 0);
  }
  override async prepareMovement(step: PlannedStep) {
    this.arrive(step.to);
    return { kind: "completed", arrival: step.to } as const;
  }
  override startEffect(operation: Exclude<PlannedOperation, { kind: "move" }>): EffectHandle {
    this.breaks.push(operation);
    if (operation.kind !== "break") return super.startEffect(operation);
    if (this.breaks.length <= this.dropped) {
      return { issued: true, completion: Promise.resolve({ kind: "failed", observation: DROPPED }), cancel: () => undefined };
    }
    this.world.load(operation.position, { stateId: 0 });
    this.current = { ...this.current, worldRevision: this.current.worldRevision + 1 };
    return { issued: true, completion: Promise.resolve({ kind: "accepted" }), cancel: () => undefined };
  }
}

function wallWorld() {
  const world = flatWorld();
  // A wall across the whole loaded width: the only way to the goal is through the cell at WALL.
  for (let z = -5; z <= 5; z += 1)
    for (const y of [63, 64, 65]) world.load({ x: WALL.x, y, z }, { stateId: 1, traits: { empty: false, safeToBreak: true } });
  return world;
}

const diggingPolicy = () => createMovementPolicy({ evaluateBreak: () => ({ decision: { kind: "allowed" }, tool: { itemType: 42, expectedTicks: 10 } }) });

test("after an unanswered break the step is planned again and digs", async () => {
  const world = wallWorld();
  const bot = new DroppingBot(world, 1);
  const navigator = createNavigator({ world, bot });
  const outcome = await settle(navigator, { goal: exactBlockGoal({ x: 2, y: 63, z: 0 }), policy: diggingPolicy() });
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
  assert.ok(bot.breaks.filter((operation) => operation.kind === "break").length >= 2, "the dropped break was tried again");
});

test("a break the server keeps dropping ends the run with the port's words, not a loop", async () => {
  const world = wallWorld();
  const bot = new DroppingBot(world, 1_000);
  const navigator = createNavigator({ world, bot });
  const outcome = await settle(navigator, { goal: exactBlockGoal({ x: 2, y: 63, z: 0 }), policy: diggingPolicy() });
  assert.equal(outcome.kind, "failed");
  assert.match(JSON.stringify(outcome), /did not confirm breaking the block/);
  assert.equal(navigator.active, null);
});
