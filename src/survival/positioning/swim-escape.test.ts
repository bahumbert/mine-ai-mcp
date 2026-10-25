import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeCell, createFakeBot } from "../../test-support/fake-bot/index.js";
import { headInAir, swimBreathRoute, swimmingRoof } from "./swim-escape.js";

const TALL_SEAGRASS_UPPER: FakeCell = { name: "tall_seagrass", properties: { half: "upper" } };

/** A bot at feet 0 60 0 in solid ground, the cells named by `cells` ("x,y") at z 0 and every other cell stone. */
function pocketBot(cells: Readonly<Record<string, string>>) {
  const named = Object.fromEntries(
    Object.entries(cells).map(([xy, name]) => [`${xy},0`, name === "tall_seagrass_upper" ? TALL_SEAGRASS_UPPER : name]),
  );
  return createFakeBot({ position: new Vec3(0.5, 60, 0.5), cells: named, groundY: 100 }).bot;
}

test("all four off-center shoulders detect the overhang beside a tall waterfall", () => {
  const waterfall: Record<string, FakeCell> = {};
  for (let y = -64; y <= 0; y++) waterfall[`0,${y},0`] = "water";
  for (const [x, z, roofX, roofZ] of [
    [0.03, 0.09, 0, -1],
    [0.97, 0.91, 0, 1],
    [0.09, 0.97, -1, 0],
    [0.91, 0.03, 1, 0],
  ] as const) {
    const { bot } = createFakeBot({
      position: new Vec3(x, -32.8, z),
      cells: { ...waterfall, [`${roofX},-31,${roofZ}`]: "bedrock" },
      groundY: null,
    });
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
