import assert from "node:assert/strict";
import minecraftData from "minecraft-data";
import test from "node:test";
import { DEFAULT_MINECRAFT_VERSION } from "../server/config.js";
import { CRAFTING_STATION, SMELTING_STATION } from "./workstations.js";

const registry = minecraftData(DEFAULT_MINECRAFT_VERSION);

test("each workstation is a block and an item of the registry", () => {
  for (const station of [CRAFTING_STATION, SMELTING_STATION]) {
    assert.ok(registry.blocksByName[station], `no block ${station}`);
    assert.ok(registry.itemsByName[station], `no item ${station}`);
  }
});

test("the crafting and the smelting station are two different blocks", () => {
  assert.notEqual(CRAFTING_STATION, SMELTING_STATION);
});
