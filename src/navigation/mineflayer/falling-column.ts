// Confirm each swing and landing of a falling column from retained server packet states.
import type { CellResync } from "../bot.js";
import type { PlannedOperation } from "../movements/movement.js";
import { blockLabel } from "../world/world.js";
import type { ServerChangeWatch, ServerCellAnswer } from "./server-block-changes.js";

type EffectFailure = { readonly kind: "failed"; readonly observation: string };
type BreakOperation = Extract<PlannedOperation, { kind: "break" }>;
interface ColumnPort {
  swing(block: unknown): Promise<EffectFailure | null>;
  blockAt(): unknown;
  readonly watch: ServerChangeWatch;
  resync(): Promise<CellResync>;
}

/** A stopped clock cannot prove that the remaining column will leave this cell clear. */
function stoppedColumn(operation: BreakOperation): EffectFailure {
  return { kind: "failed", observation: `The server clock stood still while the column above ${blockLabel(operation.position)} was falling; give the order again.` };
}

/** Wait for a loaded state different from the block swung at; a resend of that block proves no removal. */
async function confirmSwing(port: ColumnPort, operation: BreakOperation, signal: AbortSignal,
  after: number, stateId: number): Promise<ServerCellAnswer | EffectFailure> {
  const answer = await port.watch.next(signal, after, state => state.stateId !== null && state.stateId !== stateId);
  if (answer === "stalled") return stoppedColumn(operation);
  if (answer !== "none") return answer;
  const resync = await port.resync();
  return { kind: "failed", observation:
    `The server did not confirm breaking the block at ${blockLabel(operation.position)} (no removal packet for that cell arrived in time); ` +
    `the bot ${resync === "unavailable" ? "could not ask it" : "asked it"} to resend the cell. Give the order again.` };
}

/** Swing once, then serialize each brought block's server landing, swing and server removal. */
export async function clearFallingColumn(port: ColumnPort, operation: BreakOperation, signal: AbortSignal): Promise<EffectFailure | null> {
  const first = await port.swing(port.blockAt());
  if (first) return first;
  let removal = await confirmSwing(port, operation, signal, -1, operation.expectedStateId);
  if ("kind" in removal) return removal;
  for (let count = 0; count < operation.brings.length; count++) {
    const landing = await port.watch.next(signal, removal.index, state => state.solid);
    if (landing === "stalled") return stoppedColumn(operation);
    if (landing === "none") return null;
    const failure = await port.swing(port.blockAt());
    if (failure) return failure;
    removal = await confirmSwing(port, operation, signal, landing.index, landing.state.stateId!);
    if ("kind" in removal) return removal;
  }
  return null;
}
