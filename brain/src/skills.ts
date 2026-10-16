import { setTimeout as sleep } from "node:timers/promises";
import minecraftData from "minecraft-data";
import { z } from "zod";
import type { Activity } from "./activities.ts";
import { COMPASS_HEADINGS, describeStep, dropEntries, type Step } from "./actions.ts";
import { describeMaterials, shortfall, type BlockRole, type MaterialCount } from "./building/blueprint.ts";
import { checkMaterials, improvement } from "./building/materials.ts";
import { builderStand, chooseSite, planHouse, siteAt, styleOrDefault, type HousePlan, type Materials, type Site } from "./building/plan.ts";
import type { Body } from "./body.ts";
import { LEVEL_BLOCK_BUDGET, LEVEL_LIMITS, SUPPORT_REACH, levelBox, levelPlan, type LevelOptions, type TerrainCell, type Zone } from "./building/terrain.ts";
import { describeWay, dropSourcesNote, FETCH_RANGE, gatherMaterials, knownPlaces, notNear, obtainedBy, walkToStation, withMaterialsKept } from "./gathering.ts";
import type { HouseSize } from "./building/house.ts";
import { consumedBy, FULL_INVENTORY, junkHint, junkStacks, KEPT_KINDS, kindOf } from "./inventory-room.ts";
import type { KnownPlace } from "./mind.ts";
import type { KnownFarm } from "./memory.ts";
import { farm } from "./farming/farm-skill.ts";
import { ToolLosses } from "./building/tool-loss.ts";
import { areaKey, errorCode, type BotRuntime, type BotSnapshot, type ForegroundTool, type FoundBlock, type NearbyPlayer, type Position, type ProtectedArea } from "./runtime-client.ts";

/** Pause between follow checks while already close enough. */
const FOLLOW_POLL_MS = 750;
/**
 * A follow asked for by a player ends after this long without a word from them; on her own goal it lasts the minutes
 * the step says, {@link FOLLOW_OWN_MINUTES} by default (spec 2026-10-04-activity-time-travel-terraforming: live, Vex
 * followed Tester, who never asked, until an order came).
 */
const FOLLOW_QUIET_MS = 10 * 60_000;
const FOLLOW_OWN_MINUTES = 5;
/** Extra blocks tolerated beyond the follow distance before moving, so the bot does not twitch at every step. */
const FOLLOW_SLACK = 1.5;
/** A followed player this far from the current navigation target triggers a re-plan. */
const REPLAN_DISTANCE = 4;
/** Consecutive checks without seeing the followed player before giving up (~ FOLLOW_LOST_CHECKS * poll). */
const FOLLOW_LOST_CHECKS = 8;
/** Consecutive failed navigation legs before following gives up (unreachable player). */
const FOLLOW_MAX_FAILURES = 3;
/** Stop this close to a player we walk up to. */
const COME_RANGE = 2;
/** Arrival tolerance for `go_to` coordinates. */
const GO_TO_RANGE = 1;
/** An unfinished house is resumed only by a build step this close to its door; farther away a new one is started. */
export const RESUME_RANGE = 6;
/** `get_items` walks back to where it started when it ends farther than this. */
const RETURN_RANGE = 3;

export interface SkillContext {
  readonly runtime: BotRuntime;
  readonly body: Body;
  readonly signal: AbortSignal;
  /** Who asked: a house faces them. */
  readonly requester?: string;
  /** The persona's building style (always its own: the model cannot pick another). */
  readonly style?: string;
  /** Told about places worth remembering (a finished house), so later requests such as "go to the roof" can use them. */
  readonly remember?: (place: KnownPlace) => void;
  /** The house left unfinished by an earlier build step, which the next build of the same kind resumes. */
  readonly building?: { unfinished: UnfinishedHouse | null };
  /** Its own house that still has temporary parts, as last remembered (a place with a `house` whose materials are not empty). */
  readonly ownHouse?: () => KnownPlace | null;
  /** The protected areas the agent knows (ADR-012), updated in place when a skill protects or releases one. */
  readonly areas?: ProtectedArea[];
  /** The character's own username: areas it owns are its own builds. */
  readonly self?: string;
  /** Told what it starts doing now and why, at a skill's phase changes (see {@link GatherContext.progress}). */
  readonly progress?: (fact: string) => void;
  /** Told where a fetch is travelling to (a place it saw the block), and null when it arrived or gave up: getting nearer counts as progress for the no-gain stop. */
  readonly heading?: (target: { readonly x: number; readonly z: number } | null) => void;
  /** Told that the step's work is another activity from now on (the house's site preparation is terraforming). */
  readonly phase?: (activity: Activity) => void;
  /** When the player who asked for this step last said anything (epoch ms); unset for her own goals. */
  readonly heardFrom?: () => number;
  /** The farms it made, as at their last tend; farming near one tends it. */
  readonly farms?: readonly KnownFarm[];
  /** Told about a farm made or tended, to remember it. */
  readonly rememberFarm?: (farm: KnownFarm) => void;
  /** The carried items its own work needs (set for its own objectives only): a drop of its own keeps them; an order drops anything asked. */
  readonly needed?: (snapshot: BotSnapshot) => ReadonlySet<string>;
  /**
   * The place a `level_area` around a player was first aimed at in this objective, by the player's lower-case name: later
   * steps around the same player level the same place, wherever the player has gone since (run 13: Brea's second level
   * followed the owner, flying, 4 blocks up and 20 away). Kept for the objective's life by the agent.
   */
  readonly levelSites?: Map<string, { readonly x: number; readonly y: number; readonly z: number }>;
}

export interface UnfinishedHouse {
  readonly kind: string;
  readonly site: Site;
  /** The first part (batch) not yet built. */
  readonly part: number;
  /** False while its site is still to be leveled (an older note has none: its site counts as ready). */
  readonly prepared?: boolean;
  /** The roles built with other blocks than the style's (an older note has none: as the style). */
  readonly materials?: Materials;
  /**
   * The cells the runtime refused in the last run that stopped on them (an older note has none). A refusal is often
   * transient (an animal in the cell, a route that timed out), so the house is kept; it is given up only when a
   * resume is refused at one of these cells again.
   */
  readonly refused?: readonly { readonly x: number; readonly y: number; readonly z: number }[];
}

export type SkillResult =
  | { readonly status: "done"; readonly detail: string }
  | { readonly status: "failed"; readonly detail: string }
  /** Aborted by the agent (a new order or "stop"); nothing to report. */
  | { readonly status: "stopped" };

/**
 * Brain-level skills: short programs over atomic actions, one per step the model chooses (ADR-011). Following is done
 * here with repeated `navigate` rather than a new runtime action; if that proves too jerky it becomes a
 * `follow_entity` action (backlog).
 */
export async function runStep(step: Step, context: SkillContext): Promise<SkillResult> {
  const why = `I chose to ${describeStep(step)}.`;
  try {
    switch (step.skill) {
      case "follow_player": return await follow(context, step.player, step.distance, step.minutes);
      case "go_to_player": return await come(context, step.player);
      case "go_to":
        return await once(context, "navigate", { x: step.x, y: step.y, z: step.z, range: GO_TO_RANGE }, why, `reached ${step.x} ${step.y} ${step.z}`);
      case "explore": return await explore(context, step, why);
      case "collect_block": {
        // Within the fetch range, like get_items: a trip is a go_to of its own (spec 2026-10-03 fetch-range).
        const collected = await once(context, "collect_block", { block_name: step.block, count: step.count, max_distance: FETCH_RANGE }, why, `collected ${step.count} ${step.block}`);
        return collected.status === "failed" ? { status: "failed", detail: await notNear(context, step.block, collected.detail) } : collected;
      }
      case "give_item": return await give(context, step.player, step.item, step.count);
      case "drop_item": return await dropItems(context, step, why);
      case "craft_item": return await craftItem(context, step, why);
      case "get_items": return await getItems(context, step.items);
      // No refusal from the bar here: golden apples and chorus fruit are edible when it is full, so the game answers.
      case "eat": return await once(context, "eat_food", { food_name: step.food }, why, `ate ${step.food}`);
      case "equip": return await once(context, "equip", { items: [{ item_name: step.item }] }, why, `equipped ${step.item}`);
      case "sleep": return await once(context, "sleep", {}, why, "slept");
      case "hunt":
        return await once(context, "collect_mob_drop", { mob_name: step.mob, drop_name: step.drop, count: step.count }, why, `got ${step.count} ${step.drop} from ${step.mob}`);
      case "level_area": return await levelArea(context, step);
      case "protect_area": return await protectArea(context, step);
      case "release_area": return await releaseArea(context, step.area);
      case "build": return await build(context, step);
      case "improve_house": return await improveHouse(context, step);
      case "farm": return await farm(context, step);
    }
  } catch (error) {
    if (context.signal.aborted) return { status: "stopped" };
    throw error;
  }
}

export type FollowStep =
  | { readonly kind: "lost" }
  | { readonly kind: "hold" }
  | { readonly kind: "move"; readonly target: Position };

/** Pure follow decision for one tick. */
export function planFollowStep(snapshot: BotSnapshot, player: string, distance: number): FollowStep {
  const target = findPlayer(snapshot, player)?.position ?? null;
  if (target === null) return { kind: "lost" };
  if (distanceBetween(snapshot.position, target) <= distance + FOLLOW_SLACK) return { kind: "hold" };
  return { kind: "move", target };
}

async function follow(context: SkillContext, player: string, distance: number, minutes?: number): Promise<SkillResult> {
  const { runtime, body, signal, heardFrom } = context;
  const started = Date.now();
  const until = started + (minutes ?? FOLLOW_OWN_MINUTES) * 60_000;
  let unseen = 0;
  let failures = 0;
  while (!signal.aborted) {
    // Asked for by a player: it lasts while they keep talking (any line restarts the count). On her own goal: its minutes.
    if (heardFrom !== undefined && minutes === undefined) {
      if (Date.now() - heardFrom() >= FOLLOW_QUIET_MS) {
        return { status: "done", detail: `followed ${player}; they said nothing for ${FOLLOW_QUIET_MS / 60_000} minutes, so I went back to my own things` };
      }
    } else if (Date.now() >= until) {
      return { status: "done", detail: `followed ${player} for ${Math.round((Date.now() - started) / 60_000)} minutes` };
    }
    const step = planFollowStep(await runtime.status(), player, distance);
    if (step.kind === "lost") {
      unseen += 1;
      if (unseen >= FOLLOW_LOST_CHECKS) return { status: "failed", detail: `lost sight of ${player}` };
      await sleep(FOLLOW_POLL_MS, undefined, { signal });
      continue;
    }
    unseen = 0;
    if (step.kind === "hold") {
      await sleep(FOLLOW_POLL_MS, undefined, { signal });
      continue;
    }
    const target = step.target;
    const outcome = await body.act("navigate", navigateInput(target, distance), `Follow ${player}.`, {
      signal,
      interruptWhen: async () => {
        const now = findPlayer(await runtime.status(), player)?.position ?? null;
        return now !== null && distanceBetween(now, target) > REPLAN_DISTANCE;
      },
    });
    // Pre-empted legs and partial arrivals are normal while following: the next tick re-plans from where we are.
    if (outcome.status === "refused") return { status: "failed", detail: outcome.error ?? "navigation refused" };
    if (outcome.status === "failed" && !outcome.preempted) {
      failures += 1;
      if (failures >= FOLLOW_MAX_FAILURES) return { status: "failed", detail: outcome.error ?? `cannot reach ${player}` };
      await sleep(FOLLOW_POLL_MS, undefined, { signal });
    } else {
      failures = 0;
    }
  }
  return { status: "stopped" };
}

async function come(context: SkillContext, player: string): Promise<SkillResult> {
  const target = findPlayer(await context.runtime.status(), player)?.position ?? null;
  if (target === null) return { status: "failed", detail: `cannot see ${player}` };
  const outcome = await context.body.act("navigate", navigateInput(target, COME_RANGE), `Go to ${player} who called me.`, { signal: context.signal });
  if (context.signal.aborted) return { status: "stopped" };
  if (outcome.status === "succeeded") return { status: "done", detail: `reached ${player}` };
  return { status: "failed", detail: outcome.error ?? `navigation ${outcome.status}` };
}

async function once(context: SkillContext, tool: ForegroundTool, input: Record<string, unknown>, rationale: string, doneDetail: string): Promise<SkillResult> {
  const outcome = await context.body.act(tool, input, rationale, { signal: context.signal });
  if (context.signal.aborted) return { status: "stopped" };
  if (outcome.status === "succeeded") return { status: "done", detail: doneDetail };
  return { status: "failed", detail: outcome.error ?? `${tool} ${outcome.status}` };
}

/**
 * Crafts one item. A table close by is used where it stands; else the runtime sets a carried one down. With no room for
 * the result or the table, room is made from what the work does not need and the craft runs again; with no table
 * carried, one is made first (run 12: "needs inventory room to store 1 stone_shovel", "No crafting_table is carried").
 */
async function craftItem(context: SkillContext, step: Extract<Step, { skill: "craft_item" }>, why: string): Promise<SkillResult> {
  await walkToStation(context, "crafting_table");
  const run = () => once(context, "craft_item", { items: [{ item_name: step.item, count: step.count }] }, why, `crafted ${step.count} ${step.item}`);
  const first = await run();
  if (first.status !== "failed") return first;
  if (FULL_INVENTORY.test(first.detail) && (await makeRoom(context, await consumedBy(context.runtime, "craft_item", { items: [{ item_name: step.item, count: step.count }] })))) return run();
  if (/WORKSTATION_NOT_CARRIED/u.test(first.detail)) {
    const table = await getItems(context, [{ item: "crafting_table", count: 1 }], `crafting ${step.item}`);
    if (table.status === "stopped") return table;
    return table.status === "done" ? run() : { status: "failed", detail: `${first.detail}; making a crafting table failed: ${table.detail}` };
  }
  // Run 12: 16 crafts lacked raw materials; get_items gathers them and crafts (one clear next step).
  return first.detail.includes("CRAFT_MATERIALS_MISSING")
    ? { status: "failed", detail: `${first.detail} craft only uses what you carry: \`get_items ${step.item} ${step.count}\` gathers the missing materials and crafts it.` }
    : first;
}

/**
 * Frees a slot for a craft or a smelt from the carried items neither its own work nor the objective needs (the same
 * sparing as {@link dropItems}): one stack at a time, the one losing least, until a slot is free. `inputs` are what the
 * craft or the smelt consumes: never dropped, whatever the objective says (run 13: a full inventory of cobblestone lost
 * all of it to a stone shovel craft). False for an order (no `needed`), when everything carried is needed, or when no
 * slot came free: the failure then names what to drop.
 */
async function makeRoom(context: SkillContext, inputs: ReadonlySet<string>): Promise<boolean> {
  if (context.needed === undefined) return false;
  for (let attempt = 0; attempt < INVENTORY_SLOTS; attempt++) {
    const before = await context.runtime.status();
    // A count drops the kind's stacks in inventory order: the first stack's count frees exactly the first stack.
    const [stack] = junkStacks(before, new Set([...context.needed(before), ...inputs]))
      .map(({ name, stacks }) => ({ name, count: stacks[0]! }))
      .sort((x, y) => x.count - y.count || x.name.localeCompare(y.name));
    if (stack === undefined) return false;
    const dropped = await dropItems(context, { skill: "drop_item", items: [{ item: stack.name, count: stack.count }] }, "Make room in the inventory for what I am crafting.");
    if (dropped.status !== "done") return false;
    if ((await context.runtime.status()).inventory.length < INVENTORY_SLOTS) return true;
  }
  return false;
}

/** What the action says it really dropped (its `drop.dropped` counts); null when the result carries none. */
function reallyDropped(result: Readonly<Record<string, unknown>> | undefined): { item: string; count: number }[] | null {
  const dropped = (result?.drop as { dropped?: unknown } | undefined)?.dropped;
  if (!Array.isArray(dropped)) return null;
  return dropped
    .map((entry: { item?: unknown; dropped?: unknown }) => ({ item: String(entry.item), count: Number(entry.dropped) }))
    .filter((entry) => entry.count > 0);
}

const TIERS = ["netherite", "diamond", "iron", "golden", "stone", "wooden"];
const tierRank = (item: string): number => { const rank = TIERS.indexOf(item.split("_")[0]!); return rank < 0 ? TIERS.length : rank; };

/**
 * The last tool of a class, the last bed and the last boat stay in the inventory: one is kept, the best tier carried
 * (live 2026-10-10 run 8: Ayla dropped her stone pickaxe, axe, shovel, boat and bed; Yuki her axe while crafting one).
 */
function keepLastOfKind(entries: readonly { item: string; count?: number }[], inventory: readonly { name: string; count: number }[]): { entries: { item: string; count?: number }[]; kept: string[] } {
  const carried = (item: string) => inventory.filter((stack) => stack.name === item).reduce((sum, stack) => sum + stack.count, 0);
  const result = entries.map((entry) => ({ ...entry }));
  const kept: string[] = [];
  for (const kind of KEPT_KINDS) {
    const owned = [...new Set(inventory.filter((stack) => kindOf(stack.name) === kind).map((stack) => stack.name))];
    if (owned.length === 0) continue;
    const dropping = (item: string) => { const entry = result.find((candidate) => candidate.item === item); return entry === undefined ? 0 : Math.min(entry.count ?? carried(item), carried(item)); };
    if (owned.some((item) => carried(item) - dropping(item) > 0)) continue;
    const keep = [...owned].sort((a, b) => tierRank(a) - tierRank(b))[0]!;
    const entry = result.find((candidate) => candidate.item === keep);
    if (entry === undefined) continue;
    entry.count = Math.max(0, dropping(keep) - 1);
    kept.push(`kept 1 ${keep}: your only ${kind}`);
  }
  return { entries: result.filter((entry) => entry.count !== 0), kept };
}

/**
 * Buries the items in a pit; only a place with no pit within reach (water all around, bedrock) puts them on the ground,
 * and the action itself walks off from them. The step says what was really dropped, never what was asked (live 2026-10-10 run 7: 26
 * identical drops each "done" while the action dropped 0), and whether the inventory has room again.
 */
async function dropItems(context: SkillContext, step: Extract<Step, { skill: "drop_item" }>, why: string): Promise<SkillResult> {
  const before = await context.runtime.status();
  const own = keepLastOfKind(dropEntries(step), before.inventory);
  // The work's items are spared only while something else could go: with everything needed, keeping them all made
  // a full inventory a dead end (run 11, 2026-10-14: Mira, "nothing dropped; kept all 100 cobblestone" 16 times).
  const workNeeds = context.needed?.(before) ?? new Set<string>();
  const needed = before.inventory.some((stack) => !workNeeds.has(stack.name)) ? workNeeds : new Set<string>();
  const kept = [...own.kept];
  const entries = own.entries.filter((entry) => {
    if (!needed.has(entry.item)) return true;
    const all = before.inventory.filter((stack) => stack.name === entry.item).reduce((sum, stack) => sum + stack.count, 0);
    kept.push(`kept all ${Math.min(entry.count ?? all, all)} ${entry.item}: your current work needs them`);
    return false;
  });
  // What may go instead is said with the refusal, or the same drop came back (run 11: up to 7 times in a row).
  if (entries.length === 0) return { status: "failed", detail: `nothing dropped; ${kept.join("; ")}${needed.size === 0 ? "" : `; ${junkHint(before, needed)}`}` };
  const items = entries.map((entry) => ({ item_name: entry.item, ...(entry.count !== undefined && { count: entry.count }) }));
  const act = (input: Record<string, unknown>) => context.body.act("drop_item", { items, allow_equipped: true, ...input }, why, { signal: context.signal });
  // Buried, not tossed at her feet: a toss lands within a block or two, and she picked most of it up again
  // (owner, live 2026-10-07).
  let outcome = await act({ in_a_hole: true });
  if (context.signal.aborted) return { status: "stopped" };
  let onGround = false;
  if (outcome.status !== "succeeded" && (outcome.error ?? "").includes("[DROP_HOLE_UNAVAILABLE]")) {
    outcome = await act({});
    if (context.signal.aborted) return { status: "stopped" };
    onGround = true;
  }
  const dropped = reallyDropped(outcome.result);
  const total = dropped === null ? (outcome.status === "succeeded" ? 1 : 0) : dropped.reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0) return { status: "failed", detail: `${outcome.error ?? `drop_item ${outcome.status}`}${kept.length > 0 ? `; ${kept.join("; ")}` : ""}` };
  const what = dropped === null ? entries.map((entry) => `${entry.count ?? "all the"} ${entry.item}`).join(", ") : dropped.map((entry) => `${entry.count} ${entry.item}`).join(", ");
  // How much room it made is what a drop is for (live 2026-10-02: 30 of 36 panes dropped freed no slot); say so, or the
  // model does not see the problem solved (owner, live 2026-10-10).
  const free = Math.max(0, INVENTORY_SLOTS - (await context.runtime.status()).inventory.length);
  const room = free === 0 ? "the inventory is still full" : `the inventory has room again: ${free} of ${INVENTORY_SLOTS} slots free`;
  const failedPart = outcome.status === "partial" && outcome.error !== null ? ` (${outcome.error})` : "";
  const keptNote = kept.length > 0 ? `; ${kept.join("; ")}` : "";
  return { status: "done", detail: `${onGround ? "dropped" : "buried"} ${what}${onGround ? " on the ground" : ""}${failedPart}${keptNote}; ${room}` };
}

async function give(context: SkillContext, player: string, item: string, count: number): Promise<SkillResult> {
  const approach = await come(context, player);
  if (approach.status !== "done") return approach;
  return once(context, "drop_item", { items: [{ item_name: item, count }], to_player: player }, `${player} asked me for ${item}.`, `gave ${count} ${item} to ${player}`);
}

/**
 * Gets `count` more of each item like a player (`gathering.ts`), then comes back to where it started: fetching is a
 * basic function; when and what to fetch is the model's choice (ADR-011).
 */
async function getItems(context: SkillContext, items: readonly { readonly item: string; readonly count: number }[], purpose = `getting ${describeMaterials(items)}`): Promise<SkillResult> {
  const { position: start, inventory } = await context.runtime.status();
  const carried = (item: string) => inventory.filter((stack) => stack.name === item).reduce((sum, stack) => sum + stack.count, 0);
  const targets = items.map(({ item, count }) => ({ item, count: carried(item) + count }));
  // What it carried stays carried: crafting the new items must not quietly use up the others (the planks for the walls).
  const keep = [...new Set(inventory.map((stack) => stack.name))].map((item) => ({ item, count: carried(item) }));
  // What it is all for, so a line in chat says why (live 2026-10-02: "Gather 21 dirt for getting 1 stone_shovel, 21 dirt").
  const gathered = await gatherMaterials({ ...context, makeRoom: (inputs) => makeRoom(context, inputs) }, targets, purpose, start, keep);
  if (gathered.status !== "done") return gathered;
  const here = (await context.runtime.status()).position;
  if (Math.hypot(here.x - start.x, here.y - start.y, here.z - start.z) > RETURN_RANGE) {
    const back = await once(context, "navigate", navigateInput(start, GO_TO_RANGE), "Come back to where I started fetching.", "back");
    if (back.status === "stopped") return back;
    // The items are carried: that is the fetch done; the next step walks where it needs to (live 2026-10-10 run 10: a failed fetch looped the explore).
    if (back.status === "failed") return { status: "done", detail: `got ${describeMaterials(items)}; could not walk back: ${back.detail}` };
  }
  return { status: "done", detail: `got ${describeMaterials(items)}, now carrying ${describeMaterials(targets)} (${gathered.detail})` };
}

/**
 * Builds a house from the persona's style where the bot stands, facing the requester, with carried blocks only (the
 * model fetches them first with `get_items`); one `build_structure` call per batch. A house left unfinished (a cell
 * refused, the step set aside) is finished at the same site by the next build of the same kind.
 */
async function build(context: SkillContext, step: Extract<Step, { skill: "build" }>): Promise<SkillResult> {
  const snapshot = await context.runtime.status();
  const style = styleOrDefault(context.style);
  const kind = `${step.size} ${style.id} house`;
  const what = `a ${kind}`;
  // The unfinished house is resumed where it stands; asked to build somewhere else, she starts a new one (live
  // 2026-10-02: "change of plan, build it right here" resumed the old pond-side site).
  // At given coordinates (its door), wherever she happens to stand (live 2026-10-02: asked for a house at a place,
  // she walked to a crafting table for the materials and built where the table was).
  const at = step.x !== undefined && step.y !== undefined && step.z !== undefined ? { x: step.x, y: step.y, z: step.z } : null;
  const unfinished = context.building?.unfinished;
  const resumed = unfinished?.kind === kind && distanceBetween(at ?? snapshot.position, unfinished.site.door) <= RESUME_RANGE ? unfinished : null;
  // Her own house has no asker to face or to name (an ordered house is the asker's unless the step says `own`).
  const own = step.own === true || context.requester === undefined;
  const toward = own || context.requester === undefined ? null : findPlayer(snapshot, context.requester)?.position ?? null;
  // A resumed house keeps the materials it was started with; the step's are ignored then.
  const materials = resumed === null ? step.materials ?? {} : resumed.materials ?? {};
  if (resumed === null && Object.keys(materials).length > 0) {
    const refusal = checkMaterials(materials, style, await context.runtime.blockKinds(Object.values(materials).filter((block) => block !== "air")));
    if (refusal !== null) return { status: "failed", detail: `cannot build ${what} with those materials: ${refusal}` };
  }
  const plan = planHouse(style, step.size, resumed?.site ?? (at === null ? chooseSite(snapshot.position, toward) : siteAt(at, toward)), materials);
  if (resumed === null) {
    // A new site clear of every protected area before anything is protected or dug, and if not, where the nearest
    // clear one is (live 2026-10-03: told only "choose another zone clear of it", she stepped one block at a time,
    // and each refused start left its site protected for good: 16 house boxes, most of them never built).
    const areas = await context.runtime.protectedRegions();
    const blocked = overlapsOf(areas, siteBox(plan));
    if (blocked.length > 0) {
      const found = nearestClearSite(areas, style, step.size, plan.site, toward);
      const clear = found === null ? null : await groundedDoor(context.runtime, found);
      const where = clear === null
        ? `no site clear of protected areas within ${SITE_SEARCH} blocks: ask whoever asked you, or build somewhere else`
        : `the nearest site clear of them has its door ${describeWay(snapshot.position, clear)}, at ${clear.x} ${clear.y} ${clear.z}: build there with those coordinates, or ask whoever asked you`;
      return { status: "failed", detail: `the site of ${what} (door at ${plan.site.door.x} ${plan.site.door.y} ${plan.site.door.z}) ${describeOverlaps(context, blocked)}; ${where}` };
    }
    const missing = shortfall(plan.bill, snapshot.inventory);
    // Only what is missing, named as the step that fetches it: get_items adds to what she carries, so asking for the
    // whole bill fetched it twice and filled her inventory (live 2026-10-02).
    if (missing.length > 0) return { status: "failed", detail: `missing ${describeMaterials(missing)} for ${what} (the rest is carried): fetch exactly the missing items with get_items, then build again` };
  }
  if (at !== null) {
    const stand = builderStand(plan.site);
    context.progress?.(`walking to the site of ${what} at ${at.x} ${at.y} ${at.z}`);
    const there = await context.body.act("navigate", navigateInput(stand, 1), `Walk to the site of ${what}.`, { signal: context.signal });
    if (context.signal.aborted) return { status: "stopped" };
    if (there.status !== "succeeded") return { status: "failed", detail: `could not reach the site of ${what} at ${at.x} ${at.y} ${at.z}: ${there.error ?? there.status}` };
  }
  // The bill is not scaffolding while the house is built: the walks of the site's leveling used the very blocks it needs
  // (live 2026-10-04: 16 of 36 cobblestone).
  return withMaterialsKept(context.runtime, plan.bill.map((entry) => entry.item), () => buildOnSite(context, { step, kind, what, style, own, resumed, plan }));
}

/** What {@link build} worked out before the house is protected and built. */
interface SitePlan {
  readonly step: Extract<Step, { skill: "build" }>;
  readonly kind: string;
  readonly what: string;
  readonly style: ReturnType<typeof styleOrDefault>;
  readonly own: boolean;
  readonly resumed: UnfinishedHouse | null;
  readonly plan: HousePlan;
}

/** {@link build} from the protection of the site to the end. */
async function buildOnSite(context: SkillContext, { step, kind, what, style, own, resumed, plan }: SitePlan): Promise<SkillResult> {
  // Protected before the first block and again on every resume (the runtime keeps one region per box): its own
  // gathering and goals must not dig into the house (ADR-012). The build itself still works inside it.
  const protection = await context.runtime.protectRegion({
    ...houseBox(plan.batches.flat()),
    label: kind,
    reason: `Keep my own digging out of the ${kind} I am building.`,
  });
  if (protection.status === "failed") return { status: "failed", detail: `could not protect the site of ${what}: ${protection.error}` };
  noteArea(context, protection.area);
  const leaveUnfinished = (part: number, prepared = true, refused = resumed?.refused) => {
    if (context.building !== undefined) context.building.unfinished = { kind, site: plan.site, part, prepared, materials: plan.materials, ...(refused !== undefined && refused.length > 0 && { refused }) };
  };
  // The site first, the first time only: everything above the floor in the house's box dug, holes under it filled, so
  // no part meets terrain, water or loose stone (live 2026-10-01/02).
  if (resumed === null || resumed.prepared === false) {
    const box = houseBox(plan.batches.flat());
    // Clearing and levelling the site is reshaping ground, not building (spec 2026-10-04-activity-time-travel-terraforming).
    context.phase?.("terraforming");
    const prepared = await levelZone(context, { minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z }, plan.site.door.y, `the site of ${what}`, {
      // Blocks do not fall: a house needs its ring level and the water above its floor gone, not a pond filled under
      // it (live 2026-10-02: 258 cobblestone mined for a site over a pond). Its own floor goes in even over water.
      below: 1,
      placedLater: new Set(plan.batches.flat().filter((cell) => cell.block !== "air").map((cell) => `${cell.x},${cell.y},${cell.z}`)),
    }, plan.bill, [protection.area.regionId, ...earlierProtections(context, kind, plan.site.door, protection.area.regionId, await context.runtime.protectedRegions())]);
    // Nothing of the house stands yet: its site is not kept protected (a resume protects it again).
    if (prepared.status === "stopped" || context.signal.aborted) {
      leaveUnfinished(0, false);
      await releaseArea(context, protection.area.regionId);
      return { status: "stopped" };
    }
    if (prepared.status === "failed") {
      await releaseArea(context, protection.area.regionId);
      // A site another protected area overlaps cannot be prepared later either: the unfinished house is forgotten, not
      // offered again and again (live 2026-10-07: Ayla's unfinished house overlapped her other house #12; she went
      // back to it, protected a "temp_house" over it, and tried again).
      if (/overlaps protected area/u.test(prepared.detail)) {
        if (context.building !== undefined) context.building.unfinished = null;
        return { status: "failed", detail: `could not prepare the site of ${what}: ${prepared.detail}; that unfinished house is given up: build a new one somewhere clear` };
      }
      leaveUnfinished(0, false);
      return { status: "failed", detail: `could not prepare the site of ${what}: ${prepared.detail}` };
    }
    context.phase?.("building");
  }
  const stopped = await buildParts(context, plan, what, {
    reserved: plan.bill,
    leave: (part, refused) => leaveUnfinished(part, true, refused),
    refusedBefore: resumed?.refused,
    again: context.building === undefined ? "" : "; building it again resumes it there",
    abandon: () => { if (context.building !== undefined) context.building.unfinished = null; },
  });
  if (stopped !== null) return stopped;
  if (context.building !== undefined) context.building.unfinished = null;
  const { door, facing } = plan.site;
  const roof = plan.roofTop;
  context.remember?.({
    name: `the ${kind} you built${own ? "" : ` for ${context.requester}`}`,
    detail: `door ${door.x} ${door.y} ${door.z} facing ${facing}; stand on its roof at ${roof.x} ${roof.y} ${roof.z}`,
    ...(own && { own: true }),
    house: { size: step.size, style: style.id, door, facing, materials: plan.materials },
  });
  return { status: "done", detail: `built ${what}, door at ${door.x} ${door.y} ${door.z} facing ${facing}` };
}

/**
 * Swaps the temporary parts of its own house for the style's blocks, in place: the house's cells are sent again with
 * the style's blocks in those roles, and `build_structure` digs the wrong block of a cell and places the right one
 * (cells already right are skipped), so an interrupted swap is simply asked again.
 */
async function improveHouse(context: SkillContext, step: Extract<Step, { skill: "improve_house" }>): Promise<SkillResult> {
  const place = context.ownHouse?.() ?? null;
  const house = place?.house;
  if (place === null || house === undefined || Object.keys(house.materials).length === 0) return { status: "failed", detail: "you have no temporary house of your own to improve" };
  const style = styleOrDefault(house.style);
  const temporary = Object.keys(house.materials) as BlockRole[];
  const roles = step.roles ?? temporary;
  const notTemporary = roles.filter((role) => !temporary.includes(role));
  if (notTemporary.length > 0) return { status: "failed", detail: `your house is not temporary in ${notTemporary.join(", ")}: its temporary parts are ${temporary.join(", ")}` };
  const { after, rest, bill } = improvement(style, house, roles);
  const kind = `${house.size} ${style.id} house`;
  const what = `your ${kind}`;
  const snapshot = await context.runtime.status();
  const missing = shortfall(bill, snapshot.inventory);
  if (missing.length > 0) return { status: "failed", detail: `missing ${describeMaterials(missing)} to improve ${what} (the rest is carried): fetch exactly the missing items with get_items, then improve again` };
  const { x, y, z } = house.door;
  context.progress?.(`walking to ${what} at ${x} ${y} ${z}`);
  const there = await context.body.act("navigate", navigateInput(builderStand(after.site), 1), `Walk to ${what}.`, { signal: context.signal });
  if (context.signal.aborted) return { status: "stopped" };
  if (there.status !== "succeeded") return { status: "failed", detail: `could not reach ${what} at ${x} ${y} ${z}: ${there.error ?? there.status}` };
  return withMaterialsKept(context.runtime, bill.map((entry) => entry.item), () => improveOnSite(context, { place, house, style, roles, after, rest, bill, kind, what }));
}

/** What {@link improveHouse} worked out before the house is protected and improved. */
interface ImprovePlan {
  readonly place: KnownPlace;
  readonly house: NonNullable<KnownPlace["house"]>;
  readonly style: ReturnType<typeof styleOrDefault>;
  readonly roles: readonly BlockRole[];
  readonly after: HousePlan;
  readonly rest: Materials;
  readonly bill: readonly MaterialCount[];
  readonly kind: string;
  readonly what: string;
}

/** {@link improveHouse} from the protection of the house to the end. */
async function improveOnSite(context: SkillContext, { place, house, style, roles, after, rest, bill, kind, what }: ImprovePlan): Promise<SkillResult> {
  // Protected again under the same label (the runtime keeps one region per box), as a build does.
  const protection = await context.runtime.protectRegion({
    ...houseBox(after.batches.flat()),
    label: kind,
    reason: `Keep my own digging out of the ${kind} I am improving.`,
  });
  if (protection.status === "failed") return { status: "failed", detail: `could not protect ${what}: ${protection.error}` };
  noteArea(context, protection.area);
  const stopped = await buildParts(context, after, what, { reserved: bill, leave: () => undefined, again: "; improve your house again" });
  if (stopped !== null) return stopped;
  context.remember?.({ ...place, house: { ...house, materials: rest } });
  const swapped = roles.map((role) => style.palette[role]);
  const still = Object.entries(rest).map(([role, block]) => `${role} ${block}`).join(", ");
  return { status: "done", detail: `improved ${what}: ${roles.join(", ")} now ${swapped.join(", ")}${still === "" ? "" : `; still temporary: ${still}`}` };
}

/** What stops {@link buildParts} short, and what it tells the model. */
interface PartsOptions {
  /** Blocks a remade tool must not use up: the house's bill. */
  readonly reserved: readonly MaterialCount[];
  /** Told the part (batch index) to start again from when the work stops before the end, and the cells the runtime refused (none given: the stop was not a refusal). */
  readonly leave: (part: number, refused?: readonly Cell[]) => void;
  /** The cells refused when the house was last left: refused again, the house is given up. */
  readonly refusedBefore?: readonly Cell[];
  /** Ends the failure sentence: how the house is asked again. */
  readonly again: string;
  /** Forgets the unfinished house, when resuming it keeps meeting the same refused cell. */
  readonly abandon?: () => void;
}

/**
 * Sends a planned house to the runtime part by part, twice over: null when every part is built and checked, else the
 * result that ends the step. Shared by `build` and `improve_house`, which send the same cells (the second with other
 * blocks in some roles) and rely on `remove_wrong_blocks` to skip what is right and swap what is not.
 */
async function buildParts(context: SkillContext, plan: HousePlan, what: string, options: PartsOptions): Promise<SkillResult | null> {
  // A resumed house is checked again from its first part: `build_structure` skips the cells already right, and anything
  // dug out since (the doorstep under the door, by the gathering next to it: live 2026-10-01) is put back. The second
  // pass is the final check: anything a later part disturbed is put back before the house counts as built.
  const parts = [...plan.batches, ...plan.batches];
  // Each cell is built with its final intent only: the doorway is listed as air in an early part and as the door in
  // the last one, and checking the parts again must not dig the hung door out (live 2026-10-02).
  const lastPart = new Map<string, number>();
  plan.batches.forEach((batch, part) => batch.forEach((cell) => {
    lastPart.set(`${cell.x},${cell.y},${cell.z}`, part);
    // A door fills the cell above its own too.
    if (cell.block.endsWith("_door")) lastPart.set(`${cell.x},${cell.y + 1},${cell.z}`, part);
  }));
  // A tool worn out mid-build is made again once per kind, and the part is built again (live 2026-10-09: Tom's house
  // stopped at part 1/9, "stone_pickaxe was lost").
  const toolLosses = new ToolLosses();
  for (let index = 0; index < parts.length; index += 1) {
    const partIndex = index % plan.batches.length;
    const blocks = (parts[index] ?? []).filter((cell) => lastPart.get(`${cell.x},${cell.y},${cell.z}`) === partIndex).map(({ x, y, z, block, facing, half, axis }) => ({
      x, y, z, block_name: block,
      ...(facing !== undefined && { facing }),
      ...(half !== undefined && { half }),
      ...(axis !== undefined && { axis }),
    }));
    if (blocks.length === 0) continue;
    const auditing = index >= plan.batches.length;
    const part = auditing ? `final check ${index - plan.batches.length + 1}/${plan.batches.length}` : `part ${index + 1}/${plan.batches.length}`;
    context.progress?.(auditing ? `checking every block of ${what} is right` : `building ${what}, ${part}`);
    // What earlier parts built stays: a route to this part may not dig through it (live 2026-10-01: 11 cells dug).
    const keep = auditing ? [] : builtBefore(plan.batches, index, lastPart);
    const input = { blocks, remove_wrong_blocks: true, ...(keep.length > 0 && { keep }) };
    const outcome = await context.body.act("build_structure", input, `Build ${what}, ${part}.`, { signal: context.signal });
    if (context.signal.aborted) {
      options.leave(Math.min(index, plan.batches.length - 1));
      return { status: "stopped" };
    }
    if (outcome.status !== "succeeded") {
      const lost = await toolLosses.handle(outcome.error, { reserved: options.reserved, inventory: async () => (await context.runtime.status()).inventory, getItems: (items, purpose) => getItems(context, items, purpose) });
      if (lost.status === "remade") {
        index -= 1;
        continue;
      }
      if (lost.status === "stopped" || context.signal.aborted) {
        options.leave(Math.min(index, plan.batches.length - 1));
        return { status: "stopped" };
      }
      const why = lost.status === "refused" || lost.status === "failed" ? `; ${lost.note}` : "";
      // A refusal is read from the audit's structured groups, not from the error text. One refusal may be transient
      // (an animal in the cell, a route that timed out): the house is kept with the refused cells; the same cell
      // refused again on a resume is the one that would be refused for good, so the site is given up.
      const refused = refusedCells(outcome.result);
      options.leave(Math.min(index, plan.batches.length - 1), refused);
      const repeated = options.again !== "" && refused.some((cell) => options.refusedBefore?.some((before) => sameCell(before, cell)) === true);
      if (repeated) options.abandon?.();
      const again = repeated ? "; building here again would be refused at the same cell: build somewhere else, or clear that cell first" : options.again;
      return { status: "failed", detail: `${what} stopped at ${part}: ${outcome.error ?? outcome.status}${auditSuffix(outcome.error, outcome.result)}${why}${again}` };
    }
  }
  return null;
}

type Cell = { readonly x: number; readonly y: number; readonly z: number };

function sameCell(left: Cell, right: Cell): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

/** The part of `build_structure`'s audit that names the cells it left refused (src/actions/build-structure/contract.ts `left`). */
const refusedAuditSchema = z.object({
  structure: z.object({
    left: z.array(z.object({ reason: z.string(), named: z.array(z.object({ x: z.number(), y: z.number(), z: z.number() })) })),
  }),
});

/** The cells a `build_structure` audit says were refused (named ones only: the runtime names a few per reason). */
function refusedCells(result: Readonly<Record<string, unknown>> | undefined): Cell[] {
  const parsed = refusedAuditSchema.safeParse(result);
  if (!parsed.success) return [];
  return parsed.data.structure.left.filter((group) => group.reason === "refused").flatMap((group) => group.named.map(({ x, y, z }) => ({ x, y, z })));
}

/** The non-air cells of the parts before `index`: what a later part's routes must keep. */
function builtBefore(batches: readonly (readonly { x: number; y: number; z: number; block: string }[])[], index: number, lastPart: ReadonlyMap<string, number>): { x: number; y: number; z: number }[] {
  const seen = new Set<string>();
  const cells: { x: number; y: number; z: number }[] = [];
  for (const cell of batches.slice(0, index).flat()) {
    const key = `${cell.x},${cell.y},${cell.z}`;
    // Only what stays as built: a cell a later part changes again (the doorway) is not kept.
    if (cell.block === "air" || seen.has(key) || (lastPart.get(key) ?? -1) >= index) continue;
    seen.add(key);
    cells.push({ x: cell.x, y: cell.y, z: cell.z });
  }
  return cells;
}

/** The player inventory's main slots (hotbar included). */
const INVENTORY_SLOTS = 36;

/** Tools a leveling job replaces when they wear out before it gives up. */
const MAX_TOOLS_LOST = 6;

/** Cobblestone a stone tool of each class takes: with that much carried, the tool is made in stone, else in wood. */
const TOOL_COBBLESTONE: Readonly<Record<string, number>> = { pickaxe: 3, axe: 3, shovel: 1, hoe: 2 };

/**
 * Makes `zone` flat with its walking level at `level` (feet height), the way a player would: carries the right tool
 * for every kind of block to dig (owner, 2026-10-02: "ALWAYS use tools, the corresponding best one available"), fills
 * the liquid above the level, digs from the top down, then fills the holes from the bottom up with what the dig
 * brought, fetching only what is still short (`terrain.ts`).
 */
export async function levelZone(context: SkillContext, zone: Zone, level: number, what: string, options: LevelOptions & { readonly fillWith?: string } = {}, reserved: readonly { readonly item: string; readonly count: number }[] = [], ownRegions: readonly number[] = []): Promise<SkillResult> {
  const { min, max } = levelBox(zone, level);
  // Leveling digs inside her own regions too (it runs as a build): never over an area she protects, her other houses
  // included, except the house being prepared (live 2026-10-02: a zone "between the oak_log markers" reached her house).
  const overlapping = overlapsOf(await context.runtime.protectedRegions(), { min, max }, ownRegions);
  if (overlapping.length > 0) {
    return { status: "failed", detail: `${what} ${describeOverlaps(context, overlapping)}: choose another zone clear of ${overlapping.length === 1 ? "it" : "them"}, or ask whoever asked you` };
  }
  // Her own region while she works, with a margin: fill is dug a safe distance away, never at the zone's edge or
  // under it (owner, 2026-10-02: she dug right below the zone she was leveling). A house site gets it too.
  const margin = await context.runtime.protectRegion({
    min: { x: min.x - FILL_MARGIN, y: level - FILL_MARGIN_BELOW, z: min.z - FILL_MARGIN },
    max: { x: max.x + FILL_MARGIN, y: max.y, z: max.z + FILL_MARGIN },
    label: `${LEVELING_LABEL}${zone.maxX - zone.minX + 1}x${zone.maxZ - zone.minZ + 1}`,
    reason: "Keep my own digging for fill away from the zone I am leveling.",
  });
  if (margin.status === "failed") return { status: "failed", detail: `could not set the zone aside: ${margin.error}` };
  noteArea(context, margin.area);
  try {
    return await levelInside(context, zone, level, what, options, reserved, { min, max });
  } finally {
    await releaseArea(context, margin.area.regionId);
  }
}

/** {@link levelZone}'s work, once the zone and its margin are set aside. */
async function levelInside(context: SkillContext, zone: Zone, level: number, what: string, options: LevelOptions & { readonly fillWith?: string }, reserved: readonly { readonly item: string; readonly count: number }[], { min, max }: ReturnType<typeof levelBox>): Promise<SkillResult> {
  // One column past the zone on every side: what a layer can be placed against, and the ground around it (a pit's walls).
  const read = (below: number) => context.runtime.blocksIn({ x: min.x - 1, y: min.y - below, z: min.z - 1 }, { x: max.x + 1, y: max.y, z: max.z + 1 });
  const inventory = (await context.runtime.status()).inventory;
  // What it may spend: never the blocks reserved for what comes next (the house's own cobblestone).
  const spareIn = (stacks: typeof inventory) => (item: string) =>
    stacks.filter((stack) => stack.name === item).reduce((sum, stack) => sum + stack.count, 0) - (reserved.find((entry) => entry.item === item)?.count ?? 0);
  const spare = spareIn(inventory);
  // Dirt is the fill: quick to dig with a shovel and everywhere. Cobblestone only when enough of it is spare already;
  // fetching it means mining stone (live 2026-10-02: a 42-block fill sent her mining for half an hour).
  // A fill the request names (owner, 2026-10-02: "tell her with what materials to fill") is always used.
  const fillFor = (count: number, has: (item: string) => number) =>
    options.fillWith ?? (has("cobblestone") >= count && has("cobblestone") > has("dirt") ? "cobblestone" : "dirt");
  const cells = (batches: readonly (readonly TerrainCell[])[]) => batches.reduce((sum, batch) => sum + batch.length, 0);
  const planFor = (area: Awaited<ReturnType<typeof read>>) => levelPlan(zone, level, area, fillFor(cells(levelPlan(zone, level, area, "dirt", options).phases.fillFirst), spare), options);
  let area = await read(0);
  let plan = planFor(area);
  if (plan.floating) {
    // A platform in the air: the ground to build its support column from is further down than the zone's own layers.
    area = await read(SUPPORT_REACH);
    plan = planFor(area);
    if (plan.floating) return { status: "failed", detail: `leveling ${what} would build a platform in the air with no solid ground within ${SUPPORT_REACH} blocks under it: choose a nearer height` };
  }
  if (plan.batches.length === 0) return { status: "done", detail: `${what} is already level` };
  const moved = plan.dug + plan.filled;
  // A pit is told whatever the count (run 13: a cellar dug by repeated small levels passed silently under the budget).
  const pitNote = plan.pit > 0 ? ` (this digs a pit ${plan.pit} deep)` : "";
  if (options.budget !== undefined && moved > options.budget) {
    // Counted before the first block goes (run 12: a 25x25 level dug 1324 blocks; a cellar dug by repeated levels).
    const perColumn = new Map<string, number>();
    for (const cell of plan.phases.dig.flat()) perColumn.set(`${cell.x},${cell.z}`, (perColumn.get(`${cell.x},${cell.z}`) ?? 0) + 1);
    const deepest = Math.max(0, ...perColumn.values());
    return { status: "failed", detail: `leveling ${what} means moving ${moved} blocks (${plan.dug} to dig, ${plan.filled} to fill), up to ${deepest} deep${pitNote}; at most ${options.budget} blocks are moved at a time: ask for a smaller area or a nearer height` };
  }
  // The tool of each class the dig needs and it does not carry: stone when it has the cobblestone, else wood.
  const toolsMissing = (stacks: typeof inventory) => {
    const has = spareIn(stacks);
    return plan.tools
      .filter((tool) => !stacks.some((stack) => stack.name.endsWith(`_${tool}`)))
      .map((tool) => ({ item: has("cobblestone") >= (TOOL_COBBLESTONE[tool] ?? 3) ? `stone_${tool}` : `wooden_${tool}`, count: 1 }));
  };
  // The tool classes (game data: what each block is mined with) of the cells these batches dig clear.
  const toolsDug = (batches: readonly (readonly TerrainCell[])[]) =>
    new Set(batches.flat().filter((cell) => cell.block === "air").map((cell) => area.kinds[area.blocks.get(areaKey(cell.x, cell.y, cell.z)) ?? ""]?.tool).filter((tool) => tool !== null && tool !== undefined));
  const needs = toolsMissing(inventory);
  const first = cells(plan.phases.fillFirst);
  const firstFill = plan.phases.fillFirst[0]?.[0]?.block;
  if (firstFill !== undefined && spare(firstFill) < first) needs.push({ item: firstFill, count: first - Math.max(0, spare(firstFill)) });
  if (needs.length > 0) {
    const got = await getItems(context, needs, `the tools${firstFill === undefined ? "" : " and fill"} to level ${what}`);
    if (got.status !== "done") return got;
  }
  // Cells it may not touch (someone's crafting table, a block under water) are left and leveled around, as a player
  // would (live 2026-10-02: one table on a treetop stopped a whole site); anything else stops the job.
  let left = 0;
  let done = 0;
  let toolsLost = 0;
  const run = async (batches: readonly (readonly TerrainCell[])[]): Promise<SkillResult | null> => {
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index]!;
      done += 1;
      const blocks = batch.map(({ x, y, z, block }: TerrainCell) => ({ x, y, z, block_name: block }));
      const outcome = await context.body.act("build_structure", { blocks, remove_wrong_blocks: true }, `Level ${what}, ${done}/${plan.batches.length}.`, { signal: context.signal });
      if (context.signal.aborted) return { status: "stopped" };
      if (outcome.status === "succeeded") continue;
      // A tool worn out on the way is replaced and the batch done again, as a player crafts another shovel (live
      // 2026-10-02: a worn stone axe, then the shovel, each ended the whole job).
      if (errorCode(outcome.error) === "TOOL_TIER_LOST" && toolsLost < MAX_TOOLS_LOST) {
        toolsLost += 1;
        // Only for the digging still to do (this batch is done again): a tool that breaks with none left is not made again.
        const digging = toolsDug(batches.slice(index));
        const replace = toolsMissing((await context.runtime.status()).inventory).filter(({ item }) => [...digging].some((kind) => item.endsWith(`_${kind}`)));
        if (replace.length > 0) {
          const got = await getItems(context, replace, `a new tool to go on leveling ${what} (one wore out)`);
          if (got.status !== "done") return got;
        }
        done -= 1;
        index -= 1;
        continue;
      }
      const refused = /^\[BUILD_INCOMPLETE\] (\d+) cells? still wrong: \1 were refused/u.exec(outcome.error ?? "");
      if (refused !== null) {
        left += Number(refused[1]);
        continue;
      }
      return { status: "failed", detail: `leveling stopped at ${done}/${plan.batches.length}: ${outcome.error ?? outcome.status}${auditSuffix(outcome.error, outcome.result)}` };
    }
    return null;
  };
  context.progress?.(`leveling ${what}: ${plan.dug > 0 ? "digging what stands above it" : "filling it"}`);
  const dug = await run([...plan.phases.fillFirst, ...plan.phases.dig]);
  if (dug !== null) return dug;
  // The holes, with what the dig brought; only the rest is fetched.
  const holes = cells(plan.phases.fillAfter);
  if (holes > 0) {
    const has = spareIn((await context.runtime.status()).inventory);
    const fill = fillFor(holes, has);
    if (has(fill) < holes) {
      const got = await getItems(context, [{ item: fill, count: holes - Math.max(0, has(fill)) }], `filling the holes of ${what}`);
      if (got.status !== "done") return got;
    }
    context.progress?.(`filling the ${holes} holes of ${what} with ${fill}`);
    const filled = await run(plan.phases.fillAfter.map((batch) => batch.map((cell) => ({ ...cell, block: fill }))));
    if (filled !== null) return filled;
  }
  const around = left === 0 ? "" : ` (left ${left} cell${left === 1 ? "" : "s"} it may not dig, leveled around)`;
  const column = plan.support === 0 ? "" : ` (${plan.support} of them a support column up from the ground)`;
  return { status: "done", detail: `leveled ${what}: dug ${plan.dug - left}, filled ${plan.filled}${column}${around}${pitNote}` };
}

/** The part of `build_structure`'s audit the skill reports (src/actions/build-structure/contract.ts). */
const structureAuditSchema = z.object({
  structure: z.object({
    placed: z.number(),
    dug: z.number(),
    left: z.array(z.object({ reason: z.string(), count: z.number() })),
    missing: z.array(z.object({ block: z.string(), count: z.number() })),
  }),
});

/**
 * Why cells were left, for the planner: `[BUILD_INCOMPLETE]` errors already list it, but `[BUILD_STOPPED]` and
 * tool-loss errors do not.
 */
function auditSuffix(error: string | null, result: Readonly<Record<string, unknown>> | undefined): string {
  if (errorCode(error) === "BUILD_INCOMPLETE") return "";
  const parsed = structureAuditSchema.safeParse(result);
  if (!parsed.success) return "";
  const { placed, dug, left, missing } = parsed.data.structure;
  const parts = [`placed ${placed}, dug ${dug}`];
  if (left.length > 0) parts.push(`left ${left.map((group) => `${group.count} ${group.reason}`).join(", ")}`);
  if (missing.length > 0) parts.push(`short of ${missing.map((entry) => `${entry.count} ${entry.block}`).join(", ")}`);
  return ` (${parts.join("; ")})`;
}

/** The label of the region a leveling job sets aside while it works (left behind only if the job was killed). */
const LEVELING_LABEL = "leveling ";
/** How far away marker blocks are looked for. */
const MARKER_RANGE = 48;
/** Blocks around a leveling zone where she never digs her fill, and how deep under its level. */
const FILL_MARGIN = 4;
const FILL_MARGIN_BELOW = 8;
/** The most marker blocks a zone has: its corners. */
const MAX_MARKERS = 4;

/**
 * Levels a zone on request (owner, 2026-10-02): between the players' marker blocks, around a player, or between
 * corners. Her own region while she works, so fetching fill dirt never digs into it (ADR-012).
 */
async function levelArea(context: SkillContext, step: Extract<Step, { skill: "level_area" }>): Promise<SkillResult> {
  const snapshot = await context.runtime.status();
  let zone: Zone;
  let level = step.y;
  const keep = new Set<string>();
  if (step.markers !== undefined) {
    const here = snapshot.position;
    const nearest = await context.runtime.findBlocks(step.markers, MAX_MARKERS);
    const found = nearest.filter((at) => distanceBetween(at, here) <= MARKER_RANGE);
    if (found.length < 2) {
      // Where the farther ones are, so the next step can walk there (live 2026-10-02: 66 blocks away after her own
      // goal, she went to her own position six times).
      const farther = nearest.filter((at) => distanceBetween(at, here) > MARKER_RANGE).slice(0, 2);
      const hint = farther.length === 0 ? "" : `; the nearest farther ones are at ${farther.map((at) => `${at.x} ${at.y} ${at.z}`).join(" and ")}: go near them first`;
      return { status: "failed", detail: `found ${found.length === 0 ? "no" : "only one"} ${step.markers} within ${MARKER_RANGE} blocks: the zone needs two corners${hint}` };
    }
    zone = { minX: Math.min(...found.map((at) => at.x)), maxX: Math.max(...found.map((at) => at.x)), minZ: Math.min(...found.map((at) => at.z)), maxZ: Math.max(...found.map((at) => at.z)) };
    for (const at of found) keep.add(`${at.x},${at.y},${at.z}`);
    level ??= Math.min(...found.map((at) => at.y));
  } else if (step.around !== undefined) {
    // The first look fixes the place for the whole objective (the player may walk or fly away between two steps).
    const fixed = context.levelSites?.get(step.around.toLowerCase());
    const seen = fixed ?? whereIs(snapshot, step.around, context.self);
    if (seen === null) return { status: "failed", detail: `cannot see ${step.around} to level the ground around them` };
    const site = { x: Math.floor(seen.x), y: Math.floor(seen.y), z: Math.floor(seen.z) };
    if (fixed === undefined) context.levelSites?.set(step.around.toLowerCase(), site);
    zone = { minX: site.x - step.radius, maxX: site.x + step.radius, minZ: site.z - step.radius, maxZ: site.z + step.radius };
    level ??= site.y;
  } else if (step.x1 !== undefined && step.z1 !== undefined && step.x2 !== undefined && step.z2 !== undefined) {
    zone = { minX: Math.min(step.x1, step.x2), maxX: Math.max(step.x1, step.x2), minZ: Math.min(step.z1, step.z2), maxZ: Math.max(step.z1, step.z2) };
  } else {
    return { status: "failed", detail: "level_area needs markers, a player to level around, or x1, z1, x2, z2 corners" };
  }
  if (level === undefined) return { status: "failed", detail: "level_area with corners needs the walking level y" };
  const [width, depth] = [zone.maxX - zone.minX + 1, zone.maxZ - zone.minZ + 1];
  if (width > LEVEL_LIMITS.side || depth > LEVEL_LIMITS.side) return { status: "failed", detail: `the zone is ${width} by ${depth}: at most ${LEVEL_LIMITS.side} by ${LEVEL_LIMITS.side} at a time` };
  // One layer under the level: a flat floor, bridged over a pond or a ravine, not columns hanging into it (owner,
  // 2026-10-02: "a flat platform of 1 level").
  return levelZone(context, zone, level, `${width}x${depth} at y ${level}`, { keep, below: 1, budget: LEVEL_BLOCK_BUDGET, ...(step.fill !== undefined && { fillWith: step.fill }) });
}

/** Keeps the character's own digging and scaffolding out of an area (ADR-012); its own choice, e.g. when asked. */
async function protectArea(context: SkillContext, step: Extract<Step, { skill: "protect_area" }>): Promise<SkillResult> {
  let centre: Position;
  if (step.player !== undefined) {
    const seen = whereIs(await context.runtime.status(), step.player, context.self);
    if (seen === null) return { status: "failed", detail: `cannot see ${step.player} to protect the area around them` };
    centre = seen;
  } else if (step.x !== undefined && step.y !== undefined && step.z !== undefined) {
    centre = { x: step.x, y: step.y, z: step.z };
  } else {
    // Neither a player nor coordinates: where she stands (live 2026-10-11: "protect the area around you" came as the
    // speaker's name four times).
    centre = (await context.runtime.status()).position;
  }
  const c = { x: Math.floor(centre.x), y: Math.floor(centre.y), z: Math.floor(centre.z) };
  const r = step.radius;
  const outcome = await context.runtime.protectRegion({
    min: { x: c.x - r, y: c.y - r, z: c.z - r },
    max: { x: c.x + r, y: c.y + r, z: c.z + r },
    label: step.label,
    reason: `I chose to protect ${step.label}.`,
    ...(step.player !== undefined && !isSelf(step.player, context.self) && { owner: step.player }),
  });
  if (outcome.status === "failed") return { status: "failed", detail: outcome.error };
  noteArea(context, outcome.area);
  return {
    status: "done",
    detail: `protected area #${outcome.area.regionId} '${outcome.area.label}' (${2 * r + 1} blocks across around ${c.x} ${c.y} ${c.z}): I will not dig or place blocks there`,
  };
}

export async function releaseArea(context: SkillContext, regionId: number): Promise<SkillResult> {
  const outcome = await context.runtime.unprotectRegion(regionId);
  if (outcome.status === "failed") return { status: "failed", detail: outcome.error };
  const index = context.areas?.findIndex((area) => area.regionId === regionId) ?? -1;
  if (index !== -1) context.areas?.splice(index, 1);
  return { status: "done", detail: `released area #${regionId}: I may dig and place blocks there again` };
}

/**
 * A house's protected box: its cells, a one-block ring around them and the layer under them, so gathering beside it
 * cannot undermine a wall or take the doorstep (live 2026-10-01: dirt dug under Tom's doorway).
 */
export function houseBox(cells: readonly Position[]): { readonly min: Position; readonly max: Position } {
  const xs = cells.map((cell) => cell.x);
  const ys = cells.map((cell) => cell.y);
  const zs = cells.map((cell) => cell.z);
  return {
    min: { x: Math.min(...xs) - 1, y: Math.min(...ys) - 1, z: Math.min(...zs) - 1 },
    max: { x: Math.max(...xs) + 1, y: Math.max(...ys), z: Math.max(...zs) + 1 },
  };
}

/**
 * One leg of an exploring walk: within loaded ground, so `navigate` sees the surface (and the water) it goes to; a
 * leg of 32 blocks made the walk a stream of 2-chunk hops she could see past (owner, live 2026-10-07).
 */
const EXPLORE_LEG = 96;
/** A leg that ends over known water is shortened to this, so the land before the shore is still walked. */
const SHORE_LEG = 32;
/** Above this share of water in the explored ground of the next leg, the walk does not go on. */
const MOSTLY_WATER = 0.5;
/** How far ahead unseen land is looked for, along each way. */
const EXPLORE_REACH = 512;
/**
 * How far around her she sees, in blocks: chunks within it are already in her map from where she stands (the server's
 * view distance, 10 chunks, less a margin), so the walk to new land stops this short of it.
 */
const SIGHT = 128;
/** The longest walk one explore step makes. */
const EXPLORE_MAX_WALK = 384;
/**
 * The entity registry that tells a creature's name from anything else: the newest one minecraft-data ships. The brain
 * is not told the server's version, and creature names stay the same across versions (new ones are only added).
 */
const ENTITY_REGISTRY_VERSION = (minecraftData as unknown as { readonly supportedVersions: { readonly pc: readonly string[] } }).supportedVersions.pc.at(-1) ?? "";
/** minecraft-data's entity types of the creatures that live in the world (the types `view_status` lists as mobs). */
const CREATURE_TYPES: ReadonlySet<string> = new Set(["animal", "passive", "water_creature", "ambient", "hostile", "mob"]);
/** What explore says after a creature it found: the way to what it drops. */
const CREATURE_TAIL = "get_items what you want from it hunts it there";

/** Whether `name` is a creature of the game (sheep, pig, zombie), by the entity registry. */
function isCreature(name: string): boolean {
  const entities = (minecraftData(ENTITY_REGISTRY_VERSION) as unknown as { readonly entitiesByName?: Readonly<Record<string, { readonly type?: string } | undefined>> } | undefined)?.entitiesByName;
  const type = entities?.[name]?.type;
  return type !== undefined && CREATURE_TYPES.has(type);
}

/** Where the nearest loaded creature of a kind is, from `from`: the way and distance when its position is known. */
function creatureWhere(from: Position, mob: BotSnapshot["mobs"][number]): string {
  return mob.position === undefined
    ? `${Math.round(mob.distance)} blocks away`
    : `${describeWay(from, mob.position)}, around ${Math.floor(mob.position.x)} ${Math.floor(mob.position.z)}`;
}

/**
 * Walks one compass way, `chunks` x 16 blocks from where she stands, in legs of {@link EXPLORE_LEG} blocks (`navigate`
 * to the ground there, which moves a target on water to the nearest shore or refuses it), then says where she ended,
 * what water she crossed and, asked `for` a block, where the nearest one is; it stops early once that block is within
 * fetching range (spec 2026-10-03 explore-skill). It does not set off over ground she knows to be mostly water.
 * Live 2026-10-04: the runtime's `explore_frontier` walked to the edge of all she had ever explored that way first,
 * 400 blocks north over water for "3 chunks".
 */
async function explore(context: SkillContext, step: Extract<Step, { skill: "explore" }>, why: string): Promise<SkillResult> {
  // A block or a creature is seen on the way, nothing else (live 2026-10-07: explore for "water_source", "deep_water",
  // "raw_iron"; live 2026-10-09, 10 bots: "sheep", "zombie", "pig" in four of them, so a creature is walked toward and
  // looked for among the loaded mobs after each leg).
  const kinds = step.for === undefined ? null : await context.runtime.blockKinds([step.for]).catch(() => null);
  const notBlock = step.for !== undefined && kinds !== null && kinds[step.for] === undefined;
  const creature = notBlock && step.for !== undefined && isCreature(step.for) ? step.for : undefined;
  if (notBlock && creature === undefined) {
    const from = step.for === undefined ? null : await dropSourcesNote(context.runtime, step.for);
    return { status: "failed", detail: `${step.for} is not a block${from === null ? "" : ` (${from}: get_items ${step.for} breaks them)`}: explore looks for a block by its Minecraft name; get_items gets an item. To find animals or monsters, explore without "for": the new land you reach shows what lives there, and get_items gets what they drop (white_wool from sheep, porkchop from pigs)` };
  }
  // Ores lie underground nearly everywhere and the map leaves the common ones out: walking the surface finds none
  // (live 2026-10-07: Vex explored for iron_ore with 256 of it loaded around him, only short of a stone pickaxe).
  const block = creature === undefined ? step.for : undefined;
  if (block !== undefined && /_ore$/u.test(block)) {
    const drops: Readonly<Record<string, readonly string[]>> = await context.runtime.blockDrops([block]).catch(() => ({}));
    const drop = drops[block]?.[0] ?? block;
    return { status: "failed", detail: `${block} lies underground nearly everywhere, and walking the surface does not find it: get_items ${drop} digs for it near where you are (making the pickaxe it needs)` };
  }
  // What is crafted is not found (live 2026-10-07: Ayla explored for a crafting_table, four ways in a row). A smelted
  // block may also lie about (stone: live, Vex explored for it and was wrongly told it is only smelted).
  const made = block === undefined ? null : (await obtainedBy(context.runtime, block).catch(() => null))?.way;
  if (made === "craft") {
    return { status: "failed", detail: `${block} is crafted, not found: get_items ${block} makes it` };
  }
  const setOut = await context.runtime.status();
  const start = setOut.position;
  // A creature already loaded needs no walk: it is hunted where it stands.
  const loaded = creature === undefined ? undefined : setOut.mobs.find((mob) => mob.name === creature);
  if (creature !== undefined && loaded !== undefined) {
    return { status: "done", detail: `${creature} already in sight, ${creatureWhere(start, loaded)}: ${CREATURE_TAIL}` };
  }
  // A block she already knows of is named in the result, with get_items to fetch it (live 2026-10-07: Ayla explored
  // "for spruce_log" some forty times while she knew of spruce 169 blocks away). The walk still goes: stopping it there
  // made both bots ask for the same explore again and again, each one walking nowhere (live 2026-10-07, free time).
  const knownBefore = block === undefined
    ? undefined
    : (await nearestFree(context, block)) ?? (await knownPlaces(context.runtime, block, start))[0];
  // A refused walk names what she already knows of it (live 2026-10-07: Ayla tried explore for oak_log six ways in a
  // row, all seen or water, while she knew of oak 45 blocks off).
  const knownNote = knownBefore === undefined || block === undefined
    ? ""
    : `; you already know of ${block} ${describeWay(start, knownBefore)}, around ${knownBefore.x} ${knownBefore.z}: get_items ${block} fetches it`;
  // With a boat, water ahead is no reason to stop: the leg goes on to the far side and `navigate` crosses by boat (live
  // 2026-10-04: Vex made a boat to explore south-east, then was refused "water as far as you have seen" again).
  const boat = setOut.inventory.some((stack) => stack.name.endsWith("_boat") || stack.name.endsWith("_raft"));
  const radians = (COMPASS_HEADINGS[step.toward] * Math.PI) / 180;
  const [dx, dz] = [Math.sin(radians), -Math.cos(radians)];
  // Land she has seen is not explored again (owner, 2026-10-04: "exploring already known areas has no point"; her
  // houses and protected areas are such land): the walk goes on to where unseen land comes into sight, then `chunks`
  // chunks beyond it.
  const unseen = await context.runtime.unseenAlong(start, { x: start.x + dx * EXPLORE_REACH, z: start.z + dz * EXPLORE_REACH, y: start.y }).catch(() => null);
  if (unseen === null) {
    // Said plainly that the walk itself crosses known land to the unseen (live 2026-10-07: the model tried seen ways
    // again and again, as if it had to be at the edge first).
    const { near } = await unseenWayList(context, start);
    const detail = near.length > 0
      ? `${step.toward} is land you have seen as far as ${EXPLORE_REACH} blocks. Unseen land lies ${near.join(", ")}: explore one of those ways; the walk crosses the land you know to get there (up to ${EXPLORE_MAX_WALK} blocks a step)`
      : `every way from here is land you have seen as far as ${EXPLORE_REACH} blocks: go_to a place farther than that first, then explore from there`;
    return { status: "failed", detail: `${detail}${knownNote}` };
  }
  // A way already sailed from near here without finding land is not sailed again (live 2026-10-04: Vex rode 450
  // blocks of sea out and back nine times, from the same base, north, north-west, north-east and north again).
  const sailed = openSeaWays(context.runtime).find((sea) => sea.toward === step.toward && Math.hypot(sea.from.x - start.x, sea.from.z - start.z) <= OPEN_SEA_NEAR);
  if (sailed !== undefined) {
    return { status: "failed", detail: `${step.toward} from here is open sea: you sailed it and found no land within ${sailed.blocks} blocks: explore another way (${await unseenWays(context, start)})` };
  }
  const known = Math.max(0, unseen - SIGHT);
  const total = Math.min(EXPLORE_MAX_WALK, known + step.chunks * 16);
  context.progress?.(`exploring ${step.toward}${step.for === undefined ? "" : ` for ${step.for}`}`);
  let here = start;
  let stop: string | null = null;
  let found: FoundBlock | undefined;
  let sighted: { readonly mob: BotSnapshot["mobs"][number]; readonly from: Position } | undefined;
  for (let walked = 0; walked < total;) {
    let leg = Math.min(EXPLORE_LEG, total - walked);
    let target = { x: Math.floor(here.x) + Math.round(dx * leg), y: here.y, z: Math.floor(here.z) + Math.round(dz * leg) };
    let water = await context.runtime.waterAlong(here, target).catch(() => null);
    while (!boat && water !== null && water.share > MOSTLY_WATER && leg > SHORE_LEG) {
      leg = SHORE_LEG;
      target = { x: Math.floor(here.x) + Math.round(dx * leg), y: here.y, z: Math.floor(here.z) + Math.round(dz * leg) };
      water = await context.runtime.waterAlong(here, target).catch(() => null);
    }
    if (water !== null && water.share > MOSTLY_WATER && boat) {
      leg = total - walked;
      target = { x: Math.floor(here.x) + Math.round(dx * leg), y: here.y, z: Math.floor(here.z) + Math.round(dz * leg) };
    } else if (water !== null && water.share > MOSTLY_WATER) {
      const ahead = `${step.toward} is water as far as you have seen (${Math.round(water.share * 100)}% of the next ${water.chunks} chunk${water.chunks === 1 ? "" : "s"})`;
      if (walked > 0) {
        stop = ahead;
        break;
      }
      // Already out at sea, every way may be water: the way back to land is what helps (live 2026-10-04: Vex, 104
      // blocks out over water, was refused all eight ways, fifteen steps in a row). Her own chunk: a line ending where
      // she stands counts it (the start of a line never does).
      const atSea = await context.runtime.waterAlong({ x: start.x - 16, y: start.y, z: start.z }, start).catch(() => null);
      if (atSea !== null && atSea.share > MOSTLY_WATER && await onWater(context.runtime, start)) {
        const land = await context.runtime.nearestLand(start).catch(() => null);
        const back = land === null ? "you know of no land near" : `the nearest land you have seen is ${describeWay(start, land)}, around ${land.x} ${Math.floor(start.y)} ${land.z}: go_to there first`;
        return { status: "failed", detail: `you are out on the water, and ${ahead}; ${back}` };
      }
      // Unseen land may lie only across water (live 2026-10-07: every way from Ayla's coast was seen or water, and she
      // tried them all, twice, with no boat): a boat is the way on.
      return { status: "failed", detail: `${ahead}: explore another way, carry a boat to cross it, or say so${knownNote}` };
    }
    // Caves under the ground and trees over it make the column ambiguous: the walk is to the ground nearest her own
    // height (live 2026-10-04: "observed standable feet heights: 70, -19, -47"; live 2026-10-07: the highest was a canopy).
    const outcome = await context.body.act("navigate", { x: target.x, z: target.z, near_y: Math.floor(here.y), range: 4 }, why, { signal: context.signal });
    if (context.signal.aborted) return { status: "stopped" };
    const before = here;
    const after = await context.runtime.status();
    here = after.position;
    // A creature loaded by this leg ends the walk, whatever else the leg did.
    const mob = creature === undefined ? undefined : after.mobs.find((candidate) => candidate.name === creature);
    if (mob !== undefined) {
      sighted = { mob, from: here };
      break;
    }
    if (outcome.status !== "succeeded") {
      stop = outcome.error ?? `navigate ${outcome.status}`;
      break;
    }
    walked += leg;
    if (Math.hypot(here.x - before.x, here.z - before.z) < 4) {
      stop = "the way ahead did not take her any farther";
      break;
    }
    if (block !== undefined) {
      const nearest = await nearestFree(context, block);
      if (nearest !== undefined && Math.hypot(nearest.x - here.x, nearest.z - here.z) <= FETCH_RANGE) {
        found = nearest;
        break;
      }
    }
  }
  const crossed = await context.runtime.waterAlong(start, here).catch(() => null);
  const parts = [
    `now ${describeWay(start, here)} from where you started, at ${Math.floor(here.x)} ${Math.floor(here.y)} ${Math.floor(here.z)}`,
    ...(crossed === null || crossed.share === 0 ? [] : [`${Math.round(crossed.share * 100)}% of the ground crossed was water`]),
  ];
  if (creature !== undefined) {
    parts.push(sighted === undefined ? `no ${creature} seen on the way` : `found ${creature} ${creatureWhere(sighted.from, sighted.mob)}: ${CREATURE_TAIL}`);
  } else if (block !== undefined) {
    const nearest = found ?? await nearestFree(context, block);
    const known = nearest ?? knownBefore;
    parts.push(known === undefined
      ? `no ${block} seen on the way`
      : `the nearest ${block} you know of is ${describeWay(here, known)}, around ${known.x} ${known.z}: get_items ${block} goes there and gathers it`);
  }
  parts.push(`unseen land from here: ${await unseenWays(context, here)}`);
  const noLand = /no land within (\d+) blocks/u.exec(stop ?? "");
  if (noLand !== null) openSeaWays(context.runtime).push({ toward: step.toward, from: { x: start.x, z: start.z }, blocks: Number(noLand[1]) });
  // Done only when the walk went its whole way or found what it was for within reach: a walk that stopped says why,
  // even when the block is in sight farther off (live 2026-10-07: "done" after 0 blocks, forty times).
  if (stop === null || found !== undefined || sighted !== undefined) return { status: "done", detail: `explored ${step.toward}: ${parts.join("; ")}` };
  return { status: "failed", detail: `exploring ${step.toward} stopped (${stop}): ${parts.join("; ")}` };
}

/** How near where a way was sailed without land it counts as the same way. */
const OPEN_SEA_NEAR = 256;

/**
 * Whether she stands in or on water: a mostly-water chunk is not enough (live 2026-10-07: Ayla, on a hill by the sea,
 * was told she was "out on the water").
 */
async function onWater(runtime: BotRuntime, at: Position): Promise<boolean> {
  const x = Math.floor(at.x);
  const y = Math.floor(at.y);
  const z = Math.floor(at.z);
  const area = await runtime.blocksIn({ x, y: y - 1, z }, { x, y, z }).catch(() => null);
  if (area === null) return true;
  const names = [y, y - 1].map((level) => area.blocks.get(areaKey(x, level, z)));
  return names.every((name) => name === undefined) || names.includes("water");
}
/** Ways sailed without finding land, by bot, this run. */
const openSeas = new WeakMap<object, { readonly toward: string; readonly from: { readonly x: number; readonly z: number }; readonly blocks: number }[]>();

function openSeaWays(runtime: object): { readonly toward: string; readonly from: { readonly x: number; readonly z: number }; readonly blocks: number }[] {
  const ways = openSeas.get(runtime) ?? [];
  openSeas.set(runtime, ways);
  return ways;
}

/** "north 180 blocks, east 40 blocks; seen as far as 512 blocks: south, west": how far unseen land is each way. */
async function unseenWays(context: SkillContext, from: Position): Promise<string> {
  const { near, none } = await unseenWayList(context, from);
  return [near.join(", "), none.length === 0 ? "" : `seen as far as ${EXPLORE_REACH} blocks: ${none.join(", ")}`].filter((part) => part !== "").join("; ");
}

/** The ways with unseen land within reach ("north 180 blocks"), nearest first, and those seen all the way. */
async function unseenWayList(context: SkillContext, from: Position): Promise<{ readonly near: readonly string[]; readonly none: readonly string[] }> {
  const near: string[] = [];
  const none: string[] = [];
  const ways = await Promise.all(Object.entries(COMPASS_HEADINGS).map(async ([way, degrees]) => {
    const radians = (degrees * Math.PI) / 180;
    const to = { x: from.x + Math.sin(radians) * EXPLORE_REACH, y: from.y, z: from.z - Math.cos(radians) * EXPLORE_REACH };
    return [way, await context.runtime.unseenAlong(from, to).catch(() => null)] as const;
  }));
  for (const [way, distance] of [...ways].sort((a, b) => (a[1] ?? Infinity) - (b[1] ?? Infinity))) {
    if (distance === null) none.push(way);
    else near.push(`${way} ${distance} blocks`);
  }
  return { near, none };
}

/** How many of the nearest blocks of a name are looked through for one outside every protected area. */
const FREE_SCAN = 64;

/**
 * The nearest block of this name outside every protected area: one she may take (live 2026-10-04: "the nearest
 * oak_log is 22 blocks" was a wall of her own house; all 48 logs near were, and she walked to them for 40 steps).
 */
async function nearestFree(context: SkillContext, name: string): Promise<FoundBlock | undefined> {
  const areas = context.areas ?? [];
  const inside = (block: FoundBlock) => areas.some((area) =>
    block.x >= area.min.x && block.x <= area.max.x && block.y >= area.min.y && block.y <= area.max.y && block.z >= area.min.z && block.z <= area.max.z);
  return (await context.runtime.findBlocks(name, FREE_SCAN)).find((block) => !inside(block));
}

/** How far around a refused house site the nearest clear one is looked for. */
export const SITE_SEARCH = 32;

/** Protected areas a box overlaps, her leveling margins and `except` (the region of the work itself) left out. */
export function overlapsOf(areas: readonly ProtectedArea[], { min, max }: { readonly min: Position; readonly max: Position }, except: readonly number[] = []): ProtectedArea[] {
  return areas.filter((area) =>
    !except.includes(area.regionId) && !area.label.startsWith(LEVELING_LABEL) &&
    area.min.x <= max.x && area.max.x >= min.x && area.min.y <= max.y && area.max.y >= min.y && area.min.z <= max.z && area.max.z >= min.z);
}

/**
 * "overlaps protected area #4 'small medieval house' (yours: leveling would dig it up)": what each area is, so the
 * model weighs it (live 2026-10-02: told only "release it first", she released Tom's area and then her own house to
 * level around Tom, and began digging the house).
 */
export function describeOverlaps(context: SkillContext, overlapping: readonly ProtectedArea[]): string {
  const whose = (area: ProtectedArea) => area.owner === context.self ? "yours: leveling would dig it up" : `owned by ${area.owner}`;
  return `overlaps protected area${overlapping.length === 1 ? "" : "s"} ${overlapping.map((area) => `#${area.regionId} '${area.label}' (${whose(area)})`).join(", ")}`;
}

/**
 * Her own earlier protections of this same house: a region of hers, with its label, around its door (live 2026-10-04:
 * resuming her unfinished house, its site was refused for overlapping #12, the same house protected before with a
 * slightly different box). Read from the runtime, not from what this session learnt: after a restart the old box is
 * still there, and it is hers all the same.
 */
function earlierProtections(context: SkillContext, label: string, door: Position, current: number, areas: readonly ProtectedArea[]): number[] {
  return areas.filter((area) =>
    area.regionId !== current && area.owner === context.self && area.label === label &&
    door.x >= area.min.x - 1 && door.x <= area.max.x + 1 && door.z >= area.min.z - 1 && door.z <= area.max.z + 1,
  ).map((area) => area.regionId);
}

/** Everything a new house touches: its protected box and the box its site leveling digs and fills. */
function siteBox(plan: ReturnType<typeof planHouse>): { readonly min: Position; readonly max: Position } {
  const house = houseBox(plan.batches.flat());
  const level = levelBox({ minX: house.min.x, maxX: house.max.x, minZ: house.min.z, maxZ: house.max.z }, plan.site.door.y);
  return {
    min: { x: house.min.x, y: Math.min(house.min.y, level.min.y), z: house.min.z },
    max: { x: house.max.x, y: Math.max(house.max.y, level.max.y), z: house.max.z },
  };
}

/**
 * The door of the nearest house site, at the same height, whose house and leveling overlap no protected area, as
 * `build` at those coordinates would plan it (facing whoever it is for); null when none lies within
 * {@link SITE_SEARCH} blocks. Geometry only: the ground there is leveled by the build as usual.
 */
function nearestClearSite(areas: readonly ProtectedArea[], style: ReturnType<typeof styleOrDefault>, size: HouseSize, refused: Site, toward: Position | null): Position | null {
  // One plan per facing, then moved: the box of a door elsewhere is the same box shifted.
  const boxes = new Map<string, { readonly min: Position; readonly max: Position }>();
  const boxFor = (door: Position) => {
    const facing = siteAt(door, toward).facing;
    let box = boxes.get(facing);
    if (box === undefined) {
      box = siteBox(planHouse(style, size, { door: refused.door, facing }));
      boxes.set(facing, box);
    }
    const [dx, dz] = [door.x - refused.door.x, door.z - refused.door.z];
    return { min: { x: box.min.x + dx, y: box.min.y, z: box.min.z + dz }, max: { x: box.max.x + dx, y: box.max.y, z: box.max.z + dz } };
  };
  return nearestClearSpot(areas, refused.door, boxFor);
}

/** How far above and below a suggested site the ground of its column is looked for. */
const GROUND_SEARCH = 16;

/**
 * `door` moved to the walking level of its column: the feet cell over the highest solid block (leaves are not ground)
 * within {@link GROUND_SEARCH} of its height, as the walk to the site needs a cell to stand on (live 2026-10-11: a
 * door suggested at 70 over ground at 66, and the `go to` there failed NAVIGATION_TARGET_UNSUPPORTED). Unchanged when
 * the column shows no ground in that range.
 */
async function groundedDoor(runtime: BotRuntime, door: Position): Promise<Position> {
  const area = await runtime.blocksIn({ x: door.x, y: door.y - GROUND_SEARCH, z: door.z }, { x: door.x, y: door.y + GROUND_SEARCH, z: door.z });
  const solid = (y: number) => {
    const block = area.blocks.get(areaKey(door.x, y, door.z));
    return block !== undefined && !block.endsWith("_leaves") && area.kinds[block]?.solid === true;
  };
  for (let y = door.y + GROUND_SEARCH; y >= door.y - GROUND_SEARCH; y -= 1) {
    if (solid(y)) return { ...door, y: y + 1 };
  }
  return door;
}

/**
 * The spot nearest `origin`, at its height, whose box (`boxAt`) overlaps no protected area, within {@link SITE_SEARCH}
 * blocks; null when none. Shared by houses (their door) and farm plots (their middle).
 */
export function nearestClearSpot(areas: readonly ProtectedArea[], origin: Position, boxAt: (spot: Position) => { readonly min: Position; readonly max: Position }): Position | null {
  for (let ring = 1; ring <= SITE_SEARCH; ring += 1) {
    const spots: Position[] = [];
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dz = -ring; dz <= ring; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) === ring) spots.push({ x: origin.x + dx, y: origin.y, z: origin.z + dz });
      }
    }
    spots.sort((a, b) => Math.hypot(a.x - origin.x, a.z - origin.z) - Math.hypot(b.x - origin.x, b.z - origin.z));
    const clear = spots.find((spot) => overlapsOf(areas, boxAt(spot)).length === 0);
    if (clear !== undefined) return clear;
  }
  return null;
}

export function noteArea(context: SkillContext, area: ProtectedArea): void {
  if (context.areas === undefined) return;
  const index = context.areas.findIndex((known) => known.regionId === area.regionId);
  if (index === -1) context.areas.push(area);
  else context.areas[index] = area;
}

export function findPlayer(snapshot: BotSnapshot, username: string): NearbyPlayer | undefined {
  const wanted = username.toLowerCase();
  return snapshot.players.find((entry) => entry.username.toLowerCase() === wanted);
}

/** Whether a username named in a step is her own. */
function isSelf(username: string, self: string | undefined): boolean {
  return self !== undefined && username.toLowerCase() === self.toLowerCase();
}

/**
 * Where a player named in a step stands; her own name is where she stands (live 2026-10-03: "level 4 blocks around
 * Ayla" failed five times with "cannot see Ayla", the players list holding only the others).
 */
function whereIs(snapshot: BotSnapshot, username: string, self: string | undefined): Position | null {
  if (isSelf(username, self)) return snapshot.position;
  return findPlayer(snapshot, username)?.position ?? null;
}

export function navigateInput(target: Position, range: number): Record<string, unknown> {
  return { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z), range };
}

function distanceBetween(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
