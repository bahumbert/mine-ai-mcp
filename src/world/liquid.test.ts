import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture, registry } from "../test-support/bot.js";
import { FULL_CUBE, NO_SHAPE, type FakeBlock } from "../test-support/world.js";
import { observeFormations, pourAim, settledFormations, watchFormations } from "./liquid.js";

/**
 * The vanilla rule these tests encode, measured in the `pour-through-lava`
 * fixture: a full bucket's ray ignores fluid, stops at the first solid face,
 * and the liquid lands in the cell in front of that face. So a bot on the lip
 * of a pool level with its floor pours by looking at the floor *through* the
 * lava, and the water lands in the lava cell itself.
 */
const cell = (x: number, y: number, z: number) => new Vec3(x, y, z);
const lands = (landing: Vec3) => (candidate: Vec3) => (candidate.equals(landing) ? 1 : null);

/** A shore at y 60 with a pool of lava level with it, its near source at x 4. */
function shore(): Record<string, string> {
  const named: Record<string, string> = {};
  for (let x = 0; x <= 8; x += 1) {
    for (let z = -2; z <= 2; z += 1) {
      named[`${x},59,${z}`] = "stone";
      named[`${x},60,${z}`] = x >= 4 && x <= 6 && Math.abs(z) <= 1 ? "lava" : "stone";
    }
  }
  return named;
}

test("a pour aimed through a pool lands in the lava cell itself", () => {
  const bot = botFixture({ blocks: shore(), position: cell(3.5, 61, 0.5) });

  const aim = pourAim(bot, lands(cell(4, 60, 0)));

  assert.notEqual(aim, null);
  // The ray lands on the top of the pool floor; the water goes into the cell
  // in front of that face, which is the source it passed through.
  assert.deepEqual(aim?.surface, cell(4, 59, 0));
  assert.deepEqual(aim?.lookAt, cell(4.5, 60, 0.5));
});

test("a pour whose ray would cross liquid first is refused", () => {
  const bot = botFixture({ blocks: shore(), position: cell(3.5, 61, 0.5) });

  // A source in the middle of the pool: every cell around it is lava, so the
  // only face that lands there is its own floor, and the ray to that floor
  // crosses the near sources. Those would turn to obsidian behind the water,
  // walling the scoop off from the cell it just filled.
  assert.equal(pourAim(bot, lands(cell(5, 60, 0))), null);
  // The same landing is offered when it is not the ray's own fault.
  assert.notEqual(pourAim(bot, lands(cell(4, 60, 0))), null);
});

test("a pool under a lid offers no pour, because every ray meets the lid", () => {
  const named = shore();
  for (let x = 3; x <= 7; x += 1) named[`${x},61,0`] = "stone";
  const bot = botFixture({ blocks: named, position: cell(2.5, 62, 0.5) });

  assert.equal(pourAim(bot, lands(cell(4, 60, 0))), null);
});

test("a cell out of the ray's reach is refused however good it scores", () => {
  const bot = botFixture({ blocks: shore(), position: cell(0.5, 61, 0.5) });

  assert.equal(pourAim(bot, lands(cell(6, 60, 0))), null);
});

test("the highest-scoring landing wins, and the shortest ray breaks a tie", () => {
  const bot = botFixture({ blocks: shore(), position: cell(3.5, 61, 0.5) });
  const underfoot = cell(3, 61, 0);
  const source = cell(4, 60, 0);
  const score = (high: Vec3) => (landing: Vec3) =>
    landing.equals(high) ? 3 : landing.equals(underfoot) || landing.equals(source) ? 1 : null;

  // The cell the bot stands in is the shortest ray in the world; a better
  // score still beats it, and with the scores level it wins.
  assert.deepEqual(pourAim(bot, score(source))?.landing, source);
  assert.deepEqual(pourAim(bot, score(underfoot))?.landing, underfoot);
});

/** A world whose cells the test changes between observations: air where nothing is named. */
function changingWorld(initial: Record<string, string>) {
  const named = new Map(Object.entries(initial));
  const bot = botFixture({
    blocks: (position): FakeBlock => {
      const name = named.get(`${position.x},${position.y},${position.z}`) ?? "air";
      const definition = registry.blocksByName[name]!;
      const solid = definition.boundingBox === "block";
      return {
        name,
        stateId: definition.defaultState,
        position,
        boundingBox: solid ? "block" : "empty",
        shapes: solid ? FULL_CUBE : NO_SHAPE,
        getProperties: () => ({}),
      };
    },
  });
  return { bot, named };
}

test("lava flowing onto water forms stone and it is counted by name", () => {
  const { bot, named } = changingWorld({ "0,0,0": "water", "1,0,0": "lava" });
  const watch = watchFormations(bot, cell(0, 0, 0));

  named.set("0,0,0", "stone");

  assert.deepEqual(observeFormations(bot, watch), { stone: 1 });
});

test("water on lava counts each block it made under its own name", () => {
  const { bot, named } = changingWorld({ "0,0,0": "lava", "1,0,0": "lava", "2,0,0": "lava" });
  const watch = watchFormations(bot, cell(0, 0, 0));

  named.set("0,0,0", "obsidian");
  named.set("1,0,0", "obsidian");
  named.set("2,0,0", "cobblestone");

  assert.deepEqual(observeFormations(bot, watch), { obsidian: 2, cobblestone: 1 });
});

test("a block placed where air was is not formed by a liquid", () => {
  const { bot, named } = changingWorld({ "0,0,0": "water" });
  const watch = watchFormations(bot, cell(0, 0, 0));

  named.set("1,0,0", "dirt");

  assert.deepEqual(observeFormations(bot, watch), {});
});

test("air a liquid flowed into and that then hardened is counted", () => {
  const { bot, named } = changingWorld({ "0,0,0": "lava" });
  const watch = watchFormations(bot, cell(0, 0, 0));

  named.set("1,0,0", "lava");
  assert.deepEqual(observeFormations(bot, watch), {});
  named.set("1,0,0", "cobblestone");

  assert.deepEqual(observeFormations(bot, watch), { cobblestone: 1 });
});

test("a block that stood there before the pour is not counted", () => {
  const { bot } = changingWorld({ "0,0,0": "lava", "1,0,0": "obsidian" });
  const watch = watchFormations(bot, cell(0, 0, 0));

  assert.deepEqual(observeFormations(bot, watch), {});
});

test("a cell beyond the formation radius is not watched", () => {
  const { bot, named } = changingWorld({ "0,0,0": "lava", "11,0,0": "water" });
  const watch = watchFormations(bot, cell(0, 0, 0));

  named.set("11,0,0", "stone");

  assert.deepEqual(observeFormations(bot, watch), {});
});

test("a pour is settled when the blocks it made stop changing, and the last count is returned", async () => {
  const { bot, named } = changingWorld({ "0,0,0": "lava", "1,0,0": "lava" });
  const watch = watchFormations(bot, cell(0, 0, 0));
  let ticks = 0;
  bot.waitForTicks = async () => {
    ticks += 1;
    if (ticks === 3) named.set("0,0,0", "obsidian");
    if (ticks === 5) named.set("1,0,0", "obsidian");
  };

  assert.deepEqual(await settledFormations(bot, watch, undefined), { obsidian: 2 });
  assert.ok(ticks >= 15, "waited for ten quiet ticks after the last change");
});
