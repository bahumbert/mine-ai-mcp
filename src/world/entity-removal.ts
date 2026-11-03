// Hears the removal of one entity at Mineflayer's `entityGone`, before the entity is invalidated and unlisted.
import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";

export interface EntityRemovalWatch extends Disposable {
  /** True at and after the removal of the watched entity, and when the bot lists no valid entity of that id. */
  removed(): boolean;
}

/**
 * Mineflayer's `entity_destroy` handler (4.39.0 `lib/plugins/entities.js:309-320`) emits `entityGone` first, then sets
 * `isValid = false` and deletes `bot.entities[id]`: a wait woken by that event and reading `bot.entities[id]?.isValid`
 * still sees the entity listed and valid. The listener is prepended so it runs before any other `entityGone` listener
 * (the waits' own included, whatever the order they were armed in). It keeps the removed entity object, not a flag:
 * the server can spawn a new entity under the same id (a piglin that left range and came back), and that one is not
 * removed.
 */
export function watchEntityRemoval(bot: Bot, entityId: number): EntityRemovalWatch {
  let goneEntity: Entity | undefined;
  const onGone = (entity: Entity) => {
    if (entity.id === entityId) goneEntity = entity;
  };
  bot.prependListener("entityGone", onGone);
  return {
    removed: () => {
      const listed = bot.entities[entityId];
      return !listed?.isValid || listed === goneEntity;
    },
    [Symbol.dispose]: () => {
      bot.off("entityGone", onGone);
    },
  };
}
