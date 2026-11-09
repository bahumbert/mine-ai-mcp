import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { observeCombatProgress } from "./combat-progress.js";
import { ReflexProgress } from "./reflex-progress.js";

const SELF = 1;
const ZOMBIE = 7;
const BYSTANDER = 9;
/** A killed creature stays on the client for its death animation (945 ms) and is then removed. */
const DEATH_REMOVAL_MS = 1_000;

/** Stone on every side of the body at (0, 64, 0): floor, roof and the four walls of both body cells. */
const SHELTER_SHELL = ["0,63,0", "0,66,0", ...[64, 65].flatMap((y) => [`1,${y},0`, `-1,${y},0`, `0,${y},1`, `0,${y},-1`])];

/** A bot with a server connection, in the open (a shelter can close around it), a zombie in the response's threats and a cow that is not. */
function fixture() {
  const { bot, world: blocks, combat: scene, clock } = createFakeBot({
    entities: {
      [ZOMBIE]: { name: "zombie", position: new Vec3(5.5, 64, 0.5) },
      [BYSTANDER]: { name: "cow", position: new Vec3(-5.5, 64, 0.5) },
    },
  });
  const client = bot._client;
  const zombie = bot.entities[ZOMBIE]!;
  const emitter = bot;
  const world = {
    closeShelter: () => {
      for (const cell of SHELTER_SHELL) blocks.setCell(new Vec3(...(cell.split(",").map(Number) as [number, number, number])), "stone");
    },
  };
  const progress = new ReflexProgress();
  const tick = () => bot.emit("physicsTick");
  const watch = (kind: "fight" | "evade" | "hide" | "deflect" = "fight") => observeCombatProgress(bot, [ZOMBIE], progress.mark, kind);
  return { bot, emitter, client, zombie, world, progress, tick, watch, scene, clock };
}

test("damage to the bot or to a threat of the response is progress; damage to anyone else is not", () => {
  const { scene, progress, watch } = fixture();
  const stop = watch();
  scene.hurt(BYSTANDER, null, 2);
  assert.equal(progress.marks, 0);
  scene.hurtBot(2, null);
  scene.hurt(ZOMBIE, null, 2);
  assert.equal(progress.marks, 2);
  assert.equal(progress.lastReason, "hurt");
  stop();
});

test("a threat that dies or leaves is progress", async () => {
  const { scene, clock, progress, watch } = fixture();
  const stop = watch();
  scene.kill(BYSTANDER);
  await clock.advance(DEATH_REMOVAL_MS);
  assert.equal(progress.marks, 0);
  scene.kill(ZOMBIE);
  assert.equal(progress.lastReason, "threat_dead");
  await clock.advance(DEATH_REMOVAL_MS);
  assert.equal(progress.lastReason, "threat_gone");
  assert.equal(progress.marks, 2);
  stop();
});

test("fight distance rewards nearing, never pacing or shuttling; other responses retain repeated target travel", () => {
  const nearer = [[0.5, 5.1, 0], [0.5, 4.4, 1], [0.5, 4.4, 1], [0.5, 3.3, 2]];
  const pacing = [[0.5, 6.5, 0], [0.5, 5.5, 0], [1.5, 6.5, 0], [0.5, 5.5, 0]];
  const travel = [[0.5, 5.9, 0], [0.5, 6.6, 1], [0.5, 6.6, 1], [0.5, 7.7, 2]];
  for (const [kind, steps] of [["fight", nearer], ["fight", pacing], ["evade", travel], ["hide", travel], ["deflect", travel]] as const) {
    const { bot, zombie, progress, tick, watch } = fixture();
    const stop = watch(kind);
    tick();
    for (const [self, target, marks] of steps) {
      bot.entity.position.x = self!;
      zombie.position.x = target!;
      tick();
      assert.equal(progress.marks, marks, kind);
      if (marks) assert.equal(progress.lastReason, kind === "fight" ? "target_nearer" : "target_moved");
    }
    stop();
  }
});

test("a target that has left the entity list does not break the sampling", () => {
  const { bot, progress, tick, watch } = fixture();
  const stop = watch();
  tick();
  delete bot.entities[ZOMBIE];
  assert.doesNotThrow(tick);
  assert.equal(progress.marks, 0);
  stop();
});

test("a shield-blocked hit does not mark a fight; it still marks an evade", () => {
  const { client, progress, watch } = fixture();
  const fight = watch();
  client.emit("entity_status", { entityId: SELF, entityStatus: 29 });
  assert.equal(progress.marks, 0);
  fight();
  const stop = watch("evade");
  client.emit("entity_status", { entityId: SELF, entityStatus: 2 });
  client.emit("entity_status", { entityId: BYSTANDER, entityStatus: 29 });
  assert.equal(progress.marks, 0);
  client.emit("entity_status", { entityId: SELF, entityStatus: 29 });
  assert.equal(progress.lastReason, "shield_block");
  assert.equal(progress.marks, 1);
  stop();
});

test("every tick inside a closed shelter is progress: a hold is protected waiting", () => {
  const { world, progress, tick, watch } = fixture();
  const stop = watch("evade");
  tick();
  tick();
  assert.equal(progress.marks, 0, "in the open");
  world.closeShelter();
  tick();
  tick();
  assert.equal(progress.marks, 2);
  assert.equal(progress.lastReason, "enclosed");
  stop();
});

test("a world that cannot be read marks nothing and does not throw out of the tick", () => {
  const { bot, progress, tick, watch } = fixture();
  bot.blockAt = () => {
    throw new Error("chunk unloaded");
  };
  const stop = watch("evade");
  assert.doesNotThrow(tick);
  assert.equal(progress.marks, 0);
  stop();
});

test("detach removes every listener from the bot and its connection, for any number of bots", () => {
  for (let bots = 0; bots < 20; bots++) {
    const { emitter, client, watch } = fixture();
    const before = [emitter.eventNames().length, client.eventNames().length];
    const stop = watch();
    stop();
    assert.deepEqual([emitter.eventNames().length, client.eventNames().length], before);
    assert.equal(emitter.listenerCount("physicsTick"), 0);
  }
});
