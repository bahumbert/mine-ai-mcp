import { bucketAvailable, predictWaterLanding, saveWaterLanding, waterLandingActive, type WaterLandingEvidence } from "../../navigation/mineflayer/water-landing.js";
import { currentVehicle } from "../../actions/navigate/vehicle-sync.js";
import { readNavigationPolicy } from "../state/navigation-policy.js";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { z } from "zod";
import { horizontalControlsToward } from "../../navigation/index.js";
import { preferredScaffoldItem } from "../../navigation/mineflayer/movement-policy.js";
import {
  canReleaseOnObservedGround,
  isSafeSupport,
  safeSupportingCell,
} from "../../navigation/world/block-geometry.js";
import type { BlockPosition, Position3, WorldView } from "../../navigation/world/world.js";
import { monotonicNow } from "../../utils/index.js";
import { waitForTicksOrCancel } from "../../utils/physics-ticks.js";
import { isReplaceableForPlacement } from "../../world/block-classification.js";
import { observedEyeHeight } from "../../world/block-visibility.js";
import { footprintColumns } from "../../world/player-physics.js";
import { findPlacementSupport, occupiedCell, placeBlock, type BlockPlacementResult } from "../../world/placement.js";
import { lowerImpulseLanding, projectedFooting } from "../positioning/footing.js";
import type { ReflexLimits } from "../control/contract.js";

/**
 * A landing may take 30 s; 5 s without landing, entering water or falling on (the base probe) ends the footing reflex,
 * then a 2 s pause. The recovery keeps the 30 s as its own bound, so a recovery inside a fight ends there too.
 */
export const FOOTING_LIMITS: ReflexLimits = { ceilingTicks: 600, noProgressTicks: 100, standDownTicks: 40 };

// Legacy mixed-phase bound (steering, server-confirmed placement): P4-35.
const FOOTING_RECOVERY_WALL_MS = 30_000;

const impulseSchema = z.object({
  entityId: z.number(),
  velocity: z.object({
    x: z.number().int().min(-32768).max(32767),
    y: z.number().int().min(-32768).max(32767),
    z: z.number().int().min(-32768).max(32767),
  }),
});

export interface FootingRecoverySnapshot {
  readonly phase: "pending" | "steering" | "placing" | "landed" | "failed" | "cancelled";
  readonly support: BlockPosition;
  readonly impulse: Position3;
  readonly startedAt: number;
  readonly placement: {
    readonly cell: BlockPosition;
    readonly result: BlockPlacementResult["kind"] | "pending";
    readonly error?: string;
  } | null;
  readonly water?: WaterLandingEvidence;
  readonly reason?: string;
}

/** Only an owner's interrupted airborne landing can pass its obligation to another owner. */
function canReopenRecovery(bot: Bot, parent: AbortSignal, body: AbortSignal): boolean {
  return parent.aborted && !body.aborted && bot.health > 0 && !currentVehicle(bot) &&
    !bot.entity.onGround && !Reflect.get(bot.entity, "isInWater") && !Reflect.get(bot.entity, "isInLava");
}

interface ImpulseLanding {
  support: BlockPosition;
  readonly originalSupportY: number;
  readonly attempted: Set<string>;
}

/** Correct the outgoing drift toward the currently observed catching floor. */
function steerTowardSupport(bot: Bot, support: BlockPosition): void {
  const controls = horizontalControlsToward(bot.entity, { x: support.x + 0.5, y: support.y, z: support.z + 0.5 }, 0.05);
  for (const control of ["forward", "back", "left", "right"] as const) bot.setControlState(control, controls[control]);
  for (const control of ["jump", "sprint", "sneak"] as const) bot.setControlState(control, false);
}

/** Remembers support across owners; only recover() is allowed to drive the body. */
export class FootingRecovery implements Disposable {
  #support: BlockPosition | null = null;
  #state: FootingRecoverySnapshot | null = null;
  #running = false;
  #peakY = -Infinity;
  #body = new AbortController();

  constructor(
    private readonly bot: Bot,
    private readonly world: WorldView,
  ) {
    this.#observe();
    bot.on("physicsTick", this.#observe);
    bot.on("respawn", this.#reset);
    bot.on("death", this.#reset);
    bot.on("mount", this.#changeVehicle);
    bot.on("dismount", this.#changeVehicle);
    bot._client.on("entity_velocity", this.#impulse);
  }

  get needed(): boolean {
    return !waterLandingActive(this.bot) && (this.#state?.phase === "pending" || this.bucketNeeded);
  }

  get bucketNeeded(): boolean {
    if (
      currentVehicle(this.bot) || waterLandingActive(this.bot) || !readNavigationPolicy(this.bot).bucket_fall_save || !bucketAvailable(this.bot) ||
      this.bot.entity.onGround || this.bot.entity.velocity.y >= -0.1 ||
      Reflect.get(this.bot.entity, "isInWater") || Reflect.get(this.bot.entity, "isInLava")
    ) return false;
    const landing = predictWaterLanding(this.bot.entity.position, this.bot.entity.velocity, this.world);
    return landing !== null && Math.max(this.#peakY, this.bot.entity.position.y) - landing.cell.y > 3;
  }

  get active(): boolean {
    return this.#running;
  }

  snapshot(): FootingRecoverySnapshot | null {
    return this.#state;
  }

  #resetContext(reason: string): void {
    this.#body.abort(reason);
    this.#body = new AbortController();
    this.#support = null;
    this.#peakY = -Infinity;
    if (!this.#running) this.#state = null;
  }

  readonly #reset = () => this.#resetContext("The body died or respawned during footing recovery.");
  readonly #changeVehicle = () => this.#resetContext("The vehicle context changed during footing recovery.");

  readonly #observe = () => {
    if (currentVehicle(this.bot)) return;
    if (!this.bot.entity.onGround) {
      this.#peakY = Math.max(this.#peakY, this.bot.entity.position.y);
      return;
    }
    this.#peakY = this.bot.entity.position.y;
    const support = safeSupportingCell(this.world, this.bot.entity.position);
    // A grounded body can overlap the lava beside its last scaffold. That
    // unsafe observation must not erase the last known landing to recover to.
    if (support) this.#support = support;
  };

  readonly #impulse = (packet: unknown) => {
    const parsed = impulseSchema.safeParse(packet);
    if (!parsed.success || parsed.data.entityId !== this.bot.entity.id || !this.#support || this.bot.health <= 0 || currentVehicle(this.bot))
      return;
    if (
      this.#running ||
      this.needed ||
      Reflect.get(this.bot.entity, "isInWater") ||
      Reflect.get(this.bot.entity, "isInLava")
    )
      return;
    if (this.bot.entity.position.y < this.#support.y) return;
    const raw = parsed.data.velocity;
    const impulse = { x: raw.x / 8000, y: raw.y / 8000, z: raw.z / 8000 };
    if (Math.hypot(impulse.x, impulse.z) === 0) return;
    const landing = projectedFooting(this.bot.entity.position, impulse, this.#support.y);
    if (canReleaseOnObservedGround(this.world, { position: landing, velocity: impulse, onGround: true })) return;
    this.#state = { phase: "pending", support: { ...this.#support }, impulse, startedAt: Date.now(), placement: null };
  };

  /** One exclusive owner corrects movement and, if needed, extends the nearby floor. */
  async recover(parentSignal: AbortSignal, protect?: () => Promise<void>): Promise<"landed" | "failed"> {
    if (this.bucketNeeded && !this.#running) return this.#recoverWater(parentSignal);
    const initial = this.#state;
    if (!initial || !this.needed || this.#running)
      throw new Error("Footing recovery requires one pending impulse and one body owner.");
    const bodySignal = this.#body.signal;
    const signal = AbortSignal.any([parentSignal, bodySignal]);
    signal.throwIfAborted();
    const heldItemName = this.bot.heldItem?.name;
    this.#running = true;
    this.#state = { ...initial, phase: "steering" };
    const landing: ImpulseLanding = { support: initial.support, originalSupportY: initial.support.y, attempted: new Set() };
    const steer = () => steerTowardSupport(this.bot, landing.support);
    this.bot.on("physicsTick", steer);
    try {
      return await this.#landImpulse(landing, signal, steer, protect);
    } catch (cause) {
      this.#state = {
        ...this.#state!,
        support: landing.support,
        phase: canReopenRecovery(this.bot, parentSignal, bodySignal) ? "pending" : signal.aborted ? "cancelled" : "failed",
        reason: String(signal.aborted ? signal.reason : cause),
      };
      throw cause;
    } finally {
      this.bot.off("physicsTick", steer);
      this.#running = false;
      this.bot.clearControlStates();
      if (!signal.aborted && this.bot.health > 0 && heldItemName && this.bot.heldItem?.name !== heldItemName) {
        const item = this.bot.inventory.items().find((item) => item.name === heldItemName);
        if (item) await this.bot.equip(item, "hand");
      }
    }
  }

  /** Drive one pending flight until the body lands, enters fluid or exhausts the existing recovery bound. */
  async #landImpulse(landing: ImpulseLanding, signal: AbortSignal, steer: () => void, protect?: () => Promise<void>): Promise<"landed" | "failed"> {
    if (protect) await protect();
    else this.bot.deactivateItem();
    steer();
    // The velocity packet can precede the physics tick that leaves the floor.
    await waitForTicksOrCancel(this.bot, 1, signal);
    const deadline = monotonicNow() + FOOTING_RECOVERY_WALL_MS;
    while (this.bot.health > 0) {
      signal.throwIfAborted();
      if (monotonicNow() >= deadline) {
        this.#state = { ...this.#state!, phase: "failed", reason: `footing not recovered in ${FOOTING_RECOVERY_WALL_MS / 1000} s` };
        return "failed";
      }
      if (canReleaseOnObservedGround(this.world, this.bot.entity)) {
        this.#state = { ...this.#state!, phase: "landed" };
        return "landed";
      }
      if (this.bucketNeeded) {
        this.bot.off("physicsTick", steer);
        return await this.#recoverWater(signal);
      }
      const position = this.bot.entity.position;
      if (Reflect.get(this.bot.entity, "isInLava") || Reflect.get(this.bot.entity, "isInWater")) break;
      if (position.y < landing.support.y) {
        const lower = lowerImpulseLanding(this.world, position, this.bot.entity.velocity, landing.originalSupportY);
        if (!lower) break;
        landing.support = lower;
      }
      if (protect) await protect();
      const projected = projectedFooting(position, this.bot.entity.velocity, landing.support.y);
      await this.#placeFirstMissingCell(position, projected, landing.support.y, landing.attempted, signal);
      await waitForTicksOrCancel(this.bot, 1, signal);
    }
    this.#state = { ...this.#state!, phase: "failed", reason: "No observed catching floor near the original support, or the body entered fluid." };
    return "failed";
  }

  /** Catch each sampled footprint, extending from a real attachment face across column corners (C11, 2026-11-17). */
  async #placeFirstMissingCell(
    position: Vec3,
    landing: Position3,
    supportY: number,
    attempted: Set<string>,
    signal: AbortSignal,
  ): Promise<void> {
    const distance = Math.hypot(landing.x - position.x, landing.z - position.z);
    const samples = Math.max(1, Math.ceil(distance * 4));
    for (let step = 0; step <= samples; step++) {
      const sample = {
        x: position.x + ((landing.x - position.x) * step) / samples,
        y: supportY,
        z: position.z + ((landing.z - position.z) * step) / samples,
      };
      const columns = [...footprintColumns(sample)];
      if (columns.some(({ x, z }) => isSafeSupport(this.world.blockAt(x, supportY - 1, z)))) continue;
      columns.sort((a, b) => Math.hypot(a.x + 0.5 - sample.x, a.z + 0.5 - sample.z) -
        Math.hypot(b.x + 0.5 - sample.x, b.z + 0.5 - sample.z));
      for (const column of columns)
        if (await this.#placeCatchingCell({ ...column, y: supportY - 1 }, position, attempted, signal)) return;
    }
  }

  /** Try one reachable, unoccupied scaffold cell once, retaining the confirmed placement across owners. */
  async #placeCatchingCell(cell: BlockPosition, position: Vec3, attempted: Set<string>, signal: AbortSignal): Promise<boolean> {
    const key = `${cell.x},${cell.y},${cell.z}`;
    if (attempted.has(key)) return false;
    const block = this.bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
    const support = findPlacementSupport(this.bot, cell);
    const item = preferredScaffoldItem(this.bot);
    if (!block || !isReplaceableForPlacement(block, this.bot.version) || !support || !item || occupiedCell(this.bot, cell))
      return false;
    const face = support.support.position.offset(0.5 + support.face.x / 2, 0.5 + support.face.y / 2, 0.5 + support.face.z / 2);
    if (face.distanceTo(position.offset(0, observedEyeHeight(this.bot.entity), 0)) > 4.5) return false;
    attempted.add(key);
    this.#state = { ...this.#state!, phase: "placing", placement: { cell: { ...cell }, result: "pending" } };
    const result = await placeBlock(this.bot, {
      item, ...support, expectedCells: [{ ...cell }], signal,
      matches: (placed) => placed.name === item.name,
      // A falling body may be saved inside a foreign region; the ledger retains the cleanup obligation.
      lifeSaving: true,
    });
    this.#state = {
      ...this.#state!, phase: "steering",
      placement: { cell: { ...cell }, result: result.kind, ...(result.kind === "failed" && { error: result.error }) },
    };
    return true;
  }

  async #recoverWater(signal: AbortSignal): Promise<"landed" | "failed"> {
    const support = this.#support ?? { x: Math.floor(this.bot.entity.position.x), y: Math.floor(this.bot.entity.position.y), z: Math.floor(this.bot.entity.position.z) };
    this.#state = { phase: "steering", support, impulse: { ...this.bot.entity.velocity }, startedAt: Date.now(), placement: null };
    this.#running = true;
    try {
      const result = await saveWaterLanding(this.bot, {
        signal: AbortSignal.any([signal, this.#body.signal]),
        permitted: () => readNavigationPolicy(this.bot).bucket_fall_save,
        observe: water => { this.#state = { ...this.#state!, water }; },
      });
      this.#state = { ...this.#state!, phase: result.waterRecovered ? "landed" : "failed", water: result };
      return result.waterRecovered ? "landed" : "failed";
    } catch (cause) {
      this.#state = { ...this.#state!, phase: signal.aborted ? "cancelled" : "failed", reason: String(cause) };
      throw cause;
    } finally {
      this.#running = false;
    }
  }

  [Symbol.dispose](): void {
    this.#body.abort("Footing recovery closed");
    this.bot.off("physicsTick", this.#observe);
    this.bot.off("respawn", this.#reset);
    this.bot.off("death", this.#reset);
    this.bot.off("mount", this.#changeVehicle);
    this.bot.off("dismount", this.#changeVehicle);
    this.bot._client.off("entity_velocity", this.#impulse);
  }
}
