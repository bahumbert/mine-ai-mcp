// Remember one mining run's targets, exclusions, drops, casts, and exploration goal.
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { asVec3, cellKey } from "../../../utils/index.js";
import { droppedItemName } from "../../../world/item-pickup.js";
import { isLiquidSource } from "../../../world/liquid.js";
import { anyGoal, type BlockPosition, type Goal } from "../../index.js";
import { branchMiningGoal } from "./block-exploration.js";
import { carriesWaterBucket } from "./cast-obsidian.js";
import { CastTargets } from "./cast-targets.js";
import { DROP_PICKUP_TIMEOUT_MS, MineDropTracker } from "./mine-drops.js";
import { isDropTarget, mineTargetGoal, targetIdentity } from "./mine-target-goal.js";
import { MAX_MINE_TARGETS, scanMineTargets } from "./mine-target-scan.js";
import { MineWeighing } from "./target-weighing.js";
import type { MinecraftBlock, MineBlockTarget, MinePoolTarget, MineRequest, MineTarget, MineWaterTarget } from "./mine-process.js";

/**
 * How often the goal actually looks at the world again.
 *
 * The planner asks for a snapshot far more often than the world changes, and a
 * scan is 256 block reads. Baritone throttles the same rescan with
 * `mineGoalUpdateInterval`, five ticks. Between refreshes the cached target set
 * is returned unchanged, which also keeps the goal's revision stable so the
 * planner is not told the goal moved when it did not.
 */
const GOAL_UPDATE_MS = 250;

type WaterRecovery =
  | { readonly kind: "none" }
  | { readonly kind: "casting" }
  | { readonly kind: "pending"; readonly target: MineWaterTarget }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Everything one mining run remembers between looks at the world.
 *
 * It is shared by the loop and the goal because they are asking the same
 * question at different rates: the goal on every planner snapshot, the loop
 * once a route has ended. Keeping one cache means they can never disagree about
 * what the targets are.
 */
export class MineTargeting {
  #water: WaterRecovery = { kind: "none" };
  readonly #blockBlacklist = new Set<string>();
  readonly #blockStances = new Map<string, ReadonlySet<string>>();
  /** Why the last stance of each block target was refused, for the scan's refusal once none is left. */
  readonly #stanceRefusals = new Map<string, string>();
  readonly #casts: CastTargets;
  /** Sources beside a target already poured on once; a second look seals them. */
  readonly #touchingCasts = new Set<string>();
  readonly #dropBlacklist = new Set<number>();
  readonly #anticipatedDropBlacklist = new Set<string>();
  readonly #drops: MineDropTracker;
  #targets: readonly MineTarget[] = [];
  #goal: Goal | null = null;
  #branchGoal: Goal | null = null;
  #branchFailure: string | null = null;
  #knownBlocks: readonly { readonly position: BlockPosition; readonly block: MinecraftBlock | null }[] = [];
  #refreshedAtMs = Number.NEGATIVE_INFINITY;
  /** Monotonic: a wall clock that steps (NTP, WSL host sync) must not stretch or cut the drop timers. */
  readonly #now: () => number;
  #announced = "";
  /** Why each loaded matching block the last scan saw could not be a target, and how many were rejected for it. */
  rejections: ReadonlyMap<string, number> = new Map();
  underWaterRejections = 0;
  readonly weighing: MineWeighing;
  /** A previous approach or in-place break makes "none was walked to" false, even when it succeeded. */
  attemptedWork = false;
  readonly broken: BlockPosition[] = [];
  lastReason: string | null = null;
  /** Whether a just-broken source is still awaiting its item entity. */
  get anticipatingDrop(): boolean {
    return this.#drops.anticipating;
  }

  dropInFlight(entityId: number): boolean {
    return this.#drops.inFlight(entityId);
  }

  constructor(
    private readonly bot: Bot,
    private readonly request: MineRequest,
  ) {
    this.weighing = new MineWeighing(request);
    this.#now = request.now ?? (() => performance.now());
    this.#casts = new CastTargets(bot, request, MAX_MINE_TARGETS);
    this.#drops = new MineDropTracker(bot, request, this.#dropBlacklist, this.#anticipatedDropBlacklist);
  }

  isSatisfied(): boolean {
    if (!this.request.isSatisfied() || this.#water.kind !== "none") return false;
    // Incidental drops can satisfy a quantity, but a named block must also have
    // been observed removed during this run.
    const exact = this.request.exactTarget;
    return exact === undefined || this.broken.some((position) => cellKey(position) === cellKey(exact));
  }

  get waterFailure(): string | null {
    return this.#water.kind === "failed" ? this.#water.reason : null;
  }

  mayCastTouching(source: BlockPosition): boolean {
    return !this.#touchingCasts.has(cellKey(source));
  }
  castTouching(sources: readonly BlockPosition[]): void {
    for (const source of sources) this.#touchingCasts.add(cellKey(source));
  }
  forgetCastTouching(sources: readonly BlockPosition[]): void {
    for (const source of sources) this.#touchingCasts.delete(cellKey(source));
  }

  beginCast(): void {
    this.#water = { kind: "casting" };
  }
  endCast(): void {
    this.#water = { kind: "none" };
  }

  recoverWater(position: BlockPosition): void {
    this.#water = { kind: "pending", target: { kind: "water", position, excludedStances: new Set() } };
    this.#refreshedAtMs = Number.NEGATIVE_INFINITY;
  }

  excludeWaterStance(target: MineWaterTarget, feet: BlockPosition, reason: string): void {
    this.#water = {
      kind: "pending",
      target: { ...target, excludedStances: new Set([...target.excludedStances, cellKey(feet)]) },
    };
    this.lastReason = `water at ${cellKey(target.position)} was not recovered: ${reason}`;
    this.#refreshedAtMs = Number.NEGATIVE_INFINITY;
  }

  get blacklisted(): number {
    return (
      this.#blockBlacklist.size +
      this.#dropBlacklist.size +
      this.#anticipatedDropBlacklist.size +
      this.#casts.blacklisted
    );
  }

  get exploring(): boolean {
    return this.#targets.length === 0 && this.#branchGoal !== null && this.#branchFailure === null;
  }

  get explorationFailure(): string | null {
    return this.#branchFailure;
  }

  failExploration(reason: string): void {
    this.#branchFailure = reason;
    this.lastReason = reason;
  }

  /** Refuse one stance of the target, not the block: the scan keeps it while another working cell is left. */
  excludeBlockStance(target: MineBlockTarget, feet: BlockPosition, reason?: string): void {
    const key = cellKey(target.position);
    this.#blockStances.set(key, new Set([...this.#blockStances.get(key) ?? [], cellKey(feet)]));
    this.lastReason = reason ?? `the target at ${key} is occluded from ${cellKey(feet)}`;
    this.#stanceRefusals.set(key, this.lastReason);
    this.#refreshedAtMs = Number.NEGATIVE_INFINITY;
  }

  /** A failed aiming position says nothing about the other shores of a pool. */
  excludeCastStance(target: MinePoolTarget, feet: BlockPosition, reason: string): void {
    this.#casts.excludeStance(target, feet);
    this.lastReason = reason;
    this.#refreshedAtMs = Number.NEGATIVE_INFINITY;
  }

  blacklist(target: MineTarget, reason?: string): void {
    switch (target.kind) {
      case "water":
        this.#water = {
          kind: "failed",
          reason: `water at ${cellKey(target.position)} could not be recovered: ${reason ?? "unreachable"}`,
        };
        this.lastReason = this.#water.reason;
        this.#refreshedAtMs = Number.NEGATIVE_INFINITY;
        return;
      case "block":
        this.#blockBlacklist.add(cellKey(target.position));
        break;
      case "drop":
        this.#dropBlacklist.add(target.entityId);
        break;
      case "anticipated_drop":
        this.#anticipatedDropBlacklist.add(cellKey(target.position));
        break;
      case "settling_drop":
        this.#dropBlacklist.add(target.entityId);
        break;
      // A failed use or fruitless pour applies to this pool. An unavailable
      // aiming position goes through excludeCastStance instead.
      case "pool":
        this.#casts.blacklist(target);
        break;
    }
    if (reason !== undefined) this.lastReason = reason;
    this.#refreshedAtMs = Number.NEGATIVE_INFINITY;
  }

  /** Give up on the block target at `position`, when there is one, and say whether there was. */
  blacklistAt(position: BlockPosition, reason: string): boolean {
    const target = this.#targets.find(
      (candidate) => candidate.kind === "block" && cellKey(candidate.position) === cellKey(position),
    );
    if (!target) return false;
    this.blacklist(target, reason);
    return true;
  }

  /** Blacklist the known target nearest the bot's position when calculation failed. */
  /**
   * Give up on the target nearest `position` among those the failed route
   * was asked for, and say whether there was one.
   *
   * The candidates are the current target set, not a fresh scan: the failure
   * belongs to the goal the search just answered, and a scan taken now can
   * put a lava lip or an obsidian block nearer the bot than the drop the
   * route could not reach. Blacklisting that instead left the drop in the goal
   * and the miner circling a water pocket for seven minutes.
   */
  blacklistClosest(position: { readonly x: number; readonly y: number; readonly z: number }, reason: string): boolean {
    const candidates = this.#targets.length > 0 ? this.#targets : this.refresh();
    const target = candidates.reduce<MineTarget | null>((closest, candidate) => {
      if (closest === null) return candidate;
      const candidateDistance = asVec3(candidate.position).distanceSquared(
        new Vec3(position.x, position.y, position.z),
      );
      const closestDistance = asVec3(closest.position).distanceSquared(new Vec3(position.x, position.y, position.z));
      return candidateDistance < closestDistance ? candidate : closest;
    }, null);
    if (target === null) return false;
    this.blacklist(target, reason);
    return true;
  }

  refresh(): readonly MineTarget[] {
    this.#refreshedAtMs = Number.NEGATIVE_INFINITY;
    return this.targets();
  }

  /** The current target set, rescanning the world at most every `GOAL_UPDATE_MS`. */
  targets(now = this.#now()): readonly MineTarget[] {
    if (now - this.#refreshedAtMs < GOAL_UPDATE_MS) return this.#targets;

    // A block this run knew about that is loaded and no longer matches came
    // down, whoever removed it. The route breaks its own target on the way in,
    // so this is the only place a break can be observed.
    for (const { position, block: before } of this.#knownBlocks) {
      const block = this.bot.blockAt(asVec3(position));
      if (block === null || this.request.matches(block)) continue;
      this.broken.push(position);
      this.request.onBroken?.(position);
      this.#drops.noteBreak(position, now, before);
    }

    const scanResult = scanMineTargets(this.bot, this.request, {
      blockCells: this.#blockBlacklist,
      blockStances: this.#blockStances,
      stanceRefusals: this.#stanceRefusals,
      dropEntities: this.#dropBlacklist,
    });
    const found = [...scanResult.targets];
    this.rejections = scanResult.rejections;
    this.underWaterRejections = scanResult.underWaterRejections;
    this.weighing.observe(scanResult, this.bot.entity.position);
    const tracked = this.#drops.update(found, now);
    // An item the bot stands in that never enters the inventory is one the
    // inventory cannot take. Give it up now rather than when the server
    // despawns it; whether a full bag ends the run is the caller's decision.
    for (const target of tracked) {
      if (target.kind !== "drop" || !this.#drops.pickupStalled(target.entityId, now)) continue;
      const entity = this.bot.entities[target.entityId];
      const name = (entity === undefined ? null : droppedItemName(entity)) ?? "item";
      this.blacklist(
        target,
        `the ${name} drop at ${cellKey(target.position)} was not picked up after ${DROP_PICKUP_TIMEOUT_MS / 1000} s in reach, so the inventory cannot take it`,
      );
    }
    this.#targets = tracked.filter((target) => {
      if (target.kind === "block") return !this.#blockBlacklist.has(cellKey(target.position));
      if (target.kind === "drop" || target.kind === "settling_drop") return !this.#dropBlacklist.has(target.entityId);
      return !this.#anticipatedDropBlacklist.has(cellKey(target.position));
    });
    this.#knownBlocks = this.#targets.filter((target) => target.kind === "block").map(({ position }) => ({ position, block: this.bot.blockAt(asVec3(position)) }));
    // Obsidian is the one block a bot manufactures, so a cast request with
    // nothing to mine makes its targets out of the lava it can see. Asked only
    // then, which keeps a second full scan off every ordinary refresh.
    // Known limitation: any loaded obsidian, even far away, is preferred over
    // casting nearby lava; travel and casting cost are not compared.
    if (this.#targets.length === 0) this.#targets = this.#casts.scan();
    // Recover observed drops before offering more blocks to mine. Cheap breaks
    // in a netherrack bank otherwise keep winning at the current stance until
    // the break budget is exhausted, with the requested items still on ledges.
    // Keep known blocks above so route excavation remains part of the evidence.
    if (this.#targets.some(isDropTarget)) this.#targets = this.#targets.filter(isDropTarget);
    if (this.#water.kind === "pending") {
      if (carriesWaterBucket(this.bot)) this.#water = { kind: "none" };
      else if (!isLiquidSource(this.bot, this.bot.blockAt(asVec3(this.#water.target.position)), "water")) {
        this.blacklist(this.#water.target, "the poured source is no longer observed there");
      }
    }
    if (this.#water.kind === "pending") this.#targets = [this.#water.target];
    if (this.#water.kind === "failed") this.#targets = [];
    this.#goal = this.#targets.length === 0 ? null : anyGoal(this.#targets.map((target) => mineTargetGoal(this.bot, target, this.request.movements)));
    if (this.#targets.length === 0 && this.request.explore && this.#branchGoal === null) {
      const feet = this.bot.entity.position.floored();
      this.#branchGoal = branchMiningGoal({ x: feet.x, y: feet.y, z: feet.z });
    }
    // Measure the cache window from completed work. If a rich block refresh
    // itself takes longer than the interval, recording its start time makes it
    // immediately stale and every search slice performs the whole scan again.
    this.#refreshedAtMs = this.#now();
    this.announce();
    return this.#targets;
  }

  /** Notify from the refresh itself, so route-time changes cannot leave observers stale. */
  private announce(): void {
    if (!this.request.onTargets) return;
    const identity = this.#targets.map(targetIdentity).join("|");
    if (identity === this.#announced) return;
    this.#announced = identity;
    this.request.onTargets(this.#targets);
  }

  /** The target nearest `position` among those the last search was asked for; see `blacklistClosest`. */
  closestTarget(position: { readonly x: number; readonly y: number; readonly z: number }): MineTarget | null {
    const origin = new Vec3(position.x, position.y, position.z);
    const candidates = this.#targets.length > 0 ? this.#targets : this.targets();
    return candidates.reduce<MineTarget | null>((closest, candidate) => {
      if (closest === null) return candidate;
      return asVec3(candidate.position).distanceSquared(origin) < asVec3(closest.position).distanceSquared(origin)
        ? candidate
        : closest;
    }, null);
  }

  /**
   * The goal Baritone revalidates rather than reissues. Every snapshot is a
   * fresh look at the world, so a route already running walks on to whatever is
   * cheapest now instead of being torn down and replanned from scratch.
   */
  routeGoal(): Goal {
    this.attemptedWork = true;
    return {
      resolve: (observation) => {
        const targets = this.targets();
        if (targets.length > 0 && this.#goal !== null) return this.#goal.resolve(observation);
        if (this.waterFailure === null && this.#branchGoal !== null) return this.#branchGoal.resolve(observation);
        return { kind: "invalid", observation: "No mineable target remains in range." } as const;
      },
    };
  }
}
