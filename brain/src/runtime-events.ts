// What the brain reads of the runtime's recent events: the chat lines to it and the hits on it, paged out of `read_recent_events`.
import { z } from "zod";
import type { PlayerMessage } from "./runtime-client.ts";

/** One hit on the bot by a player (runtime event `hurt_by`): `direct` names what struck (an arrow), null when the player did. */
export interface HurtBy {
  readonly attacker: string;
  readonly direct: string | null;
  readonly at: number;
}

/** What one read of the runtime's recent events holds for the brain. */
export interface RuntimeEvents {
  readonly messages: readonly PlayerMessage[];
  readonly hurts: readonly HurtBy[];
}

/** Largest page `read_recent_events` accepts. */
export const EVENT_PAGE = 100;

const eventsSchema = z.object({
  result: z.object({
    events: z.array(z.object({ type: z.string(), payload: z.unknown() })),
    remainingEventCount: z.number(),
  }),
});

const playerMessagePayloadSchema = z.object({
  username: z.string(),
  channel: z.enum(["chat", "whisper"]),
  direction: z.enum(["incoming", "outgoing"]),
  message: z.string(),
  addressed: z.boolean(),
  distance: z.number().optional(),
});

const hurtByPayloadSchema = z.object({ attacker: z.string(), direct: z.string().nullable(), at: z.number() });

/** Reads pages of `read_recent_events` (`call` returns the raw tool result for a page size) until none remain; a reply of another shape throws. */
export async function readEventPages(call: (limit: number) => Promise<unknown>): Promise<RuntimeEvents> {
  const messages: PlayerMessage[] = [];
  const hurts: HurtBy[] = [];
  for (;;) {
    const { result } = eventsSchema.parse(await call(EVENT_PAGE));
    for (const event of result.events) {
      if (event.type === "hurt_by") {
        hurts.push(hurtByPayloadSchema.parse(event.payload));
        continue;
      }
      if (event.type !== "player_message") continue;
      const payload = playerMessagePayloadSchema.parse(event.payload);
      if (payload.direction !== "incoming") continue;
      messages.push({ username: payload.username, channel: payload.channel, message: payload.message, addressed: payload.addressed, ...(payload.distance !== undefined && { distance: payload.distance }) });
    }
    if (result.remainingEventCount === 0) return { messages, hurts };
  }
}
