/**
 * The edges one bot's routes failed on, remembered across its requests (run 15, Finn: every request planned the same
 * swim under the same lip for 75 minutes, because each run started with no memory of the last).
 *
 * Per navigation runtime, never shared between bots. An edge is priced as refused for ten minutes of the wall clock,
 * and forgotten earlier by a success of that edge or when the bot is 4+ blocks from where it failed.
 */
import type { MovementKind } from "../movements/movement.js";
import { blockKey, type BlockPosition } from "../world/world.js";

/** How long a failed edge stays refused. */
export const FAILED_EDGE_MEMORY_MS = 10 * 60_000;
/** Blocks from the failure that count as having left it. */
const LEFT_THE_FAILURE_BLOCKS = 4;

interface FailedEdge {
  readonly expiresAtMs: number;
  readonly failedAt: BlockPosition;
}

export class FailedEdges {
  readonly #edges = new Map<string, FailedEdge>();
  readonly #now: () => number;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  /** Remember that `kind` from `from` to `to` failed while the bot stood at `failedAt`. */
  record(kind: MovementKind, from: BlockPosition, to: BlockPosition, failedAt: BlockPosition): void {
    this.#edges.set(edgeKey(kind, from, to), { expiresAtMs: this.#now() + FAILED_EDGE_MEMORY_MS, failedAt });
  }

  /** Whether a search should price this edge as refused. */
  isFailed(kind: MovementKind, from: BlockPosition, to: BlockPosition): boolean {
    const key = edgeKey(kind, from, to);
    const edge = this.#edges.get(key);
    if (edge === undefined) return false;
    if (this.#now() < edge.expiresAtMs) return true;
    this.#edges.delete(key);
    return false;
  }

  /** The edge worked: it is forgotten. */
  succeeded(kind: MovementKind, from: BlockPosition, to: BlockPosition): void {
    this.#edges.delete(edgeKey(kind, from, to));
  }

  /** The bot is here: failures from 4+ blocks away are forgotten. */
  noteBotAt(position: BlockPosition): void {
    for (const [key, edge] of this.#edges) {
      const apart = Math.max(Math.abs(position.x - edge.failedAt.x), Math.abs(position.y - edge.failedAt.y), Math.abs(position.z - edge.failedAt.z));
      if (apart >= LEFT_THE_FAILURE_BLOCKS) this.#edges.delete(key);
    }
  }
}

function edgeKey(kind: MovementKind, from: BlockPosition, to: BlockPosition): string {
  return `${kind}|${blockKey(from)}>${blockKey(to)}`;
}
