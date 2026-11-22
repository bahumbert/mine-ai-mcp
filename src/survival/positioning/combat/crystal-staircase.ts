import { crystalBlastCovered, crystalMeleeAimFrom, crystalMeleeReach } from "./crystal-melee.js";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { BUILD_REACH, BuildProgress, build, keptWith, type BuildCell, type BuildRequest, type BuildResult, type CellKeys } from "../../../navigation/processes/building/build-process.js";
import { createMovements, customGoal, nearGoal, observeMineflayerBlock, packKey, type BlockPosition, type Goal, type MovementPolicy, type NavigationRuntime } from "../../../navigation/index.js";
import { DIG_REACH } from "../../../navigation/movements/excavation.js";
import { GEOMETRY_FULL_CUBE, navigationFeet } from "../../../navigation/world/block-geometry.js";
import { isAir } from "../../../world/block-classification.js";
import { STANDING_EYE_HEIGHT, visibleBlockAim } from "../../../world/block-visibility.js";
import { readDragonCloudHazards, type DragonCloud } from "../../../world/dragon-hazards.js";
import { placeBlock } from "../../../world/index.js";
import type { SurvivalPolicy } from "../../policy/contract.js";

type WorkBox = { readonly min: Vec3; readonly max: Vec3 };

export interface CrystalStaircase {
  readonly cells: readonly BuildCell[];
  /** Feet cell of the swing: on the covered rim below the pedestal when reach allows, else on top of the tower. */
  readonly stance: Vec3;
  /** Whether the stance keeps the whole body under the pedestal's top face. */
  readonly covered: boolean;
  readonly pedestal: Vec3;
  /** The tower's native full blocks from the island to the top layers; no crystal route mines them. */
  readonly tower: readonly Vec3[];
  /** The plan cells' bounds grown by BUILD_REACH on each axis: where a work route that starts inside may stand. */
  readonly box: WorkBox;
  /** Feet cell of the first tread (the spiral's first path cell). */
  readonly foot: Vec3;
  /** Scaffold blocks a straight pillar from the island to the stance needs, for the alternative approach. */
  readonly pillarBlocks: number;
}

/** Fixed clockwise square spiral ending at the north-east attack corner.
 * Treads attach directly to obsidian; only gaps around the tower's round
 * corners need a lower support beside the preceding tread.
 *
 * The tower itself is never excavated. Narrow towers offer a covered stance on
 * the rim, one block below the pedestal's top face, within melee reach. Wider
 * ones put that rim out of reach, and the answer is to step onto the top layer
 * and swing from the disc cell farthest from the crystal that still reaches
 * it: the pedestal shields the lower body there, so the hit is survivable in
 * armor, and mining minutes of obsidian for full cover is not worth it. */
export function planCrystalStaircase(bot: Bot, crystal: Vec3): CrystalStaircase {
  const center = crystal.floored(), top = center.y - 2;
  if (!crystalBlastCovered(bot, crystal, center.offset(2, -2, -2)))
    throw new Error("[CRYSTAL_BLAST_COVER_UNAVAILABLE] The crystal needs an intact native pedestal before building an approach.");
  const radius = readTowerRadius(bot, center);
  const ground = readIslandGround(bot, center, top, radius + 1);
  const rise = top - ground - 1;
  const path = staircasePath(bot, center, radius + 1, ground, top);
  const rim = path.at(-1)!;
  const eyeAt = (feet: Vec3) => feet.offset(0.5, STANDING_EYE_HEIGHT, 0.5);
  const covered = crystalBlastCovered(bot, crystal, rim.offset(0.5, 0, 0.5)) && crystalMeleeReach(crystal, eyeAt(rim));
  const stance = covered ? rim : topStance(bot, crystal, center, radius, rim, eyeAt);
  if (!stance) throw new Error("[CRYSTAL_STANCE_UNAVAILABLE] Neither the covered rim nor the tower top offers a clear melee hit within reach without mining the tower.");
  const pedestal = center.offset(0, -1, 0);
  const cells = staircaseCells(bot, path, pedestal);
  const tower = nativeTower(bot, center, ground, top, cells);
  return { cells, stance, covered, pedestal, tower, box: workBox(cells), foot: path[0]!, pillarBlocks: rise };
}

/** Survey the native tower at its core so the spiral fits outside its radius. */
function readTowerRadius(bot: Bot, center: Vec3): number {
  let radius = 0;
  for (const [x, z] of towerColumns()) {
    const block = bot.blockAt(center.offset(x, -4, z));
    if (!block) throw new Error("[CRYSTAL_TOWER_UNLOADED] Load the tower before planning its staircase.");
    if (block.name === "obsidian") radius = Math.max(radius, Math.abs(x), Math.abs(z));
  }
  if (radius < 1 || radius > 5) throw new Error("[CRYSTAL_TOWER_UNSUPPORTED] Expected an observed native obsidian tower.");
  return radius;
}

/** Use the same survey square for the tower radius and its protected column. */
function* towerColumns(): Iterable<[number, number]> {
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) yield [x, z];
}

/** Read the island outside the footprint so existing treads cannot change the spiral. */
function readIslandGround(bot: Bot, center: Vec3, top: number, edge: number): number {
  // Survey outside the staircase footprint; completed treads cannot raise the
  // next request's ground estimate and change the spiral's orientation.
  for (let y = top; y >= 1; y--) {
    const block = bot.blockAt(new Vec3(center.x, y, center.z - edge - 3));
    if (!block) throw new Error("[CRYSTAL_TOWER_UNLOADED] Load the island below the tower.");
    if (block.boundingBox !== "block") continue;
    if (y + 1 < top) return y;
    break;
  }
  throw new Error("[CRYSTAL_TOWER_UNSUPPORTED] No lower island surface was observed for the staircase.");
}

/** Wind from the island to the attack corner, following only open cells inward on top. */
function staircasePath(bot: Bot, center: Vec3, edge: number, ground: number, top: number): Vec3[] {
  const ring: Vec3[] = [];
  for (let x = -edge; x < edge; x++) ring.push(new Vec3(x, 0, -edge));
  for (let z = -edge; z < edge; z++) ring.push(new Vec3(edge, 0, z));
  for (let x = edge; x > -edge; x--) ring.push(new Vec3(x, 0, edge));
  for (let z = edge; z > -edge; z--) ring.push(new Vec3(-edge, 0, z));
  const rise = top - ground - 1, end = edge + 2;
  const path: Vec3[] = [];
  for (let i = 0; i <= rise; i++) {
    const point = ring[((end - rise + i) % ring.length + ring.length) % ring.length]!;
    path.push(new Vec3(center.x + point.x, ground + 1 + i, center.z + point.z));
  }
  // Walk the attack column inward only while the top layer leaves it open.
  for (let z = -edge + 1; z <= -2; z++) {
    const cell = new Vec3(center.x + 2, top, center.z + z);
    const block = bot.blockAt(cell);
    if (!block) throw new Error("[CRYSTAL_TOWER_UNLOADED] Load the tower before planning its staircase.");
    if (block.name === "obsidian" && block.boundingBox === "block") break;
    path.push(cell);
  }
  return path;
}

/** Declare the treads, corner supports and clearance without rebuilding the native pedestal. */
function staircaseCells(bot: Bot, path: readonly Vec3[], pedestal: Vec3): BuildCell[] {
  const floors = new Map<string, Vec3>();
  for (let i = 0; i < path.length; i++) {
    const feet = path[i]!;
    const floor = feet.offset(0, -1, 0);
    floors.set(floor.toString(), floor);
    // Use the native wall, not previously built treads, so retrying produces
    // the same support layout even after partial construction.
    const wallFace = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => {
      const block = bot.blockAt(floor.offset(x!, 0, z!));
      return block?.name === "obsidian" && block.boundingBox === "block";
    });
    if (i > 0 && feet.y > path[i - 1]!.y && !wallFace) {
      const support = feet.offset(0, -2, 0);
      floors.set(support.toString(), support);
    }
  }
  // Anchor the first tread to observed terrain if this side is lower than the survey.
  const first = path[0]!;
  for (let depth = 1; depth <= 32; depth++) {
    const position = first.offset(0, -depth, 0), block = bot.blockAt(position);
    if (!block) throw new Error("[CRYSTAL_TOWER_UNLOADED] Staircase footing is not loaded.");
    if (block.boundingBox === "block") break;
    if (depth === 32) throw new Error("[CRYSTAL_TOWER_UNSUPPORTED] Staircase has no nearby island footing.");
    floors.set(position.toString(), position);
  }
  const cells = new Map<string, BuildCell>();
  for (const position of floors.values()) {
    const existing = bot.blockAt(position);
    cells.set(position.toString(), { position, blockName: existing?.boundingBox === "block" ? existing.name : "end_stone" });
  }
  for (const position of staircaseClearance(path)) {
    if (floors.has(position.toString())) throw new Error("Staircase clearance overlaps a tread");
    cells.set(position.toString(), { position, blockName: "air" });
  }
  // The feet/head clearance above opens the attack corner. Keep the rest of
  // the cage intact; the attack checks actual reach and line of sight.
  cells.set(pedestal.toString(), { position: pedestal, blockName: bot.blockAt(pedestal)!.name });
  return [...cells.values()];
}

/** A one-block rise needs clearance above the takeoff head, as required by step_up. */
function* staircaseClearance(path: readonly Vec3[]): Iterable<Vec3> {
  for (const [index, feet] of path.entries()) {
    yield feet;
    yield feet.offset(0, 1, 0);
    const next = path[index + 1];
    if (next && next.y > feet.y) yield feet.offset(0, 2, 0);
  }
}

/** Protect the observed full-block column, including the layers a return leg can dig below the island. */
function nativeTower(bot: Bot, center: Vec3, ground: number, top: number, cells: readonly BuildCell[]): Vec3[] {
  const core = bot.blockAt(center.offset(0, -4, 0));
  if (!core) throw new Error("[CRYSTAL_TOWER_UNLOADED] Load the tower before planning its staircase.");
  if ((observeMineflayerBlock(core).bits & GEOMETRY_FULL_CUBE) === 0)
    throw new Error("[CRYSTAL_TOWER_UNSUPPORTED] The surveyed tower is missing its native full-block core.");
  const planned = new Set(cells.map(({ position }) => keyOf(position)));
  for (const { position, blockName } of cells) {
    if (isAir({ name: blockName }) && bot.blockAt(new Vec3(position.x, position.y, position.z))?.name === core.name)
      throw new Error("[CRYSTAL_TOWER_UNSUPPORTED] Staircase clearance would excavate the tower.");
  }
  const tower = new Map<number, Vec3>();
  for (const [x, z] of towerColumns()) for (let y = ground - BUILD_REACH; y <= top; y++) {
    const position = new Vec3(center.x + x, y, center.z + z);
    const block = bot.blockAt(position);
    if (!block) throw new Error("[CRYSTAL_TOWER_UNLOADED] Load the tower before planning its staircase.");
    const key = keyOf(position);
    if (block.name === core.name && !planned.has(key) && (observeMineflayerBlock(block).bits & GEOMETRY_FULL_CUBE) !== 0)
      tower.set(key, position);
  }
  return [...tower.values()];
}

const keyOf = ({ x, y, z }: BlockPosition): number => packKey(x, y, z);

/** Include every standing cell within reach of any planned cell. */
function workBox(cells: readonly BuildCell[]): WorkBox {
  const min = new Vec3(Infinity, Infinity, Infinity);
  const max = new Vec3(-Infinity, -Infinity, -Infinity);
  for (const { position: { x, y, z } } of cells) {
    min.set(Math.min(min.x, x), Math.min(min.y, y), Math.min(min.z, z));
    max.set(Math.max(max.x, x), Math.max(max.y, y), Math.max(max.z, z));
  }
  return { min: min.offset(-BUILD_REACH, -BUILD_REACH, -BUILD_REACH), max: max.offset(BUILD_REACH, BUILD_REACH, BUILD_REACH) };
}

/** Inclusive limits, as used by the in-reach work goals. */
function insideBox({ min, max }: WorkBox, { x, y, z }: BlockPosition): boolean {
  return x >= min.x && x <= max.x && y >= min.y && y <= max.y && z >= min.z && z <= max.z;
}

/** Return the bot's standing cell in the same coordinates as the build goals. */
function feetOf(bot: Bot): BlockPosition {
  return navigationFeet(bot.entity.position, bot.entity.onGround === true);
}

const OUTSIDE_WORK_BOX = "Outside the staircase's work box";

/** Inside `plan.box`: no scaffold, no standing outside the box; the work legs' policy. It digs nothing unless the
 * caller passes `allowDigging` (the one exit leg out of a closed cell does; a whole route with it measured 1,717-2,524
 * visits against 264 without). */
export function crystalWorkRoutePolicy(bot: Bot, plan: CrystalStaircase, protectedCells: CellKeys,
  { allowDigging = false }: { readonly allowDigging?: boolean } = {}): MovementPolicy {
  const base = createMovements(bot, { allowDigging, scaffolding: false, protectedCells });
  return {
    ...base,
    get scaffold() { return base.scaffold; },
    decideStep(x, y, z, view) {
      return insideBox(plan.box, { x, y, z }) ? base.decideStep(x, y, z, view)
        : { kind: "prohibited", reason: OUTSIDE_WORK_BOX };
    },
  };
}

/** Any feet cell inside the box, level with `start` or above it, other than `start`: the exit leg ends as soon as the
 * body leaves its cell. A cell below is no way out: the cheapest dig from a closed cell is straight down, into a pit
 * that is shut in again (first red run of the exit leg: 9 cells shut in at the start, one level lower). */
export function leaveCellGoal(start: BlockPosition, box: WorkBox): Goal {
  return customGoal(`leave:${start.x},${start.y},${start.z}`, ({ feet }) =>
    insideBox(box, feet) && feet.y >= start.y && (feet.x !== start.x || feet.y !== start.y || feet.z !== start.z));
}

/** Carried blocks from the policy's scaffold list against what a pillar to the stance needs. */
export function pillarShortfall(bot: Bot, policy: Readonly<SurvivalPolicy>, plan: CrystalStaircase): string | null {
  if (!policy.combat.terrain.place)
    return "[CRYSTAL_PILLAR_CONSTRAINED] The pillar approach places scaffold blocks, which the survival policy's combat.terrain.place prohibits.";
  const names = policy.navigation.scaffold_blocks;
  const carried = bot.inventory.items().filter(item => names.includes(item.name)).reduce((sum, item) => sum + item.count, 0);
  return carried >= plan.pillarBlocks
    ? null
    : `[CRYSTAL_PILLAR_SHORTFALL] Tower at ${plan.pedestal}: about ${plan.pillarBlocks} scaffold blocks (${names.join(", ")}) are needed to pillar to the stance; carrying ${carried}. Gather at least ${plan.pillarBlocks - carried} more, or use approach "staircase".`;
}

/** The top-layer cell farthest from the crystal with a clear hit in reach, nearest the rim path on ties. */
function topStance(bot: Bot, crystal: Vec3, center: Vec3, radius: number, rim: Vec3, eyeAt: (feet: Vec3) => Vec3): Vec3 | null {
  let best: { cell: Vec3; distance: number; walk: number } | null = null;
  for (let x = -radius; x <= radius; x++) for (let z = -radius; z <= radius; z++) {
    // Guarded towers wrap their crystal in bars two cells out; a stance inside
    // that ring could only be reached through them.
    if (Math.max(Math.abs(x), Math.abs(z)) < 3) continue;
    const cell = center.offset(x, -1, z);
    if (bot.blockAt(cell.offset(0, -1, 0))?.name !== "obsidian") continue;
    if ([cell, cell.offset(0, 1, 0)].some(space => bot.blockAt(space)?.boundingBox !== "empty")) continue;
    if (!crystalMeleeAimFrom(bot, crystal, eyeAt(cell))) continue;
    const distance = Math.hypot(x, z), walk = cell.distanceTo(rim);
    if (!best || distance > best.distance || (distance === best.distance && walk < best.walk)) best = { cell, distance, walk };
  }
  return best?.cell ?? null;
}

export function staircaseShortfall(bot: Bot, plan: CrystalStaircase): string | null {
  const needed = new Map<string, number>();
  for (const cell of plan.cells) {
    if (cell.blockName !== "air" && bot.blockAt(new Vec3(cell.position.x, cell.position.y, cell.position.z))?.name !== cell.blockName)
      needed.set(cell.blockName, (needed.get(cell.blockName) ?? 0) + 1);
  }
  for (const [name, count] of needed) {
    const carried = bot.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
    if (carried < count) return `[CRYSTAL_STAIRCASE_SHORTFALL] Tower at ${plan.pedestal}: ${count} ${name} blocks still needed; carrying ${carried}. Gather at least ${count - carried} more ${name} and retry this crystal. Existing staircase blocks will be reused. Alternatively, approach "pillar" scaffolds straight up beside the tower with about ${plan.pillarBlocks} carried scaffold blocks.`;
  }
  return null;
}

/** Same re-auditing builder as build_structure, under the combat body's owner. An attempt that starts inside a closed
 * cell first steps out of it, digging within the box as the policy permits; the work legs dig nothing. */
export async function buildCrystalStaircase(bot: Bot, navigation: NavigationRuntime,
  policy: Readonly<SurvivalPolicy>, plan: CrystalStaircase, signal: AbortSignal,
  startEnclosed?: () => boolean): Promise<string | null> {
  const needsBlocks = plan.cells.some(cell => cell.blockName !== "air" &&
    bot.blockAt(new Vec3(cell.position.x, cell.position.y, cell.position.z))?.name !== cell.blockName);
  if (needsBlocks && (!policy.combat.terrain.place || !policy.navigation.scaffold_blocks.includes("end_stone")))
    return "[CRYSTAL_STAIRCASE_CONSTRAINED] Building this reusable staircase requires end_stone placement permitted by the survival policy.";
  const shortfall = staircaseShortfall(bot, plan);
  if (shortfall) return shortfall;
  const towerKeys = new Set(plan.tower.map(keyOf));
  const planKeys = new Set(plan.cells.filter(cell => !isAir({ name: cell.blockName })).map(({ position }) => keyOf(position)));
  const digs: BuildRequest["movements"] = live => createMovements(bot, {
    allowDigging: policy.combat.terrain.dig, scaffolding: false, protectedCells: keptWith(live, towerKeys),
  });
  const request: BuildRequest = {
    cells: plan.cells, removeWrongBlocks: policy.combat.terrain.dig,
    movements: digs,
    routeMovements: live => crystalWorkRoutePolicy(bot, plan, keptWith(live, towerKeys)),
    routeObservation: () => workRouteObservation(bot, plan),
    route: options => navigateForWork(bot, navigation, plan.box, options),
    breakInPlace: navigation.breakBlockInPlace,
    canSeeDig: (target, standing) => canSeeClearance(bot, target, standing),
    place: placement => placeBlock(bot, placement), signal,
  };
  const progress = new BuildProgress();
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    if (!insideBox(plan.box, feetOf(bot))) {
      const foot = await navigation.navigate({ goal: nearGoal(plan.foot, BUILD_REACH), movements: digs(planKeys), signal });
      signal.throwIfAborted();
      if (foot.status === "stopped")
        return `[CRYSTAL_STAIRCASE_INCOMPLETE] The way to the staircase's foot failed: ${foot.reason} Reach the foot at ${plan.foot} before retrying this crystal.`;
    } else if (policy.combat.terrain.dig && startEnclosed?.()) {
      const cell = feetOf(bot);
      const out = await navigation.navigate({ goal: leaveCellGoal(cell, plan.box), signal,
        movements: crystalWorkRoutePolicy(bot, plan, keptWith(planKeys, towerKeys), { allowDigging: true }) });
      signal.throwIfAborted();
      if (out.status === "stopped")
        return `[CRYSTAL_STAIRCASE_INCOMPLETE] The way out of the closed cell at ${JSON.stringify(cell)} failed: ${out.reason} Open a side of the cell or choose another approach.`;
    }
    const placedBefore = progress.placed;
    const result = await build(bot, request, false, progress);
    if (result.status === "complete") return null;
    if (progress.placed <= placedBefore || attempt >= plan.cells.length || insideBox(plan.box, feetOf(bot)))
      return incompleteStaircase(bot, plan, result);
  }
}

/** The explicit clearance dig checks line of sight from its work stance. */
function canSeeClearance(bot: Bot, target: BlockPosition, standing: BlockPosition): boolean {
  const block = bot.blockAt(new Vec3(target.x, target.y, target.z));
  return block !== null && visibleBlockAim(bot.world, { ...standing, y: standing.y + STANDING_EYE_HEIGHT },
    target, DIG_REACH, observeMineflayerBlock(block).collisionShapes) !== null;
}

/** Builder exit legs keep their policy. Work goals also refuse a replan starting after a knock outside the box. */
function navigateForWork(bot: Bot, navigation: NavigationRuntime, box: WorkBox, options: Parameters<BuildRequest["route"]>[0]) {
  if (!options.onArrival) return navigation.navigate(options);
  if (!insideBox(box, feetOf(bot))) return Promise.resolve({ status: "stopped", reason: OUTSIDE_WORK_BOX, elapsedMs: 0 } as const);
  const goal = options.goal;
  return navigation.navigate({
    ...options,
    goal: { resolve: observed => insideBox(box, navigationFeet(observed.position, observed.stance === "supported")) ? goal.resolve(observed)
      : { kind: "invalid", observation: OUTSIDE_WORK_BOX } },
  });
}

/** A sphere intersects the box if its centre is within its radius of the closest point. */
function cloudMeetsBox(cloud: DragonCloud, { min, max }: WorkBox): boolean {
  return Math.hypot(Math.max(0, min.x - cloud.x, cloud.x - max.x),
    Math.max(0, min.y - cloud.y, cloud.y - max.y), Math.max(0, min.z - cloud.z, cloud.z - max.z)) <= cloud.radius;
}

/** The dragon breath clouds whose sphere meets the work box, lowest id first. */
function cloudsMeetingBox(bot: Bot, plan: CrystalStaircase): DragonCloud[] {
  return readDragonCloudHazards(bot).filter(cloud => cloudMeetsBox(cloud, plan.box)).sort((a, b) => a.id - b.id);
}

/** Only facts that could reopen a refused work route change its stamp. */
function workRouteObservation(bot: Bot, plan: CrystalStaircase): string {
  const feet = feetOf(bot);
  const clouds = cloudsMeetingBox(bot, plan)
    .map(({ id, x, y, z, radius }) => `${id}:${[x, y, z, radius].map(value => value.toFixed(1)).join(",")}`).sort();
  const states = plan.cells.map(({ position: { x, y, z } }) => bot.blockAt(new Vec3(x, y, z))?.stateId ?? "u");
  return JSON.stringify([[feet.x, feet.y, feet.z], clouds, states]);
}

/** Tell the caller which observed refusal is holding up the repair. */
function incompleteStaircase(bot: Bot, plan: CrystalStaircase, result: BuildResult): string {
  const left = result.cells.filter(cell => cell.state.kind !== "correct");
  const refused = left.find(cell => cell.state.kind === "refused" && cell.state.cause === "route");
  const first = refused ?? left[0];
  // Name the first wrong cell's own reason: "refused" alone sent a live run's
  // caller back to retry blind.
  const why = first
    ? `${first.state.kind} at ${JSON.stringify(first.cell.position)}${"reason" in first.state && first.state.reason ? `: ${first.state.reason}` : ""}`
    : "build stopped";
  const next = refused ? "Inspect or clear the blocked way to the named cell, or choose a different approach."
    : "Retry this crystal to repair and reuse the same staircase.";
  // Name the clouds meeting the box, so a caller can tell a cloud from terrain in a refused route.
  const clouds = refused ? cloudsMeetingBox(bot, plan).map(({ id, x, y, z, radius }) =>
    `Dragon breath #${id} at ${[x, y, z].map(value => value.toFixed(1)).join(", ")} (radius ${radius.toFixed(1)}) meets the staircase's work box. `).join("") : "";
  return staircaseShortfall(bot, plan) ?? `[CRYSTAL_STAIRCASE_INCOMPLETE] ${left.length} cells remain; ${refused ? why : result.reason ?? why}. ${clouds}${next}`;
}
