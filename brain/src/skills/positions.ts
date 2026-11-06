// Where players and targets are: finding a player in a snapshot, navigate inputs, distances.
import type { BotSnapshot, NearbyPlayer, Position } from "../runtime-client.ts";

/** Arrival tolerance for `go_to` coordinates. */
export const GO_TO_RANGE = 1;

export function findPlayer(snapshot: BotSnapshot, username: string): NearbyPlayer | undefined {
  const wanted = username.toLowerCase();
  return snapshot.players.find((entry) => entry.username.toLowerCase() === wanted);
}

/** Whether a username named in a step is her own. */
export function isSelf(username: string, self: string | undefined): boolean {
  return self !== undefined && username.toLowerCase() === self.toLowerCase();
}

/**
 * Where a player named in a step stands; her own name is where she stands (live 2026-10-03: "level 4 blocks around
 * Ayla" failed five times with "cannot see Ayla", the players list holding only the others).
 */
export function whereIs(snapshot: BotSnapshot, username: string, self: string | undefined): Position | null {
  if (isSelf(username, self)) return snapshot.position;
  return findPlayer(snapshot, username)?.position ?? null;
}

export function navigateInput(target: Position, range: number): Record<string, unknown> {
  return { x: Math.floor(target.x), y: Math.floor(target.y), z: Math.floor(target.z), range };
}

export function distanceBetween(a: Position, b: Position): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}
