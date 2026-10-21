import { describeActivity, type Activity } from "./activities.ts";
import type { BlockRole } from "./building/blueprint.ts";
import type { KnownFarm } from "./memory.ts";
import type { BotSnapshot, Position } from "./runtime-client.ts";
import type { UnfinishedHouse } from "./skills.ts";

/**
 * The tasks a character looks for (spec 2026-10-03-specialisations-preferences, section 4): code perceives, the model
 * chooses. Each finder is a pure function over what the brain already knows and states a fact worth acting on, tagged
 * with the kind of work it is; the goal tier sees them beside its tastes and may ignore them all (Rule #0: nothing here
 * decides what to do).
 */
export interface Opportunity {
  /** The kinds of work it would take; several when there are several ways (food: farming, hunting or cooking). */
  readonly activities: readonly Activity[];
  readonly text: string;
}

/** A material a house of her own still needs, and the work that gets it (as `get_items` would). */
export interface Shortfall {
  readonly item: string;
  readonly count: number;
  readonly activity: Activity;
}

export interface OpportunityFacts {
  readonly now: number;
  readonly snapshot: BotSnapshot;
  readonly farms: readonly KnownFarm[];
  readonly unfinished: UnfinishedHouse | null;
  /** Whether she knows a house she built for herself. */
  readonly ownHome: boolean;
  /** What her style's small house needs beyond what she carries; looked up only while she has no home. */
  readonly houseShortfall: readonly Shortfall[];
  /** The cells per role of her style's small house (air excluded); looked up only while she has no home. */
  readonly smallHouse: readonly { readonly role: BlockRole; readonly count: number }[];
  /** Carried blocks that fill a whole cell, most first, at most five: what `build` may use for a part; looked up only while she has no home. */
  readonly carriedBlocks: readonly { readonly name: string; readonly count: number }[];
  /** Her own house built with other blocks than her style's (it counts as her home), and what improving it needs. */
  readonly temporaryHouse: {
    readonly door: Position;
    readonly roles: readonly { readonly role: BlockRole; readonly block: string; readonly style: string }[];
    readonly shortfall: readonly Shortfall[];
  } | null;
  /** Items an own objective could not get, the partners to ask (online) and what she can offer, biggest stack first. */
  readonly tradeNeeds?: { readonly items: readonly string[]; readonly partners: readonly string[]; readonly offer: readonly { readonly item: string; readonly count: number }[] };
}

/** Shown to the goal tier at most: more is a list to read, not a hint. */
export const MAX_OPPORTUNITIES = 6;
/** A tool with this share of its uses left or fewer is nearly worn out. */
const WORN_SHARE = 0.1;
/** ... or with this many uses left or fewer, whatever its tier. */
const WORN_USES = 16;
/**
 * Hunger points of food carried that count as enough for now: a full bar. (unverified: an estimate of a Minecraft
 * day's needs for a working player; the model sees the numbers and decides.)
 */
const ENOUGH_FOOD_POINTS = 20;
/** Hunger at or under this is starving: sprinting stops at 6 (the game's rule). */
const STARVING = 6;
/** A farm left this long may have ripened (wheat takes about half an hour near water). */
const FARM_RECHECK_MINUTES = 20;

function wornTools(facts: OpportunityFacts): Opportunity[] {
  return facts.snapshot.inventory.flatMap((stack) => {
    const durability = stack.durability ?? null;
    if (durability === null || durability.remaining > Math.max(WORN_USES, durability.maximum * WORN_SHARE)) return [];
    return [{ activities: ["crafting"], text: `your ${stack.name} has ${durability.remaining} uses left` }];
  });
}

function lowFood(facts: OpportunityFacts): Opportunity[] {
  const { foods, food } = facts.snapshot;
  const points = foods.reduce((sum, carried) => sum + carried.points * carried.count, 0);
  if (points >= ENOUGH_FOOD_POINTS) return [];
  const carried = foods.length === 0 ? "you carry no food" : `you carry food for ${points} hunger points (${foods.map((entry) => `${entry.count} ${entry.name}`).join(", ")})`;
  // Starving, a new farm is too slow (live 2026-10-04: Ayla, hunger 0, tried to eat seeds and to farm a cave floor).
  const starving = food <= STARVING ? ": you are starving, food comes before anything else; a new crop takes many minutes to grow, an animal near is quicker" : "";
  // The animals in sight (live 2026-10-04: starving, Ayla tried to eat seeds and to farm, never to hunt).
  const animals = facts.snapshot.mobs.filter((mob) => !mob.hostile).map((mob) => `${mob.count} ${mob.name} ${Math.round(mob.distance)} blocks away`);
  const near = animals.length === 0 ? "" : `; animals in sight: ${animals.join(", ")}`;
  return [{ activities: ["farming", "hunting", "cooking"], text: `${carried}; your hunger is ${food}/20${starving}${near}` }];
}

const TRADE_PARTNERS_SHOWN = 3;
const TRADE_OFFER_SHOWN = 5;

/** Items she could not get by her own work and who might have them: the partners nearest first (those out of sight last). */
function tradeNeeds(facts: OpportunityFacts): Opportunity[] {
  const needs = facts.tradeNeeds;
  if (needs === undefined || needs.items.length === 0 || needs.partners.length === 0) return [];
  const { position, players } = facts.snapshot;
  const away = (name: string) => {
    const there = players.find((player) => player.username.toLowerCase() === name.toLowerCase())?.position;
    return there === undefined || there === null ? Infinity : Math.abs(there.x - position.x) + Math.abs(there.y - position.y) + Math.abs(there.z - position.z);
  };
  const asked = [...needs.partners].sort((a, b) => away(a) - away(b)).slice(0, TRADE_PARTNERS_SHOWN);
  const carried = needs.offer.slice(0, TRADE_OFFER_SHOWN).map((entry) => `${entry.count} ${entry.item}`).join(", ");
  return [{ activities: ["trading"], text: `trade for ${needs.items.join(", ")} you could not get: ask ${asked.join(", ")} what they would want for it (you carry ${carried})` }];
}

function minutesSince(iso: string, now: number): number {
  return Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
}

/** The farm and how far it is: what tending it costs is in front of the model (live 2026-10-04: one 200 blocks off). */
function where(farm: KnownFarm, facts: OpportunityFacts): string {
  const { x, z } = facts.snapshot.position;
  const away = Math.round(Math.hypot(farm.centre.x - x, farm.centre.z - z));
  return `your ${farm.crop} farm around ${farm.centre.x} ${farm.centre.y} ${farm.centre.z}, ${away} blocks away,`;
}

function farmsToHarvest(facts: OpportunityFacts): Opportunity[] {
  return facts.farms.flatMap((farm) => {
    const minutes = minutesSince(farm.tendedAt, facts.now);
    if (minutes < FARM_RECHECK_MINUTES && farm.state.ripe === 0) return [];
    return [{ activities: ["farming"], text: `${where(farm, facts)} was tended ${minutes} min ago (${farm.state.ripe} ripe then)` }];
  });
}

function farmsToSow(facts: OpportunityFacts): Opportunity[] {
  const carries = (item: string) => facts.snapshot.inventory.some((stack) => stack.name === item);
  // Seeds gathered for a farm are time for farming (run 11, 2026-10-14: what a thing is for is its activity).
  return facts.farms.flatMap((farm) => farm.state.empty === 0 || carries(farm.crop)
    ? []
    : [{ activities: ["farming"], text: `${where(farm, facts)} has ${farm.state.empty} empty farmland and you carry no ${farm.crop}` }]);
}

/**
 * No farm yet, and what a new one takes that she does not carry (the `farm` skill's own needs: a hoe, a bucket for its
 * water, something to plant). Run 11 (2026-10-14): the farming lovers never learnt what a farm needs until a `farm` step
 * was refused, and some never tried one.
 */
function noFarm(facts: OpportunityFacts): Opportunity[] {
  if (facts.farms.length > 0) return [];
  const inventory = facts.snapshot.inventory;
  const missing = [
    ...(inventory.some((stack) => stack.name.endsWith("_hoe")) ? [] : ["no hoe"]),
    ...(inventory.some((stack) => stack.name === "bucket" || stack.name === "water_bucket") ? [] : ["no bucket"]),
  ];
  const carried = missing.length === 0 ? "" : `; you carry ${missing.join(", ")}`;
  return [{ activities: ["farming"], text: `you have no farm yet: a new one takes a hoe, a bucket for its water and seeds to plant (wheat_seeds come from breaking grass)${carried}; get_items fetches what is missing, then farm` }];
}

function unfinishedHouse(facts: OpportunityFacts): Opportunity[] {
  const house = facts.unfinished;
  if (house === null) return [];
  const { x, y, z } = house.site.door;
  return [{ activities: ["building"], text: `your unfinished ${house.kind}, door at ${x} ${y} ${z}` }];
}

/**
 * The missing materials of a house as one building line, grouped by the work that gets them: `<what> needs 22 more
 * oak_log (cutting wood); 16 more cobblestone (mining)`. A house's materials are time *for* building, whatever work
 * fetches them (run 11, 2026-10-14: tagged by that work, "a house needs 16 more cobblestone" was chosen as mining).
 */
function shortfallLines(what: string, missing: readonly Shortfall[]): Opportunity[] {
  if (missing.length === 0) return [];
  const byActivity = new Map<Activity, Shortfall[]>();
  for (const entry of missing) byActivity.set(entry.activity, [...(byActivity.get(entry.activity) ?? []), entry]);
  const parts = [...byActivity].map(([activity, items]) => `${items.map((entry) => `${entry.count} more ${entry.item}`).join(", ")} (${describeActivity(activity)})`);
  return [{ activities: ["building"], text: `${what} needs ${parts.join("; ")}` }];
}

function noHome(facts: OpportunityFacts): Opportunity[] {
  if (facts.ownHome || facts.unfinished !== null) return [];
  // The two ways to a first house: her style's blocks, or what she carries (`build` takes other blocks per role).
  const takes = facts.smallHouse.length === 0 ? "" : `; a small house takes ${facts.smallHouse.map((entry) => `${entry.count} ${entry.role}`).join(", ")} blocks`;
  const carries = facts.carriedBlocks.length === 0 ? "" : `; build can use other blocks per role: you carry ${facts.carriedBlocks.map((entry) => `${entry.count} ${entry.name}`).join(", ")}`;
  return [
    { activities: ["building"], text: `you have no house of your own yet${takes}${carries}` },
    ...shortfallLines("a house of your own", facts.houseShortfall),
  ];
}

function temporaryHouse(facts: OpportunityFacts): Opportunity[] {
  const house = facts.temporaryHouse;
  if (house === null || house.roles.length === 0) return [];
  const { x, y, z } = house.door;
  return [
    {
      activities: ["building"],
      text: `your house at door ${x} ${y} ${z} is temporary: ${house.roles.map((entry) => `${entry.role} ${entry.block}`).join(", ")} (your style: ${house.roles.map((entry) => entry.style).join(", ")})`,
    },
    ...shortfallLines("improving your house", house.shortfall),
  ];
}

function noBed(facts: OpportunityFacts): Opportunity[] {
  // Every bed's id ends in `_bed` (one per colour).
  return facts.snapshot.inventory.some((stack) => stack.name.endsWith("_bed")) ? [] : [{ activities: ["crafting"], text: "you carry no bed" }];
}

/** The tools every player makes first; any tier counts (`wooden_sword`, `iron_pickaxe`, ...). */
const FIRST_TOOLS = ["sword", "pickaxe", "axe"] as const;

/**
 * Bare hands (owner, real-world session 2026-10-07: Ayla did everything with her hands, a sword never made, and
 * nights there are dangerous): the tools she has none of, a sword first.
 */
function missingTools(facts: OpportunityFacts): Opportunity[] {
  const missing = FIRST_TOOLS.filter((tool) => !facts.snapshot.inventory.some((stack) => stack.name.endsWith(`_${tool}`)));
  if (missing.length === 0) return [];
  const stone = facts.snapshot.inventory.some((stack) => stack.name === "cobblestone" || stack.name === "cobbled_deepslate") ? "stone" : "wooden";
  return [{
    activities: ["crafting"],
    text: `you carry no ${missing.join(", no ")}: you fight and work bare-handed, slow and in danger; ` +
      `get_items ${missing.map((tool) => `${stone}_${tool}`).join(", ")} makes them in a few minutes`,
  }];
}

/**
 * The gear she has, once she has tools at all (owner, 2026-10-07: Vex carried 100 raw iron and fought with a stone
 * sword, never thinking of better gear): what each first tool and armour piece is, from the runtime's view of her
 * inventory; the model sees what she carries and judges whether better is within reach.
 */
function gear(facts: OpportunityFacts): Opportunity[] {
  const gearSeen = facts.snapshot.gear;
  if (gearSeen === undefined) return [];
  const tools = gearSeen.tools.filter((entry) => (FIRST_TOOLS as readonly string[]).includes(entry.class));
  if (tools.every((entry) => entry.item === null)) return [];
  const named = (entries: readonly { readonly class: string; readonly item: string | null }[]) => entries.map((entry) => entry.item ?? `no ${entry.class}`).join(", ");
  return [{
    activities: ["crafting"],
    text: `your gear: ${named(tools)}; armour: ${named(gearSeen.armour)} (better tools and armour are crafted from what you mine and smelt)`,
  }];
}

/**
 * Every opportunity found, at most {@link MAX_OPPORTUNITIES}: the pressing ones first (a tool about to break, no tools,
 * food), then those of the drawn activities, then the rest. Cut before the drawn ones were picked, a farming lover's
 * "no farm yet" never reached the prompt behind the house and bed lines (run 11, 2026-10-14).
 */
export function findOpportunities(facts: OpportunityFacts, drawn: readonly Activity[] = []): Opportunity[] {
  const pressing = [tradeNeeds, wornTools, missingTools, lowFood].flatMap((finder) => finder(facts));
  const rest = [farmsToHarvest, unfinishedHouse, farmsToSow, noHome, temporaryHouse, noFarm, noBed, gear].flatMap((finder) => finder(facts));
  return [...pressing, ...drawnFirst(rest, drawn)].slice(0, MAX_OPPORTUNITIES);
}

/** The opportunities for the drawn activities first, then the others, each group in its order: none is dropped. */
export function drawnFirst(opportunities: readonly Opportunity[], drawn: readonly Activity[]): Opportunity[] {
  const wanted = (opportunity: Opportunity) => opportunity.activities.some((activity) => drawn.includes(activity));
  return [...opportunities.filter(wanted), ...opportunities.filter((opportunity) => !wanted(opportunity))];
}

/** One line each, `- (farming) ...`, for the goal tier's situation. */
export function describeOpportunities(opportunities: readonly Opportunity[]): string {
  if (opportunities.length === 0) return "none that you know of";
  return opportunities.map((opportunity) => `\n- (${opportunity.activities.map(describeActivity).join(", ")}) ${opportunity.text}`).join("");
}
