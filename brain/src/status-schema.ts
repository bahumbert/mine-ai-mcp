// The runtime status fields the brain accepts, including optional fields from newer runtimes.
import { z } from "zod";

export const positionSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });

export const viewStatusSchema = z.object({
  result: z.object({
    situation: z.object({
      position: positionSchema,
      dimension: z.string().default("minecraft:overworld"),
      difficulty: z.string().optional(),
      observedAt: z.string().optional(),
      lastDeath: z.unknown().optional(),
      vitals: z.object({
        health: z.number(), food: z.number(), saturation: z.number().optional(),
        armour: z.number().nullable().optional(), armourToughness: z.number().nullable().optional(),
        burn: z.object({ ticks: z.number(), hp: z.number() }).nullable().optional(),
      }),
      armourWorn: z.array(z.object({ slot: z.string(), item: z.string().nullable() })).nullable().optional(),
      armourCarried: z.array(z.object({ item: z.string(), count: z.number() })).nullable().optional(),
      light: z.object({ sky: z.number().nullable(), block: z.number().nullable(), openSkyAbove: z.number().nullable() }).nullable().optional(),
      combat: z.object({ melee: z.string().nullable(), bow: z.string().nullable(), arrows: z.number(), shield: z.string().nullable() }).nullable().optional(),
      respawn: z.object({ kind: z.enum(["bed", "world_spawn"]), position: positionSchema, distance: z.number().nullable() }).nullable().optional(),
      inventory: z.object({
        stacks: z.array(z.object({ name: z.string(), count: z.number(), durability: z.object({ remaining: z.number(), maximum: z.number() }).nullable().default(null), families: z.array(z.string()).default([]) })),
        foods: z.array(z.object({ name: z.string(), count: z.number(), points: z.number(), saturation: z.number() })).default([]),
      }),
      nearby: z.object({
        players: z.array(z.object({ username: z.string(), position: positionSchema.nullable() })),
        mobs: z.array(z.object({ name: z.string(), hostile: z.boolean().default(false), count: z.number(), nearest: z.object({ distance: z.number(), position: positionSchema.optional() }) })).default([]),
      }),
      clock: z.object({ phase: z.enum(["day", "night"]).nullable(), minutesUntilChange: z.number().nullable() }).optional(),
      navigation: z.object({ coverExit: z.object({ at: positionSchema, plannedAt: z.string(), reached: z.boolean() }).nullable().optional() }).optional(),
      tools: z.object({
        tools: z.array(z.object({ class: z.string(), item: z.string().nullable() })),
        armour: z.array(z.object({ class: z.string(), item: z.string().nullable() })),
      }).optional(),
    }),
  }),
  survivalPolicy: z.object({
    revision: z.string(),
    effective: z.object({ navigation: z.object({ dig_straight_down: z.boolean().default(true), scaffold_blocks: z.array(z.string()).default([]), report_open_sky: z.boolean().optional() }) }),
  }).optional(),
});
