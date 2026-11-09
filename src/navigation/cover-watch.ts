// Passive route telemetry and the navigation world's solid non-leaf cover reader.
import type { Bot } from "mineflayer";
import { tagsOf } from "../world/block-tags.js";
import { coverOver } from "../world/cover.js";
import type { RoutePlan } from "./movements/movement.js";
import type { NavigationEvent } from "./telemetry/index.js";
import type { BlockPosition, WorldView } from "./world/world.js";

export interface CoverExit {
  readonly at: BlockPosition;
  readonly plannedAt: string;
  readonly reached: boolean;
}

/** The first destination exposed to the sky, even when the route starts exposed. */
export function firstOpenStep(plan: Pick<RoutePlan, "start" | "steps">, covered: (cell: BlockPosition) => boolean): { stepId: string; at: BlockPosition } | null {
  const step = plan.steps.find(({ to }) => !covered(to));
  return step ? { stepId: step.id, at: step.to } : null;
}

/** Read the navigation world's cached state ids with the same solid/tag rule as view_blocks and the brain. */
export function coveredCellReader(bot: Bot, world: WorldView): (cell: BlockPosition) => boolean {
  const kinds = new Map<number, { solid: boolean; tags: readonly string[] }>();
  const read = (x: number, y: number, z: number) => {
    const block = world.blockAt(x, y, z);
    if (block.kind === "unloaded") return null;
    let kind = kinds.get(block.stateId);
    if (!kind) {
      const data = bot.registry.blocksByStateId[block.stateId];
      if (!data) return null;
      kind = { solid: data.boundingBox === "block", tags: tagsOf(data.name, bot.version) };
      kinds.set(block.stateId, kind);
    }
    return kind;
  };
  return (cell) => {
    // Mineflayer game.js supplies these dimension bounds at login/respawn; its typings omit them.
    const dimension = bot.game as typeof bot.game & { minY: number; height: number };
    return coverOver(read, cell, dimension.minY + dimension.height - 1);
  };
}

/** Passive telemetry: never owns controls or changes a route. Match run and plan as step ids may repeat across runs. */
export class CoverWatch {
  #exit: (CoverExit & { stepId: string; runId: string; planId: string }) | null = null;
  constructor(readonly covered: (cell: BlockPosition) => boolean) {}
  clear(): void { this.#exit = null; }
  snapshot(): CoverExit | null {
    const exit = this.#exit;
    return exit ? { at: exit.at, plannedAt: exit.plannedAt, reached: exit.reached } : null;
  }
  observe(event: NavigationEvent, enabled: boolean): void {
    if (event.kind === "route_committed" && enabled) {
      const exit = firstOpenStep(event.plan, this.covered);
      if (exit) this.#exit = { ...exit, runId: event.runId, planId: event.planId, plannedAt: new Date().toISOString(), reached: false };
    } else if (event.kind === "step_started" && this.#exit?.stepId === event.stepId &&
      this.#exit.runId === event.runId && this.#exit.planId === event.planId) {
      this.#exit = { ...this.#exit, reached: true };
    }
  }
}
