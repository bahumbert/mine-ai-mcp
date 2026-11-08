// Walking one compass way to see new land and find a block or creature (explore), in legs, with its refusals and report.
import minecraftData from "minecraft-data";
import { COMPASS_HEADINGS, type Step } from "../actions.ts";
import { MOSTLY_WATER } from "../bot-data-sql.ts";
import { describeWay, FETCH_RANGE, knownPlaces } from "../gathering/fetch-farther.ts";
import { dropSourcesNote, obtainedBy } from "../gathering/how-to-get.ts";
import { carriesFamily } from "../inventory-room.ts";
import { NEWEST_REGISTRY_VERSION as ENTITY_REGISTRY_VERSION } from "../newest-registry.ts";
import type { BotSnapshot, FoundBlock, Position, SeenBlock } from "../runtime-client.ts";
import type { SkillContext, SkillResult } from "../skills.ts";
import { EXPLORE_REACH, OPEN_SEA_NEAR, onWater, openSeaWays, unseenWayList, unseenWays } from "./explore-ways.ts";

/**
 * One leg of an exploring walk: within loaded ground, so `navigate` sees the surface (and the water) it goes to; a
 * leg of 32 blocks made the walk a stream of 2-chunk hops she could see past (owner, live 2026-10-07).
 */
const EXPLORE_LEG = 96;
/** A leg that ends over known water is shortened to this, so the land before the shore is still walked. */
const SHORE_LEG = 32;
/**
 * How far around her she sees, in blocks: chunks within it are already in her map from where she stands (the server's
 * view distance, 10 chunks, less a margin), so the walk to new land stops this short of it.
 */
const SIGHT = 128;
/** The longest walk one explore step makes. */
const EXPLORE_MAX_WALK = 384;
/** minecraft-data's entity types of the creatures that live in the world (the types `view_status` lists as mobs). */
const CREATURE_TYPES: ReadonlySet<string> = new Set(["animal", "passive", "water_creature", "ambient", "hostile", "mob"]);
/** What explore says after a creature it found: the way to what it drops. */
const CREATURE_TAIL = "get_items what you want from it hunts it there";

/** Whether `name` is a creature of the game (sheep, pig, zombie), by the newest entity registry: creature names stay the same across versions (new ones are only added). */
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
export async function explore(context: SkillContext, step: ExploreStep, why: string): Promise<SkillResult> {
  const looking = await exploreRefusal(context, step);
  if ("status" in looking) return looking;
  const { creature, block } = looking;
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
    : await knownBlocks(context, block, start);
  // A refused walk names what she already knows of it (live 2026-10-07: Ayla tried explore for oak_log six ways in a
  // row, all seen or water, while she knew of oak 45 blocks off).
  const knownNote = knownBefore?.nearest === undefined || block === undefined
    ? ""
    : `; ${blockHint(block, start, knownBefore, true)}`;
  // With a boat, water ahead is no reason to stop: the leg goes on to the far side and `navigate` crosses by boat (live
  // 2026-10-04: Vex made a boat to explore south-east, then was refused "water as far as you have seen" again).
  const boat = carriesFamily(setOut.inventory, "boat");
  const radians = (COMPASS_HEADINGS[step.toward] * Math.PI) / 180;
  const [dx, dz] = [Math.sin(radians), -Math.cos(radians)];
  const way: ExploreWay = { start, dx, dz, knownNote };
  const refused = await refusedWay(context, step, way);
  if ("status" in refused) return refused;
  const known = Math.max(0, refused.unseen - SIGHT);
  const total = Math.min(EXPLORE_MAX_WALK, known + step.chunks * 16);
  context.progress?.(`exploring ${step.toward}${step.for === undefined ? "" : ` for ${step.for}`}`);
  const walked = await walkLegs(context, step, why, { ...way, total, boat, creature, block });
  if ("status" in walked) return walked;
  return exploreReport(context, step, { start, creature, block, knownBefore }, walked);
}

type ExploreStep = Extract<Step, { skill: "explore" }>;

/** The block or creature explore looks for, or the refusal when the name is neither a block, nor a creature, nor something found on foot. */
async function exploreRefusal(context: SkillContext, step: ExploreStep): Promise<SkillResult | { readonly creature: string | undefined; readonly block: string | undefined }> {
  // A block or a creature is seen on the way, nothing else (live 2026-10-07: explore for "water_source", "deep_water",
  // "raw_iron"; live 2026-10-09, 10 bots: "sheep", "zombie", "pig" in four of them, so a creature is walked toward and
  // looked for among the loaded mobs after each leg).
  const kinds = step.for === undefined ? null : await context.runtime.blockKinds([step.for]).catch(() => null);
  const notBlock = step.for !== undefined && kinds !== null && kinds[step.for] === undefined;
  const creature = notBlock && step.for !== undefined && isCreature(step.for) ? step.for : undefined;
  if (notBlock && creature === undefined) {
    const from = step.for === undefined ? null : await dropSourcesNote(context.runtime, step.for);
    return { status: "failed", detail: `${step.for} is not a block${from === null ? "" : ` (${from}: get_items ${step.for} breaks them)`}: explore looks for a block by its Minecraft name; get_items gets an item. To find animals or monsters, leave \"for\" out to just explore: the new land you reach shows what lives there, and get_items gets what they drop (white_wool from sheep, porkchop from pigs)` };
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
  return { creature, block };
}

/** Where an explore walk starts, which way it goes (a unit vector) and what she already knows of the block it looks for. */
interface ExploreWay {
  readonly start: Position;
  readonly dx: number;
  readonly dz: number;
  readonly knownNote: string;
}

/** The refusal of a way that is all land she has seen or a sea sailed from here; else how far off its unseen land lies. */
async function refusedWay(context: SkillContext, step: ExploreStep, { start, dx, dz, knownNote }: ExploreWay): Promise<SkillResult | { readonly unseen: number }> {
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
  // Only from near where it was sailed, and only where the ride went past her by more than she sees: from the boat
  // where it ended at sea, the way on is unsailed (run 14 review SF5).
  const sailed = openSeaWays(context.runtime).find((sea) => sea.toward === step.toward && Math.hypot(sea.from.x - start.x, sea.from.z - start.z) <= OPEN_SEA_NEAR && (sea.to.x - start.x) * dx + (sea.to.z - start.z) * dz > SIGHT);
  if (sailed !== undefined) {
    return { status: "failed", detail: `${step.toward} from here is open sea: you sailed it and found no land within ${sailed.blocks} blocks: explore another way (${await unseenWays(context, start)})` };
  }
  return { unseen };
}

/** What a whole explore walk is: its way, its length and what it looks for. */
interface ExploreWalk extends ExploreWay {
  readonly total: number;
  readonly boat: boolean;
  readonly creature: string | undefined;
  readonly block: string | undefined;
}

/** Where a walk ended, why it stopped early (null: it went its whole way), and the block or creature it found. */
interface Walked {
  readonly here: Position;
  readonly stop: string | null;
  readonly found?: FreeBlocks;
  readonly sighted?: { readonly mob: BotSnapshot["mobs"][number]; readonly from: Position };
}

/** One leg's length and target from `here`, shortened toward the shore over water without a boat, run to the far side with one; with the water ahead. */
async function nextLeg(context: SkillContext, { dx, dz, boat }: ExploreWalk, here: Position, remaining: number) {
  let leg = Math.min(EXPLORE_LEG, remaining);
  let target = { x: Math.floor(here.x) + Math.round(dx * leg), y: here.y, z: Math.floor(here.z) + Math.round(dz * leg) };
  let water = await context.runtime.waterAlong(here, target).catch(() => null);
  while (!boat && water !== null && water.share > MOSTLY_WATER && leg > SHORE_LEG) {
    leg = SHORE_LEG;
    target = { x: Math.floor(here.x) + Math.round(dx * leg), y: here.y, z: Math.floor(here.z) + Math.round(dz * leg) };
    water = await context.runtime.waterAlong(here, target).catch(() => null);
  }
  if (water !== null && water.share > MOSTLY_WATER && boat) {
    leg = remaining;
    target = { x: Math.floor(here.x) + Math.round(dx * leg), y: here.y, z: Math.floor(here.z) + Math.round(dz * leg) };
  }
  return { leg, target, water };
}

/** The refusal of a walk that is water from the start: the way back to land when she is out at sea, else the way on by boat. */
async function waterAheadRefusal(context: SkillContext, start: Position, ahead: string, knownNote: string): Promise<SkillResult> {
  // Already out at sea, every way may be water: the way back to land is what helps (live 2026-10-04: Vex, 104
  // blocks out over water, was refused all eight ways, fifteen steps in a row). Her own chunk: a line ending where
  // she stands counts it (the start of a line never does).
  const atSea = await context.runtime.waterAlong({ x: start.x - 16, y: start.y, z: start.z }, start).catch(() => null);
  if (atSea !== null && atSea.share > MOSTLY_WATER && await onWater(context.runtime, start)) {
    const land = await context.runtime.nearestLand(start).catch(() => null);
    const back = land === null ? "you know of no land near" : `the nearest land you have seen is ${describeWay(start, land)}, around ${land.x} ${land.z}: go_to there first`;
    return { status: "failed", detail: `you are out on the water, and ${ahead}; ${back}` };
  }
  // Unseen land may lie only across water (live 2026-10-07: every way from Ayla's coast was seen or water, and she
  // tried them all, twice, with no boat): a boat is the way on.
  return { status: "failed", detail: `${ahead}: explore another way, carry a boat to cross it, or say so${knownNote}` };
}

/** Walks the legs of an explore until the walk is done, a creature or the block is in reach, or a leg stops; a result when the walk itself is refused or stopped. */
async function walkLegs(context: SkillContext, step: ExploreStep, why: string, walk: ExploreWalk): Promise<Walked | SkillResult> {
  const { start, total, boat, creature, block, knownNote } = walk;
  let here = start;
  let stop: string | null = null;
  let found: FreeBlocks | undefined;
  let sighted: { readonly mob: BotSnapshot["mobs"][number]; readonly from: Position } | undefined;
  for (let walked = 0; walked < total;) {
    const { leg, target, water } = await nextLeg(context, walk, here, total - walked);
    if (!boat && water !== null && water.share > MOSTLY_WATER) {
      const ahead = `${step.toward} is water as far as you have seen (${Math.round(water.share * 100)}% of the next ${water.chunks} chunk${water.chunks === 1 ? "" : "s"})`;
      if (walked > 0) {
        stop = ahead;
        break;
      }
      return waterAheadRefusal(context, start, ahead, knownNote);
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
      if (nearest.open !== undefined && Math.hypot(nearest.open.x - here.x, nearest.open.z - here.z) <= FETCH_RANGE) {
        found = nearest;
        break;
      }
    }
  }
  return { here, stop, found, sighted };
}

/** What explore tells after its walk: where she ended, the water crossed, what she looked for, and the unseen land left. */
async function exploreReport(context: SkillContext, step: ExploreStep, looked: { readonly start: Position; readonly creature: string | undefined; readonly block: string | undefined; readonly knownBefore: FreeBlocks | undefined }, { here, stop, found, sighted }: Walked): Promise<SkillResult> {
  const { start, creature, block, knownBefore } = looked;
  const crossed = await context.runtime.waterAlong(start, here).catch(() => null);
  const parts = [
    `now ${describeWay(start, here)} from where you started, at ${Math.floor(here.x)} ${Math.floor(here.y)} ${Math.floor(here.z)}`,
    ...(crossed === null || crossed.share === 0 ? [] : [`${Math.round(crossed.share * 100)}% of the ground crossed was water`]),
  ];
  if (creature !== undefined) {
    parts.push(sighted === undefined ? `no ${creature} seen on the way` : `found ${creature} ${creatureWhere(sighted.from, sighted.mob)}: ${CREATURE_TAIL}`);
  } else if (block !== undefined) {
    const nearest = found ?? await nearestFree(context, block);
    const known = nearest.nearest === undefined ? knownBefore : nearest;
    parts.push(known?.nearest === undefined
      ? `no ${block} seen on the way`
      : blockHint(block, here, known));
  }
  parts.push(`unseen land from here: ${await unseenWays(context, here)}`);
  const noLand = /no land within (\d+) blocks/u.exec(stop ?? "");
  if (noLand !== null) openSeaWays(context.runtime).push({ toward: step.toward, from: { x: start.x, z: start.z }, to: { x: here.x, z: here.z }, blocks: Number(noLand[1]) });
  // Done only when the walk went its whole way or found what it was for within reach: a walk that stopped says why,
  // even when the block is in sight farther off (live 2026-10-07: "done" after 0 blocks, forty times).
  if (stop === null || found !== undefined || sighted !== undefined) return { status: "done", detail: `explored ${step.toward}: ${parts.join("; ")}` };
  return { status: "failed", detail: `exploring ${step.toward} stopped (${stop}): ${parts.join("; ")}` };
}

/** How many of the nearest blocks of a name are looked through for one outside every protected area. */
const FREE_SCAN = 64;

/**
 * The nearest block of this name outside every protected area: one she may take (live 2026-10-04: "the nearest
 * oak_log is 22 blocks" was a wall of her own house; all 48 logs near were, and she walked to them for 40 steps).
 */
async function nearestFree(context: SkillContext, name: string): Promise<FreeBlocks> {
  const areas = context.areas ?? [];
  const inside = (block: FoundBlock) => areas.some((area) =>
    block.x >= area.min.x && block.x <= area.max.x && block.y >= area.min.y && block.y <= area.max.y && block.z >= area.min.z && block.z <= area.max.z);
  const found = (await context.runtime.findBlocks(name, FREE_SCAN)).filter((block) => !inside(block));
  return { nearest: found[0], open: found.find((block) => block.situation === undefined) };
}

/** Nearest known block and the first one in the open, retaining non-open facts for the model. */
interface FreeBlocks {
  readonly nearest: FoundBlock | SeenBlock | undefined;
  readonly open: FoundBlock | SeenBlock | undefined;
}

/** Loaded observations first, otherwise a frontier place with no known height or loaded situation. */
async function knownBlocks(context: SkillContext, block: string, from: Position): Promise<FreeBlocks> {
  const loaded = await nearestFree(context, block);
  if (loaded.nearest !== undefined) return loaded;
  const place = (await knownPlaces(context.runtime, block, from))[0];
  return { nearest: place, open: place?.waterShare !== undefined && place.waterShare > MOSTLY_WATER ? undefined : place };
}

/** A non-open nearest is named as such; only an open entry is offered as an automatic fetch. */
function blockHint(block: string, from: Position, known: FreeBlocks, before = false): string {
  const { nearest, open } = known;
  if (nearest === undefined) return `no ${block} seen on the way`;
  if ("waterShare" in nearest && nearest.waterShare !== undefined && nearest.waterShare > MOSTLY_WATER) {
    return `the nearest ${block} you know of was seen in a chunk that is mostly water, around ${nearest.x} ${nearest.z}: go_to there yourself if it is worth the trip, use another material, or say so`;
  }
  const trip = open === undefined ? "" : `${describeWay(from, open)}, around ${open.x} ${open.z}: get_items ${block} ${before ? "fetches it" : "goes there and gathers it"}`;
  if ("situation" in nearest && nearest.situation !== undefined) {
    const situation = nearest.situation === "under_water" ? "under water" : "roofed over";
    return `the nearest ${block} you know of lies ${situation} at ${nearest.x} ${nearest.y} ${nearest.z}${open === undefined ? "" : `; the nearest in the open is ${trip}`}`;
  }
  return before ? `you already know of ${block} ${trip}` : `the nearest ${block} you know of is ${trip}`;
}
