// Tests of the tool a gathering round still has to make: which harvest tool a block lacks.
import assert from "node:assert/strict";
import test from "node:test";
import { newKnowledge } from "./how-to-get.ts";
import { toolMissing } from "./plan-round.ts";

test("a tool that broke is made again only when no carried item has its family, whatever the item is called", () => {
  const knowledge = newKnowledge(new Set(["shovel"]));
  knowledge.toolClass.set("dirt", "shovel");
  knowledge.harvest.set("dirt", null);
  assert.equal(toolMissing("dirt", [{ name: "mythril_digger", count: 1, families: ["shovel"] }], knowledge), null);
  assert.equal(toolMissing("dirt", [{ name: "wooden_shovel", count: 1, families: [] }], knowledge), "wooden_shovel", "a name alone is no shovel (an older runtime reports no families)");
});
