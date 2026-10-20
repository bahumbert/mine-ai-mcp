import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import prismarineBlock from "prismarine-block";
import { Vec3 } from "vec3";
import { headInAir, swimBreathRoute, swimmingRoof } from "./swim-escape.js";

const registry = minecraftData("1.21.4");
const Block = prismarineBlock("1.21.4");
const blockOf = (name: string) =>
  name === "tall_seagrass_upper"
    ? Block.fromProperties(registry.blocksByName.tall_seagrass!.id, { half: "upper" }, 0)
    : Block.fromStateId(registry.blocksByName[name]!.defaultState, 0);

/** A bot at feet 0 60 0 in a pocket of dirt, the cells named by `cells` ("x,y") at z 0 and every other cell dirt. */
function pocketBot(cells: Readonly<Record<string, string>>): Bot {
  return {
    entity: { position: new Vec3(0.5, 60, 0.5) },
    blockAt: (p: Vec3) => {
      const at = p.floored();
      return blockOf((at.z === 0 && cells[`${at.x},${at.y}`]) || "dirt");
    },
  } as unknown as Bot;
}

test("all four off-center shoulders detect the overhang beside a tall waterfall", () => {
  for (const [x, z, roofX, roofZ] of [
    [0.03, 0.09, 0, -1],
    [0.97, 0.91, 0, 1],
    [0.09, 0.97, -1, 0],
    [0.91, 0.03, 1, 0],
  ] as const) {
    const bot = {
      entity: { position: new Vec3(x, -32.8, z) },
      blockAt: (p: Vec3) => {
        const at = p.floored();
        const name =
          at.x === roofX && at.y === -31 && at.z === roofZ ? "bedrock" : at.x === 0 && at.z === 0 ? "water" : "air";
        return Block.fromStateId(registry.blocksByName[name]!.defaultState, 0);
      },
    } as unknown as Bot;
    assert.equal(swimmingRoof(bot)?.name, "bedrock");
    bot.entity.position = new Vec3(0.5, -32.8, 0.5);
    assert.equal(swimmingRoof(bot), null);
  }
});

test("the head in a tall seagrass cell is under water, and the air pocket beside it is the way to breathe (run 16, Lena)", () => {
  const bot = pocketBot({ "0,60": "tall_seagrass", "0,61": "tall_seagrass_upper", "1,60": "air", "1,61": "air" });
  assert.equal(headInAir(bot), false);
  assert.deepEqual(swimBreathRoute(bot, new Set())?.at(-1), new Vec3(1.5, 60, 0.5));
});

test("no breath route ends in a kelp cell: the swim goes on to real air", () => {
  const bot = pocketBot({
    "0,60": "water", "0,61": "water",
    "1,60": "kelp_plant", "1,61": "kelp",
    "-1,60": "water", "-1,61": "water",
    "-2,60": "air", "-2,61": "air",
  });
  assert.deepEqual(swimBreathRoute(bot, new Set())?.at(-1), new Vec3(-1.5, 60, 0.5));
});
