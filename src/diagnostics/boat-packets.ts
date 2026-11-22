// Received boat metadata retained beside each attack, without claiming an attack acknowledgement.
import type { Bot } from "mineflayer";
import { z } from "zod";
import { isBoatEntity } from "../actions/navigate/boat-entities.js";

/** Observe metadata rather than infer boat damage from the number of attempted attacks. */
export function observeBoatPackets(bot: Bot, record: (direction: "incoming", packet: string, fields: unknown) => unknown) {
  const metadata = new Map<number, Map<number, unknown>>();
  const onMetadata = (raw: unknown) => {
    const parsed = z.object({ entityId: z.number(), metadata: z.array(z.object({ key: z.number(), value: z.unknown() })) }).safeParse(raw);
    if (!parsed.success || !isBoatEntity(bot.entities[parsed.data.entityId] ?? null)) return;
    const values = metadata.get(parsed.data.entityId) ?? new Map<number, unknown>();
    for (const entry of parsed.data.metadata) values.set(entry.key, entry.value);
    metadata.set(parsed.data.entityId, values);
    record("incoming", "entity_metadata", parsed.data);
  };
  const onGone = (entity: { readonly id: number }) => { metadata.delete(entity.id); };
  const reset = () => metadata.clear();
  const onCorrection = (raw: unknown) => {
    const parsed = z.object({ x: z.number(), y: z.number(), z: z.number(), yaw: z.number(), pitch: z.number() }).safeParse(raw);
    if (parsed.success) record("incoming", "vehicle_move", parsed.data);
  };
  bot._client.on("entity_metadata", onMetadata);
  bot._client.on("vehicle_move", onCorrection);
  bot.on("entityGone", onGone);
  bot.on("respawn", reset);
  return {
    target(raw: unknown) {
      const parsed = z.object({ target: z.number(), mouse: z.number() }).safeParse(raw);
      const entity = parsed.success ? bot.entities[parsed.data.target] : undefined;
      if (!entity || !isBoatEntity(entity)) return undefined;
      return {
        position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
        observerPosition: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
        distance: entity.position.distanceTo(bot.entity.position),
        metadata: metadata.has(entity.id) ? [...metadata.get(entity.id)!].map(([key, value]) => ({ key, value })) : null,
        metadataKeys: bot.registry.entitiesByName[entity.name ?? ""]?.metadataKeys ?? [],
      };
    },
    [Symbol.dispose]() {
      bot._client.off("entity_metadata", onMetadata);
      bot._client.off("vehicle_move", onCorrection);
      bot.off("entityGone", onGone);
      bot.off("respawn", reset);
      reset();
    },
  };
}
