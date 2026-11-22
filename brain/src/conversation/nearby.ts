/** Who is near a character and what was last said to them: the players an opening can speak to, and each partner's past talk. */
import type { Nearby, PastTalk } from "../mind.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import { manhattan, same } from "./state.ts";
import type { Talk } from "./types.ts";

/** The players other than `self` with a position within `distance` blocks (Manhattan) of the snapshot's bot. */
export function playersNear(snapshot: BotSnapshot, self: string, distance: number): { readonly username: string; readonly distance: number }[] {
  const near: { username: string; distance: number }[] = [];
  for (const player of snapshot.players) {
    if (player.position === null || same(player.username, self)) continue;
    const away = manhattan(snapshot.position, player.position);
    if (away <= distance) near.push({ username: player.username, distance: away });
  }
  return near;
}

/** The names an opening speaks to, as spelled by the players online; ["everyone"] is all within `talkRange`. */
export function addressed(to: readonly string[], snapshot: BotSnapshot, self: string, talkRange: number): string[] {
  if (to.some((name) => name.toLowerCase() === "everyone")) return playersNear(snapshot, self, talkRange).map((player) => player.username);
  const online = snapshot.players.map((player) => player.username);
  return to.flatMap((name) => online.filter((known) => same(known, name) && !same(known, self)));
}

/** A talk's age in minutes: `wallNow` less its stored wall `endedAt` (a recalled talk comes from an ISO date). */
export function pastTalk(talk: Talk, wallNow: number): PastTalk {
  return { with: talk.with, topic: talk.topic, gist: talk.gist, minutesAgo: Math.max(0, Math.round((wallNow - talk.endedAt) / 60_000)) };
}

/** One player near the bot, with the latest talk had with them (`talks` is keyed by lower-case name). */
export function nearby(talks: ReadonlyMap<string, Talk>, username: string, distance: number | null, wallNow: number): Nearby {
  const talk = talks.get(username.toLowerCase());
  return { username, distance, lastTalk: talk === undefined ? null : pastTalk(talk, wallNow) };
}
