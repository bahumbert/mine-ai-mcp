/** The Mine Labs arrangement of a contract fixture: the setup commands, the player and the entities its YAML must hold. */
import minecraftData from "minecraft-data";
import { DEFAULT_MINECRAFT_VERSION } from "../../../src/server/config.ts";
import { stacksOf } from "../../../src/test-support/fake-bot/fake-inventory.ts";
import { itemCommandOf } from "../../../src/test-support/fake-bot/item-variants.ts";
import { WITHOUT_RUNTIME_FLAG } from "../client-host-args.ts";
import { blockArgument } from "./subject.ts";
import type { ContractCheck, ContractFixture } from "./checks.ts";

/** The arena every check stays in: a stone floor at `FLOOR_Y`, air above, `RADIUS` blocks around the origin. */
export const ARENA = { radius: 6, floorY: -61, airTopY: -55 } as const;

/** How minecraft-data files the mobs that attack on sight. */
const HOSTILE_CATEGORY = "Hostile mobs";

export interface ContractArrangement {
  /** The YAML's `setup` lines, in order. */
  readonly setup: readonly string[];
  readonly player: { readonly pos: readonly [number, number, number]; readonly inventory: readonly { item: string; count: number }[] };
  readonly entities: readonly { readonly type: string; readonly pos: readonly [number, number, number]; readonly nbt?: string }[];
}

/** Throws when a cell or the feet leave the arena: outside it the reset and the snapshot do not reach. */
function assertInArena(label: string, [x, y, z]: readonly number[]): void {
  const inside = Math.abs(x!) <= ARENA.radius && Math.abs(z!) <= ARENA.radius && y! >= ARENA.floorY && y! <= ARENA.airTopY;
  if (!inside) throw new Error(`${label} ${x},${y},${z} is outside the contract arena (radius ${ARENA.radius}, y ${ARENA.floorY}..${ARENA.airTopY})`);
}

/** `item replace block` for each stack of each container, after the `setblock` of the container itself: stacks fill the slots from 0, split at the item's stack size; a variant name (`ITEM_VARIANTS`) is written as its command text. */
function containerLines(fixture: ContractFixture): string[] {
  const registry = minecraftData(DEFAULT_MINECRAFT_VERSION);
  return Object.entries(fixture.containers ?? {}).flatMap(([key, carried]) => {
    if (!(key in fixture.cells)) throw new Error(`container ${key} has no block in cells: name the chest to set`);
    return stacksOf(registry, carried).map(({ name, count }, slot) => `item replace block ${key.split(",").join(" ")} container.${slot} with ${itemCommandOf(name)} ${count}`);
  });
}

/** Whether the fixture summons a hostile mob, which a peaceful world removes at once (the mob's attack also scales with the difficulty). */
function holdsHostileMob(fixture: ContractFixture): boolean {
  const registry = minecraftData(DEFAULT_MINECRAFT_VERSION);
  return (fixture.entities ?? []).some(({ name }) => registry.entitiesByName[name]?.category === HOSTILE_CATEGORY);
}

/** The fixture as Mine Labs arranges it: the floor and the air, each cell set, the bot's place, stacks and entities. */
export function setupCommands(fixture: ContractFixture): ContractArrangement {
  const { radius, floorY, airTopY } = ARENA;
  const cellLines = Object.entries(fixture.cells).map(([key, block]) => {
    const cell = key.split(",").map(Number);
    assertInArena("cell", cell);
    return `setblock ${cell.join(" ")} ${blockArgument(block)}`;
  });
  const worldLines = [
    ...(fixture.daylightCycle === undefined ? [] : [`gamerule doDaylightCycle ${fixture.daylightCycle}`]),
    ...(fixture.difficulty !== undefined ? [`difficulty ${fixture.difficulty}`] : holdsHostileMob(fixture) ? ["difficulty easy"] : []),
    ...(fixture.timeOfDay === undefined ? [] : [`time set ${fixture.timeOfDay}`]),
    ...(fixture.weather === undefined ? [] : [`weather ${fixture.weather}`]),
  ];
  assertInArena("feet", fixture.position);
  return {
    setup: [
      `fill ${-radius} ${floorY} ${-radius} ${radius} ${floorY} ${radius} stone`,
      `fill ${-radius} ${floorY + 1} ${-radius} ${radius} ${airTopY} ${radius} air`,
      ...cellLines,
      ...containerLines(fixture),
      ...worldLines,
    ],
    player: { pos: fixture.position, inventory: Object.entries(fixture.carried).map(([item, count]) => ({ item, count })) },
    entities: (fixture.entities ?? []).map((entity) => {
      const nbt = entityNbt(entity);
      return { type: entity.name, pos: entity.position, ...(nbt !== undefined && { nbt }) };
    }),
  };
}

/** The SNBT an entity is summoned with: its raw `nbt`, or its `passengers` as the `Passengers` it rides with; both is a mistake. */
function entityNbt({ nbt, passengers }: NonNullable<ContractFixture["entities"]>[number]): string | undefined {
  if (nbt !== undefined && passengers !== undefined) throw new Error("an entity takes nbt or passengers, not both: passengers are nbt");
  if (passengers === undefined) return nbt;
  return `{Passengers:[${passengers.map((name) => `{id:"minecraft:${name}"}`).join(",")}]}`;
}

/** The YAML's `tags`: every contract scenario, and `exclusive` for a check that changes the whole server (it then never shares a server with other lanes). */
export function contractTags(check: Pick<ContractCheck, "exclusive">): readonly string[] {
  return ["contract", ...(check.exclusive === undefined ? [] : ["exclusive"])];
}

/** The YAML's `client.args`: the host and the contract driver, bare when the check measures the server alone. */
export function contractClientArgs(check: Pick<ContractCheck, "withoutRuntime">): readonly string[] {
  return ["client-host.ts", "drivers/bot-contract.ts", ...(check.withoutRuntime === true ? [WITHOUT_RUNTIME_FLAG] : [])];
}
