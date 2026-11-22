// Kept claim supports must not become impossible build_structure substitutions.
import assert from "node:assert/strict";
import test from "node:test";
import prismarineBlock from "prismarine-block";
import { parseBuildStructureRequest } from "../../../src/actions/build-structure/contract.ts";
import { siteBreakRequest } from "../../../src/actions/build-structure/build-structure.ts";
import { createMovements, observeMineflayerBlock, packKey } from "../../../src/navigation/index.ts";
import { createFakeBot } from "../../../src/test-support/fake-bot/index.ts";
import { flatWorld } from "../../../src/test-support/navigation.ts";
import { planTemplate } from "../building/plan.ts";
import { templateFor } from "../building/templates.ts";
import { runStep } from "../skills.ts";
import { FakeRuntime } from "../testing.ts";
import { buildParts } from "./house-parts.ts";
import { contextFor } from "./skill-fixtures.test.ts";

for (const state of ["wrong", "correct", "unloaded", "abort"] as const) test(`a kept claim support is ${state}: the build respects its observed support`, async () => {
  const support = { x: 1, y: 64, z: 2 };
  const runtime = new FakeRuntime();
  runtime.world.set("1,64,2", state === "correct" ? "oak_planks" : "dirt");
  if (state === "unloaded") runtime.unloadedCells.add("1,64,2");
  const controller = new AbortController();
  if (state === "abort") {
    const read = runtime.cellsAt.bind(runtime);
    runtime.cellsAt = async (cells) => { const result = await read(cells); controller.abort(); return result; };
  }
  const plan = planTemplate(templateFor("medieval-small")!, { door: { x: 0, y: 64, z: 2 }, facing: "north" });
  let left: number | null = null;
  const context = contextFor(runtime, { signal: controller.signal });
  const result = await buildParts(context, plan, "my house", { reserved: [], keepAlways: [support], leave: (part) => { left = part; }, again: "; resume here", remadeNotes: [] });
  if (state === "correct") {
    assert.equal(result, null);
    assert.equal(left, null);
    assert.ok(runtime.submitted.length > 2);
  } else {
    assert.equal(result?.status, state === "abort" ? "stopped" : "failed");
    if (state !== "abort") assert.match(result?.status === "failed" ? result.detail : "", /claim sign.*support/iu);
    assert.equal(left, 0);
    assert.equal(runtime.submitted.length, 0);
  }
  assert.equal((await runStep({ skill: "go_to", x: 2, y: 64, z: 0 }, { ...context, signal: new AbortController().signal })).status, "done");
});

test("kept supports are refused to the movement policy", () => {
  const support = { x: 1, y: 64, z: 2 };
  const request = parseBuildStructureRequest({ blocks: [{ ...support, block_name: "oak_planks" }], keep: [support], remove_wrong_blocks: true });
  const { bot } = createFakeBot({ carried: { wooden_shovel: 1, dirt: 3 } });
  const dirt = observeMineflayerBlock(prismarineBlock(bot.registry).fromStateId(bot.registry.blocksByName.dirt!.defaultState, 0));
  const options = { isRequestedBreak: siteBreakRequest(request), ignoreRegionsOwnedBy: bot.username };
  assert.notEqual(createMovements(bot, options).evaluateBreak(dirt, support, flatWorld()).decision.kind, "prohibited");
  assert.equal(createMovements(bot, { ...options, protectedCells: new Set([packKey(1, 64, 2)]) }).evaluateBreak(dirt, support, flatWorld()).decision.kind, "prohibited", "production policy protects a keep cell even when its replacement is requested");
});
