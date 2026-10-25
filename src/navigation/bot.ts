/**
 * The bot as the engine sees it: what it can observe of the bot, and what it
 * can do to it.
 *
 * This is the one port at the Mineflayer boundary. The run, search, and the
 * executor are written against it and never against a Mineflayer `Bot`,
 * which is what lets them run under a fake. The production implementation is
 * `mineflayer/bot.ts`; the test double is `test-support/navigation.ts`.
 * Nothing in this file may import Mineflayer.
 */
import type {
  MovementControlIntent,
  MovementController,
  MovementExecution,
  MovementSnapshot,
} from "./execution/movement-controller.js";
import type { AttemptToken } from "./execution/mutations.js";
import type { PlannedOperation, PlannedStep } from "./movements/movement.js";
import type { NavigationObservation, Position3, WorldView } from "./world/world.js";
export type { MovementExecution } from "./execution/movement-controller.js";

export interface EffectHandle {
  readonly completion: Promise<{ kind: "accepted" } | { kind: "failed"; observation: string }>;
  readonly issued: boolean;
  cancel(): void;
}
export type MovementPreparation =
  | { readonly kind: "ready"; readonly controller: MovementController }
  | { readonly kind: "completed"; readonly arrival: PlannedStep["validArrivals"][number] }
  | { readonly kind: "failed"; readonly observation: string };

/** What a resend of a cell came to: the server sent it, said nothing in time, or the bot could not ask without using an item. */
export type CellResync = "resent" | "unanswered" | "unavailable";

export interface NavigationBot {
  /** One reading of the bot and what is around it; see `NavigationObservation`. */
  observe(): NavigationObservation;
  /** The per-physics-tick position and velocity sample that movement controllers steer by. */
  movementSnapshot(): MovementSnapshot;
  prepareMovement(
    step: PlannedStep,
    token: AttemptToken,
    signal: AbortSignal,
    execution: MovementExecution,
    snapshot: () => MovementSnapshot,
  ): Promise<MovementPreparation>;
  applyMovementSteering(target: Position3): void;
  applyMovementControls(intent: MovementControlIntent): void;
  subscribePhysicsTick(listener: () => void): () => void;
  describeMovementFailure(step: PlannedStep): string;
  startEffect(
    operation: Exclude<PlannedOperation, { kind: "move" }>,
    token: AttemptToken,
    signal: AbortSignal,
  ): EffectHandle;
  /**
   * The longest the body can take to dig the block of a break operation from its state now, in ms: its tool, its
   * enchantments and effects, and both of Minecraft's penalties (x5 in water, x5 off the ground) for a body with any
   * part in water; null when the block is not loaded. The planner prices the stance it plans (water at the head cell,
   * ground = a solid cell below, `solidFloorUnder`), so a body in water above a solid cell is priced as standing (the
   * water hold lets it sink onto that floor); the executor sets a break's confirmation deadline from this instead.
   * Optional so fakes keep the planned deadline.
   */
  longestBreakDurationMs?(operation: Extract<PlannedOperation, { kind: "break" }>): number | null;
  stabilize(signal: AbortSignal): Promise<{ kind: "stable" } | { kind: "failed"; observation: string }>;
  /**
   * Ask the server to send `cell` again (see `mineflayer/cell-resync.ts`) and wait for its packet: the way out of a client
   * that holds air where the server holds a block (the cell under the feet) or the reverse (a break the server dropped).
   * Optional so fakes without a server need no change; an abort rejects with the signal's reason.
   */
  requestCellResync?(cell: Position3, signal: AbortSignal): Promise<CellResync>;
  /** Fit the body inside its current stance before a neighbouring passage can close. */
  centerOnCell(cell: Position3, signal: AbortSignal): Promise<boolean>;
  /** Retain supported footing or the water column while calculating; release before moving. */
  holdPosition(world: WorldView): () => void;
  clearOwnedControls(): void;
  readonly ownedControlCount: number;
}
