// Live threat observations, committed goals and reach evidence for one evade.
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { safeFromEntitiesGoal, type Goal } from "../../navigation/index.js";
import { monotonicNow } from "../../utils/index.js";
import type { ResponseContext } from "../control/combat/context.js";
import type { EvadeThreatEnd } from "../control/combat/response-result.js";
import { positionThreat } from "../perception/combat/observations.js";
import { projectileThreatensBody } from "../perception/combat/shield-projectiles.js";
import { observeExposedAvoidanceContact } from "../perception/combat/threats.js";
import type { HostileThreat } from "../policy/combat/response.js";
import { positionExposed } from "../positioning/combat/exposure.js";
import type { EvadeClock } from "./evade-clock.js";
import { RETREAT_PROJECTILE_ALLOWANCE } from "../weapons/projectile-guard.js";
import { coverHolds, EVADE_CLOSING_WINDOW_TICKS, judgeReach, ReachHistory, type ReachThreat } from "./evade-reach.js";

const EVADE_ARRIVAL_MARGIN = 8;
const EVADE_GOAL_REFRESH_BLOCKS = 4;
const EVADE_COVER_REFRESH_BLOCKS = 1;

interface Entry {
  threat: HostileThreat;
  body: ReachThreat;
  readonly firstDistance: number;
  readonly firstSeen: "decision" | "joined";
}

/** Response-local history never substitutes an unseen entity's movement for observation. */
export class EvadeObservation {
  readonly startPosition;
  readonly startedAtMs = monotonicNow();
  readonly #entries = new Map<number, Entry>();
  readonly #dead = new Set<number>();
  readonly #history = new ReachHistory();
  #snapshot = new Map<number, ReachThreat & { advancing: boolean | null }>();
  #projectiles: readonly Bot["entity"][] = [];
  #unsafeRevision = 0;
  goal!: Goal;
  goalRefreshes = 0;

  /** `clock` tells when the world age last moved and how long it may stand still (the server's own packet cadence). */
  constructor(readonly bot: Bot, readonly context: ResponseContext,
    threats: readonly HostileThreat[], readonly safeRange: number, readonly clock: EvadeClock) {
    this.startPosition = { ...bot.entity.position };
    for (const threat of threats) this.#add(threat, "decision");
    this.observe();
    this.refreshGoal(false);
  }

  /** Preserve entry distances even when a confirmed death removes the live goal contact. */
  #add(threat: HostileThreat, firstSeen: Entry["firstSeen"]): void {
    const entity = this.bot.entities[threat.id];
    const position = entity?.isValid ? entity.position.clone() : new Vec3(threat.position.x, threat.position.y, threat.position.z);
    const body = entity?.isValid ? positionThreat(this.bot, entity)
      : { id: threat.id, position, attack: "unmodelled" as const, width: 0, height: 0 };
    this.#entries.set(threat.id, { threat: { ...threat, position, distance: position.distanceTo(this.bot.entity.position) },
      body: { ...body, name: threat.name }, firstDistance: position.distanceTo(this.bot.entity.position), firstSeen });
  }

  /** Record at most one position per world age and revise only when the committed snapshot changed enough. */
  observe(): void {
    const { bot } = this;
    const now = monotonicNow();
    const age = bot.time.age;
    for (const [id, entry] of this.#entries) {
      if (this.#dead.has(id)) continue;
      const entity = bot.entities[id];
      if (!entity?.isValid) continue;
      entry.body = { ...positionThreat(bot, entity), name: entry.threat.name };
      entry.threat = { ...entry.threat, position: { ...entity.position }, distance: entity.position.distanceTo(bot.entity.position) };
      if (typeof age === "number") this.#history.record(id, age, now, entity.position);
    }
    for (const threat of observeExposedAvoidanceContact(bot, this.context))
      if (!this.#dead.has(threat.id) && !this.#entries.has(threat.id)) this.#add(threat, "joined");
    if (this.goal) {
      const ends = this.ends();
      const retained = this.#projectiles.filter((p) => p.isValid
        && projectileThreatensBody(bot, p, RETREAT_PROJECTILE_ALLOWANCE, bot.entity));
      const trajectoriesChanged = retained.length !== this.#projectiles.length;
      if (trajectoriesChanged) {
        this.#projectiles = retained;
        this.#unsafeRevision++;
      }
      if (trajectoriesChanged || this.#changed(ends)) this.refreshGoal(true, ends);
    }
  }

  /** A settled stop under fire must choose a cell outside the incoming trajectories. */
  refuseTrajectories(projectiles: readonly Bot["entity"][]): void {
    this.#projectiles = projectiles;
    this.#unsafeRevision++;
    this.refreshGoal();
  }

  /** Match navigation's current-body and candidate-cell geometry. */
  #unsafe(feet: Vec3): boolean {
    const position = feet.equals(this.bot.entity.position.floored()) ? this.bot.entity.position : feet.offset(0.5, 0, 0.5);
    const body = { ...this.bot.entity, position };
    return this.#projectiles.some((p) => p.isValid && projectileThreatensBody(this.bot, p, RETREAT_PROJECTILE_ALLOWANCE, body));
  }

  /** A death changes goal membership but keeps the threat's receipt. */
  resolved(id: number): void {
    if (!this.#entries.has(id) || this.#dead.has(id)) return;
    this.#dead.add(id);
    this.refreshGoal();
  }

  /** Refresh when a projectile's reach verdict changes as well as when its position moves. */
  #changed(ends: readonly EvadeThreatEnd[]): boolean {
    const live = [...this.#entries].filter(([id]) => !this.#dead.has(id));
    return live.length !== this.#snapshot.size || live.some(([id, entry]) => {
      const previous = this.#snapshot.get(id);
      return !previous || previous.attack !== entry.body.attack
        || (entry.body.attack === "projectile" && (previous.advancing === true) !== (ends.find((end) => end.id === id)?.advancing === true))
        || previous.position.distanceTo(entry.body.position)
        >= (entry.body.attack === "projectile" ? EVADE_COVER_REFRESH_BLOCKS : EVADE_GOAL_REFRESH_BLOCKS);
    });
  }

  /** A snapshot lets navigation finish useful steps between observed threat changes. */
  refreshGoal(count = true, ends = this.ends()): void {
    this.#snapshot = new Map([...this.#entries].filter(([id]) => !this.#dead.has(id))
      .map(([id, entry]) => [id, { ...entry.body, position: entry.body.position.clone(),
        advancing: ends.find((end) => end.id === id)?.advancing ?? null }]));
    const minRange = Math.min(this.context.policy.evade_cover_range, this.safeRange);
    this.goal = safeFromEntitiesGoal([...this.#snapshot.values()].map((body) => ({ ...body,
      ...(body.attack === "projectile" && body.advancing !== true ? { cover: { minRange, eyeHeight: body.height * 0.85, width: body.width } } : {}) })),
    this.safeRange + EVADE_ARRIVAL_MARGIN, { follow: "snapshot",
      ...(this.#unsafeRevision > 0 ? { unsafe: (feet: Vec3) => this.#unsafe(feet), unsafeRevision: this.#unsafeRevision } : {}) });
    if (count) this.goalRefreshes++;
  }

  /** Judge against live blocks after a route settles, including every retained dead or unseen threat. */
  ends(): EvadeThreatEnd[] {
    const { bot, context } = this;
    const observations = context.perception.read();
    return [...this.#entries].map(([id, entry]) => {
      const distance = entry.body.position.distanceTo(bot.entity.position);
      const shotAge = observations.find((threat) => threat.id === id)?.lastShotAge ?? null;
      const verdict = judgeReach({ threat: entry.body, dead: this.#dead.has(id), observed: !!bot.entities[id]?.isValid,
        distance, samples: this.#history.samples(id), botPosition: bot.entity.position, ageNow: bot.time.age,
        ageMovedAtMs: this.clock.ageMovedAtMs(), staleAfterMs: this.clock.staleAfterMs(), nowMs: monotonicNow(),
        exposed: () => positionExposed(bot.world, bot.entity, entry.body),
        // World ticks, not client ticks: a 10 tps server spreads 40 client ticks over 20 of its own. The age is the cached one
        // (0-19 ticks behind the server at any rate), so the window is 40-59 server ticks.
        shotInWindow: shotAge !== null && typeof bot.time.age === "number" && bot.time.age - shotAge <= EVADE_CLOSING_WINDOW_TICKS,
        policy: { ...context.policy, evade_safe_range: this.safeRange } });
      return { ...verdict, firstDistance: entry.firstDistance, firstSeen: entry.firstSeen, gained: distance - entry.firstDistance };
    });
  }

  /** Only a hidden projectile threat may hold the body while its observation window fills. */
  canWaitInCover(ends: readonly EvadeThreatEnd[], incoming: boolean): boolean {
    if (incoming || ends.some((end) => end.advancing === true)) return false;
    return ends.filter((end) => end.basis === null).every((end) => {
      const body = this.#entries.get(end.id)!.body;
      return end.advancing === null && coverHolds({ attack: body.attack, distance: end.distance,
        policy: { ...this.context.policy, evade_safe_range: this.safeRange },
        exposed: () => positionExposed(this.bot.world, this.bot.entity, body) });
    });
  }

  /** Evidence retains dead entries rather than silently dropping their result. */
  threats(): HostileThreat[] { return [...this.#entries].filter(([id]) => !this.#dead.has(id)).map(([, entry]) => entry.threat); }
}
