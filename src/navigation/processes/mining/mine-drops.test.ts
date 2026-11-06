import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../../../test-support/fake-bot/index.js";
import { MineDropTracker } from "./mine-drops.js";

function trackerWith(drops: Record<number, Vec3>, cells: Record<string, string> = {}) {
  const { bot, entities: server } = createFakeBot({
    position: new Vec3(0, 64, 0),
    cells,
    entities: Object.fromEntries(Object.entries(drops).map(([id, position]) => [id, { name: "item", position }])),
  });
  let lostDrops = 0;
  const tracker = new MineDropTracker(
    bot,
    { observedInventoryGain: () => 0, onLostDrop: () => { lostDrops += 1; } },
    new Set(),
    new Set(),
  );
  /** The server spawns a drop of the block just broken, after the bot was made. */
  const spawnDrop = (id: number, position: Vec3) => server.spawn({ id, name: "item", position, item: { name: "cobblestone", count: 1 } });
  /** Breaks whose drop never appeared, as the caller of the tracker hears them through `onLostDrop`. */
  return { tracker, entities: bot.entities, spawnDrop, lost: () => lostDrops, blockAt: (x: number, z: number) => bot.blockAt(new Vec3(x, 64, z)) };
}

describe("MineDropTracker anticipated drops", () => {
  test("a drop spawning 2 s after the break (server behind) is still a target and then followed", () => {
    const { tracker, spawnDrop, lost } = trackerWith({});
    tracker.noteBreak({ x: 5, y: 64, z: 5 }, 0);
    assert.deepEqual(tracker.update([], 2_000).map((t) => t.kind), ["anticipated_drop"]);
    spawnDrop(7, new Vec3(5.5, 64, 5.5));
    assert.partialDeepStrictEqual(tracker.update([], 2_100), [{ kind: "drop", entityId: 7 }]);
    tracker.update([], 9_000);
    assert.equal(lost(), 0);
  });

  test("no spawn within 5 s expires the anticipation and reports it lost once", () => {
    const { tracker, lost } = trackerWith({});
    tracker.noteBreak({ x: 5, y: 64, z: 5 }, 0);
    assert.equal(tracker.update([], 4_999).length, 1);
    assert.equal(lost(), 0);
    assert.equal(tracker.update([], 5_000).length, 0);
    assert.equal(tracker.anticipating, false);
    assert.equal(lost(), 1);
    tracker.update([], 9_000);
    assert.equal(lost(), 1, "an expired anticipation is not counted again");
  });

  test("a block with no loot data is counted lost when no drop appears, as before", () => {
    const { tracker, lost, blockAt } = trackerWith({}, { "5,64,5": "bedrock" });
    tracker.noteBreak({ x: 5, y: 64, z: 5 }, 0, blockAt(5, 5));
    tracker.update([], 5_000);
    assert.equal(lost(), 1);
  });

  test("a stone broken by hand loiters like any break but, expiring with a dirt break, only the dirt counts lost", () => {
    const { tracker, lost, blockAt } = trackerWith({}, { "5,64,5": "stone", "9,64,5": "dirt" });
    tracker.noteBreak({ x: 5, y: 64, z: 5 }, 0, blockAt(5, 5));
    tracker.noteBreak({ x: 9, y: 64, z: 5 }, 0, blockAt(9, 5));
    assert.equal(tracker.update([], 2_000).length, 2, "both are provisional targets while they loiter");
    tracker.update([], 5_000);
    assert.equal(tracker.anticipating, false);
    assert.equal(lost(), 1);
  });

  test("once the item entity appeared and vanished, the break is no longer anticipated", () => {
    const { tracker, entities, lost } = trackerWith({ 7: new Vec3(5.5, 64, 5.5) });
    tracker.noteBreak({ x: 5, y: 64, z: 5 }, 0);
    tracker.update([], 100);
    delete entities[7];
    const kinds = tracker.update([], 3_000).map((t) => t.kind);
    assert.ok(!kinds.includes("anticipated_drop"));
    assert.equal(lost(), 0);
  });

  test("20 breaks with late drops gain 20", () => {
    const { tracker, spawnDrop, lost } = trackerWith({});
    for (let i = 0; i < 20; i++) tracker.noteBreak({ x: i * 10, y: 64, z: 0 }, 0);
    assert.equal(tracker.update([], 2_000).filter((t) => t.kind === "anticipated_drop").length, 20);
    for (let i = 0; i < 20; i++) spawnDrop(100 + i, new Vec3(i * 10 + 0.5, 64, 0.5));
    const drops = tracker.update([], 2_100).filter((t) => t.kind === "drop");
    assert.equal(drops.length, 20);
    assert.equal(lost(), 0);
  });
});

describe("MineDropTracker anticipated drops rank last", () => {
  const block = (x: number) => ({ kind: "block", position: { x, y: 64, z: 0 }, excludedStances: new Set<string>() }) as never;

  test("10 leaf breaks with no spawns never offer an anticipated target while blocks remain", () => {
    const { tracker } = trackerWith({});
    for (let i = 0; i < 10; i++) {
      tracker.noteBreak({ x: i, y: 64, z: 0 }, i * 100);
      const kinds = tracker.update([block(i + 1)], i * 100 + 50).map((t) => t.kind);
      assert.deepEqual(kinds, ["block"]);
    }
    assert.equal(tracker.anticipating, true);
  });

  test("the last break's late drop (2 s) is still waited for and followed once the blocks are gone", () => {
    const { tracker, spawnDrop } = trackerWith({});
    for (let i = 0; i < 10; i++) tracker.noteBreak({ x: i, y: 64, z: 0 }, i * 100);
    assert.equal(tracker.update([block(99)], 950).length, 1);
    const waiting = tracker.update([], 2_000);
    assert.ok(waiting.every((t) => t.kind === "anticipated_drop"));
    spawnDrop(5, new Vec3(9.5, 64, 0.5));
    assert.ok(tracker.update([], 2_100).some((t) => t.kind === "drop" && t.entityId === 5));
  });

  test("a live drop outranks an anticipated one", () => {
    const { tracker } = trackerWith({ 9: new Vec3(40.5, 64, 0.5) });
    tracker.noteBreak({ x: 0, y: 64, z: 0 }, 0);
    const live = { kind: "drop", position: { x: 40, y: 64, z: 0 }, entityId: 9 } as never;
    assert.deepEqual(tracker.update([live], 100).map((t) => t.kind), ["drop"]);
  });
});
