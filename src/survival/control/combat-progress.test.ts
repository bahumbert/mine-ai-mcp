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
  const watch = () => observeCombatProgress(bot, [ZOMBIE], progress.mark);
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

test("a target that moves a block marks; jitter does not; each block moved marks again", () => {
  const { zombie, progress, tick, watch } = fixture();
  const stop = watch();
  tick();
  zombie.position = new Vec3(5.9, 64, 0.5);
  tick();
  assert.equal(progress.marks, 0, "0.4 blocks");
  zombie.position = new Vec3(6.6, 64, 0.5);
  tick();
  assert.equal(progress.marks, 1);
  assert.equal(progress.lastReason, "target_moved");
  tick();
  assert.equal(progress.marks, 1, "standing still after the move");
  zombie.position = new Vec3(7.7, 64, 0.5);
  tick();
  assert.equal(progress.marks, 2);
  stop();
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

test("a blocked hit (entity status 29 on the bot) is progress; other statuses and other entities are not", () => {
  const { client, progress, watch } = fixture();
  const stop = watch();
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
  const stop = watch();
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
  const stop = watch();
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
