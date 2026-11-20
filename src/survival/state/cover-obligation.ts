// The cover obligation of a resumed request: after an evade that ended behind cover from a shooter, the request the
// evade interrupted owes that cover. The step field prices the shooter's sight (`hostile-field.ts`); this module holds
// who owes what and judges a whole planned route against it (plan 2026-11-18-evade-resume-bound T7, spec D4).
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import {
  NO_OBSTACLE,
  obstaclesOf,
  packKey,
  OverlayInterner,
  PlanningOverlay,
  worldViewRaycaster,
  type BlockPosition,
  type MovementKind,
  type PlannedOperation,
  type PlannedStep,
  type PredictedWorldEffect,
  type RouteAdmission,
  type WorldView,
} from "../../navigation/index.js";
import type { BlockRaycaster } from "../../world/block-visibility.js";
import { entityDimensions } from "../../world/entity-dimensions.js";
import { shooterSeesBody, type EntityBody } from "../../world/entity-geometry.js";

/** The code a refused route carries in navigate's error, so the model (and a test) can name the refusal. */
export const COVER_REFUSED_CODE = "[COVER_ROUTE_REFUSED]";

/** How far a body rises above its feet at the top of a jump (vanilla jump height, 1.25 blocks). */
export const JUMP_APEX = 1.25;

/** Spacing of the bodies judged along one movement, in blocks. */
const SAMPLE_SPACING = 0.25;

/** A single endpoint proof can read at most this many ray cells, including the start's waiver checks. */
const MAX_PROOF_READS = 20_000;
const REFUSAL_SUFFIX = "no committed route keeps cover. The reflex still protects the body; choose the next action.";

export interface CoverObligation {
  readonly requestId: string;
  readonly generation: number;
  readonly threatId: number;
  readonly name: string;
  /** Where the shooter stands now (refreshed while it is loaded) and how big it is. */
  body: EntityBody;
  readonly safeRange: number;
}

/**
 * Which movement leaves the ground. Every kind is listed, so a new `MovementKind` fails to compile here until someone
 * says whether the body rises: the admission refuses a kind it cannot model rather than certify it.
 */
const RISES: Readonly<Record<MovementKind, boolean>> = {
  walk: false, sprint: false, step_up: true, pillar: true, jump: true, sprint_jump: true, parkour: true,
  downward: false, bucket_drop: false, drop: false, swim: false, climb: false,
};

/**
 * The shooters a request still owes cover from, for one request and one life. Cleared by death and by a dimension
 * change (with the threat chains), emptied when another request (or none) asks.
 */
export class CoverObligations {
  readonly #byThreat = new Map<number, CoverObligation>();

  /** Record one obligation; an obligation of another request or life replaces what was held. */
  add(obligation: CoverObligation): void {
    const held = this.#byThreat.values().next().value;
    if (held && (held.requestId !== obligation.requestId || held.generation !== obligation.generation)) this.#byThreat.clear();
    this.#byThreat.set(obligation.threatId, obligation);
  }

  /**
   * What `requestId` owes now. Another request, no request or another generation empties the store; a shooter confirmed
   * dead is dropped; a loaded shooter's body is refreshed, and a shooter no longer loaded keeps its last body.
   */
  current(requestId: string | null, generation: number, bot: Bot, resolved: ReadonlySet<number>): readonly CoverObligation[] {
    const foreign = [...this.#byThreat.values()].some((held) => held.requestId !== requestId || held.generation !== generation);
    if (foreign) this.#byThreat.clear();
    for (const [id, held] of this.#byThreat) {
      if (resolved.has(id)) {
        this.#byThreat.delete(id);
        continue;
      }
      const entity = bot.entities[id];
      if (entity?.isValid) held.body = { position: entity.position.clone(), ...entityDimensions(bot, entity) };
    }
    return [...this.#byThreat.values()];
  }

  clear(): void {
    this.#byThreat.clear();
  }
}

/** What the planner predicts one operation does to the world's blocks, in the order the executor does it (an activation: see `openedBy`). */
function effectsOf(operation: PlannedOperation): readonly PredictedWorldEffect[] {
  switch (operation.kind) {
    case "break":
      return [operation.position, ...operation.brings].map((position) => ({ kind: "break", position, stateId: 0 }));
    case "place":
      return [{ kind: "place", position: operation.placement.position, stateId: operation.placement.stateId }];
    case "activate":
    case "move":
      return [];
  }
}

/** The cells a step's activations open: the planner emits one operation per door group and an effect for each half. */
function openedBy(step: PlannedStep): readonly number[] {
  return step.effects.filter((effect) => effect.kind === "activate").map(({ position }) => packKey(position.x, position.y, position.z));
}

/** A body that can be tested for exposure: where its feet are, and the block they are in (named in a refusal). */
interface Judged {
  readonly body: EntityBody;
  readonly cell: BlockPosition;
}

type SightVerdict = "seen" | "hidden" | "unknown";
type EndpointRefutation = NonNullable<RouteAdmission["refuteEndpoints"]>;

/** The cheap proof leaves uncertain geometry to the normal search and replay. */
function uncertainForProof(block: ReturnType<WorldView["blockAt"]>): boolean {
  if (block.kind === "unloaded") return true;
  const { traits, geometry, collisionShapes } = block;
  return traits.liquid !== null || traits.waterlogged || traits.openable || (!geometry.fullCube && collisionShapes.length > 0);
}

/**
 * The world as an eye ray meets it. A cell nobody has loaded hides nothing and makes the body exposed, wherever on the ray
 * it lies (a known wall beyond it does not certify cover). A door the route opens is judged as open air: the overlay
 * keeps the closed door's collision shapes, so its post-activation geometry is not known, and open is the safe answer.
 */
class Sight {
  readonly #view: WorldView;
  readonly #ray: BlockRaycaster;
  #remainingReads: number | null;
  #touchedUncertain = false;

  constructor(view: WorldView, readonly size: { readonly width: number; readonly height: number }, opened: ReadonlySet<number>, maxReads?: number) {
    this.#view = view;
    this.#remainingReads = maxReads ?? null;
    this.#ray = worldViewRaycaster((x, y, z) => {
      if (this.#remainingReads !== null && --this.#remainingReads < 0) return null;
      if (opened.has(packKey(x, y, z))) return NO_OBSTACLE;
      const block = view.blockAt(x, y, z);
      if (maxReads !== undefined && uncertainForProof(block)) {
        this.#touchedUncertain = true;
        return null;
      }
      const boxes = obstaclesOf(block);
      if (boxes === null) this.#touchedUncertain = true;
      return boxes ?? NO_OBSTACLE;
    });
  }

  get exhausted(): boolean {
    return this.#remainingReads !== null && this.#remainingReads < 0;
  }

  at(cell: BlockPosition, lift = 0, x = cell.x + 0.5, z = cell.z + 0.5): Judged {
    return { body: { position: new Vec3(x, cell.y + lift, z), ...this.size }, cell };
  }

  /** The shooter judges the body exposed: in its range, and its eye (or a shoulder of it) sees it; an unknown cell of the body is exposed. */
  exposes(obligation: CoverObligation, judged: Judged): boolean {
    return this.proves(obligation, judged) !== "hidden";
  }

  /** Sight counts as proof only when the body and rays used to judge it are known. */
  proves(obligation: CoverObligation, { body }: Judged): SightVerdict {
    if (body.position.distanceTo(obligation.body.position) > obligation.safeRange) return "hidden";
    const x = Math.floor(body.position.x);
    const z = Math.floor(body.position.z);
    const y = Math.floor(body.position.y);
    for (const height of [y, y + 1]) {
      const block = this.#view.blockAt(x, height, z);
      if (block.kind === "unloaded" || (this.#remainingReads !== null && uncertainForProof(block))) return "unknown";
    }
    this.#touchedUncertain = false;
    const seen = shooterSeesBody(this.#ray, obligation.body, body);
    if (this.exhausted || this.#touchedUncertain) return "unknown";
    return seen ? "seen" : "hidden";
  }

  first(obligations: readonly CoverObligation[], judged: readonly Judged[]): { obligation: CoverObligation; judged: Judged } | null {
    for (const candidate of judged)
      for (const obligation of obligations) if (this.exposes(obligation, candidate)) return { obligation, judged: candidate };
    return null;
  }
}

/** Both admission checks waive each shooter from whom the start has already lost cover. */
function owedAtStart(sight: Sight, start: BlockPosition, obligations: readonly CoverObligation[]): readonly CoverObligation[] {
  const root = sight.at(start);
  return obligations.filter((obligation) => !sight.exhausted && !sight.exposes(obligation, root));
}

/** A different owed shooter can witness each endpoint. Stop on the first endpoint with no certain witness. */
function refuteEndpoints(sight: Sight, { start, endpoints }: Parameters<EndpointRefutation>[0], obligations: readonly CoverObligation[]): string | null {
  const owed = owedAtStart(sight, start, obligations);
  if (owed.length === 0 || sight.exhausted) return null;
  const root = sight.at(start).body.position;
  const witnesses = new Set<CoverObligation>();
  let nearest: { judged: Judged; obligation: CoverObligation; distanceSquared: number } | undefined;
  for (const cell of endpoints) {
    const judged = sight.at(cell);
    const obligation = owed.find((shooter) => !sight.exhausted && sight.proves(shooter, judged) === "seen");
    if (!obligation || sight.exhausted) return null;
    witnesses.add(obligation);
    const distanceSquared = root.distanceSquared(judged.body.position);
    if (!nearest || distanceSquared < nearest.distanceSquared) nearest = { judged, obligation, distanceSquared };
  }
  if (!nearest) return null;
  const names = new Set(owed.filter((obligation) => witnesses.has(obligation)).map(shooterLabel));
  const { x, y, z } = nearest.judged.cell;
  const distance = nearest.judged.body.position.distanceTo(nearest.obligation.body.position).toFixed(1);
  return `${COVER_REFUSED_CODE} every end of this route (${endpoints.length} cells) is in sight of ${[...names].join(", ")}; ` +
    `the nearest, ${x} ${y} ${z}, is ${distance} blocks from ${shooterLabel(nearest.obligation)}; ${REFUSAL_SUFFIX}`;
}

/** Every body a movement puts the player in: its cells, and a body every 0.25 blocks between them, raised at a jump's apex. */
function movementBodies(sight: Sight, step: PlannedStep): readonly Judged[] {
  const { from, to } = step;
  const cells = [from, to, ...step.validArrivals].map((cell) => sight.at(cell));
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const parts = Math.max(1, Math.ceil(Math.hypot(dx, dz) / SAMPLE_SPACING));
  // A step that rises (any kind: a climb or swim up too) or leaves the ground puts the body above its feet level.
  const rises = RISES[step.kind] || to.y > from.y;
  const level = { x: from.x, y: Math.max(from.y, to.y), z: from.z };
  const samples: Judged[] = [];
  for (let part = 0; part <= parts; part++) {
    const x = from.x + 0.5 + (dx * part) / parts;
    const z = from.z + 0.5 + (dz * part) / parts;
    const cell = { x: Math.floor(x), y: level.y, z: Math.floor(z) };
    samples.push(sight.at(cell, 0, x, z));
    if (rises) samples.push(sight.at(cell, JUMP_APEX, x, z));
  }
  return [...cells, ...samples];
}

/** The shooter as named in a refusal. */
function shooterLabel(obligation: CoverObligation): string {
  return `${obligation.name}#${obligation.threatId}`;
}

function refusal(step: number, steps: number, judged: Judged, obligation: CoverObligation): string {
  const { x, y, z } = judged.cell;
  const distance = judged.body.position.distanceTo(obligation.body.position).toFixed(1);
  return `${COVER_REFUSED_CODE} step ${step}/${steps} at ${x} ${y} ${z} is in sight of ${shooterLabel(obligation)} at ${distance} blocks; ` + REFUSAL_SUFFIX;
}

function unmodelled(step: number, steps: number, kind: string): string {
  return `${COVER_REFUSED_CODE} step ${step}/${steps} uses the movement "${kind}", which cannot be checked for cover; ${REFUSAL_SUFFIX}`;
}

/**
 * The veto over a route owed cover: the route as walked, with its digs and placements in the order they happen, keeps
 * every body the player will be in out of each shooter's sight. A shooter that already sees the start is waived for this
 * check (that cover is lost and the reflex decides), the others are still judged.
 */
export function coverAdmission(bot: Bot, obligations: readonly CoverObligation[], maxProofReads = MAX_PROOF_READS): RouteAdmission & { refuteEndpoints: EndpointRefutation } {
  const size = entityDimensions(bot, bot.entity);
  return {
    refuteEndpoints(plan, world) {
      return refuteEndpoints(new Sight(world, size, new Set(), maxProofReads), plan, obligations);
    },
    check(plan, world) {
      const begin = new Sight(world, size, new Set());
      const owed = owedAtStart(begin, plan.start, obligations);
      if (owed.length === 0) return null;
      const replay = new Replay(world, size);
      for (const [index, step] of plan.steps.entries()) {
        const refused = replay.judge(owed, step, index + 1, plan.steps.length);
        if (refused) return refused;
      }
      return null;
    },
  };
}

/** The route as it changes the world while it is walked: its digs and placements (an overlay) and the doors it opens. */
class Replay {
  #overlay = new PlanningOverlay(new OverlayInterner());
  readonly #opened = new Set<number>();

  constructor(readonly world: WorldView, readonly size: { readonly width: number; readonly height: number }) {}

  #sight(): Sight {
    return new Sight(this.#overlay.view(this.world), this.size, this.#opened);
  }

  /** The refusal for the first body of this step a shooter sees, replaying its operations in order; null when it keeps cover. */
  judge(owed: readonly CoverObligation[], step: PlannedStep, number: number, steps: number): string | null {
    if (!Object.hasOwn(RISES, step.kind)) return unmodelled(number, steps, step.kind);
    for (const operation of step.operations) {
      for (const effect of effectsOf(operation)) this.#overlay = this.#overlay.apply(effect);
      if (operation.kind === "activate") for (const key of openedBy(step)) this.#opened.add(key);
      if (operation.kind !== "break" && operation.kind !== "place") continue;
      const sight = this.#sight();
      const stance = operation.kind === "break" ? operation.stance ?? step.from : step.from;
      const seen = sight.first(owed, [sight.at(stance)]);
      if (seen) return refusal(number, steps, seen.judged, seen.obligation);
    }
    const sight = this.#sight();
    const seen = sight.first(owed, movementBodies(sight, step));
    return seen ? refusal(number, steps, seen.judged, seen.obligation) : null;
  }
}
