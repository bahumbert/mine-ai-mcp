// The live bot and constants the view_status test files share (view-status.test.ts, view-status-conditions.test.ts).
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { type FakeBotOptions, type FakeEntitySpec, type FakeInventoryOptions, createFakeBot, itemOf } from "../../test-support/fake-bot/index.js";

export const idleActivity = () => ({ owner: "idle" as const, activeAction: null });

/** Where the bot stands: the loaded entities and the expected distances are placed around it. */
export const FEET = new Vec3(-9.5, 99, 18.68);

/** The carried stacks by window slot, unless a test carries others. */
const CARRIED: NonNullable<FakeInventoryOptions["slots"]> = {
  36: { name: "stone_pickaxe" },
  9: { name: "cobblestone", count: 64 },
  10: { name: "cobblestone", count: 12 },
};

/**
 * The version's registry, read before a scene's harness exists (the entity specs need its ids); every harness here is
 * on the same version.
 */
export const { registry } = createFakeBot().bot;

/**
 * One loaded entity, typed as the live server types it: a numeric registry id plus Mineflayer's category (the fields
 * Mineflayer's `entities.js` sets from the spawn packet, which the harness leaves to the test).
 */
export function loaded(name: string, position: Vec3, extra: Record<string, unknown> = {}): FakeEntitySpec {
  const registered = registry.entitiesByName[name];
  if (!registered) throw new Error(`no entity named ${name} in the 1.21.4 registry`);
  return { name, position, entityType: registered.id, kind: registered.category, isValid: true, ...extra };
}

/** A dropped stack's item, as `getDroppedItem` reads it from the entity's metadata. */
function dropOf(name: string, count: number) {
  return { getDroppedItem: () => itemOf(registry, name, count) };
}

interface LiveBotOptions {
  readonly timeOfDay?: number;
  /** Carried stacks by window slot, in place of `CARRIED`. */
  readonly carried?: FakeInventoryOptions["slots"];
  /** More loaded entities by id, beside the scene's. */
  readonly entities?: Readonly<Record<number, FakeEntitySpec>>;
  readonly cells?: FakeBotOptions["cells"];
}

/**
 * A bot asleep at night beside its base, with players, mobs of every kind, and
 * two drops loaded. The far ones are outside the sixteen-block nearby range and
 * inside the loaded chunks, which is the distinction the mob summary exists for.
 */
export function liveBot(options: LiveBotOptions = {}): Bot {
  const { bot } = createFakeBot({
    position: FEET,
    groundY: null,
    health: 18.08,
    food: 12,
    server: { timeOfDay: options.timeOfDay ?? 13826 },
    slots: { 5: { name: "diamond_helmet" }, 45: { name: "shield" }, ...(options.carried ?? CARRIED) },
    cells: options.cells,
    players: { Scout: { username: "Scout" }, Faraway: { username: "Faraway" } },
    entities: {
      1: loaded("zombie", new Vec3(-4.5, 99, 18.68)),
      2: loaded("item", new Vec3(-9.5, 99, 20.68), dropOf("coal", 3)),
      3: loaded("item", new Vec3(40, 99, 20.68), dropOf("dirt", 1)),
      4: loaded("cow", new Vec3(-8, 99, 18)),
      5: loaded("cow", new Vec3(-9.5, 99, 30)),
      6: loaded("bat", new Vec3(-9.5, 105, 18.68)),
      7: loaded("villager", new Vec3(-15.5, 99, 18.68)),
      8: loaded("cod", new Vec3(-9.5, 99, 8.68)),
      9: loaded("rabbit", new Vec3(30, 99, 18.68)),
      10: loaded("slime", new Vec3(-9.5, 99, 78.68)),
      11: loaded("player", new Vec3(-12, 99, 14)),
      // A modded stack whose metadata never parsed: skipped, not a failed report.
      12: loaded("item", new Vec3(-9, 99, 20), {
        getDroppedItem: () => {
          throw new TypeError("undefined is not an object (evaluating 'networkItem.present')");
        },
      }),
      ...options.entities,
    },
    overrides: { foodSaturation: 0.4, isSleeping: true, isRaining: false },
  });
  bot.entity.yaw = Math.PI / 2;
  // Scout's entity is the loaded player beside the bot; Faraway is online but not loaded (Mineflayer's null entity).
  bot.players.Scout!.entity = bot.entities[11]!;
  Object.assign(bot.players.Faraway!, { entity: null });
  return bot;
}
