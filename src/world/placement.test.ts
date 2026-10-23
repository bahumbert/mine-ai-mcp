import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import {
  type FakeBotOptions,
  type FakeClock,
  type FakeServer,
  createFakeBot,
  createFakeClock,
} from "../test-support/fake-bot/index.js";
import { placeBlock, type InventoryItem, type WorldBlock } from "./placement.js";

/** Off every target cell: Mineflayer lists the bot's own entity in `bot.entities` (`entities.js:105`), which a placement checks. */
const STANDING = new Vec3(3.5, 64, 3.5);

/**
 * A creative-mode bot carrying one `itemName` over a stone floor (y 63), its clock driving the timers the placement
 * waits on; `options` add cells, entities, a game mode or the methods the test scripts.
 */
function placer(itemName: string, options: FakeBotOptions = {}) {
  const harness = createFakeBot({
    gameMode: "creative",
    position: STANDING,
    carried: { [itemName]: 1 },
    clock: createFakeClock({ mode: "mocked" }),
    ...options,
  });
  const item: InventoryItem = harness.bot.inventory.items()[0]!;
  return { ...harness, item };
}

/** Mineflayer's own placement with options (`place_block.js`), which the fake leaves out: the test scripts it. Stopgap until the shared fake has it (gap reported to the master, M5). */
function withNativePlacement(bot: Bot, place: (support: unknown, face: unknown, options: unknown) => Promise<void>): void {
  Object.assign(bot, { _placeBlockWithOptions: place });
}

/** The shift key as the 1.21.4 server reads it: `entity_action` 0 down, 1 up (`sneak.ts`). */
function shiftPackets(server: FakeServer): number[] {
  return server.packets.filter((packet) => packet.name === "entity_action").map((packet) => (packet.data as { actionId: number }).actionId);
}

/** Move the clock `ms` on and hand back `pending`, which must be over by then. Stopgap until M2 merges `clock.settle`. */
async function settledAfter<T>(clock: FakeClock, ms: number, pending: Promise<T>): Promise<T> {
  let over = false;
  void pending.then(() => (over = true), () => (over = true));
  await clock.advance(ms);
  assert.ok(over, `still waiting after ${ms} ms of clock`);
  return pending;
}

/** A turn of a quarter circle at Mineflayer's 3 rad/s (11 ticks), with room. */
const QUARTER_TURN_MS = 1_000;
/** Two time packets, one a second (contract check `world-age-per-second`): the 40 ticks past a send. */
const TWO_TIME_PACKETS_MS = 2_000;

function placementAt(bot: Bot, item: InventoryItem, target: Vec3, extra: Record<string, unknown> = {}) {
  return {
    item,
    support: bot.blockAt(target.offset(0, -1, 0))!,
    face: new Vec3(0, 1, 0),
    expectedCells: [target] as [Vec3],
    matches: (block: WorldBlock) => block.name === item.name,
    ...extra,
  };
}

test("placement settles the last item before another caller can select the emptied stack", async () => {
  const target = new Vec3(0, 64, 0);
  const { bot, clock, world, inventory, item } = placer("cobblestone", {
    gameMode: "survival",
    overrides: {
      placeBlock: async () => {
        world.setCell(target, "cobblestone");
        clock.after(30, () => inventory.updateSlot(36, null as never));
      },
    },
  });
  using _timers = clock.install();
  const result = await settledAfter(clock, 100, placeBlock(bot, placementAt(bot, item, target)));
  assert.equal(result.kind, "placed");
  assert.equal(bot.inventory.count(item.type, null), 0);
});

test("places an oriented block while sneaking and always releases sneak", async () => {
  const target = new Vec3(1, 64, 0);
  const { bot, clock, server, world, item } = placer("red_bed");
  using _timers = clock.install();
  withNativePlacement(bot, async (_support, _face, options) => {
    assert.deepEqual(options, { forceLook: "ignore", swingArm: "right" });
    world.setCell(target, "red_bed");
  });

  const result = await settledAfter(
    clock,
    QUARTER_TURN_MS,
    placeBlock(bot, placementAt(bot, item, target, { matches: (block: WorldBlock) => block.name.endsWith("_bed"), lookDirection: new Vec3(1, 0, 0) })),
  );

  assert.equal(result.kind, "placed");
  assert.equal(bot.entity.yaw, -Math.PI / 2);
  assert.equal(bot.entity.pitch, 0);
  assert.deepEqual(shiftPackets(server), [0, 1]);
});

test("ordinary placement requests immediate native face aiming", async () => {
  const target = new Vec3(1, 64, 0);
  const face = new Vec3(0, 1, 0);
  const { bot, clock, server, world, item } = placer("cobblestone", {
    overrides: {
      lookAt: async (point: Vec3, force?: boolean) => {
        assert.deepEqual(point, new Vec3(1.5, 64, 0.5));
        assert.equal(force, true);
      },
      placeBlock: async () => {
        throw new Error("Default native placement waits for a smooth turn");
      },
    },
  });
  using _timers = clock.install();
  const support = bot.blockAt(target.offset(0, -1, 0))!;
  withNativePlacement(bot, async (actualSupport, actualFace, options) => {
    assert.equal(actualSupport, support);
    assert.deepEqual(actualFace, face);
    assert.deepEqual(options, { forceLook: "ignore", swingArm: "right" });
    world.setCell(target, "cobblestone");
  });
  const result = await settledAfter(clock, 0, placeBlock(bot, { ...placementAt(bot, item, target), support, face }));
  assert.equal(result.kind, "placed");
  assert.deepEqual(shiftPackets(server), [0, 1]);
});

for (const entersDuringAim of [false, true]) {
  test(`full-cube placement refuses an observed body ${entersDuringAim ? "entering during aim" : "already in the cell"}`, async () => {
    const target = new Vec3(0, 64, 0);
    let packets = 0;
    let equips = 0;
    const { bot, clock, item } = placer("cobblestone", {
      entities: { 9: { name: "wither_skeleton", position: new Vec3(0.5, 64, entersDuringAim ? 3 : 0.5) } },
      overrides: {
        equip: async () => {
          equips++;
        },
        lookAt: async () => {
          bot.entities[9]!.position.z = 0.5;
        },
      },
    });
    using _timers = clock.install();
    withNativePlacement(bot, async () => {
      packets++;
    });
    const result = await settledAfter(clock, 0, placeBlock(bot, placementAt(bot, item, target, { matches: () => true })));
    assert.equal(result.kind, "failed");
    if (result.kind === "failed") assert.match(result.error, /\(0, 64, 0\).*wither_skeleton #9/);
    assert.equal(packets, 0);
    assert.equal(equips, entersDuringAim ? 1 : 0);
  });
}

test("a player standing in the cell is named by username, with a request to step out, not an entity id", async () => {
  const target = new Vec3(0, 64, 0);
  const { bot, clock, item } = placer("cobblestone", {
    entities: { 305: { name: "player", username: "Tester", position: new Vec3(0.5, 64, 0.5) } },
    players: { Tester: { gamemode: 0 } },
  });
  using _timers = clock.install();
  const result = await settledAfter(clock, 0, placeBlock(bot, placementAt(bot, item, target, { matches: () => true })));
  assert.equal(result.kind, "failed");
  if (result.kind === "failed") {
    assert.match(result.error, /overlaps player Tester/u);
    assert.match(result.error, /ask Tester to step out/u);
    assert.doesNotMatch(result.error, /#305/u);
  }
});

test("does not accept half of a multi-block placement", async () => {
  const foot = new Vec3(1, 64, 0);
  const head = new Vec3(2, 64, 0);
  const { bot, clock, item } = placer("red_bed", { cells: { "1,64,0": "red_bed" } });
  using _timers = clock.install();
  withNativePlacement(bot, async () => {});

  const result = await settledAfter(
    clock,
    QUARTER_TURN_MS + TWO_TIME_PACKETS_MS,
    placeBlock(bot, {
      ...placementAt(bot, item, foot),
      expectedCells: [foot, head],
      matches: (block: WorldBlock) => block.name.endsWith("_bed"),
      lookDirection: new Vec3(1, 0, 0),
    }),
  );

  assert.equal(result.kind, "failed");
});

test("waits for every cell of a multi-block placement", async () => {
  const foot = new Vec3(1, 64, 0);
  const head = new Vec3(2, 64, 0);
  const { bot, clock, world, item } = placer("red_bed", { cells: { "1,64,0": "red_bed" } });
  using _timers = clock.install();
  // The head half is a server moment behind the foot half.
  withNativePlacement(bot, async () => {
    clock.after(40, () => world.setCell(head, "red_bed"));
  });

  const result = await settledAfter(
    clock,
    QUARTER_TURN_MS,
    placeBlock(bot, {
      ...placementAt(bot, item, foot),
      expectedCells: [foot, head],
      matches: (block: WorldBlock) => block.name.endsWith("_bed"),
      lookDirection: new Vec3(1, 0, 0),
    }),
  );

  assert.equal(result.kind, "placed");
});

test("releases sneak when Mineflayer rejects placement", async () => {
  const { bot, clock, server, item } = placer("red_bed");
  using _timers = clock.install();
  withNativePlacement(bot, async () => {
    throw new Error("rejected");
  });

  const result = await settledAfter(
    clock,
    QUARTER_TURN_MS,
    placeBlock(bot, { ...placementAt(bot, item, new Vec3(0, 64, 0)), lookDirection: new Vec3(1, 0, 0) }),
  );

  assert.deepEqual(result, { kind: "failed", error: "rejected" });
  assert.deepEqual(shiftPackets(server), [0, 1]);
});

test("uses the 1.21.4 sneaking action before placement against an interactive support", async () => {
  const target = new Vec3(0, 64, 0);
  // Mineflayer's own placement on the fake: the look at the face, `block_place`, the server's block update.
  const { bot, clock, server, item } = placer("furnace", { version: "1.21.4", cells: { "0,63,0": "crafting_table" } });
  using _timers = clock.install();

  const result = await settledAfter(clock, QUARTER_TURN_MS, placeBlock(bot, placementAt(bot, item, target)));

  assert.equal(result.kind, "placed");
  const protocol = server.packets
    .filter((packet) => packet.name === "entity_action" || packet.name === "block_place")
    .map((packet) => (packet.name === "entity_action" ? `entity_action:${(packet.data as { actionId: number }).actionId}` : "place"));
  assert.deepEqual(protocol, ["entity_action:0", "place", "entity_action:1"]);
});

test("accepts a physically observed placement after Mineflayer's block-update timeout", async () => {
  const target = new Vec3(0, 64, 0);
  const { bot, clock, world, item } = placer("furnace", {
    overrides: {
      placeBlock: async () => {
        world.setCell(target, "furnace");
        throw new Error("Event blockUpdate:(0, 64, 0) did not fire within timeout of 5000ms");
      },
    },
  });
  using _timers = clock.install();

  const result = await settledAfter(clock, 0, placeBlock(bot, placementAt(bot, item, target)));

  assert.equal(result.kind, "placed");
});

test("preserves a block-update timeout with post-timeout world evidence", async () => {
  const target = new Vec3(0, 64, 0);
  const { bot, clock, item } = placer("furnace", {
    overrides: {
      placeBlock: async () => {
        throw new Error("Event blockUpdate:(0, 64, 0) did not fire within timeout of 5000ms");
      },
    },
  });
  using _timers = clock.install();
  const sentAt = bot.time.age;

  const result = await settledAfter(clock, TWO_TIME_PACKETS_MS, placeBlock(bot, placementAt(bot, item, target)));

  assert.deepEqual(result, {
    kind: "failed",
    error:
      "Event blockUpdate:(0, 64, 0) did not fire within timeout of 5000ms; " +
      "the server moved 40 ticks past it and (0, 64, 0)=air.",
  });
  assert.equal(bot.time.age, sentAt + 40, "the wait ended on the server answer: two time packets");
});

/** What the test's server does with a survival placement: show the block, send the slot update, on its clock. */
interface PlacementAnswer {
  readonly appear: () => void;
  readonly consume: () => void;
  readonly clock: FakeClock;
}

/** A survival bot placing its one cobblestone at `target`, the placement answered by `answer`. */
function survivalPlacer(target: Vec3, answer: (scene: PlacementAnswer) => Promise<void>) {
  const harness = placer("cobblestone", {
    gameMode: "survival",
    overrides: {
      placeBlock: () =>
        answer({
          appear: () => harness.world.setCell(target, "cobblestone"),
          consume: () => harness.inventory.updateSlot(36, null as never),
          clock: harness.clock,
        }),
    },
  });
  return { ...harness, placement: placementAt(harness.bot, harness.item, target) };
}

test("a block whose slot update comes 600 ms after it is placed, not failed", async () => {
  const target = new Vec3(0, 64, 0);
  const { bot, clock, placement } = survivalPlacer(target, async (scene) => {
    scene.appear();
    scene.clock.after(600, scene.consume);
  });
  using _timers = clock.install();

  const result = await settledAfter(clock, 700, placeBlock(bot, placement));

  assert.equal(result.kind, "placed");
});

test("a block that appears after mineflayer's timeout but before the world age moved 40 ticks is placed", async () => {
  const target = new Vec3(0, 64, 0);
  const { bot, clock, server, world, item } = placer("cobblestone", {
    overrides: {
      placeBlock: async () => {
        throw new Error("Event blockUpdate:(0, 64, 0) did not fire within timeout of 5000ms");
      },
    },
  });
  using _timers = clock.install();
  // The block lands with the first time packet after the send: 20 ticks, half the answer wait.
  server.onTimePacket(() => world.setCell(target, "cobblestone"));

  const result = await settledAfter(clock, 1_050, placeBlock(bot, placementAt(bot, item, target)));

  assert.equal(result.kind, "placed");
});

test("a server that answered without the block fails after 40 ticks with the observed cells", async () => {
  const target = new Vec3(0, 64, 0);
  const { bot, clock, item } = placer("cobblestone", { overrides: { placeBlock: async () => {} } });
  using _timers = clock.install();

  const result = await settledAfter(clock, TWO_TIME_PACKETS_MS, placeBlock(bot, placementAt(bot, item, target)));

  assert.deepEqual(result, {
    kind: "failed",
    error: "The expected block did not appear after placement: the server moved 40 ticks past it and (0, 64, 0)=air.",
  });
});

test("physics stopped (waitForTicks never resolves): the block wait still ends on the wall clock", async () => {
  const target = new Vec3(0, 64, 0);
  const { bot, clock, server, item } = placer("cobblestone", { overrides: { placeBlock: async () => {} } });
  using _timers = clock.install();
  // No physics tick and no time packet: only the wall bound can end the wait.
  bot.physicsEnabled = false;
  server.stop();

  const outcome = await settledAfter(clock, 150, placeBlock(bot, placementAt(bot, item, target, { answerWallMs: 120 })));

  assert.equal(outcome.kind, "failed");
});

test("creative placement does not wait for a count", async () => {
  const target = new Vec3(0, 64, 0);
  const { bot, clock, world, item } = placer("cobblestone", {
    overrides: { placeBlock: async () => world.setCell(target, "cobblestone") },
  });
  using _timers = clock.install();

  const result = await settledAfter(clock, 0, placeBlock(bot, placementAt(bot, item, target)));

  assert.equal(result.kind, "placed");
});

test("a block that appeared but whose consumption never shows fails once the server answered", async () => {
  const target = new Vec3(0, 64, 0);
  const { bot, clock, placement } = survivalPlacer(target, async (scene) => scene.appear());
  using _timers = clock.install();

  const result = await settledAfter(clock, TWO_TIME_PACKETS_MS, placeBlock(bot, placement));

  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.match(result.error, /consumption of cobblestone was not observed \(inventory 1 → 1\)/u);
});

test("onSent fires once, after the equip and look, right before the placement packet", async () => {
  const target = new Vec3(0, 64, 0);
  const calls: string[] = [];
  const { bot, clock, item } = placer("cobblestone", {
    cells: { "0,64,0": "cobblestone" },
    overrides: {
      equip: async () => void calls.push("equip"),
      lookAt: async () => void calls.push("look"),
    },
  });
  using _timers = clock.install();
  withNativePlacement(bot, async () => void calls.push("packet"));

  await settledAfter(clock, 0, placeBlock(bot, placementAt(bot, item, target, { onSent: () => calls.push("sent") })));

  assert.deepEqual(calls, ["equip", "look", "sent", "packet"]);
});

test("onSent does not fire when the look throws", async () => {
  const target = new Vec3(0, 64, 0);
  let sent = 0;
  const { bot, clock, item } = placer("cobblestone", {
    overrides: {
      lookAt: async () => {
        throw new Error("no look");
      },
    },
  });
  using _timers = clock.install();
  withNativePlacement(bot, async () => {});

  const result = await settledAfter(clock, 0, placeBlock(bot, placementAt(bot, item, target, { onSent: () => void (sent += 1) })));

  assert.equal(result.kind, "failed");
  assert.equal(sent, 0);
});

test("onSent does not fire when the signal aborts before the send", async () => {
  const target = new Vec3(0, 64, 0);
  const controller = new AbortController();
  let sent = 0;
  const { bot, clock, item } = placer("cobblestone", { overrides: { lookAt: async () => controller.abort(new Error("cut")) } });
  using _timers = clock.install();
  withNativePlacement(bot, async () => {});

  await assert.rejects(
    settledAfter(clock, 0, placeBlock(bot, placementAt(bot, item, target, { signal: controller.signal, onSent: () => void (sent += 1) }))),
    /cut/u,
  );
  assert.equal(sent, 0);
});
