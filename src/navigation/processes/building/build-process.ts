/**
 * Make every cell of a structure hold its block.
 *
 * This is Baritone's `BuilderProcess`, and it keeps that shape: every tick it
 * finds the cells that are wrong, breaks the wrong ones in reach, places the
 * placeable ones in reach without moving, and otherwise hands the pathing
 * behaviour one composite goal of the cells it can work next, revalidated as
 * the world changes rather than reissued. So the goal here is the same kind of
 * continuously evaluated object `MineProcess` uses: every time the planner
 * takes a snapshot it reclassifies the structure, and a route already running
 * walks on to whatever is workable now.
 *
 * What is left out is Baritone's schematic-aware cost context, in which a
 * route lays correct blocks as its own scaffolding. No structure asked for
 * here is tall enough to need it, and that context is what made Baritone's
 * builder hard.
 *
 * Two rules Baritone does not have. A placement never goes into the bot's own
 * cells and never seals the bot in: standing inside a structure it is asked to
 * close, the bot steps out first. And cells already correct are protected from
 * the route that reaches the next one.
 *
 * The result is every cell's final state, so a caller can say not only how
 * many cells are still wrong but why each one was left: it holds another
 * block, nothing is there to place against, its block is not carried, placing
 * it would seal the bot in, or the server or the pathfinder refused it. The
 * first ten live calls of the action above this all failed, and the model
 * retried blind, because the audit only counted.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { asVec3, monotonicNow } from "../../../utils/index.js";
import {
  findPlacementSupport,
  isAir,
  isReplaceableForPlacement,
  type BlockPlacement,
  type BlockPlacementResult,
  type RefusalCause,
  type WorldBlock,
} from "../../../world/index.js";
import {
  anyGoal,
  describeCalculationFailure,
  exactBlockGoal,
  nearGoal,
  packKey,
  type BlockPosition,
  type BreakBlockInPlace,
  type Goal,
  type MovementPolicy,
  type Navigate,
  type NavigationResult,
} from "../../index.js";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { Position3 } from "../../world/world.js";
import type { CellKeys } from "../../mineflayer/movement-policy.js";
import { facingVector } from "../../../world/facing.js";
import { clingsBehindFacing } from "../../../world/block-states.js";
import { described, faceFits, holdsCell, type BuildCell } from "./build-cell.js";
import { takeScaffoldDown } from "./scaffold-takedown.js";
import { blockRangeOf, eyeOver, reachGoal, withinBlockReach } from "./build-reach.js";
import { planStandColumns, type StandColumns } from "./stand-columns.js";
import { boundsOf, enclosesBot, feetOf, isSolid, keyOf, obstructs } from "./build-enclosure.js";

export { faceFits, holdsCell, type BuildCell } from "./build-cell.js";
export { enclosesBot } from "./build-enclosure.js";
export type { CellKeys } from "../../mineflayer/movement-policy.js";

/** A live view keeps cells the builder protects after the movement policy is made. */
export function keptWith(live: CellKeys, kept: CellKeys): CellKeys {
  return { has: (key) => live.has(key) || kept.has(key) };
}

/**
 * Passes that change nothing before the process stops. One covers a route that
 * completed without bringing anything into reach; a second in a row means the
 * world and the loop disagree about what is workable, and continuing would
 * only repeat the disagreement. A step out that moved the bot between two idle
 * routes does not reset the count (it neither counts nor forgives), so "step
 * out, route back in" cannot alternate for ever.
 */
const IDLE_PASSES = 2;

/**
 * How often the classification actually looks at the world again. The planner
 * asks for a snapshot far more often than the world changes, and every cell is
 * several block reads; the mine process throttles its rescan the same way.
 */
const REFRESH_MS = 250;

/** The states of a cell that still asks for a block of its own from the bot (not given up, not one only digging serves). */
const OWED_KINDS: ReadonlySet<BuildCellState["kind"]> = new Set(["placeable", "unsupported", "not_carried", "would_enclose", "occupied"]);

/** What one cell of the structure is, as of the last look at the world. */
export type BuildCellState =
  | { readonly kind: "correct" }
  /** Empty enough, something solid beside it, its block carried, and safe to fill. */
  | { readonly kind: "placeable"; readonly support: WorldBlock; readonly face: Vec3 }
  /** Holds another block, and the request allows digging it out; a cell asked to be air always does. */
  | { readonly kind: "diggable"; readonly holds: string }
  /** Holds another block, and the request leaves such cells alone. */
  | { readonly kind: "blocked"; readonly holds: string }
  /** Not loaded, so nothing is known until the bot is nearer. */
  | { readonly kind: "unloaded" }
  /** Nothing solid on any side to place against. */
  | { readonly kind: "unsupported" }
  | { readonly kind: "not_carried" }
  /** Filling it would leave the bot's feet with no way out. */
  | { readonly kind: "would_enclose" }
  /** The bot's own feet or head. */
  | { readonly kind: "occupied" }
  /** A failed placement, dig or route whose refusal still applies. */
  | { readonly kind: "refused"; readonly reason: string; readonly cause: RefusalCause };

export interface BuildRequest {
  readonly cells: readonly BuildCell[];
  readonly removeWrongBlocks: boolean;
  /**
   * The default policy, given the live keys of the structure's correct cells.
   */
  readonly movements: (protectedCells: CellKeys) => MovementPolicy;
  /** Policy for each work route. In-reach digs and the outside leg use `movements`. */
  readonly routeMovements?: (protectedCells: CellKeys) => MovementPolicy;
  /** A route refusal lasts while this observation stays equal. Without it, the refusal lasts the run. */
  readonly routeObservation?: () => string;
  readonly route: Navigate;
  /**
   * Whether the cells the ground cannot serve are worked from the top of pillars of scaffold (default true). The pillars are
   * planned from the level the bot first stood on, so a structure the bot climbs as it builds (a staircase up a tower, whose
   * route places no scaffold) sets false and works each cell from where its own finished part leads.
   */
  readonly standColumns?: boolean;
  readonly breakInPlace: BreakBlockInPlace;
  /** Whether the target has a reachable visible face from these feet. */
  readonly canSeeDig: (target: BlockPosition, standing: Position3) => boolean;
  /** Injectable physical placement for process regressions. */
  readonly place: (placement: BlockPlacement) => Promise<BlockPlacementResult>;
  readonly signal?: AbortSignal;
  /** A policy stop observed between completed cell operations/routes. */
  readonly stopSignal?: AbortSignal;
}

export interface BuildResult {
  readonly status: "complete" | "stopped";
  /** Why the run stopped short, when one event rather than the cell states explains it; `routeStop` when it is a route failure. */
  readonly reason: string | null;
  readonly routeStop?: true;
  readonly placed: number;
  readonly dug: number;
  readonly passes: number;
  readonly cells: readonly { readonly cell: BuildCell; readonly state: BuildCellState }[];
  /** The blocks the build's own routes placed to get about (not cells of the structure), and what became of them. */
  readonly scaffold: { readonly placed: number; readonly removed: number; readonly left: readonly BlockPosition[] };
}

export interface PlacedScaffold {
  readonly position: BlockPosition;
  readonly stateId: number;
}

/**
 * What one build request keeps when a reflex cuts it into attempts (spec 2026-10-18-reflex-continuity, R2): the tally,
 * the cells given up on, and every scaffold block its routes placed, so the attempt that finishes the structure takes
 * down the scaffold of all of them. The caller makes one per request and hands it to each `build`.
 */
export class BuildProgress {
  placed = 0;
  dug = 0;
  passes = 0;
  readonly refused = new Map<number, { readonly reason: string; readonly cause: RefusalCause; readonly stamp?: string }>();
  readonly scaffold = new Map<number, PlacedScaffold>();
  /** The feet level the bot walked on when the request first looked at the world: the level its stand columns rise from. */
  groundY: number | null = null;
  /** The item entities lying about when the request's first takedown began: a resumed takedown still picks up the drops a cut one left. */
  lyingBeforeTakedown: ReadonlySet<number> | null = null;
}

function carriedCounts(bot: Bot): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of bot.inventory.items()) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  return counts;
}

/**
 * Everything one build remembers between looks at the world: the state of
 * every cell, the cells refused this run, and the tally. It is shared by the
 * loop and the goal because they ask the same question at different rates,
 * and one cache means they can never disagree about what is workable.
 */
export class BuildTargeting {
  readonly #states = new Map<number, BuildCellState>();
  /** The correct cells as packed keys, handed to the movement policy and kept current. */
  readonly protectedCells = new Set<number>();
  /** Those of them a bot cannot walk through (a ladder is protected, yet no wall): what the enclosure check fills. */
  readonly #obstructingCells = new Set<number>();
  /** The last stamped failure in this attempt, even if its cell becomes workable again. */
  lastRouteRefusal: string | undefined;
  readonly #bounds: { readonly min: Vec3; readonly max: Vec3 };
  readonly #cellAt: ReadonlyMap<number, BuildCell>;
  /** Where the structure will hold a block of its own, built yet or not: no stand column goes through these. */
  readonly #ownBlockCells: ReadonlySet<number>;
  /** The reach of the bot's eye, read once per build (the attribute does not change within a call). */
  readonly #range: number;
  /**
   * The columns for the cells the ground cannot serve, with the cells they were chosen for: kept while those cells stay
   * the same and every column is still free. Chosen again at each look from where the bot has walked to, equal columns
   * fall the other way and the route walking to the first is revised at every step (Mine Labs 2026-11-17, saltbox roof).
   */
  #columns: { readonly owed: string; readonly plan: StandColumns } | null = null;
  #refreshedAtMs = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly bot: Bot,
    private readonly request: BuildRequest,
    /** Taking scaffold down: the highest cell first, as a pillar is taken down from its top. */
    private readonly highestFirst = false,
    /** What the request has done and given up on so far, across the attempts a reflex cut it into. */
    readonly progress: BuildProgress = new BuildProgress(),
  ) {
    this.#bounds = boundsOf(request.cells);
    this.#cellAt = new Map(request.cells.map((cell) => [keyOf(cell.position), cell]));
    this.#ownBlockCells = new Set(request.cells.filter((cell) => cell.blockName !== "air").map((cell) => keyOf(cell.position)));
    this.#range = blockRangeOf(bot);
    this.progress.groundY ??= feetOf(bot).y;
  }

  /** Whether the bot's eye, over its feet cell, reaches this cell: the server's own test of a placement or a dig. */
  reaches(position: BlockPosition): boolean {
    return withinBlockReach(eyeOver(feetOf(this.bot)), position, this.#range);
  }

  /** Work done or given up on, whose standing still across passes means the run is idle. */
  get workDone(): number {
    return this.progress.placed + this.progress.dug + this.progress.refused.size;
  }

  refuse(cell: BuildCell, reason: string, cause: RefusalCause): void {
    const stamp = cause === "route" ? this.request.routeObservation?.() : undefined;
    if (stamp !== undefined) {
      reason = `${reason}; tried again when the clouds near the build, its cells or the bot's feet change`;
      this.lastRouteRefusal = reason;
    }
    this.progress.refused.set(keyOf(cell.position), { reason, cause, ...(stamp !== undefined && { stamp }) });
    this.#refreshedAtMs = Number.NEGATIVE_INFINITY;
  }

  /** Baritone's `blacklistClosestOnFailure`: the target nearest the failure is given up on, not the build. */
  refuseClosest(position: BlockPosition, reason: string, cause: RefusalCause): boolean {
    const origin = asVec3(position);
    let closest: BuildCell | null = null;
    for (const target of this.targets()) {
      if (
        closest === null ||
        asVec3(target.position).distanceSquared(origin) < asVec3(closest.position).distanceSquared(origin)
      )
        closest = target;
    }
    if (closest === null) return false;
    this.refuse(closest, reason, cause);
    return true;
  }

  refresh(): void {
    this.#refreshedAtMs = Number.NEGATIVE_INFINITY;
    this.states();
  }

  /** Every cell's state, reclassifying the world at most every `REFRESH_MS`. */
  states(now = monotonicNow()): ReadonlyMap<number, BuildCellState> {
    if (now - this.#refreshedAtMs < REFRESH_MS) return this.#states;
    const bot = this.bot;
    const feet = feetOf(bot);
    const head = feet.offset(0, 1, 0);
    const carried = carriedCounts(bot);
    let stamp: string | undefined;
    const routeStamp = () => (stamp ??= this.request.routeObservation?.());

    this.#states.clear();
    this.protectedCells.clear();
    this.#obstructingCells.clear();
    for (const cell of this.request.cells) {
      if (cell.blockName === "air") continue;
      const block = bot.blockAt(asVec3(cell.position));
      if (block === null || !holdsCell(block, cell)) continue;
      this.protectedCells.add(keyOf(cell.position));
      if (obstructs(bot, block)) this.#obstructingCells.add(keyOf(cell.position));
    }
    for (const cell of this.request.cells) {
      this.#states.set(keyOf(cell.position), this.classify(cell, feet, head, carried, routeStamp));
    }
    this.#refreshedAtMs = now;
    return this.#states;
  }

  private classify(
    cell: BuildCell,
    feet: Vec3,
    head: Vec3,
    carried: ReadonlyMap<string, number>,
    routeStamp: () => string | undefined,
  ): BuildCellState {
    const position = asVec3(cell.position);
    const block = this.bot.blockAt(position);
    if (block === null) return { kind: "unloaded" };
    if (holdsCell(block, cell) || (cell.blockName === "air" && isAir(block))) return { kind: "correct" };
    const refused = this.progress.refused.get(keyOf(cell.position));
    if (refused !== undefined && (refused.stamp === undefined || refused.stamp === routeStamp())) {
      return { kind: "refused", cause: refused.cause, reason: refused.reason };
    }
    // A cell asked to be air can only be dug clear, so asking is allowing.
    if (cell.blockName === "air") return { kind: "diggable", holds: block.name };
    if (!isReplaceableForPlacement(block, this.bot.version)) {
      return this.request.removeWrongBlocks
        ? { kind: "diggable", holds: described(block, cell) }
        : { kind: "blocked", holds: described(block, cell) };
    }
    if (position.equals(feet) || position.equals(head)) return { kind: "occupied" };
    // A door is hung from a side wall as readily as from the floor, yet it pops when the block under it goes: nothing is
    // placed on a cell whose block under it is still to be replaced, whatever else it could rest on. An empty cell under
    // is no block to replace (a lantern hangs from its beam, which stands above it).
    const under = this.bot.blockAt(position.offset(0, -1, 0));
    if (under !== null && !isAir(under) && this.awaitsFinalBlock(under)) return { kind: "unsupported" };
    const clings = clingsBehindFacing(this.bot.registry, cell.blockName);
    const placement = findPlacementSupport(this.bot, position, (support) => isSolid(support) && !this.awaitsFinalBlock(support), (face) => faceFits(face, cell, clings));
    if (!placement) return { kind: "unsupported" };
    if ((carried.get(cell.blockName) ?? 0) === 0) return { kind: "not_carried" };
    const after = new Set(this.#obstructingCells);
    if (!clings) after.add(keyOf(cell.position));
    if (enclosesBot(this.bot, feet, after, this.#bounds)) return { kind: "would_enclose" };
    return { kind: "placeable", support: placement.support, face: placement.face };
  }

  /**
   * Whether this block is one the request still replaces: a cell of the structure that does not yet hold its block and
   * will be dug out for it (a wrong block under `removeWrongBlocks`, or a cell asked to be air). A block placed against it
   * goes when it is replaced: a door put on the stone its call then digs for the support popped and its item was lost
   * (house-templates scenario log-cabin), so such a block is no support until the cell holds its own block.
   */
  private awaitsFinalBlock(support: WorldBlock): boolean {
    const cell = this.#cellAt.get(keyOf(support.position));
    return cell !== undefined && !holdsCell(support, cell) && (this.request.removeWrongBlocks || cell.blockName === "air");
  }

  stateOf(cell: BuildCell): BuildCellState {
    return this.states().get(keyOf(cell.position)) ?? { kind: "unloaded" };
  }

  canWorkFrom(cell: BuildCell, standing: Position3): boolean {
    return this.stateOf(cell).kind !== "diggable" || this.request.canSeeDig(cell.position, standing);
  }

  wrong(): readonly BuildCell[] {
    return this.request.cells.filter((cell) => this.stateOf(cell).kind !== "correct");
  }

  /**
   * The cells worth going to, lowest first and nearest on a tie, so a wall
   * rises from its supports: those placeable or diggable now, and those not
   * loaded yet, which become one or the other once the bot is near them.
   */
  targets(): readonly BuildCell[] {
    const from = this.bot.entity.position;
    return this.request.cells
      .filter((cell) => {
        const kind = this.stateOf(cell).kind;
        return kind === "placeable" || kind === "diggable" || kind === "unloaded";
      })
      .sort(
        (left, right) =>
          (this.highestFirst ? right.position.y - left.position.y : left.position.y - right.position.y) ||
          asVec3(left.position).distanceTo(from) - asVec3(right.position).distanceTo(from),
      );
  }

  /** The bot is standing where the structure needs a block. */
  standingInStructure(): boolean {
    return this.request.cells.some((cell) => this.stateOf(cell).kind === "occupied");
  }

  /** Every remaining placement would seal the bot in, so it has to leave before any of them. */
  onlyEnclosing(): boolean {
    return (
      this.targets().length === 0 && this.request.cells.some((cell) => this.stateOf(cell).kind === "would_enclose")
    );
  }

  /** Any cell beside the structure but outside its bounds is a way out. */
  outsideGoal(): Goal {
    const feet = feetOf(this.bot);
    return nearGoal({ x: this.#bounds.max.x + 2, y: feet.y, z: this.#bounds.max.z + 2 }, 2);
  }

  private workGoal(target: BuildCell): Goal {
    const approach = reachGoal(target.position, this.#range);
    return {
      resolve: (observation) => {
        const spatial = approach.resolve(observation);
        if (spatial.kind === "invalid" || this.stateOf(target).kind !== "diggable") return spatial;
        // The bot's own cell is judged from where it really stands, as the
        // in-reach work will aim from there; the centre of that cell is not
        // where an off-centre bot is. The live house of 30 September idled out
        // on that disagreement: the route arrived at once, nothing was seen.
        const here = observation.position;
        return {
          ...spatial,
          revision: `visible-dig:${spatial.revision}`,
          isSatisfied: (node, world) =>
            spatial.isSatisfied(node, world) &&
            this.canWorkFrom(
              target,
              node.feet.x === Math.floor(here.x) && node.feet.y === Math.floor(here.y) && node.feet.z === Math.floor(here.z)
                ? here
                : { x: node.feet.x + 0.5, y: node.feet.y, z: node.feet.z + 0.5 },
            ),
        };
      },
    };
  }

  /**
   * The columns to stand on for the cells to place that the ground cannot serve, from the last look at the world: a cell
   * out of the eye's reach from the ground is worked from the top of a pillar chosen to serve many cells, not from
   * under itself. Only a cell to place is served so (a dig also needs a visible face, which the cell's own goal checks).
   */
  private standColumns(): StandColumns {
    if (this.request.standColumns === false) return { columns: [], served: new Set() };
    const feet = feetOf(this.bot);
    const ground = this.progress.groundY ?? feet.y;
    const cells = this.request.cells.flatMap((cell) => {
      const kind = this.stateOf(cell).kind;
      // Every block still owed, the layers waiting for their support included: a roof's layers share their pillars.
      return OWED_KINDS.has(kind) && cell.blockName !== "air"
        ? [{ ...cell.position, key: keyOf(cell.position), placeable: kind === "placeable" }]
        : [];
    });
    const owed = cells.map((cell) => `${cell.key}${cell.placeable ? "+" : "-"}`).join(",");
    const isFree = (x: number, y: number, z: number): boolean => {
      const key = packKey(x, y, z);
      if (this.#ownBlockCells.has(key)) return false;
      const block = this.bot.blockAt(new Vec3(x, y, z));
      return block !== null && (!obstructs(this.bot, block) || this.progress.scaffold.has(key));
    };
    const kept = this.#columns;
    // A kept column is free from the ground to the head room of its top (the cells `planStandColumns` asked free).
    const stillFree = (plan: StandColumns) =>
      plan.columns.every((column) => Array.from({ length: column.height + 2 }, (_, up) => isFree(column.x, ground + up, column.z)).every(Boolean));
    if (kept !== null && kept.owed === owed && stillFree(kept.plan)) return kept.plan;
    const plan = planStandColumns({ cells, ground, range: this.#range, near: feet, isFree });
    this.#columns = { owed, plan };
    return plan;
  }

  /**
   * The goal Baritone revalidates rather than reissues: within reach of any
   * workable cell, or on top of a column that serves the cells the ground cannot.
   * Every snapshot is a fresh look at the structure, so a route already running
   * walks on to whatever is workable now.
   */
  goal(): Goal {
    return {
      resolve: (observation) => {
        const targets = this.targets();
        if (targets.length === 0) return { kind: "invalid", observation: "No workable cell remains." } as const;
        const { columns, served } = this.standColumns();
        const ground = this.progress.groundY ?? feetOf(this.bot).y;
        const goals = [
          ...columns.map((column) => exactBlockGoal({ x: column.x, y: ground + column.height, z: column.z })),
          ...targets.filter((target) => !served.has(keyOf(target.position))).map((target) => this.workGoal(target)),
        ];
        return anyGoal(goals).resolve(observation);
      },
    };
  }

  identity(): string {
    return this.targets()
      .map((target) => keyOf(target.position))
      .join("|");
  }

  result(status: BuildResult["status"], reason: string | null, routeStop = false): BuildResult {
    this.refresh();
    return {
      status,
      reason,
      ...(routeStop && { routeStop: true as const }),
      placed: this.progress.placed,
      dug: this.progress.dug,
      passes: this.progress.passes,
      cells: this.request.cells.map((cell) => ({ cell, state: this.stateOf(cell) })),
      scaffold: { placed: 0, removed: 0, left: [] },
    };
  }
}

/**
 * Baritone's builder breaks and places in reach before it will consider
 * pathing anywhere. Lowest first, refreshing after each so a cell placed this
 * pass supports the next; a cell that fails is refused for the run.
 */
async function workInReach(
  bot: Bot,
  request: BuildRequest,
  targeting: BuildTargeting,
  movements: MovementPolicy,
  signal?: AbortSignal,
): Promise<boolean> {
  let worked = false;
  // The bot has usually just arrived somewhere, so what is in reach, occupied,
  // or enclosing is not what the last look said.
  targeting.refresh();
  for (;;) {
    signal?.throwIfAborted();
    if (request.stopSignal?.aborted) return worked;
    const target = targeting
      .targets()
      .find((cell) => targeting.reaches(cell.position) && targeting.canWorkFrom(cell, bot.entity.position));
    if (!target) return worked;
    const state = targeting.stateOf(target);
    if (state.kind === "diggable") await digCell(bot, request, targeting, movements, target, state.holds, signal);
    else if (state.kind === "placeable") {
      // The body moved off before the click: where it stands now is for the caller's next look (the route), not this loop's.
      if (!(await placeCell(bot, request, targeting, target, state, signal))) return worked;
    } else {
      // A cell within reach that still reads as unloaded is nothing to work on.
      return worked;
    }
    worked = true;
    targeting.refresh();
  }
}

/**
 * Break what blocks a cell. A reflex that aborts the attempt after the block came out still gets the dig counted
 * (spec 2026-10-18 R2: progress is kept before an abort can throw), or the resumed attempt would report less than it did.
 */
async function digCell(
  bot: Bot,
  request: BuildRequest,
  targeting: BuildTargeting,
  movements: MovementPolicy,
  target: BuildCell,
  holds: string,
  signal?: AbortSignal,
): Promise<void> {
  const heldBefore = bot.blockAt(asVec3(target.position))?.name;
  try {
    const dug = await request.breakInPlace({ movements, position: target.position, signal });
    if (dug.status === "broken") targeting.progress.dug += 1;
    else targeting.refuse(target, `${holds} there could not be cleared: ${dug.reason}`, dug.cause === "policy" ? "policy" : "placement");
  } catch (error) {
    if (bot.blockAt(asVec3(target.position))?.name !== heldBefore) targeting.progress.dug += 1;
    throw error;
  }
}

/**
 * Put the cell's block down; an abort after the block landed still counts the placement (same rule as `digCell`). The
 * reach was judged before the placement's equip and turn: it is judged again at the send (`stillInReach`), and a body that
 * moved off leaves the cell as it was, to be worked again from where the route puts the bot, not refused. Returns whether
 * the call changed anything (a placement or a refusal), which the idle-pass count needs.
 */
async function placeCell(
  bot: Bot,
  request: BuildRequest,
  targeting: BuildTargeting,
  target: BuildCell,
  state: Extract<BuildCellState, { kind: "placeable" }>,
  signal?: AbortSignal,
): Promise<boolean> {
  const item = bot.inventory.items().find((candidate) => candidate.name === target.blockName)!;
  try {
    const placed = await request.place({
      item,
      support: state.support,
      face: state.face,
      expectedCells: [target.position],
      matches: (block) => holdsCell(block, target),
      stillInReach: () => targeting.reaches(target.position),
      ...(target.facing !== undefined && { lookDirection: facingVector(target.facing) }),
      ...(target.half !== undefined && { half: target.half }),
      signal,
    });
    if (placed.kind === "placed") {
      targeting.progress.placed += 1;
      return true;
    }
    if (placed.cause === "moved") return false;
    targeting.refuse(target, placed.error, placed.cause ?? "placement");
    return true;
  } catch (error) {
    const block = bot.blockAt(asVec3(target.position));
    if (block !== null && holdsCell(block, target)) targeting.progress.placed += 1;
    throw error;
  }
}

export async function build(
  bot: Bot,
  request: BuildRequest,
  takingScaffoldDown = false,
  progress: BuildProgress = new BuildProgress(),
): Promise<BuildResult> {
  const targeting = new BuildTargeting(bot, request, takingScaffoldDown, progress);
  const movements = request.movements(targeting.protectedCells);
  // Every block the routes of this request placed (live 2026-10-11, Theo: a ring of dirt at head height round his new
  // house shut him in): taken down once the structure is complete, those of earlier attempts included.
  const scaffold = progress.scaffold;
  // The takedown's own routes pillar up to the highest block too: what they place is kept, for the next round of the takedown.
  const onPlacement = (placed: PlacedScaffold) => void scaffold.set(keyOf(placed.position), placed);
  let idlePasses = 0;
  // A step-out that moved the bot ran since the last route pass: if the next idle route reaches the limit, the stop says so.
  let steppedOutSinceRoute = false;

  for (;;) {
    // Each pass gives the event loop a turn: a pass whose route and work resolve at once (nothing to walk, nothing in
    // reach) otherwise runs on promises alone and starves every timer, the runtime's heartbeat included.
    await nextTurn();
    request.signal?.throwIfAborted();
    if (request.stopSignal?.aborted) return targeting.result("stopped", String(request.stopSignal.reason));
    targeting.progress.passes += 1;
    targeting.refresh();
    if (targeting.wrong().length === 0) return takingScaffoldDown ? targeting.result("complete", null) : takeScaffoldDown(bot, request, targeting.result("complete", null), progress);
    const workBefore = targeting.workDone;

    // Standing in a cell the structure needs means every placement around it
    // would either be refused or wall the bot into a pit, so step out first;
    // likewise when every remaining placement would seal the bot in.
    if (targeting.standingInStructure() || targeting.onlyEnclosing()) {
      const before = feetOf(bot);
      const exit = await request.route({ movements, goal: targeting.outsideGoal(), signal: request.signal, stopSignal: request.stopSignal, onPlacement });
      if (exit.status === "stopped") {
        return targeting.result("stopped", `could not step out of the structure: ${exit.reason}`);
      }
      // An exit that left the bot where it was changes nothing the next pass would see: it counts. One that moved neither
      // counts nor resets: moving out is not work (a reset here let "step out" and "route back in" alternate for ever,
      // review B1), and the exit route cannot place, dig or refuse a cell, so nothing here is progress.
      if (feetOf(bot).equals(before)) idlePasses += 1;
      else steppedOutSinceRoute = true;
      if (idlePasses >= IDLE_PASSES) {
        return targeting.result("stopped", "could not step out of the structure: the way out leaves it where it stands");
      }
      continue;
    }

    if (await workInReach(bot, request, targeting, movements, request.signal)) {
      idlePasses = 0;
      steppedOutSinceRoute = false;
      continue;
    }
    if (targeting.targets().length === 0) return targeting.result("stopped", null);

    const routed = targeting.identity();
    const route = await runRoute(bot, request, targeting, movements, onPlacement);
    if (route.status === "stopped") {
      targeting.refresh();
      if (request.stopSignal?.aborted) return targeting.result("stopped", String(request.stopSignal.reason));
      // A goal the search could not reach is not a reason to abandon the build,
      // only that cell — unless the targets already changed underneath it.
      if (targeting.identity() === routed && !targeting.refuseClosest(feetOf(bot), route.reason, "route")) {
        return targeting.result("stopped", route.reason, true);
      }
    }

    idlePasses = targeting.workDone === workBefore ? idlePasses + 1 : 0;
    if (idlePasses >= IDLE_PASSES) {
      if (steppedOutSinceRoute) {
        return targeting.result("stopped", `${IDLE_PASSES} passes changed nothing: the bot stepped out of the structure and the walk back to the work placed and dug nothing; last route ${route.status}`);
      }
      const lastRoute = targeting.lastRouteRefusal === undefined
        ? `last route ${route.status}`
        : `last work route refusal: ${targeting.lastRouteRefusal}`;
      return targeting.result("stopped", `${IDLE_PASSES} passes changed nothing; ${lastRoute}`, true);
    }
    steppedOutSinceRoute = false;
  }
}

/** One leg: walk under a goal that keeps re-evaluating, working every arrival, until nothing workable remains. */
async function runRoute(
  bot: Bot,
  request: BuildRequest,
  targeting: BuildTargeting,
  movements: MovementPolicy,
  onPlacement: (placed: PlacedScaffold) => void,
): Promise<NavigationResult> {
  const goal = targeting.goal();
  const stampsRefusals = request.routeObservation !== undefined;
  let revision: string | null | undefined;
  const trackedGoal: Goal = {
    resolve(observation) {
      const resolved = goal.resolve(observation);
      revision = resolved.kind === "active" && (revision === undefined || revision === resolved.revision)
        ? resolved.revision
        : null;
      return resolved;
    },
  };
  return request.route({
    movements: request.routeMovements?.(targeting.protectedCells) ?? movements,
    onPlacement,
    goal: stampsRefusals ? trackedGoal : goal,
    onArrival: async ({ signal }) => {
      // An arrival that works nothing ends the route: continuing would ask the
      // navigator the same question from the same place, and the loop above
      // counts idle passes where a route cannot.
      if (!(await workInReach(bot, request, targeting, movements, signal))) return { kind: "completed" };
      targeting.refresh();
      const more = targeting.targets().length > 0 && !targeting.standingInStructure();
      revision = undefined;
      return more ? { kind: "continue" } : { kind: "completed" };
    },
    onCalculationFailure: async ({ failure, observation }) => {
      if (stampsRefusals) {
        // The navigator may finish a search after a refused cell has rejoined its live goal.
        targeting.refresh();
        trackedGoal.resolve(observation);
        if (revision === null) return { kind: "completed" };
      }
      const workBefore = targeting.workDone;
      targeting.refuseClosest(observation.position, describeCalculationFailure(failure), "route");
      // A repeat can leave a moving set of targets inside this route. Let the outer pass count the idle work.
      if (stampsRefusals && targeting.workDone === workBefore) return { kind: "completed" };
      targeting.refresh();
      revision = undefined;
      return targeting.targets().length > 0 ? { kind: "continue" } : { kind: "completed" };
    },
    signal: request.signal,
    stopSignal: request.stopSignal,
  });
}

