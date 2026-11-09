// The BotSnapshot of one `view_status` reply: the facts of this moment every skill reads (`McpBotRuntime.status()`).
import type { z } from "zod";
import { parseLastDeath } from "./last-death.ts";
import type { BotSnapshot, NearbyMob, Position } from "./runtime-client.ts";
import type { viewStatusSchema } from "./status-schema.ts";

/** The runtime lists a species once per age group: one entry per species, counts added, the nearest distance kept. */
function mobSpecies(groups: readonly { name: string; hostile: boolean; count: number; nearest: { distance: number; position?: Position | undefined } }[]): NearbyMob[] {
  const species = new Map<string, NearbyMob>();
  for (const group of groups) {
    const seen = species.get(group.name);
    const nearest = { distance: group.nearest.distance, ...(group.nearest.position === undefined ? {} : { position: group.nearest.position }) };
    species.set(group.name, seen === undefined
      ? { name: group.name, hostile: group.hostile, count: group.count, ...nearest }
      : { ...seen, count: seen.count + group.count, ...(group.nearest.distance < seen.distance ? nearest : {}) });
  }
  return [...species.values()].sort((a, b) => a.distance - b.distance);
}

/** The snapshot a parsed `view_status` reply stands for; an optional field an older runtime does not send stays unset. */
export function snapshotOf(data: z.infer<typeof viewStatusSchema>): BotSnapshot {
  const { situation } = data.result;
  return {
    position: situation.position,
    dimension: situation.dimension,
    health: situation.vitals.health,
    food: situation.vitals.food,
    ...(situation.vitals.saturation === undefined ? {} : { saturation: situation.vitals.saturation }),
    ...(situation.vitals.armour === undefined ? {} : { armourPoints: situation.vitals.armour }),
    ...(situation.vitals.armourToughness === undefined ? {} : { armourToughness: situation.vitals.armourToughness }),
    ...(situation.vitals.burn === undefined ? {} : { burn: situation.vitals.burn }),
    ...(situation.armourWorn == null || situation.armourCarried == null ? {} : { armour: { worn: situation.armourWorn, carried: situation.armourCarried } }),
    ...(situation.light == null ? {} : { light: situation.light }),
    ...(situation.combat == null ? {} : { combat: situation.combat }),
    ...(situation.respawn === undefined ? {} : { respawn: situation.respawn }),
    difficulty: situation.difficulty,
    inventory: situation.inventory.stacks.map(({ name, count, durability, families }) => ({ name, count, durability, families })),
    foods: situation.inventory.foods,
    mobs: mobSpecies(situation.nearby.mobs),
    players: situation.nearby.players,
    ...(situation.clock === undefined ? {} : { clock: situation.clock }),
    ...(situation.navigation?.coverExit === undefined ? {} : { coverExit: situation.navigation.coverExit }),
    ...(situation.tools === undefined ? {} : { gear: situation.tools }),
    ...(situation.lastDeath === undefined ? {} : { lastDeath: parseLastDeath(situation.lastDeath, situation.observedAt) }),
    policy: data.survivalPolicy === undefined
      ? null
      : {
        revision: data.survivalPolicy.revision,
        digStraightDown: data.survivalPolicy.effective.navigation.dig_straight_down,
        scaffoldBlocks: data.survivalPolicy.effective.navigation.scaffold_blocks,
        ...(data.survivalPolicy.effective.navigation.report_open_sky === undefined ? {} : { reportOpenSky: data.survivalPolicy.effective.navigation.report_open_sky }),
      },
  };
}
