import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { type FakeCell, createFakeBot } from "../test-support/fake-bot/index.js";
import { findFlatPlacementCandidates, searchFlatPlacements } from "./placement-candidates.js";

const PAIR = [new Vec3(0, 0, 0), new Vec3(1, 0, 0)];
const ORIGIN = new Vec3(1, 64, 0);

/** The search for the pair footprint, radius 1, in a scene: the bot's feet, the cells that differ from the default ground. */
function pairSearch(position: Vec3, cells: Record<string, FakeCell>, loadedColumns?: readonly [number, number][]) {
  const { bot } = createFakeBot({ position, cells, loadedColumns });
  return searchFlatPlacements(bot, PAIR, 1);
}

test("finds supported flat footprints without placing through the player", () => {
  // Stone at y 63 and below under the feet, air above.
  const { bot } = createFakeBot({ position: new Vec3(0.8, 64, 0.5) });

  const candidates = findFlatPlacementCandidates(bot, [new Vec3(0, 0, 0), new Vec3(1, 0, 0)], 1);

  assert.ok(candidates.length > 0);
  assert.equal(
    candidates.some((origin) => origin.equals(new Vec3(1, 64, 0))),
    false,
  );
  assert.equal(
    candidates.every((origin) => origin.y === 64),
    true,
  );
});

test("the misses count each origin by its first failing rule", () => {
  // Stone on the eight ring cells of y 64 except 1,64,0 (air) and -1,64,0 (water); the default ground is stone at y 63.
  const ring = [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
  const cells: Record<string, FakeCell> = {};
  for (const [x, z] of ring) cells[`${x},64,${z}`] = "stone";
  cells["1,64,0"] = "air";
  cells["-1,64,0"] = "water";
  const { bot } = createFakeBot({ position: new Vec3(0.5, 64, 0.5), cells });

  const search = searchFlatPlacements(bot, [new Vec3(0, 0, 0)], 1);

  assert.equal(search.origins, 24);
  assert.deepEqual(search.misses, { unloaded: 0, body: 0, wet: 1, blocked: 14, unsupported: 2 });
  assert.equal(search.candidates.length, 7);
  assert.deepEqual(search.candidates, findFlatPlacementCandidates(bot, [new Vec3(0, 0, 0)], 1));
  assert.equal(search.origins, search.candidates.length + Object.values(search.misses).reduce((sum, count) => sum + count, 0));
});

test("the origin's first failing cell decides its miss, in the order unloaded, body, wet, blocked, unsupported", () => {
  const control = pairSearch(new Vec3(0.5, 64, 0.5), {});
  assert.ok(control.candidates.some((origin) => origin.equals(ORIGIN)), "the control scene has the origin as a candidate");

  // (a) nothing loaded: the origin cell is unloaded, so every origin is unloaded.
  const unloaded = pairSearch(new Vec3(0.5, 64, 0.5), {}, []);
  assert.equal(unloaded.misses.unloaded, unloaded.origins);
  assert.equal(unloaded.candidates.length, 0);

  // (b) the head cell 16,64,0 is in the body and in the unloaded chunk x 16..31, z 0..15, while the origin 15,64,0 is
  // loaded: unloaded wins over body in the head cell, so the origin is unloaded. A flipped order would count it as body.
  const seamOrigin = new Vec3(15, 64, 0);
  const seamLoaded: [number, number][] = [];
  for (const chunkX of [-1, 0, 1]) for (const chunkZ of [-1, 0, 1]) if (chunkX !== 1 || chunkZ !== 0) seamLoaded.push([chunkX, chunkZ]);
  const unloadedBeforeBody = pairSearch(new Vec3(16.5, 64, 0.5), {}, seamLoaded);
  assert.equal(unloadedBeforeBody.misses.body, 0);
  assert.ok(unloadedBeforeBody.misses.unloaded > 0);
  assert.equal(unloadedBeforeBody.candidates.some((origin) => origin.equals(seamOrigin)), false);
  assert.ok(pairSearch(new Vec3(16.5, 64, 0.5), {}).misses.body > 0, "a loaded scene has body misses");

  // (c) the origin cell is water inside the body: body wins over wet.
  const bodyVersusWet = pairSearch(new Vec3(0.9, 64, 0.5), { "1,64,0": "water" });
  assert.equal(bodyVersusWet.misses.wet, 0);
  assert.ok(bodyVersusWet.misses.body > 0);

  // (d) water at 1,64,0 over air at 1,63,0: wet wins over unsupported.
  const wetVersusUnsupported = pairSearch(new Vec3(0.5, 64, 0.5), { "1,64,0": "water", "1,63,0": "air" });
  assert.equal(wetVersusUnsupported.misses.wet, control.misses.wet + 1);
  assert.equal(wetVersusUnsupported.candidates.some((origin) => origin.equals(ORIGIN)), false);

  // (e) stone at 1,64,0: blocked.
  const blocked = pairSearch(new Vec3(0.5, 64, 0.5), { "1,64,0": "stone" });
  assert.equal(blocked.misses.blocked, control.misses.blocked + 1);

  // (f) air over air at 1,63,0: unsupported.
  const unsupported = pairSearch(new Vec3(0.5, 64, 0.5), { "1,63,0": "air" });
  assert.equal(unsupported.misses.unsupported, control.misses.unsupported + 1);
  assert.equal(unsupported.candidates.some((origin) => origin.equals(ORIGIN)), false);

  // (g) the origin cell is air over air and its head 2,64,0 is stone: the first failing cell decides, so unsupported, not blocked.
  const firstCell = pairSearch(new Vec3(0.5, 64, 0.5), { "1,63,0": "air", "2,64,0": "stone" });
  assert.equal(firstCell.misses.unsupported, control.misses.unsupported + 1);
  assert.equal(firstCell.misses.blocked, control.misses.blocked);
});
