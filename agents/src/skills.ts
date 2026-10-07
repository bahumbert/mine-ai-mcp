import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { Activity } from "./activities.ts";
import { COMPASS_HEADINGS, describeStep, dropEntries, type Step } from "./actions.ts";
import { describeMaterials, shortfall } from "./building/blueprint.ts";
import { builderStand, chooseSite, planHouse, siteAt, styleOrDefault, type Site } from "./building/plan.ts";
import type { Body } from "./body.ts";
import { LEVEL_LIMITS, levelBox, levelPlan, type LevelOptions, type TerrainCell, type Zone } from "./building/terrain.ts";
import { describeWay, FETCH_RANGE, gatherMaterials, groundHeight, knownPlaces, notNear, walkToStation } from "./gathering.ts";
import type { HouseSize } from "./building/house.ts";
import type { KnownPlace } from "./mind.ts";
import type { KnownFarm } from "./memory.ts";
import { farm } from "./farming/farm-skill.ts";
import { errorCode, type BotRuntime, type BotSnapshot, type ForegroundTool, type FoundBlock, type NearbyPlayer, type Position, type ProtectedArea } from "./runtime-client.ts";

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
  /** The protected areas the agent knows (ADR-012), updated in place when a skill protects or releases one. */
  readonly areas?: ProtectedArea[];
  /** The character's own username: areas it owns are its own builds. */
  readonly self?: string;
  /** Told what it starts doing now and why, at a skill's phase changes (see {@link GatherContext.progress}). */
  readonly progress?: (fact: string) => void;
  /** Told that the step's work is another activity from now on (the house's site preparation is terraforming). */
  readonly phase?: (activity: Activity) => void;
  /** When the player who asked for this step last said anything (epoch ms); unset for her own goals. */
  readonly heardFrom?: () => number;
  /** The farms it made, as at their last tend; farming near one tends it. */
  readonly farms?: readonly KnownFarm[];
  /** Told about a farm made or tended, to remember it. */
  readonly rememberFarm?: (farm: KnownFarm) => void;
}

export interface UnfinishedHouse {
  readonly kind: string;
  readonly site: Site;
  /** The first part (batch) not yet built. */
  readonly part: number;
  /** False while its site is still to be leveled (an older note has none: its site counts as ready). */
  readonly prepared?: boolean;
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
      case "drop_item": {
        const entries = dropEntries(step);
        const items = entries.map((entry) => ({ item_name: entry.item, ...(entry.count !== undefined && { count: entry.count }) }));
        const what = entries.map((entry) => `${entry.count ?? "all the"} ${entry.item}`).join(", ");
        const dropped = await once(context, "drop_item", { items, allow_equipped: true }, why, `dropped ${what}`);
        // How much room it made is what a drop is for (live 2026-10-02: 30 of 36 panes dropped freed no slot).
        const stacks = (await context.runtime.status()).inventory.length;
        const room = `${Math.max(0, INVENTORY_SLOTS - stacks)} of ${INVENTORY_SLOTS} inventory slots free`;
        return dropped.status === "stopped" ? dropped : { ...dropped, detail: `${dropped.detail}; ${room}` };
      }
      case "craft_item":
        // A table close by is used where it stands; else the runtime sets a carried one down.
        await walkToStation(context, "crafting_table");
        return await once(context, "craft_item", { items: [{ item_name: step.item, count: step.count }] }, why, `crafted ${step.count} ${step.item}`);
      case "get_items": return await getItems(context, step.items);
      case "eat": return await once(context, "eat_food", { food_name: step.food }, why, `ate ${step.food}`);
      case "equip": return await once(context, "equip", { items: [{ item_name: step.item }] }, why, `equipped ${step.item}`);
      case "sleep": return await once(context, "sleep", {}, why, "slept");
      case "hunt":
        return await once(context, "collect_mob_drop", { mob_name: step.mob, drop_name: step.drop, count: step.count }, why, `got ${step.count} ${step.drop} from ${step.mob}`);
      case "level_area": return await levelArea(context, step);
      case "protect_area": return await protectArea(context, step);
      case "release_area": return await releaseArea(context, step.area);
      case "build": return await build(context, step);
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
  const gathered = await gatherMaterials(context, targets, purpose, start, keep);
  if (gathered.status !== "done") return gathered;
  const here = (await context.runtime.status()).position;
  if (Math.hypot(here.x - start.x, here.y - start.y, here.z - start.z) > RETURN_RANGE) {
    const back = await once(context, "navigate", navigateInput(start, GO_TO_RANGE), "Come back to where I started fetching.", "back");
    if (back.status === "stopped") return back;
    if (back.status === "failed") return { status: "failed", detail: `got ${describeMaterials(items)} but could not come back: ${back.detail}` };
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
  const toward = context.requester === undefined ? null : findPlayer(snapshot, context.requester)?.position ?? null;
  const plan = planHouse(style, step.size, resumed?.site ?? (at === null ? chooseSite(snapshot.position, toward) : siteAt(at, toward)));
  if (resumed === null) {
    // A new site clear of every protected area before anything is protected or dug, and if not, where the nearest
    // clear one is (live 2026-10-03: told only "choose another zone clear of it", she stepped one block at a time,
    // and each refused start left its site protected for good: 16 house boxes, most of them never built).
    const areas = await context.runtime.protectedRegions();
    const blocked = overlapsOf(areas, siteBox(plan));
    if (blocked.length > 0) {
      const clear = nearestClearSite(areas, style, step.size, plan.site, toward);
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
  // Protected before the first block and again on every resume (the runtime keeps one region per box): its own
  // gathering and goals must not dig into the house (ADR-012). The build itself still works inside it.
  const protection = await context.runtime.protectRegion({
    ...houseBox(plan.batches.flat()),
    label: kind,
    reason: `Keep my own digging out of the ${kind} I am building.`,
  });
  if (protection.status === "failed") return { status: "failed", detail: `could not protect the site of ${what}: ${protection.error}` };
  noteArea(context, protection.area);
  const leaveUnfinished = (part: number, prepared = true) => {
    if (context.building !== undefined) context.building.unfinished = { kind, site: plan.site, part, prepared };
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
    }, plan.bill, [protection.area.regionId, ...earlierProtections(context, kind, plan.site.door, protection.area.regionId)]);
    // Nothing of the house stands yet: its site is not kept protected (a resume protects it again).
    if (prepared.status === "stopped" || context.signal.aborted) {
      leaveUnfinished(0, false);
      await releaseArea(context, protection.area.regionId);
      return { status: "stopped" };
    }
    if (prepared.status === "failed") {
      leaveUnfinished(0, false);
      await releaseArea(context, protection.area.regionId);
      return { status: "failed", detail: `could not prepare the site of ${what}: ${prepared.detail}` };
    }
    context.phase?.("building");
  }
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
      leaveUnfinished(Math.min(index, plan.batches.length - 1));
      return { status: "stopped" };
    }
    if (outcome.status !== "succeeded") {
      leaveUnfinished(Math.min(index, plan.batches.length - 1));
      const again = context.building === undefined ? "" : "; building it again resumes it there";
      return { status: "failed", detail: `${what} stopped at ${part}: ${outcome.error ?? outcome.status}${auditSuffix(outcome.error, outcome.result)}${again}` };
    }
  }
  if (context.building !== undefined) context.building.unfinished = null;
  const { door, facing } = plan.site;
  const roof = plan.roofTop;
  context.remember?.({
    name: `the ${kind} you built${context.requester === undefined ? "" : ` for ${context.requester}`}`,
    detail: `door ${door.x} ${door.y} ${door.z} facing ${facing}; stand on its roof at ${roof.x} ${roof.y} ${roof.z}`,
    ...(context.requester === undefined && { own: true }),
  });
  return { status: "done", detail: `built ${what}, door at ${door.x} ${door.y} ${door.z} facing ${facing}` };
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
  const area = await context.runtime.blocksIn(min, max);
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
  const plan = levelPlan(zone, level, area, fillFor(cells(levelPlan(zone, level, area, "dirt", options).phases.fillFirst), spare), options);
  if (plan.batches.length === 0) return { status: "done", detail: `${what} is already level` };
  // The tool of each class the dig needs and it does not carry: stone when it has the cobblestone, else wood.
  const toolsMissing = (stacks: typeof inventory) => {
    const has = spareIn(stacks);
    return plan.tools
      .filter((tool) => !stacks.some((stack) => stack.name.endsWith(`_${tool}`)))
      .map((tool) => ({ item: has("cobblestone") >= (TOOL_COBBLESTONE[tool] ?? 3) ? `stone_${tool}` : `wooden_${tool}`, count: 1 }));
  };
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
        const replace = toolsMissing((await context.runtime.status()).inventory);
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
  return { status: "done", detail: `leveled ${what}: dug ${plan.dug - left}, filled ${plan.filled}${around}` };
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
    const seen = whereIs(snapshot, step.around, context.self);
    if (seen === null) return { status: "failed", detail: `cannot see ${step.around} to level the ground around them` };
    const [x, z] = [Math.floor(seen.x), Math.floor(seen.z)];
    zone = { minX: x - step.radius, maxX: x + step.radius, minZ: z - step.radius, maxZ: z + step.radius };
    level ??= Math.floor(seen.y);
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
  return levelZone(context, zone, level, `${width}x${depth} at y ${level}`, { keep, below: 1, ...(step.fill !== undefined && { fillWith: step.fill }) });
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
    return { status: "failed", detail: "protect_area needs a player or x, y and z" };
  }
  const c = { x: Math.floor(centre.x), y: Math.floor(centre.y), z: Math.floor(centre.z) };
  const r = step.radius;
  const outcome = await context.runtime.protectRegion({
    min: { x: c.x - r, y: c.y - r, z: c.z - r },
    max: { x: c.x + r, y: c.y + r, z: c.z + r },
    label: step.label,
    reason: `I chose to protect ${step.label}.`,
    ...(step.player !== undefined && { owner: step.player }),
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
 * Walks one compass way, `chunks` x 16 blocks from where she stands, in legs of {@link EXPLORE_LEG} blocks (`navigate`
 * to the ground there, which moves a target on water to the nearest shore or refuses it), then says where she ended,
 * what water she crossed and, asked `for` a block, where the nearest one is; it stops early once that block is within
 * fetching range (spec 2026-10-03 explore-skill). It does not set off over ground she knows to be mostly water.
 * Live 2026-10-04: the runtime's `explore_frontier` walked to the edge of all she had ever explored that way first,
 * 400 blocks north over water for "3 chunks".
 */
async function explore(context: SkillContext, step: Extract<Step, { skill: "explore" }>, why: string): Promise<SkillResult> {
  const setOut = await context.runtime.status();
  const start = setOut.position;
  // Exploring is for what she knows of nowhere (live 2026-10-07: Ayla explored "for spruce_log" some forty times while
  // she knew of spruce 169 blocks away; live 2026-10-04: Vex explored three more times after "the nearest dark_oak_log
  // is 37 blocks east"): a known one is fetched, and get_items goes there by itself.
  if (step.for !== undefined) {
    const known = (await nearestFree(context, step.for)) ?? (await knownPlaces(context.runtime, step.for, start))[0];
    if (known !== undefined) {
      return { status: "failed", detail: `you already know of ${step.for} ${describeWay(start, known)}, around ${known.x} ${known.z}: get_items ${step.for} goes there and gathers it (a way across deep water needs a boat); explore only for what you know of nowhere` };
    }
  }
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
    return { status: "failed", detail: `${step.toward} is land you have seen as far as ${EXPLORE_REACH} blocks: explore another way (${await unseenWays(context, start)})` };
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
      if (atSea !== null && atSea.share > MOSTLY_WATER) {
        const land = await context.runtime.nearestLand(start).catch(() => null);
        const back = land === null ? "you know of no land near" : `the nearest land you have seen is ${describeWay(start, land)}, around ${land.x} ${Math.floor(start.y)} ${land.z}: go_to there first`;
        return { status: "failed", detail: `you are out on the water, and ${ahead}; ${back}` };
      }
      return { status: "failed", detail: `${ahead}: explore another way, or say so` };
    }
    let outcome = await context.body.act("navigate", { x: target.x, z: target.z, range: 4 }, why, { signal: context.signal });
    // Caves under the ground and trees over it make the column ambiguous: the walk is to the ground at her own height
    // (live 2026-10-04: "observed standable feet heights: 70, -19, -47"; live 2026-10-07: the highest was a canopy).
    const ground = outcome.status === "succeeded" ? undefined : groundHeight(outcome.error, here.y);
    if (outcome.status !== "succeeded" && !context.signal.aborted && ground !== undefined) {
      outcome = await context.body.act("navigate", { x: target.x, y: ground, z: target.z, range: 4 }, why, { signal: context.signal });
    }
    if (context.signal.aborted) return { status: "stopped" };
    const before = here;
    here = (await context.runtime.status()).position;
    if (outcome.status !== "succeeded") {
      stop = outcome.error ?? `navigate ${outcome.status}`;
      break;
    }
    walked += leg;
    if (Math.hypot(here.x - before.x, here.z - before.z) < 4) {
      stop = "the way ahead did not take her any farther";
      break;
    }
    if (step.for !== undefined) {
      const nearest = await nearestFree(context, step.for);
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
  if (step.for !== undefined) {
    const nearest = found ?? await nearestFree(context, step.for);
    parts.push(nearest === undefined ? `no ${step.for} seen on the way` : `the nearest ${step.for} is ${describeWay(here, nearest)}, at ${nearest.x} ${nearest.y} ${nearest.z}`);
  }
  parts.push(`unseen land from here: ${await unseenWays(context, here)}`);
  const noLand = /no land within (\d+) blocks/u.exec(stop ?? "");
  if (noLand !== null) openSeaWays(context.runtime).push({ toward: step.toward, from: { x: start.x, z: start.z }, blocks: Number(noLand[1]) });
  // Done only when the walk went its whole way or found what it was for within reach: a walk that stopped says why,
  // even when the block is in sight farther off (live 2026-10-07: "done" after 0 blocks, forty times).
  if (stop === null || found !== undefined) return { status: "done", detail: `explored ${step.toward}: ${parts.join("; ")}` };
  return { status: "failed", detail: `exploring ${step.toward} stopped (${stop}): ${parts.join("; ")}` };
}

/** How near where a way was sailed without land it counts as the same way. */
const OPEN_SEA_NEAR = 256;
/** Ways sailed without finding land, by bot, this run. */
const openSeas = new WeakMap<object, { readonly toward: string; readonly from: { readonly x: number; readonly z: number }; readonly blocks: number }[]>();

function openSeaWays(runtime: object): { readonly toward: string; readonly from: { readonly x: number; readonly z: number }; readonly blocks: number }[] {
  const ways = openSeas.get(runtime) ?? [];
  openSeas.set(runtime, ways);
  return ways;
}

/** "north 180 blocks, east 40 blocks; seen as far as 512 blocks: south, west": how far unseen land is each way. */
async function unseenWays(context: SkillContext, from: Position): Promise<string> {
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
  return [near.join(", "), none.length === 0 ? "" : `seen as far as ${EXPLORE_REACH} blocks: ${none.join(", ")}`].filter((part) => part !== "").join("; ");
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
const SITE_SEARCH = 32;

/** Protected areas a box overlaps, her leveling margins and `except` (the region of the work itself) left out. */
function overlapsOf(areas: readonly ProtectedArea[], { min, max }: { readonly min: Position; readonly max: Position }, except: readonly number[] = []): ProtectedArea[] {
  return areas.filter((area) =>
    !except.includes(area.regionId) && !area.label.startsWith(LEVELING_LABEL) &&
    area.min.x <= max.x && area.max.x >= min.x && area.min.y <= max.y && area.max.y >= min.y && area.min.z <= max.z && area.max.z >= min.z);
}

/**
 * "overlaps protected area #4 'small medieval house' (yours: leveling would dig it up)": what each area is, so the
 * model weighs it (live 2026-10-02: told only "release it first", she released Tom's area and then her own house to
 * level around Tom, and began digging the house).
 */
function describeOverlaps(context: SkillContext, overlapping: readonly ProtectedArea[]): string {
  const whose = (area: ProtectedArea) => area.owner === context.self ? "yours: leveling would dig it up" : `owned by ${area.owner}`;
  return `overlaps protected area${overlapping.length === 1 ? "" : "s"} ${overlapping.map((area) => `#${area.regionId} '${area.label}' (${whose(area)})`).join(", ")}`;
}

/**
 * Her own earlier protections of this same house: a region of hers, with its label, around its door (live 2026-10-04:
 * resuming her unfinished house, its site was refused for overlapping #12, the same house protected before with a
 * slightly different box).
 */
function earlierProtections(context: SkillContext, label: string, door: Position, current: number, areas: readonly ProtectedArea[] = context.areas ?? []): number[] {
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
  for (let ring = 1; ring <= SITE_SEARCH; ring += 1) {
    const doors: Position[] = [];
    for (let dx = -ring; dx <= ring; dx += 1) {
      for (let dz = -ring; dz <= ring; dz += 1) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) === ring) doors.push({ x: refused.door.x + dx, y: refused.door.y, z: refused.door.z + dz });
      }
    }
    doors.sort((a, b) => Math.hypot(a.x - refused.door.x, a.z - refused.door.z) - Math.hypot(b.x - refused.door.x, b.z - refused.door.z));
    const clear = doors.find((door) => overlapsOf(areas, boxFor(door)).length === 0);
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

/**
 * Where a player named in a step stands; her own name is where she stands (live 2026-10-03: "level 4 blocks around
 * Ayla" failed five times with "cannot see Ayla", the players list holding only the others).
 */
function whereIs(snapshot: BotSnapshot, username: string, self: string | undefined): Position | null {
  if (self !== undefined && username.toLowerCase() === self.toLowerCase()) return snapshot.position;
  return findPlayer(snapshot, username)?.position ?? null;
}

export function navigateInput(target: Position, range: number): Record<string, unknown> {
  return { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z), range };
}

function distanceBetween(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
