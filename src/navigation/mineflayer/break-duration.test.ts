import assert from "node:assert/strict";
import test from "node:test";
import { botFixture, registry } from "../../test-support/bot.js";
import { MineflayerBot, type MineflayerBotSurface } from "./bot.js";
import { longestBreakDurationMs } from "./break-duration.js";
import { Vec3 } from "vec3";
import { MemoryWorld } from "../world/memory-world.js";
import { blockClass } from "./world.js";

const STONE_PICKAXE = registry.itemsByName.stone_pickaxe!.id;
const AT = { x: 0, y: 64, z: 1 };

/** The body's state: Mineflayer asks the block at the eyes whether it is in water, not the body's own flag. */
interface Body {
  readonly onGround: boolean;
  readonly eyesInWater: boolean;
  /** The physics flag; true whenever the feet are in water. Defaults to the eyes. */
  readonly isInWater?: boolean;
}

/** A bot standing at (0.5, 64, 0.5) with andesite at `AT`, in the given body state. */
function andesiteBot(body: Body, extra: Parameters<typeof botFixture>[0] = {}) {
  const bot = botFixture({ items: [{ name: "stone_pickaxe", count: 1 }], ...extra });
  Object.assign(bot.entity, { onGround: body.onGround, isInWater: body.isInWater ?? body.eyesInWater, eyeHeight: 1.62 });
  const andesite = blockClass(bot).fromStateId(registry.blocksByName.andesite!.defaultState, 0);
  const water = blockClass(bot).fromStateId(registry.blocksByName.water!.defaultState, 0);
  bot.blockAt = (cell) => {
    // Mineflayer's blockAt floors a point to its cell.
    const [x, y, z] = [Math.floor(cell.x), Math.floor(cell.y), Math.floor(cell.z)];
    if (x === AT.x && y === AT.y && z === AT.z) return andesite;
    return body.eyesInWater && x === 0 && y === 65 && z === 0 ? water : null;
  };
  return bot;
}

/** What Mineflayer's own `block.digTime` says for the same stone pickaxe, andesite and body state. */
function mineflayerDigTime(inWater: boolean, airborne: boolean): number {
  const bot = andesiteBot({ onGround: true, eyesInWater: false });
  return bot.blockAt(new Vec3(AT.x, AT.y, AT.z))!.digTime(STONE_PICKAXE, false, inWater, airborne, [], []);
}

test("a dry body is read as it stands: x1 on the ground, x5 off it", () => {
  const dry = mineflayerDigTime(false, false);
  assert.ok(dry > 0 && dry < 1_000, `dry ${dry}`);
  assert.equal(longestBreakDurationMs(andesiteBot({ onGround: true, eyesInWater: false }), AT, STONE_PICKAXE), dry);
  assert.equal(
    longestBreakDurationMs(andesiteBot({ onGround: false, eyesInWater: false }), AT, STONE_PICKAXE),
    mineflayerDigTime(false, true),
  );
});

test("a body with any part in water is costed x25 whatever its stance now: it can lift or dip before the swing", () => {
  const worst = mineflayerDigTime(true, true);
  assert.ok(worst > 20 * mineflayerDigTime(false, false), "x25 is about 25 times the dry dig");
  for (const [name, body] of [
    ["grounded, feet in water, eyes in air", { onGround: true, eyesInWater: false, isInWater: true }],
    ["grounded, eyes in water", { onGround: true, eyesInWater: true }],
    ["floating at the surface, eyes in air", { onGround: false, eyesInWater: false, isInWater: true }],
    ["floating under water", { onGround: false, eyesInWater: true }],
  ] as const)
    assert.equal(longestBreakDurationMs(andesiteBot(body), AT, STONE_PICKAXE), worst, name);
});

test("the dig time counts the tool of the operation, bare hands when it has none", () => {
  const bot = andesiteBot({ onGround: true, eyesInWater: false });
  const withTool = longestBreakDurationMs(bot, AT, STONE_PICKAXE)!;
  const bare = longestBreakDurationMs(bot, AT, null)!;
  assert.ok(bare > withTool * 3, `bare ${bare} against tool ${withTool}`);
});

test("an aqua affinity helmet takes the water penalty off the dig time", () => {
  const water = { onGround: true, eyesInWater: true };
  const plain = longestBreakDurationMs(andesiteBot(water), AT, STONE_PICKAXE)!;
  const helmet = { name: "turtle_helmet", enchants: [{ name: "aqua_affinity", lvl: 1 }] };
  const helmeted = longestBreakDurationMs(andesiteBot(water, { slots: { 5: helmet } }), AT, STONE_PICKAXE)!;
  assert.ok(helmeted < plain, `helmeted ${helmeted} against plain ${plain}`);
});

test("an enchanted tool in the 1.21 component shape digs without throwing", () => {
  const efficiency = { id: registry.enchantmentsByName.efficiency!.id, level: 3 };
  const bot = andesiteBot({ onGround: true, eyesInWater: false });
  const plain = longestBreakDurationMs(bot, AT, STONE_PICKAXE)!;
  bot.inventory.items()[0]!.enchants = { enchantments: [efficiency] } as never;
  assert.ok(longestBreakDurationMs(bot, AT, STONE_PICKAXE)! < plain);
});

test("an unloaded block has no dig time", () => {
  const bot = andesiteBot({ onGround: true, eyesInWater: false });
  assert.equal(longestBreakDurationMs(bot, { x: 5, y: 64, z: 5 }, STONE_PICKAXE), null);
});

test("the Mineflayer adapter answers from its surface, and null when the surface cannot", () => {
  const asked: unknown[] = [];
  const operation = { kind: "break", position: AT, expectedStateId: 1, toolType: STONE_PICKAXE, brings: [] } as const;
  const surface = (longestBreakDurationMs?: MineflayerBotSurface["longestBreakDurationMs"]) =>
    new MineflayerBot({ longestBreakDurationMs } as unknown as MineflayerBotSurface, new MemoryWorld());
  const answering = surface((position, toolType) => {
    asked.push(position, toolType);
    return 14_100;
  });
  assert.equal(answering.longestBreakDurationMs(operation), 14_100);
  assert.deepEqual(asked, [AT, STONE_PICKAXE]);
  assert.equal(surface().longestBreakDurationMs(operation), null);
});
