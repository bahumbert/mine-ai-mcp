// Snapshot-only night, respawn and low-health events, independent of the agent loop.
import type { LastDeath } from "../last-death.ts";
import { sameDimension } from "../bot-data-sql.ts";
import { oneLine } from "../condition.ts";
import { monotonicNow } from "../monotonic-clock.ts";
import type { Persona } from "../persona.ts";
import { cut } from "../prompt-budget.ts";
import type { BotSnapshot, Position } from "../runtime-client.ts";

// Game knowledge, unverified here (backlog P4-18): sunset to first surface monster spawns in clear weather.
export const DUSK_FROM_TICK = 12_000;
export const DUSK_TO_TICK = 13_188;
export const DUSK_SPREAD_MS = 59_400;
export const SITUATION_POLL_MS = 10_000;
export const COVER_REFRESH_MS = 30_000;
export const LOW_HEALTH_STEP = 4;
export const HEART = 2;
/** Runtime default: src/survival/policy/combat/contract.ts:86. */
export const DEFAULT_CRITICAL_HEALTH = 8;
/** Runtime STALE_RECOVERY_MS: src/actions/pick-up-items/pick-up-items.ts:17. */
export const RECOVERY_MINUTES = 5;
export const TICKS_PER_MINUTE = 1200;
// Copies of src/world/daylight.ts:11-12; the brain imports no runtime code.
export const BEDTIME_START_TICK = 12_542;
export const BEDTIME_END_TICK = 23_458;

export type SituationKind = "night" | "respawn" | "low_health";
export interface SituationInfo {
  readonly kind: SituationKind;
  readonly cause: string;
  readonly raisedAt: number;
  readonly death?: LastDeath;
  readonly health?: number;
}
export interface SituationHost {
  readonly persona: Persona;
  readonly random: () => number;
  status(): Promise<BotSnapshot>;
  underCover(at: Position): Promise<boolean>;
  busy(): readonly SituationKind[];
  answeringNight(): "night" | "for now" | null;
  raise(info: SituationInfo, snapshot: BotSnapshot): void;
  end(kind: SituationKind, detail: string, snapshot: BotSnapshot): void;
  /** Each drained observation, fallback polls included, after its events are decided (the open-sky report follows the night). */
  observed?(snapshot: BotSnapshot): void;
}

/** One test of this bot's night, including its early dusk point. */
export function nightFor(timeOfDay: number, duskPoint: number): boolean {
  return duskPoint <= timeOfDay && timeOfDay <= BEDTIME_END_TICK;
}

/** Real minutes at 20 TPS, left unrounded until shown to the model. */
export function minutesToDay(timeOfDay: number): number {
  return (BEDTIME_END_TICK + 1 - timeOfDay) / TICKS_PER_MINUTE;
}

/** A missing clock or null phase gives no overworld night facts. */
export function inOverworld(snapshot: BotSnapshot): boolean {
  return snapshot.clock?.phase != null;
}

/** Unknown footing cannot authorize stopping a step at a safe place. */
export function restsOnLand(snapshot: BotSnapshot): boolean {
  return snapshot.vehicle == null && snapshot.footing?.onGround === true && !snapshot.footing.inWater && snapshot.footing.inLava !== true;
}

/** The persona overrides the runtime's effective setting, then its default. */
export function lowHealthAt(snapshot: BotSnapshot, persona: Persona): number {
  return persona.settings.lowHealthAt ?? snapshot.policy?.criticalHealth ?? DEFAULT_CRITICAL_HEALTH;
}

interface Observation {
  readonly snapshot: BotSnapshot;
  readonly generation: number;
}
interface CoverKey {
  readonly position: Position;
  readonly dimension: string;
  readonly night: number;
}
interface CoveredCell {
  readonly key: CoverKey;
  readonly readAt: number;
}

/** Cover belongs to a block cell, dimension and night, never just the latest bot position. */
function coverKey(snapshot: BotSnapshot, night: number): CoverKey {
  const { x, y, z } = snapshot.position;
  return { position: { x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }, dimension: snapshot.dimension, night };
}

/** Dimension aliases refer to the same cell. */
function sameCoverKey(a: CoverKey, b: CoverKey): boolean {
  return a.night === b.night && sameDimension(a.dimension, b.dimension) &&
    a.position.x === b.position.x && a.position.y === b.position.y && a.position.z === b.position.z;
}

/** Cause coordinates follow the runtime's block convention, including negative positions. */
export function coordinates(at: Position): string {
  return `${Math.floor(at.x)} ${Math.floor(at.y)} ${Math.floor(at.z)}`;
}

/** Server text cannot create a second prompt line; the same bounds as condition.ts apply (spec D5). */
function deathCause(death: LastDeath, snapshot: BotSnapshot, night: boolean): string {
  const cause = death.cause === null ? "" : cut(oneLine(death.cause), 120);
  const prefix = night ? `It is night (day comes in ${minutesToDay(snapshot.clock!.timeOfDay!).toFixed(1)} min). ` : "";
  return `${prefix}You died ${Number(death.minutesAgo.toFixed(1))} min ago at ${coordinates(death.position)}${cause === "" ? "" : ` (${cause})`} and respawned at ${coordinates(snapshot.position)}`;
}

/** Serial snapshot processing keeps only the newest waiting sample and never acts on stale cover or poll answers. */
export class SituationWatch {
  #snapshot: BotSnapshot | null = null;
  #latest: Observation | null = null;
  #observing: Promise<void> | null = null;
  #polling = false;
  #lastObservedAt = -Infinity;
  #observations = 0;
  #generation = 0;
  #duskPoint: number | null = null;
  #newNight = true;
  #nightKey = 0;
  #handled = false;
  #readyAt = 0;
  #cover: CoveredCell | null = null;
  #exitNights = new Map<string, number | null>();
  #deathBaseline: string | null | undefined;
  #deathInitialized = false;
  #pendingDeath: { readonly id: string; readonly atNight: boolean } | null = null;
  #deaths = { total: 0, atNight: 0 };
  #lastAsk: number | null = null;
  #rearmed = false;
  #previousHealth: number | null = null;

  constructor(readonly host: SituationHost) {}

  /** Every supplied snapshot postpones the fallback poll, including samples waiting behind cover I/O. */
  observe(snapshot: BotSnapshot): Promise<void> {
    this.#lastObservedAt = monotonicNow();
    this.#observations++;
    this.#latest = { snapshot, generation: this.#generation };
    if (this.#observing !== null) return this.#observing;
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const observing = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    this.#observing = observing;
    void this.drain().then(resolve, reject);
    return observing;
  }

  /** A held status call neither blocks new observations nor allows another poll. */
  async poll(): Promise<void> {
    if (this.#polling || monotonicNow() - this.#lastObservedAt < SITUATION_POLL_MS) return;
    this.#polling = true;
    const generation = this.#generation;
    const observations = this.#observations;
    try {
      const snapshot = await this.host.status();
      if (generation === this.#generation && observations === this.#observations) await this.observe(snapshot);
    } finally {
      this.#polling = false;
    }
  }

  /** Stops invalidate I/O, while retaining the handled night until an observed day. */
  invalidate(): void { this.#generation++; this.#latest = null; }
  nightActive(): boolean {
    const snapshot = this.#snapshot;
    return snapshot !== null && inOverworld(snapshot) && this.#duskPoint !== null && snapshot.clock?.timeOfDay !== undefined && nightFor(snapshot.clock.timeOfDay, this.#duskPoint);
  }
  nightHandled(): boolean { return this.#handled; }
  nightKey(): number { return this.#nightKey; }
  minutesToDay(): number | null {
    const time = this.timeOfDay();
    return this.nightActive() && time !== null ? minutesToDay(time) : null;
  }
  timeOfDay(): number | null { return this.#snapshot?.clock?.timeOfDay ?? null; }
  deaths(): { readonly total: number; readonly atNight: number } { return { ...this.#deaths }; }

  /** Each pass handles synchronous life events before awaiting the one external cover read. */
  private async drain(): Promise<void> {
    try {
      while (this.#latest !== null) {
        const observation = this.#latest;
        this.#latest = null;
        if (observation.generation !== this.#generation) continue;
        const wasNight = this.nightActive();
        this.#snapshot = observation.snapshot;
        this.updateNight(observation.snapshot);
        const respawned = this.observeDeath(observation.snapshot, wasNight);
        this.observeHealth(observation.snapshot, respawned);
        await this.observeExposure(observation);
        this.host.observed?.(observation.snapshot);
      }
    } finally {
      // Clear ownership in the same turn as the empty-queue check, before another observe can join it (T2 review).
      this.#observing = null;
    }
  }

  /** Only an observed pre-dusk day rearms the cycle; backwards time within a night never does. */
  private updateNight(snapshot: BotSnapshot): void {
    const time = snapshot.clock?.timeOfDay;
    if (inOverworld(snapshot) && time !== undefined && time < DUSK_FROM_TICK) {
      this.#newNight = true;
      this.#duskPoint = null;
      this.#handled = false;
      this.#cover = null;
    } else if (inOverworld(snapshot) && time !== undefined && time <= BEDTIME_END_TICK && this.#newNight) {
      this.#newNight = false;
      this.#nightKey++;
      this.#duskPoint = DUSK_FROM_TICK + Math.floor(this.host.random() * (DUSK_TO_TICK - DUSK_FROM_TICK + 1));
      this.#readyAt = monotonicNow() + (time > this.#duskPoint ? this.host.random() * DUSK_SPREAD_MS : 0);
    }
    const exit = snapshot.coverExit;
    if (exit != null && !this.#exitNights.has(exit.plannedAt)) this.#exitNights.set(exit.plannedAt, this.nightActive() ? this.#nightKey : null);
    if (!this.nightActive() && this.host.busy().includes("night")) this.host.end("night", inOverworld(snapshot) ? "day came" : "left the overworld", snapshot);
    if (this.nightActive() && (snapshot.clock?.sleeping === true || this.host.answeringNight() === "night" || this.host.busy().includes("night"))) this.#handled = true;
  }

  /** Null is a valid startup baseline; subsequent nulls never erase a recorded death. */
  private observeDeath(snapshot: BotSnapshot, wasNight: boolean): boolean {
    const death = snapshot.lastDeath;
    if (!this.#deathInitialized) {
      this.#deathInitialized = true;
      this.#deathBaseline = death == null ? death : death.observedAt;
      return false;
    }
    if (this.#deathBaseline === undefined || death == null || death.observedAt === this.#deathBaseline) return false;
    if (this.#pendingDeath?.id !== death.observedAt) this.#pendingDeath = { id: death.observedAt, atNight: wasNight };
    if (snapshot.health <= 0) return false;
    this.#deaths.total++;
    if (this.#pendingDeath.atNight) this.#deaths.atNight++;
    this.#deathBaseline = death.observedAt;
    this.#pendingDeath = null;
    this.#lastAsk = null;
    this.#rearmed = false;
    const busy = this.host.busy();
    if (busy.includes("respawn")) this.host.end("respawn", "died again", snapshot);
    if (busy.includes("low_health")) this.host.end("low_health", "died", snapshot);
    this.host.raise({ kind: "respawn", cause: deathCause(death, snapshot, this.nightActive()), raisedAt: monotonicNow(), death }, snapshot);
    return true;
  }

  /** Recovery only rearms a future fall; crossing the full recovery boundary forgets the prior ask. */
  private observeHealth(snapshot: BotSnapshot, respawned: boolean): void {
    const health = snapshot.health;
    const previous = this.#previousHealth;
    this.#previousHealth = health;
    const threshold = lowHealthAt(snapshot, this.host.persona);
    if (health >= threshold + LOW_HEALTH_STEP) {
      this.#lastAsk = null;
      this.#rearmed = false;
      if (!respawned && this.host.busy().includes("low_health")) this.host.end("low_health", `health back to ${Number(health.toFixed(1))}`, snapshot);
      return;
    }
    if (this.#lastAsk !== null && health >= this.#lastAsk + HEART) this.#rearmed = true;
    if (health <= 0 || health >= threshold || this.host.busy().includes("low_health")) return;
    if (this.#lastAsk !== null && health > this.#lastAsk - LOW_HEALTH_STEP && !(this.#rearmed && previous !== null && health < previous)) return;
    this.#lastAsk = health;
    this.#rearmed = false;
    this.host.raise({ kind: "low_health", cause: `Your health fell to ${Number(health.toFixed(1))}/20`, raisedAt: monotonicNow(), health }, snapshot);
  }

  /** Eligibility is rechecked after cover I/O: a sleep or shelter can start while the read is held. */
  private canRaiseNight(snapshot: BotSnapshot): boolean {
    if (snapshot.clock?.sleeping === true || this.host.answeringNight() === "night" || this.host.busy().includes("night")) this.#handled = this.nightActive() || this.#handled;
    return this.nightActive() && !this.#handled && this.host.answeringNight() === null && monotonicNow() >= this.#readyAt;
  }

  /** Only covered cells are cached; exposed ones cause the single event immediately. */
  private async observeExposure({ snapshot, generation }: Observation): Promise<void> {
    if (!this.canRaiseNight(snapshot)) return;
    const exit = snapshot.coverExit;
    if (exit != null && !exit.reached && this.#exitNights.get(exit.plannedAt) === this.#nightKey) {
      this.raiseNight(snapshot, `Your route goes out under the open sky at ${coordinates(exit.at)}; you are at ${coordinates(snapshot.position)} (day comes in ${this.minutesToDay()!.toFixed(1)} min)`);
      return;
    }
    const key = coverKey(snapshot, this.#nightKey);
    if (this.#cover !== null && sameCoverKey(key, this.#cover.key) && monotonicNow() - this.#cover.readAt < COVER_REFRESH_MS) return;
    const readAt = monotonicNow();
    const covered = await this.host.underCover(snapshot.position);
    if (generation !== this.#generation) return;
    const newest: Observation | null = this.#latest;
    if (newest !== null && !sameCoverKey(key, coverKey(newest.snapshot, this.#nightKey))) return;
    this.#cover = covered ? { key, readAt } : null;
    if (newest !== null || !this.canRaiseNight(snapshot) || covered) return;
    this.raiseNight(snapshot, `Night has just fallen (day comes in ${this.minutesToDay()!.toFixed(1)} min)`);
  }

  /** Set handled before notifying the host, so reentrant observations cannot duplicate a night. */
  private raiseNight(snapshot: BotSnapshot, cause: string): void {
    this.#handled = true;
    this.host.raise({ kind: "night", cause, raisedAt: monotonicNow() }, snapshot);
  }
}
