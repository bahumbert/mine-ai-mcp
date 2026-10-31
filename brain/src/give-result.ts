// Readers of a `drop_item` action result for a hand-over to a player (`drop.droppedAt`, `drop.recipient`).
import type { Position } from "./runtime-client.ts";

/** Where the giver stood when it tossed (the action's `drop.droppedAt`); null when the result names no such spot. */
export function tossSpot(result: Readonly<Record<string, unknown>> | undefined): Position | null {
  const at = (result?.drop as { droppedAt?: { x?: unknown; y?: unknown; z?: unknown } } | undefined)?.droppedAt;
  return typeof at?.x === "number" && typeof at.y === "number" && typeof at.z === "number" ? { x: at.x, y: at.y, z: at.z } : null;
}

/** Whether the runtime's answer to a hand-over is final (`drop.recipient.settled`); true when it names no such field. */
export function recipientSettled(result: Readonly<Record<string, unknown>> | undefined): boolean {
  const settled = ((result?.drop as { recipient?: { settled?: unknown } | null } | undefined)?.recipient)?.settled;
  return typeof settled === "boolean" ? settled : true;
}

/** How many items the recipient picked up (the action's `drop.recipient.collectedCount`); null when the result names no recipient. */
export function recipientTook(result: Readonly<Record<string, unknown>> | undefined): number | null {
  const counted = ((result?.drop as { recipient?: { collectedCount?: unknown } | null } | undefined)?.recipient)?.collectedCount;
  return typeof counted === "number" ? counted : null;
}

/** Whether the recipient picked the toss up (the action's `drop.recipient.collected`); null when the result says nothing. */
export function handedOver(result: Readonly<Record<string, unknown>> | undefined): boolean | null {
  const collected = ((result?.drop as { recipient?: { collected?: unknown } | null } | undefined)?.recipient)?.collected;
  return typeof collected === "boolean" ? collected : null;
}
