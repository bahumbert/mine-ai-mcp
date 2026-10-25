import assert from "node:assert/strict";
import test from "node:test";
import { lostToolClass, ToolLosses, toolToMake, type ToolLossDeps } from "./tool-loss.ts";

const LOST = "[TOOL_TIER_LOST] stone_pickaxe was lost at -732,111,87; no pickaxe remains.";

function deps(carried: { name: string; count: number }[], reserved: { item: string; count: number }[] = []): ToolLossDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    reserved,
    inventory: async () => carried,
    getItems: async (items) => {
      asked.push(...items.map((entry) => entry.item));
      for (const entry of items) carried.push({ name: entry.item, count: entry.count });
      return { status: "done", detail: "ok" };
    },
  };
}

test("the lost tool's class comes from the error, whatever its tier", () => {
  assert.equal(lostToolClass(LOST), "pickaxe");
  assert.equal(lostToolClass("[TOOL_TIER_LOST] wooden_shovel was lost; no shovel remains."), "shovel");
  assert.equal(lostToolClass("[TOOL_TIER_LOST] iron_axe was lost at 1,2,3; no axe remains."), "axe");
  assert.equal(lostToolClass("[BUILD_INCOMPLETE] 2 cells still wrong"), null);
  assert.equal(lostToolClass(null), null);
});

test("the best tier the spare cobblestone allows: stone with enough of it, else wood", () => {
  const has = (map: Record<string, number>) => (item: string) => map[item] ?? 0;
  assert.equal(toolToMake("pickaxe", has({ cobblestone: 3 })), "stone_pickaxe");
  assert.equal(toolToMake("pickaxe", has({ cobblestone: 2 })), "wooden_pickaxe");
  assert.equal(toolToMake("shovel", has({ cobblestone: 1 })), "stone_shovel");
  assert.equal(toolToMake("axe", has({})), "wooden_axe");
});

test("a tool lost mid-build is made again from what is carried, once per class", async () => {
  const losses = new ToolLosses();
  const carried = [{ name: "oak_planks", count: 8 }, { name: "stick", count: 4 }];
  const context = deps(carried);
  const first = await losses.handle(LOST, context);
  assert.deepEqual(first, { status: "remade", item: "wooden_pickaxe" });
  assert.deepEqual(context.asked, ["wooden_pickaxe"]);
  // Lost again in the same step: not made a second time.
  const second = await losses.handle(LOST, context);
  assert.equal(second.status, "refused");
  assert.match(second.status === "refused" ? second.note : "", /wooden_pickaxe was remade earlier in this step and lost again/u);
  assert.deepEqual(context.asked, ["wooden_pickaxe"]);
  // Another class has its own allowance.
  const shovel = await losses.handle("[TOOL_TIER_LOST] wooden_shovel was lost; no shovel remains.", context);
  assert.deepEqual(shovel, { status: "remade", item: "wooden_shovel" });
});

test("the house's own cobblestone is not spent on a stone tool", async () => {
  const losses = new ToolLosses();
  const context = deps([{ name: "cobblestone", count: 40 }], [{ item: "cobblestone", count: 40 }]);
  assert.deepEqual(await losses.handle(LOST, context), { status: "remade", item: "wooden_pickaxe" });
  const spare = new ToolLosses();
  const rich = deps([{ name: "cobblestone", count: 43 }], [{ item: "cobblestone", count: 40 }]);
  assert.deepEqual(await spare.handle(LOST, rich), { status: "remade", item: "stone_pickaxe" });
});

test("a tool that is carried again needs no making; other errors are not a lost tool", async () => {
  const losses = new ToolLosses();
  const context = deps([{ name: "wooden_pickaxe", count: 1 }]);
  assert.deepEqual(await losses.handle(LOST, context), { status: "remade", item: "wooden_pickaxe" });
  assert.deepEqual(context.asked, []);
  assert.deepEqual(await new ToolLosses().handle("[BUILD_INCOMPLETE] 2 cells still wrong", context), { status: "none" });
});

test("when making the tool fails, the build's wording says why; a stop is passed on", async () => {
  const failing: ToolLossDeps = { reserved: [], inventory: async () => [], getItems: async () => ({ status: "failed", detail: "no oak_log within 64 blocks" }) };
  const failed = await new ToolLosses().handle(LOST, failing);
  assert.deepEqual(failed, { status: "failed", note: "making a new wooden_pickaxe failed: no oak_log within 64 blocks" });
  const stopping: ToolLossDeps = { reserved: [], inventory: async () => [], getItems: async () => ({ status: "stopped", detail: "" }) };
  assert.deepEqual(await new ToolLosses().handle(LOST, stopping), { status: "stopped" });
});

test("a step may allow several losses per class and in all; the one past either cap is refused", async () => {
  const carried = [{ name: "oak_planks", count: 20 }, { name: "stick", count: 8 }];
  const context = deps(carried);
  const twice = new ToolLosses({ perClass: 2, total: 10 });
  assert.equal((await twice.handle(LOST, context)).status, "remade");
  carried.length = 2;
  assert.equal((await twice.handle(LOST, context)).status, "remade");
  carried.length = 2;
  const third = await twice.handle(LOST, context);
  assert.equal(third.status, "refused");
  assert.match(third.status === "refused" ? third.note : "", /lost 3 times in this step/u);

  const total = new ToolLosses({ perClass: 5, total: 2 });
  assert.equal((await total.handle(LOST, context)).status, "remade");
  assert.equal((await total.handle("[TOOL_TIER_LOST] wooden_shovel was lost; no shovel remains.", context)).status, "remade");
  assert.equal((await total.handle("[TOOL_TIER_LOST] wooden_axe was lost; no axe remains.", context)).status, "refused");
});

test("a loss is told to the caller, and a tool no work is left for is not made", async () => {
  const lost: string[] = [];
  const context = { ...deps([{ name: "oak_planks", count: 8 }]), onLost: (toolClass: string) => lost.push(toolClass), stillNeeded: (toolClass: string) => toolClass !== "pickaxe" };
  assert.deepEqual(await new ToolLosses().handle(LOST, context), { status: "unneeded" });
  assert.deepEqual(context.asked, []);
  assert.deepEqual((await new ToolLosses().handle("[TOOL_TIER_LOST] wooden_shovel was lost; no shovel remains.", context)).status, "remade");
  assert.deepEqual(lost, ["pickaxe", "shovel"]);
});
