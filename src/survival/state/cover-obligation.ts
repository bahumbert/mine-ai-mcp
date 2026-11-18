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

/**
 * The world as an eye ray meets it. A cell nobody has loaded hides nothing and makes the body exposed, wherever on the ray
 * it lies (a known wall beyond it does not certify cover). A door the route opens is judged as open air: the overlay
 * keeps the closed door's collision shapes, so its post-activation geometry is not known, and open is the safe answer.
 */
class Sight {
  readonly #view: WorldView;
  readonly #ray: BlockRaycaster;
  #touchedUnknown = false;

  constructor(view: WorldView, readonly size: { readonly width: number; readonly height: number }, opened: ReadonlySet<number>) {
    this.#view = view;
    this.#ray = worldViewRaycaster((x, y, z) => {
      if (opened.has(packKey(x, y, z))) return NO_OBSTACLE;
      const boxes = obstaclesOf(view.blockAt(x, y, z));
      if (boxes === null) this.#touchedUnknown = true;
      return boxes ?? NO_OBSTACLE;
    });
  }

  at(cell: BlockPosition, lift = 0, x = cell.x + 0.5, z = cell.z + 0.5): Judged {
    return { body: { position: new Vec3(x, cell.y + lift, z), ...this.size }, cell };
  }

  /** The shooter judges the body exposed: in its range, and its eye (or a shoulder of it) sees it; an unknown cell of the body is exposed. */
  exposes(obligation: CoverObligation, { body }: Judged): boolean {
    if (body.position.distanceTo(obligation.body.position) > obligation.safeRange) return false;
    const x = Math.floor(body.position.x);
    const z = Math.floor(body.position.z);
    const y = Math.floor(body.position.y);
    if ([y, y + 1].some((cell) => this.#view.blockAt(x, cell, z).kind === "unloaded")) return true;
    this.#touchedUnknown = false;
    const seen = shooterSeesBody(this.#ray, obligation.body, body);
    return seen || this.#touchedUnknown;
  }

  first(obligations: readonly CoverObligation[], judged: readonly Judged[]): { obligation: CoverObligation; judged: Judged } | null {
    for (const candidate of judged)
      for (const obligation of obligations) if (this.exposes(obligation, candidate)) return { obligation, judged: candidate };
    return null;
  }
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

function refusal(step: number, steps: number, judged: Judged, obligation: CoverObligation): string {
  const { x, y, z } = judged.cell;
  const distance = judged.body.position.distanceTo(obligation.body.position).toFixed(1);
  return `${COVER_REFUSED_CODE} step ${step}/${steps} at ${x} ${y} ${z} is in sight of ${obligation.name}#${obligation.threatId} at ${distance} blocks; ` +
    "no committed route keeps cover. The reflex still protects the body; choose the next action.";
}

function unmodelled(step: number, steps: number, kind: string): string {
  return `${COVER_REFUSED_CODE} step ${step}/${steps} uses the movement "${kind}", which cannot be checked for cover; no committed route keeps cover. ` +
    "The reflex still protects the body; choose the next action.";
}

/**
 * The veto over a route owed cover: the route as walked, with its digs and placements in the order they happen, keeps
 * every body the player will be in out of each shooter's sight. A shooter that already sees the start is waived for this
 * check (that cover is lost and the reflex decides), the others are still judged.
 */
export function coverAdmission(bot: Bot, obligations: readonly CoverObligation[]): RouteAdmission {
  const size = entityDimensions(bot, bot.entity);
  return {
    check(plan, world) {
      const begin = new Sight(world, size, new Set());
      const owed = obligations.filter((obligation) => !begin.exposes(obligation, begin.at(plan.start)));
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
