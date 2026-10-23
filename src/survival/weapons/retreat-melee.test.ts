import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import type { HostileContext } from "../control/combat/context.js";
import { type FakeEntitySpec, createFakeBot } from "../../test-support/fake-bot/index.js";
import { defendWhileRetreating } from "./retreat-melee.js";

/** A wall between the bot's eye and the magma cube, which a raycast meets. */
const COVER_CELLS = [new Vec3(1, 64, 0), new Vec3(1, 65, 0)];

/** Retreat defence must not steal the route's equip, look or control operations: each fails the test. */
function stolen(operation: string) {
  return () => assert.fail(`retreat defence used ${operation}, which belongs to the route`);
}

/** A size-2 magma cube two blocks from a bot holding a diamond sword, and with `neutral`, a piglin beside it. */
function fixture(options: { neutral?: boolean } = {}) {
  const metadata: unknown[] = [];
  // Not on the shared fake until M3 merges: entity.kind.
  const cube = { kind: "Hostile mobs", width: 1.04, height: 1.04 };
  const entities: Record<number, FakeEntitySpec> = {
    7: { name: "magma_cube", position: new Vec3(2, 64, 0), metadata, ...cube },
  };
  if (options.neutral) entities[8] = { name: "piglin", position: new Vec3(1, 64, 1), metadata, ...cube };
  const harness = createFakeBot({
    position: new Vec3(0, 64, 0),
    health: 11,
    carried: { diamond_sword: 1 },
    entities,
    overrides: {
      attack: () => {
        attacks.push(ticks);
      },
      equip: stolen("equip"),
      look: stolen("look"),
      lookAt: stolen("lookAt"),
      setControlState: stolen("setControlState"),
      clearControlStates: stolen("clearControlStates"),
    },
  });
  const { bot, clock, world } = harness;
  metadata[bot.registry.entitiesByName.magma_cube!.metadataKeys!.indexOf("size")] = 2;
  const target = bot.entities[7]!;
  const attacks: number[] = [];
  let ticks = 0;
  bot.on("physicsTick", () => {
    ticks += 1;
  });
  const resolvedIds = new Set<number>();
  const context: HostileContext = {
    resolvedIds,
    attackerIds: new Set(),
    unreachableIds: new Set(),
  };
  return {
    bot,
    target,
    context,
    resolvedIds,
    attacks,
    /** The physics listeners the scene itself holds (its tick counter). */
    ownTickListeners: bot.listenerCount("physicsTick"),
    advance: (count = 1) => clock.advance(50 * count),
    cover: (value: boolean) => {
      for (const cell of COVER_CELLS) world.setCell(cell, value ? "stone" : "air");
    },
  };
}

test("retreat strikes respect sword cooldown, observed death, and observer disposal without steering", async () => {
  const f = fixture();
  const defence = defendWhileRetreating(f.bot, f.context, new AbortController().signal);
  await f.advance(14);
  assert.deepEqual(f.attacks, [1, 14]);
  // The hostile observer owns the shared record of dead threats.
  f.resolvedIds.add(f.target.id);
  f.bot.emit("entityDead", f.target);
  await f.advance(20);
  assert.deepEqual(defence.evidence(), { attacks: 2, weaponsUsed: ["diamond_sword"], killedTargetIds: [7] });
  defence[Symbol.dispose]();
  assert.equal(f.bot.listenerCount("physicsTick"), f.ownTickListeners);
  assert.equal(f.bot.listenerCount("entityDead"), 0);
});

test("retreat does not strike through cover, beyond reach, during a dig, or after cancellation", async () => {
  const f = fixture();
  const controller = new AbortController();
  using defence = defendWhileRetreating(f.bot, f.context, controller.signal);
  f.cover(true);
  await f.advance();
  f.cover(false);
  f.target.position.x = 4;
  await f.advance();
  f.target.position.x = 2;
  f.bot.targetDigBlock = f.bot.blockAt(new Vec3(0, 63, 0))!;
  await f.advance();
  Object.assign(f.bot, { targetDigBlock: null });
  f.bot.usingHeldItem = true;
  await f.advance();
  f.bot.usingHeldItem = false;
  assert.deepEqual(f.attacks, []);
  await f.advance();
  assert.deepEqual(f.attacks, [5]);
  controller.abort();
  await f.advance(20);
  assert.deepEqual(f.attacks, [5]);
  assert.equal(defence.evidence().attacks, 1);
});

test("retreat preserves nearby neutrals from sword sweep and never selects them as targets", async () => {
  const f = fixture({ neutral: true });
  const neutral = f.bot.entities[8]!;
  using defence = defendWhileRetreating(f.bot, f.context, new AbortController().signal);
  await f.advance();
  assert.deepEqual(f.attacks, []);
  neutral.position.x = 10;
  await f.advance();
  assert.deepEqual(f.attacks, [2]);
  delete f.bot.entities[7];
  neutral.position.x = 1;
  await f.advance(20);
  assert.deepEqual(f.attacks, [2]);
  assert.equal(defence.evidence().attacks, 1);
});
