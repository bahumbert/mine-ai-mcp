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

/** The shift key as the 1.21.4 server reads it: `entity_action` 0 down, 1 up (`sneak.ts`). */
function shiftPackets(server: FakeServer): number[] {
  return server.packets.filter((packet) => packet.name === "entity_action").map((packet) => (packet.data as { actionId: number }).actionId);
}

/** A turn of a quarter circle at Mineflayer's 3 rad/s (11 ticks), with room. */
const QUARTER_TURN_MS = 1_000;
/** The server answers a click one slice of clock after it is written. */
const SERVER_ANSWER_MS = 50;
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
      _placeBlockWithOptions: async () => {
        world.setCell(target, "cobblestone");
        clock.after(30, () => inventory.updateSlot(36, null as never));
      },
    },
  });
  using _timers = clock.install();
  const result = await clock.settle(placeBlock(bot, placementAt(bot, item, target)), 100);
  assert.equal(result.kind, "placed");
  assert.equal(bot.inventory.count(item.type, null), 0);
});

test("places an oriented block while sneaking and always releases sneak", async () => {
  const target = new Vec3(1, 64, 0);
  const { bot, clock, server, item } = placer("red_bed");
  using _timers = clock.install();

  const result = await clock.settle(placeBlock(bot, placementAt(bot, item, target, { matches: (block: WorldBlock) => block.name.endsWith("_bed"), lookDirection: new Vec3(1, 0, 0) })), QUARTER_TURN_MS);

  assert.equal(result.kind, "placed");
  // `forceLook: "ignore"` leaves the look where `look` turned it, and `swingArm: "right"` is the arm_animation of hand 0.
  assert.equal(bot.entity.yaw, -Math.PI / 2);
  assert.equal(bot.entity.pitch, 0);
  assert.deepEqual(server.packets.filter((packet) => packet.name === "arm_animation").map((packet) => packet.data), [{ hand: 0 }]);
  assert.deepEqual(shiftPackets(server), [0, 1]);
});

test("ordinary placement requests immediate native face aiming", async () => {
  const target = new Vec3(1, 64, 0);
  const face = new Vec3(0, 1, 0);
  let looks = 0;
  const { bot, clock, server, item } = placer("cobblestone", {
    overrides: {
      lookAt: async (point: Vec3, force?: boolean) => {
        looks += 1;
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
  const result = await clock.settle(placeBlock(bot, { ...placementAt(bot, item, target), support, face }), SERVER_ANSWER_MS);
  assert.equal(result.kind, "placed");
  // The click names the support and the face; `forceLook: "ignore"` keeps Mineflayer from aiming again (the one look is placement's).
  const click = server.packets.find((packet) => packet.name === "block_place")!.data as { location: Vec3; direction: number };
  assert.deepEqual([click.location, click.direction], [support.position, 1]);
  assert.equal(looks, 1);
  assert.deepEqual(shiftPackets(server), [0, 1]);
});

for (const entersDuringAim of [false, true]) {
  test(`full-cube placement refuses an observed body ${entersDuringAim ? "entering during aim" : "already in the cell"}`, async () => {
    const target = new Vec3(0, 64, 0);
    let equips = 0;
    const { bot, clock, server, item } = placer("cobblestone", {
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
    const result = await clock.settle(placeBlock(bot, placementAt(bot, item, target, { matches: () => true })), 0);
    assert.equal(result.kind, "failed");
    if (result.kind === "failed") assert.match(result.error, /\(0, 64, 0\).*wither_skeleton #9/);
    assert.equal(server.packets.filter((packet) => packet.name === "block_place").length, 0);
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
  const result = await clock.settle(placeBlock(bot, placementAt(bot, item, target, { matches: () => true })), 0);
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
  // A server that puts the foot and never the head (the fake puts a bed whole, `fake-bot-placement.ts`): scripted.
  const harness = placer("red_bed", { overrides: { _placeBlockWithOptions: async () => harness.world.setCell(foot, "red_bed") } });
  const { bot, clock, item } = harness;
  using _timers = clock.install();

  const result = await clock.settle(placeBlock(bot, {
      ...placementAt(bot, item, foot),
      expectedCells: [foot, head],
      matches: (block: WorldBlock) => block.name.endsWith("_bed"),
      lookDirection: new Vec3(1, 0, 0),
    }), QUARTER_TURN_MS + TWO_TIME_PACKETS_MS);

  assert.equal(result.kind, "failed");
});

test("waits for every cell of a multi-block placement", async () => {
  const foot = new Vec3(1, 64, 0);
  const head = new Vec3(2, 64, 0);
  // The server puts the foot; its head half is a moment behind (the fake puts a bed whole, at once): scripted.
  const harness = placer("red_bed", {
    overrides: {
      _placeBlockWithOptions: async () => {
        harness.world.setCell(foot, "red_bed");
        harness.clock.after(40, () => harness.world.setCell(head, "red_bed"));
      },
    },
  });
  const { bot, clock, item } = harness;
  using _timers = clock.install();

  const result = await clock.settle(placeBlock(bot, {
      ...placementAt(bot, item, foot),
      expectedCells: [foot, head],
      matches: (block: WorldBlock) => block.name.endsWith("_bed"),
      lookDirection: new Vec3(1, 0, 0),
    }), QUARTER_TURN_MS);

  assert.equal(result.kind, "placed");
});

test("releases sneak when Mineflayer rejects placement", async () => {
  const { bot, clock, server, item } = placer("red_bed", {
    overrides: {
      _placeBlockWithOptions: async () => {
        throw new Error("rejected");
      },
    },
  });
  using _timers = clock.install();

  const result = await clock.settle(placeBlock(bot, { ...placementAt(bot, item, new Vec3(0, 64, 0)), lookDirection: new Vec3(1, 0, 0) }), QUARTER_TURN_MS);

  assert.deepEqual(result, { kind: "failed", error: "rejected" });
  assert.deepEqual(shiftPackets(server), [0, 1]);
});

test("uses the 1.21.4 sneaking action before placement against an interactive support", async () => {
  const target = new Vec3(0, 64, 0);
  // Mineflayer's own placement on the fake: the look at the face, `block_place`, the server's block update.
  const { bot, clock, server, item } = placer("furnace", { version: "1.21.4", cells: { "0,63,0": "crafting_table" } });
  using _timers = clock.install();

  const result = await clock.settle(placeBlock(bot, placementAt(bot, item, target)), QUARTER_TURN_MS);

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
      _placeBlockWithOptions: async () => {
        world.setCell(target, "furnace");
        throw new Error("Event blockUpdate:(0, 64, 0) did not fire within timeout of 5000ms");
      },
    },
  });
  using _timers = clock.install();

  const result = await clock.settle(placeBlock(bot, placementAt(bot, item, target)), 0);

  assert.equal(result.kind, "placed");
});

test("preserves a block-update timeout with post-timeout world evidence", async () => {
  const target = new Vec3(0, 64, 0);
  const { bot, clock, item } = placer("furnace", {
    overrides: {
      _placeBlockWithOptions: async () => {
        throw new Error("Event blockUpdate:(0, 64, 0) did not fire within timeout of 5000ms");
      },
    },
  });
  using _timers = clock.install();
  const sentAt = bot.time.age;

  const result = await clock.settle(placeBlock(bot, placementAt(bot, item, target)), TWO_TIME_PACKETS_MS);

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
      _placeBlockWithOptions: () =>
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

  const result = await clock.settle(placeBlock(bot, placement), 700);

  assert.equal(result.kind, "placed");
});

test("a block that appears after mineflayer's timeout but before the world age moved 40 ticks is placed", async () => {
  const target = new Vec3(0, 64, 0);
  const { bot, clock, server, world, item } = placer("cobblestone", {
    overrides: {
      _placeBlockWithOptions: async () => {
        throw new Error("Event blockUpdate:(0, 64, 0) did not fire within timeout of 5000ms");
      },
    },
  });
  using _timers = clock.install();
  // The block lands with the first time packet after the send: 20 ticks, half the answer wait.
  server.onTimePacket(() => world.setCell(target, "cobblestone"));

  const result = await clock.settle(placeBlock(bot, placementAt(bot, item, target)), 1_050);

  assert.equal(result.kind, "placed");
});

test("a server that answered without the block fails after 40 ticks with the observed cells", async () => {
  const target = new Vec3(0, 64, 0);
  const { bot, clock, item } = placer("cobblestone", { overrides: { _placeBlockWithOptions: async () => {} } });
  using _timers = clock.install();

  const result = await clock.settle(placeBlock(bot, placementAt(bot, item, target)), TWO_TIME_PACKETS_MS);

  assert.deepEqual(result, {
    kind: "failed",
    error: "The expected block did not appear after placement: the server moved 40 ticks past it and (0, 64, 0)=air.",
  });
});

test("physics stopped (waitForTicks never resolves): the block wait still ends on the wall clock", async () => {
  const target = new Vec3(0, 64, 0);
  const { bot, clock, server, item } = placer("cobblestone", { overrides: { _placeBlockWithOptions: async () => {} } });
  using _timers = clock.install();
  // No physics tick and no time packet: only the wall bound can end the wait.
  bot.physicsEnabled = false;
  server.stop();

  const outcome = await clock.settle(placeBlock(bot, placementAt(bot, item, target, { answerWallMs: 120 })), 150);

  assert.equal(outcome.kind, "failed");
});

test("creative placement does not wait for a count", async () => {
  const target = new Vec3(0, 64, 0);
  const { bot, clock, world, item } = placer("cobblestone", {
    overrides: { _placeBlockWithOptions: async () => world.setCell(target, "cobblestone") },
  });
  using _timers = clock.install();

  const result = await clock.settle(placeBlock(bot, placementAt(bot, item, target)), 0);

  assert.equal(result.kind, "placed");
});

test("a block that appeared but whose consumption never shows fails once the server answered", async () => {
  const target = new Vec3(0, 64, 0);
  const { bot, clock, placement } = survivalPlacer(target, async (scene) => scene.appear());
  using _timers = clock.install();

  const result = await clock.settle(placeBlock(bot, placement), TWO_TIME_PACKETS_MS);

  assert.equal(result.kind, "failed");
  if (result.kind === "failed") assert.match(result.error, /consumption of cobblestone was not observed \(inventory 1 → 1\)/u);
});

test("onSent fires once, after the equip and look, right before the placement packet", async () => {
  const target = new Vec3(0, 64, 0);
  const calls: string[] = [];
  const { bot, clock, server, item } = placer("cobblestone", {
    overrides: {
      equip: async () => void calls.push("equip"),
      lookAt: async () => void calls.push("look"),
    },
  });
  using _timers = clock.install();
  server.onPacket("block_place", () => void calls.push("packet"));

  await clock.settle(placeBlock(bot, placementAt(bot, item, target, { onSent: () => calls.push("sent") })), SERVER_ANSWER_MS);

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

  const result = await clock.settle(placeBlock(bot, placementAt(bot, item, target, { onSent: () => void (sent += 1) })), 0);

  assert.equal(result.kind, "failed");
  assert.equal(sent, 0);
});

test("onSent does not fire when the signal aborts before the send", async () => {
  const target = new Vec3(0, 64, 0);
  const controller = new AbortController();
  let sent = 0;
  const { bot, clock, item } = placer("cobblestone", { overrides: { lookAt: async () => controller.abort(new Error("cut")) } });
  using _timers = clock.install();

  await assert.rejects(
    clock.settle(placeBlock(bot, placementAt(bot, item, target, { signal: controller.signal, onSent: () => void (sent += 1) })), 0),
    /cut/u,
  );
  assert.equal(sent, 0);
});
