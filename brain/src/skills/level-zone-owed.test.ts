// The levelling fill leaves what a trade owes.
import assert from "node:assert/strict";
import test from "node:test";
import { stepSchema } from "../actions.ts";
import { runStep } from "../skills.ts";
import { FakeRuntime } from "../testing.ts";
import { builds, contextFor } from "./skill-fixtures.test.ts";

test("a levelling fill leaves the cobblestone a trade owes: with all of it owed the hole is filled with dirt", async () => {
  const levelled = async (owed: readonly { item: string; count: number; partner: string; tradeId: string }[], inventory = [{ name: "cobblestone", count: 5 }, { name: "dirt", count: 1 }]) => {
    const runtime = new FakeRuntime();
    runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory };
    runtime.world.set("2,64,2", "gold_block");
    runtime.world.set("6,64,5", "gold_block");
    for (const y of [63, 62, 61]) runtime.world.set(`5,${y},4`, "air");
    const result = await runStep(stepSchema.parse({ skill: "level_area", markers: "gold_block" }), contextFor(runtime, { areas: [], owed: () => owed }));
    assert.equal(result.status, "done", JSON.stringify(result));
    return builds(runtime).flatMap((call) => call.blocks).map((cell) => cell.block_name);
  };
  assert.deepEqual(await levelled([]), ["cobblestone"], "nothing owed: the cobblestone fills, as before");
  assert.deepEqual(await levelled([{ item: "cobblestone", count: 5, partner: "Ayla", tradeId: "t1" }]), ["dirt"]);
  assert.deepEqual(await levelled([{ item: "cobblestone", count: 4, partner: "Ayla", tradeId: "t1" }], [{ name: "cobblestone", count: 5 }]), ["cobblestone"], "5 carried, 4 owed: the one spare fills");
});
