// The entity a damage_event's cause or direct field names, decoded once for every reader of the packet.
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";

/**
 * The entity a `damage_event`'s `sourceCauseId` or `sourceDirectId` names: the packet carries the entity id + 1 and 0 for none
 * (Mineflayer's `entities.js:398-400` reads `sourceCauseId - 1`; contract check `damage-event-attacker`). `entity` is undefined
 * when the client does not know it (out of range, already gone).
 */
export function damageSourceEntity(bot: Bot, encodedId: number): { readonly id: number; readonly entity: Entity | undefined } | null {
  if (encodedId === 0) return null;
  const id = encodedId - 1;
  return { id, entity: bot.entities[id] };
}
