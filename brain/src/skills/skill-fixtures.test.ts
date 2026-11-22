// Helpers shared by the skill tests of this folder: the skill context, recipes and call descriptions.
import { Body } from "../body.ts";
import { TEMPLATES, templateFor, type Template } from "../building/templates.ts";
import { type SkillContext } from "../skills.ts";
import { neededItems } from "../inventory-room.ts";
import { BodyDown, type BotSnapshot } from "../runtime-client.ts";
import { FakeRuntime } from "../testing.ts";

export function contextFor(runtime: FakeRuntime, extra: Partial<SkillContext> = {}): SkillContext {
  runtime.blockTags = { air: ["air"], ...runtime.blockTags };
  return { runtime, body: new Body(runtime, () => undefined), signal: new AbortController().signal, ...extra };
}

export function builds(runtime: FakeRuntime) {
  return runtime.submitted.filter((call) => call.tool === "build_structure").map((call) => call.input as { blocks: { x: number; y: number; z: number; block_name: string; facing?: string }[]; remove_wrong_blocks: boolean });
}

/** Enough of Minecraft's recipes for a small medieval house. */
export const HOUSE_RECIPES = {
  oak_planks: { makes: 4, needs: [{ item: "oak_log", count: 1 }] },
  spruce_planks: { makes: 4, needs: [{ item: "spruce_log", count: 1 }] },
  spruce_stairs: { makes: 4, needs: [{ item: "spruce_planks", count: 6 }] },
  spruce_slab: { makes: 6, needs: [{ item: "spruce_planks", count: 3 }] },
  stick: { makes: 4, needs: [{ item: "oak_planks", count: 2 }] },
  crafting_table: { makes: 1, needs: [{ item: "oak_planks", count: 4 }] },
  wooden_pickaxe: { makes: 1, needs: [{ item: "oak_planks", count: 3 }, { item: "stick", count: 2 }] },
  oak_fence: { makes: 3, needs: [{ item: "oak_planks", count: 4 }, { item: "stick", count: 2 }] },
  oak_door: { makes: 3, needs: [{ item: "oak_planks", count: 6 }] },
};

export function describeCall(call: { readonly tool: string; readonly input: Readonly<Record<string, unknown>> }): string {
  if (call.tool === "collect_block") return `collect ${String(call.input.block_name)}`;
  if (call.tool === "craft_item") {
    const items = (call.input.items as { item_name: string }[]).map((item) => item.item_name).join("+");
    return `craft ${items}${call.input.temporary_workstation === true ? " at table" : ""}`;
  }
  return call.tool;
}

/** House recipes plus what glass windows take: a furnace, and panes from glass. */
export const GLASS_RECIPES = {
  ...HOUSE_RECIPES,
  furnace: { makes: 1, needs: [{ item: "cobblestone", count: 8 }] },
  glass_pane: { makes: 16, needs: [{ item: "glass", count: 6 }] },
};

/** A failed `build_structure` whose audit names these cells as refused (the runtime's structured `left` groups). */
export function refusedBuild(cells: readonly { x: number; y: number; z: number; detail: string; cause?: string }[]): { readonly error: string; readonly result: Record<string, unknown> } {
  return {
    error: `[BUILD_INCOMPLETE] ${cells.length} cell still wrong: ${cells.length} were refused.`,
    result: {
      status: "failed",
      error: "refused",
      structure: { placed: 0, dug: 0, wrong: cells.length, left: [{ reason: "refused", count: cells.length, named: cells.map((cell) => ({ cause: "policy", ...cell })) }], missing: [] },
    },
  };
}

export const needsOnlyTools = (snapshot: BotSnapshot) => neededItems(snapshot, {});

/** The small medieval template: every shipped template declares its claim sign cell (`templates.ts`), so its plans carry a sign spot. */
export const SIGNED_MEDIEVAL: Template = templateFor("medieval-small")!;

/** The shipped registry: kept under this name for the tests that pass it as the skill's templates. */
export const SIGNED_TEMPLATES: ReadonlyMap<string, Template> = TEMPLATES;

/** The record of an unfinished small medieval house before its stage and part change. */
export const MEDIEVAL_SMALL_RECORD = { kind: "small medieval house", template: "medieval-small", family: "europe", stage: 0, stages: 4, stageName: "floor" };

/** Who the house is for and where: the identity a build for the requester Steve records (the claim sign reads it). */
export const STEVE_IN_OVERWORLD = { owner: "steve", dimension: "minecraft:overworld" };

export const owedToAyla = [{ item: "crafting_table", count: 1, partner: "Ayla", tradeId: "t1" }];

export const owing = (item: string, count: number, partner = "Ayla", tradeId = "t1") => ({ item, count, partner, tradeId });

export const count = (runtime: FakeRuntime, item: string) => runtime.snapshot.inventory.filter((stack) => stack.name === item).reduce((sum, stack) => sum + stack.count, 0);

export const bodyDownError = () => new BodyDown({ at: new Date(Date.now() + 30_000).toISOString(), attempt: 2, of: 6 }, new Error("[RUNTIME_UNRESPONSIVE] Runtime event-loop heartbeat absent"));

/** An own area of the house `label` around `door`, as the runtime keeps it across a restart. */
export function ownAreaAround(runtime: FakeRuntime, regionId: number, label: string, door: { x: number; y: number; z: number }): void {
  runtime.areas.push({ regionId, owner: "self", label, min: { x: door.x - 3, y: door.y - 1, z: door.z - 3 }, max: { x: door.x + 3, y: door.y + 8, z: door.z + 3 } });
}
