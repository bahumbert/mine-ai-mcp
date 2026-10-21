/** `world.getBlockStateId` and `blockAt` read one cell the same way, and the state's properties are the ones set. */
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import type { ContractCheck } from "../checks.ts";

const CELL = [2, -60, 0] as const;
const STAIRS = { name: "oak_stairs", properties: { facing: "east", half: "top" } } as const;

export const stateIdAgrees: ContractCheck = {
  name: "state-id-agrees",
  fixture: { cells: { [CELL.join(",")]: STAIRS }, carried: {}, position: [0.5, -60, 0.5] },
  async run({ bot }) {
    const cell = new Vec3(CELL[0], CELL[1], CELL[2]);
    const block = bot.blockAt(cell);
    assert.equal(block?.name, STAIRS.name, `${CELL}: ${block?.name ?? "unloaded"}`);
    assert.equal(bot.world.getBlockStateId(cell), block.stateId, "getBlockStateId and blockAt().stateId differ");
    assert.notEqual(block.stateId, bot.registry.blocksByName[STAIRS.name]!.defaultState, "the stairs kept their default state");
    const properties = block.getProperties();
    assert.equal(properties.facing, STAIRS.properties.facing);
    assert.equal(properties.half, STAIRS.properties.half);
  },
};
