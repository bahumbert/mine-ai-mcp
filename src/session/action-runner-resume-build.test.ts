// The runner gives a reflex-interrupted build_structure back to its caller as one request (spec 2026-10-18, R2, task T4).
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { createBuildStructureAction } from "../actions/build-structure/build-structure.js";
import type { NavigationRuntime } from "../navigation/index.js";
import { temporaryBotData } from "../test-support/bot-data.js";
import { structureWorld } from "../test-support/structure-world.js";
import { ActionRunner } from "./action-runner.js";
const botData = temporaryBotData();after(() => botData.close());

const WALL = { blocks: [2, 3, 4, 5].map((x) => ({ x, y: 64, z: 0, block_name: "cobblestone" })) };

/** A build whose second placement never returns until the body is taken: the reflex arrives there. */
function buildCutAtSecondPlacement() {
  const world = structureWorld();
  Object.assign(world.bot, { clearControlStates() {}, deactivateItem() {}, currentWindow: null, isSleeping: false });
  const navigation = { cancel() {} } as unknown as NavigationRuntime;
  let placed = 0;
  let cutAt: () => void = () => {};
  const atSecond = new Promise<void>((resolve) => { cutAt = resolve; });
  const physics = {
    ...world.physics,
    place: async (placement: Parameters<typeof world.physics.place>[0]) => {
      placed += 1;
      if (placed === 2) {
        cutAt();
        await new Promise<void>((resolve) => placement.signal?.addEventListener("abort", () => resolve(), { once: true }));
        placement.signal?.throwIfAborted();
      }
      return world.physics.place(placement);
    },
  };
  return { ...world, action: createBuildStructureAction(world.bot as Bot, navigation, botData, physics), atSecond };
}

test("a build the hunger reflex interrupts finishes as one request that names the interruption", async () => {
  const { action, atSecond, placements, blocks } = buildCutAtSecondPlacement();
  const runner = new ActionRunner();
  const outcome = runner.run(action, WALL);
  await atSecond;
  runner.claim("hunger_reflex", "[HUNGER] ate cooked_beef.", async () => ({ value: "ate", continuation: { kind: "resume" as const } }));
  const output = await outcome;
  assert.equal(output.result.status, "succeeded");
  assert.equal("structure" in output.result && output.result.structure?.placed, 4);
  assert.deepEqual(output.interruptions, ["[HUNGER] ate cooked_beef."]);
  assert.deepEqual([...placements].sort(), ["2,64,0", "3,64,0", "4,64,0", "5,64,0"], "no cell placed twice");
  assert.equal(blocks.get("5,64,0")!.name, "cobblestone");
  assert.deepEqual(runner.status(), { busy: false, activeAction: null, owner: "idle" });
});

test("a build whose reflex ends with a return verdict ends interrupted, unchanged, and places nothing more", async () => {
  const { action, atSecond, placements } = buildCutAtSecondPlacement();
  const runner = new ActionRunner();
  const outcome = runner.run(action, WALL);
  await atSecond;
  const claim = runner.claim("hostile_reflex", "[HOSTILE_CONTACT] fight.", async () => ({
    value: "evaded", continuation: { kind: "return" as const, reason: "Evaded; health 9." },
  }));
  const output = await outcome;
  if (claim.kind === "claimed") await claim.outcome;
  assert.equal(output.result.status, "cancelled");
  assert.deepEqual(output.interruptions, ["Evaded; health 9."]);
  assert.deepEqual(placements, ["2,64,0"], "only what the first attempt placed before the cut");
});

test("two reflexes in a row on one build give two interruptions and one success", async () => {
  const world = structureWorld();
  Object.assign(world.bot, { clearControlStates() {}, deactivateItem() {}, currentWindow: null, isSleeping: false });
  const navigation = { cancel() {} } as unknown as NavigationRuntime;
  let placed = 0;
  const arrivals: (() => void)[] = [];
  const waiting = [0, 1].map(() => new Promise<void>((resolve) => arrivals.push(resolve)));
  const action = createBuildStructureAction(world.bot as Bot, navigation, botData, {
    ...world.physics,
    place: async (placement) => {
      placed += 1;
      if (placed === 2 || placed === 4) {
        arrivals[placed === 2 ? 0 : 1]!();
        await new Promise<void>((resolve) => placement.signal?.addEventListener("abort", () => resolve(), { once: true }));
        placement.signal?.throwIfAborted();
      }
      return world.physics.place(placement);
    },
  });
  const runner = new ActionRunner();
  const outcome = runner.run(action, WALL);
  await waiting[0];
  runner.claim("hunger_reflex", "[HUNGER] first.", async () => ({ value: null, continuation: { kind: "resume" as const } }));
  await waiting[1];
  runner.claim("fall_reflex", "[FALL] second.", async () => ({ value: null, continuation: { kind: "resume" as const } }));
  const output = await outcome;
  assert.equal(output.result.status, "succeeded");
  assert.deepEqual(output.interruptions, ["[HUNGER] first.", "[FALL] second."]);
  assert.equal(world.placements.length, new Set(world.placements).size, "no cell placed twice");
  assert.equal("structure" in output.result && output.result.structure?.placed, 4);
});

test("a model cancel while the reflex holds the body is final: the build does not resume", async () => {
  const { action, atSecond, placements } = buildCutAtSecondPlacement();
  const runner = new ActionRunner();
  const outcome = runner.run(action, WALL);
  await atSecond;
  let releaseReflex!: () => void;
  const reflexBusy = new Promise<void>((resolve) => { releaseReflex = resolve; });
  runner.claim("hunger_reflex", "[HUNGER] eating.", async () => {
    await reflexBusy;
    return { value: "ate", continuation: { kind: "resume" as const } };
  });
  runner.cancelActive("The model cancelled the build.");
  releaseReflex();
  const output = await outcome;
  assert.equal(output.result.status, "cancelled");
  assert.deepEqual(placements, ["2,64,0"]);
});
