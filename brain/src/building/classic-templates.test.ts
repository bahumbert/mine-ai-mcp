import assert from "node:assert/strict";
import test from "node:test";
import type { Facing } from "./blueprint.ts";
import { cellsHash } from "./cells-hash.ts";
import { planTemplate } from "./plan.ts";
import { supportGroups } from "./support.ts";
import { TEMPLATES } from "./templates.ts";

const FACINGS: readonly Facing[] = ["north", "south", "east", "west"];

/** The cells hash of each classic file at each facing, door at 0 64 0: pinned on 2026-11-09 from the output of the generator `house()`, deleted by Task 4d of the house-templates plan: the files are the classic houses now. */
const PINNED_HASHES: Readonly<Record<string, string>> = {
  "japanese-small north": "ee05a26cc24e156bbfa7f39636a7a27cc580b4d26bb7182a82aa4a392e592a8f",
  "japanese-small south": "15d439107e95eb20136dc246e180a2484be858e5a7ff53fed01a14b44ac6388e",
  "japanese-small east": "147466c965e35478bb65077fa110355fcb9872a635ce9ee6e9b617ad9755ea4b",
  "japanese-small west": "44f4fedb7b213c5fc0c3465fc2b2b1eb247ba648768d1bc80880800c74f402c5",
  "japanese-medium north": "da7940b3cecccb9d63242925498b27c55049757e66e597acbb130ac507fb04f0",
  "japanese-medium south": "ef702b631c264fd828a810d0db0e1cacc7dfc29588ea23c4fbb52ababaf13bf7",
  "japanese-medium east": "4b703d2e88120ec0fd98d1e8c559525251d99efd621b22147085fe9a417c9ca3",
  "japanese-medium west": "38b99f0fdac47586bd146acb5dd45cbf6ff89dd4406772e215f6a49e373eb513",
  "medieval-small north": "ecba104a0aea426eac95d022ada626b74bcc115b4c2a7f973613a656459691e9",
  "medieval-small south": "290588770d1cea8713f30b6ac5553c7d1325cae760b03cf5029d0a4beac9c61a",
  "medieval-small east": "c77e182a1683dd3e2891a3e443efa34aa4204fba8cb7000b6016ff4fc56db168",
  "medieval-small west": "b3e39427cdd2d593b2777f2ab82621e72d73ed13b5c14585e7ed75c1782f7757",
  "medieval-medium north": "5c3360b21b85fc4e61b0f4118a38fd3d11b140c8d66dc9598876f58d6ecd0f25",
  "medieval-medium south": "f7d483b1da9ebc876b7eaf74500fea26a6ab8ae5ae82e0ac182be197a4d5f54e",
  "medieval-medium east": "86587b567403c1d0233acde8c1dbf065461004f87878e8cb1845cb29d75f2fdd",
  "medieval-medium west": "8f19aa7c88b0cd15e406ca46c8762d0749c400195b76a95ab2c9d303928b2552",
  "rustic-small north": "8b0e2b200c9ab48386917cd4aba4feddd880ae15e1d10102a50d2dacfc014863",
  "rustic-small south": "163fa45dbd7b7d698b34ba8aafde3f025c2fcebb4b653cbb0757b80d48053909",
  "rustic-small east": "6e42d9241b47796f7fd5de2c4627592fc6b27ecd9fa0d0eacb0398bd34575432",
  "rustic-small west": "783293b021ba74ba547626a9c14feec3ce5d4319fdafb25cf566d8e2a5747179",
  "rustic-medium north": "f7c6ff0a7a65de0ff526c24c5527d0815ec0d4fe1a8b26fd37bb6476c8519026",
  "rustic-medium south": "9a68bc1b3a0864165b2451f1ad17d2c25e6f10a1495f94a6db9cbf030f539fc8",
  "rustic-medium east": "00e37b64fa9c8f750e22d596740acb54f9fd907b49c7aceeca3fb93b2a1b9318",
  "rustic-medium west": "2cd043e3f3da015dfcaae85773340ec74faf27a44f1e04f4b471e15d456b3253",
};

const classicFiles = [...TEMPLATES.values()].filter((template) => template.classic !== undefined);
const siteOf = (facing: Facing) => ({ door: { x: 0, y: 64, z: 0 }, facing });

test("there are six classic files and each has its hashes pinned", () => {
  assert.equal(classicFiles.length, 6);
  assert.equal(Object.keys(PINNED_HASHES).length, 24);
  for (const template of classicFiles) for (const facing of FACINGS) assert.ok(PINNED_HASHES[`${template.id} ${facing}`], `${template.id} ${facing}`);
});

test("the classic files place the cells they placed: the pinned hashes", () => {
  for (const template of classicFiles) {
    for (const facing of FACINGS) assert.equal(cellsHash(planTemplate(template, siteOf(facing)).cells), PINNED_HASHES[`${template.id} ${facing}`], `${template.id} ${facing}`);
  }
});

test("every classic file goes in layer by layer at every facing, then the clearing pass, then the door", () => {
  for (const template of classicFiles) {
    for (const facing of FACINGS) {
      const { batches, cells } = planTemplate(template, siteOf(facing));
      assert.deepEqual(batches.at(-1)!.map((cell) => cell.role), ["foundation", "door"], `${template.id} ${facing}`);
      assert.ok(batches.at(-2)!.every((cell) => cell.block === "air"), `${template.id} ${facing} clearing`);
      const layers = batches.slice(0, -2).map((batch) => batch[0]!.y);
      assert.deepEqual([...new Set(layers)], [...new Set(cells.map((cell) => cell.y))].sort((a, b) => a - b), `${template.id} ${facing} layers bottom up`);
    }
  }
});

test("the classic files need no scaffolding: every cell gets a group and the groups are the layers", () => {
  for (const template of classicFiles) {
    for (const facing of FACINGS) {
      const { cells } = planTemplate(template, siteOf(facing));
      const { groups, unsupported } = supportGroups(cells);
      assert.deepEqual(unsupported, [], `${template.id} ${facing}`);
      for (const cell of cells.filter((placed) => placed.role !== "air" && placed.role !== "door")) {
        assert.equal(groups.get(`${cell.x},${cell.y},${cell.z}`)?.group, cell.y, `${template.id} ${facing} ${cell.x},${cell.y},${cell.z}`);
      }
    }
  }
});
