import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, itemOf } from "../../test-support/fake-bot/index.js";
import { observeHuntDrops } from "./drop-accounting.js";
import { huntDropSightingSchema } from "./contract.js";

/** The item entities the tests drop, made by the harness and held back until a test lets the bot see one. */
const DROP_IDS = [7, 8] as const;
/** Another player, the collector the bot is not. */
const OTHER_PLAYER_ID = 2;

function fixture() {
  const stacks = new Map<number, { name: string; count: number } | null>();
  const harness = createFakeBot({
    groundY: null,
    // Unloaded chunks where the first test's drop is seen: the bot reads no block there.
    cells: { "20,45,-19": "void", "20,44,-19": "void", "22,44,-19": "void", "22,43,-19": "void" },
    entities: {
      [OTHER_PLAYER_ID]: { name: "player", position: new Vec3(25, 45, -19) },
      ...Object.fromEntries(
        DROP_IDS.map((id) => [
          id,
          {
            name: "item",
            position: new Vec3(20, 45, -19),
            getDroppedItem: () => {
              const stack = stacks.get(id) ?? null;
              return stack && itemOf(harness.bot.registry, stack.name, stack.count);
            },
          },
        ]),
      ),
    },
  });
  const { bot, world } = harness;
  const unseen = new Map(DROP_IDS.map((id) => [id, bot.entities[id]!]));
  for (const id of DROP_IDS) delete bot.entities[id];
  /** The listeners of the idle harness bot (its physics and digging), which an observation leaves as it found them. */
  const idleEvents = bot.eventNames();
  const lifetime = new AbortController();
  const item = (id: (typeof DROP_IDS)[number], stack: { name: string; count: number } | null) => {
    stacks.set(id, stack);
    const state = {
      get stack() {
        return stacks.get(id) ?? null;
      },
      set stack(next) {
        stacks.set(id, next);
      },
    };
    const entity = unseen.get(id)!;
    bot.entities[id] = entity;
    return { entity, state };
  };
  return { bot, lifetime, item, world, idleEvents, otherPlayer: bot.entities[OTHER_PLAYER_ID]! };
}

test("records late item metadata, current location, and unexplained disappearance without inventing a pickup", () => {
  const f = fixture();
  const read = observeHuntDrops(f.bot, "magma_cream", f.lifetime.signal);
  const drop = f.item(7, null);
  f.bot.emit("entitySpawn", drop.entity);
  assert.deepEqual(read(), []);
  drop.state.stack = { name: "magma_cream", count: 2 };
  f.bot.emit("itemDrop", drop.entity);
  drop.entity.position = new Vec3(22, 44, -19);
  assert.equal(read()[0]!.position.y, 44);
  f.bot.emit("entityGone", drop.entity);
  delete f.bot.entities[7];
  const sighting = huntDropSightingSchema.parse(read()[0]);
  assert.equal(sighting.firstSeen, "during_hunt");
  assert.equal(sighting.state, "no_longer_observed");
  assert.equal(sighting.observedCount, 2);
  assert.equal(sighting.collectedByBot, false);
  assert.deepEqual(sighting.blocks, { atPosition: null, belowPosition: null });
  f.lifetime.abort();
  assert.deepEqual(f.bot.eventNames(), f.idleEvents, "request settlement detaches every listener");
});

test("records a drop moving from air into lava without claiming destruction or pickup", () => {
  const f = fixture();
  f.world.setCell(new Vec3(20, 45, -19), "air");
  f.world.setCell(new Vec3(20, 44, -19), "lava");
  f.world.setCell(new Vec3(20, 43, -19), "basalt");
  const read = observeHuntDrops(f.bot, "magma_cream", f.lifetime.signal);
  const drop = f.item(7, { name: "magma_cream", count: 1 });
  f.bot.emit("itemDrop", drop.entity);
  assert.deepEqual(read()[0]!.blocks, { atPosition: "air", belowPosition: "lava" });
  drop.entity.position.y = 44.56;
  f.bot.emit("entityMoved", drop.entity);
  // Removal may arrive without readable item metadata; retain the last movement observation.
  drop.state.stack = null;
  f.bot.emit("entityGone", drop.entity);
  delete f.bot.entities[7];
  const sighting = huntDropSightingSchema.parse(read()[0]);
  assert.deepEqual(sighting.blocks, { atPosition: "lava", belowPosition: "basalt" });
  assert.equal(sighting.position.y, 44.56);
  assert.equal(sighting.state, "no_longer_observed");
  assert.equal(sighting.collectedByBot, false);
  assert.equal(sighting.collectedByOther, false);
  f.lifetime.abort();
  assert.deepEqual(f.bot.eventNames(), f.idleEvents);
});

test("a partial collection can leave a loaded remainder; other collectors are distinct", () => {
  const f = fixture();
  const drop = f.item(7, { name: "magma_cream", count: 3 });
  const read = observeHuntDrops(f.bot, "magma_cream", f.lifetime.signal);
  f.bot.emit("playerCollect", f.bot.entity, drop.entity);
  drop.state.stack = { name: "magma_cream", count: 2 };
  assert.deepEqual(
    read().map((s) => [s.state, s.observedCount, s.collectedByBot]),
    [["loaded", 2, true]],
  );
  f.bot.emit("playerCollect", f.otherPlayer, drop.entity);
  delete f.bot.entities[7];
  assert.equal(read()[0]!.collectedByOther, true);
  assert.equal(read()[0]!.firstSeen, "already_loaded");
  f.lifetime.abort();
});

test("observations survive physical attempt cancellation but end with the admitted request", () => {
  const f = fixture();
  const attempt = new AbortController();
  const read = observeHuntDrops(f.bot, "magma_cream", f.lifetime.signal);
  attempt.abort("hostile reflex took over");
  const drop = f.item(8, { name: "magma_cream", count: 1 });
  f.bot.emit("itemDrop", drop.entity);
  assert.equal(read()[0]!.state, "loaded");
  assert.equal(f.bot.listenerCount("itemDrop"), 1);
  f.lifetime.abort();
  assert.equal(f.bot.listenerCount("itemDrop"), 0);
});
