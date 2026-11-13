import assert from "node:assert/strict";
import test from "node:test";
import { stepSchema } from "./actions.ts";
import { Body } from "./body.ts";
import { keptInputsUsed } from "./kept-replacement.ts";
import { runStep, type SkillContext } from "./skills.ts";
import { FakeRuntime } from "./testing.ts";

// Plan 2026-11-12-house-build-fixes Task 4: `get_items` fetches a kept item's replacement before a craft uses it, and
// fails before using any of what it carried when no more can be got (live 2026-11-10: Nia's 44 packed_mud given for her
// rondavel became bricks, 16 a call, four calls running).

/** House blocks the way the game makes them: bricks from packed mud (1:1), packed mud from mud and wheat. */
const HOUSE_BLOCKS = {
  mud_bricks: { makes: 1, needs: [{ item: "packed_mud", count: 1 }] },
  packed_mud: { makes: 1, needs: [{ item: "mud", count: 1 }, { item: "wheat", count: 1 }] },
  spruce_planks: { makes: 4, needs: [{ item: "spruce_log", count: 1 }] },
  spruce_stairs: { makes: 4, needs: [{ item: "spruce_planks", count: 6 }] },
  oak_planks: { makes: 4, needs: [{ item: "oak_log", count: 1 }] },
  stick: { makes: 4, needs: [{ item: "oak_planks", count: 2 }] },
  crafting_table: { makes: 1, needs: [{ item: "oak_planks", count: 4 }] },
  wooden_pickaxe: { makes: 1, needs: [{ item: "oak_planks", count: 3 }, { item: "stick", count: 2 }] },
};

function contextFor(runtime: FakeRuntime): SkillContext {
  return { runtime, body: new Body(runtime, () => undefined), signal: new AbortController().signal };
}

/** A fake runtime carrying `inventory` (a crafting table too: no table is made on the way), crafting like the game. */
function carrying(inventory: readonly { readonly name: string; readonly count: number }[], noDrop: readonly string[] = []): FakeRuntime {
  const runtime = new FakeRuntime();
  runtime.recipes = HOUSE_BLOCKS;
  runtime.simulateInventory = true;
  runtime.notDropped = new Set([...runtime.notDropped, ...noDrop]);
  runtime.snapshot = { ...runtime.snapshot, inventory: [...inventory, { name: "crafting_table", count: 1 }] };
  return runtime;
}

function count(runtime: FakeRuntime, item: string): number {
  return runtime.snapshot.inventory.filter((stack) => stack.name === item).reduce((sum, stack) => sum + stack.count, 0);
}

/** The items of each `craft_item` call, in order: "packed_mud" or "mud_bricks+packed_mud". */
function crafts(runtime: FakeRuntime): string[] {
  return runtime.submitted.filter((call) => call.tool === "craft_item").map((call) => (call.input.items as { item_name: string }[]).map((entry) => entry.item_name).join("+"));
}

function detailOf(result: Awaited<ReturnType<typeof runStep>>): string {
  return result.status === "done" || result.status === "failed" ? result.detail : "";
}

test("a craft that would take carried packed_mud fails before using any when no more can be got", async () => {
  const runtime = carrying([{ name: "packed_mud", count: 44 }], ["mud"]);
  const result = await runStep({ skill: "get_items", items: [{ item: "mud_bricks", count: 16 }] }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(detailOf(result), /^mud_bricks would be crafted from 16 of the packed_mud you carry, and no more packed_mud could be got \(.+\): get_items keeps what you carried; \{"skill":"craft_item","item":"mud_bricks","count":16\} crafts it from them/u);
  assert.equal(count(runtime, "packed_mud"), 44, "nothing carried was used");
  assert.deepEqual(crafts(runtime), [], "no craft of mud_bricks submitted");
  // Next action from the stop: the quoted step makes the bricks from the packed_mud carried.
  const quoted = /(\{"skill":"craft_item"[^}]*\})/u.exec(detailOf(result))?.[1];
  assert.ok(quoted !== undefined, "the stop quotes a craft_item step");
  const next = await runStep(stepSchema.parse(JSON.parse(quoted)), contextFor(runtime));
  assert.equal(next.status, "done");
  assert.equal(count(runtime, "mud_bricks"), 16);
  assert.equal(count(runtime, "packed_mud"), 28);
});

test("a replacement whose gathering fails (none near) ends the fetch with the same sentence, the gathering's words as the reason", async () => {
  const runtime = carrying([{ name: "packed_mud", count: 44 }]);
  runtime.failures.collect_block = "[NO_TARGET_IN_RANGE] no mud within 64 blocks of you";
  const result = await runStep({ skill: "get_items", items: [{ item: "mud_bricks", count: 16 }] }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(detailOf(result), /^mud_bricks would be crafted from 16 of the packed_mud you carry, and no more packed_mud could be got \(.*no mud within.*\): get_items keeps what you carried; \{"skill":"craft_item","item":"mud_bricks","count":16\} crafts it from them/u);
  assert.equal(count(runtime, "packed_mud"), 44);
  assert.deepEqual(crafts(runtime), []);
});

test("the step's count is the asked output, the sentence's number the input the craft takes", async () => {
  // 8 stairs take 12 planks (4 stairs from 6 planks); no logs to be got.
  const runtime = carrying([{ name: "spruce_planks", count: 12 }], ["spruce_log"]);
  const result = await runStep({ skill: "get_items", items: [{ item: "spruce_stairs", count: 8 }] }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(detailOf(result), /^spruce_stairs would be crafted from 12 of the spruce_planks you carry, and no more spruce_planks could be got \(.+\): get_items keeps what you carried; \{"skill":"craft_item","item":"spruce_stairs","count":8\} crafts it from them/u);
  assert.equal(count(runtime, "spruce_planks"), 12);
});

test("the replacement near: crafted alone first, then the asked items", async () => {
  const runtime = carrying([{ name: "packed_mud", count: 44 }]);
  const result = await runStep({ skill: "get_items", items: [{ item: "mud_bricks", count: 16 }] }, contextFor(runtime));
  assert.equal(result.status, "done", detailOf(result));
  assert.equal(count(runtime, "mud_bricks"), 16);
  assert.equal(count(runtime, "packed_mud"), 44, "what she carried is still carried");
  assert.deepEqual(crafts(runtime), ["packed_mud", "mud_bricks"], "the replacement alone, then the asked items: two calls");
});

test("a replacement that needs a furnace first is not refused: the prerequisite craft runs, then the smelt, then the asked craft (task review 2026-11-12 item 1)", async () => {
  // 16 panes take 6 glass of the 12 carried: the 6 more are smelted from sand, in a furnace the bag has the cobblestone for.
  const runtime = carrying([{ name: "glass", count: 12 }, { name: "cobblestone", count: 8 }]);
  runtime.recipes = { ...HOUSE_BLOCKS, furnace: { makes: 1, needs: [{ item: "cobblestone", count: 8 }] }, glass_pane: { makes: 16, needs: [{ item: "glass", count: 6 }] } };
  runtime.smelting = { glass: ["sand"] };
  const result = await runStep({ skill: "get_items", items: [{ item: "glass_pane", count: 16 }] }, contextFor(runtime));
  assert.equal(result.status, "done", detailOf(result));
  assert.equal(count(runtime, "glass_pane"), 16);
  assert.equal(count(runtime, "glass"), 12, "the glass carried is still carried");
  const order = runtime.submitted.map((call) => call.tool).filter((tool) => tool === "craft_item" || tool === "smelt_item");
  assert.ok(order.indexOf("smelt_item") >= 0 && order.lastIndexOf("craft_item") > order.indexOf("smelt_item"), `the panes come after the smelt (${order.join(", ")})`);
});

test("a craft asked for more than the step schema allows quotes 64 and says so", async () => {
  const runtime = carrying([{ name: "packed_mud", count: 100 }], ["mud"]);
  const result = await runStep({ skill: "get_items", items: [{ item: "mud_bricks", count: 100 }] }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(detailOf(result), /^mud_bricks would be crafted from 100 of the packed_mud you carry, .*\{"skill":"craft_item","item":"mud_bricks","count":64\} crafts 64 of it from them/u);
});

test("with two asked crafts in one batch, the stop names the one that uses the kept item", async () => {
  const runtime = carrying([{ name: "packed_mud", count: 44 }], ["mud"]);
  const result = await runStep({ skill: "get_items", items: [{ item: "oak_planks", count: 4 }, { item: "mud_bricks", count: 16 }] }, contextFor(runtime));
  assert.equal(result.status, "failed");
  assert.match(detailOf(result), /^mud_bricks would be crafted from 16 of the packed_mud you carry/u);
});

test("a table or tool the fetch needs still uses carried planks (the tool's own path is unchanged)", async () => {
  const runtime = carrying([{ name: "oak_planks", count: 12 }]);
  const result = await runStep({ skill: "get_items", items: [{ item: "cobblestone", count: 4 }] }, contextFor(runtime));
  assert.equal(result.status, "done", detailOf(result));
  assert.doesNotMatch(detailOf(result), /would be crafted from/u);
  assert.ok(crafts(runtime).includes("wooden_pickaxe"), `the pickaxe is made first (${crafts(runtime).join(", ")})`);
  assert.equal(count(runtime, "cobblestone"), 4);
  assert.ok(count(runtime, "oak_planks") >= 12, "the planks the tool used are made again, as before");
});

test("keptInputsUsed: a kept item the craft would take below its kept count is raised by what the craft uses", () => {
  const inventory = [{ name: "packed_mud", count: 44 }];
  const keep = [{ item: "packed_mud", count: 44 }];
  assert.deepEqual(keptInputsUsed([{ item: "packed_mud", count: 6 }], [], keep, [{ name: "packed_mud", count: 50 }]), [], "used within what is spare");
  assert.deepEqual(keptInputsUsed([{ item: "packed_mud", count: 16 }], [{ item: "packed_mud", count: 16 }], keep, inventory), [], "the same batch makes enough");
  assert.deepEqual(keptInputsUsed([{ item: "packed_mud", count: 16 }], [], keep, inventory), [{ item: "packed_mud", count: 60 }], "short: kept count plus what the craft uses");
});
