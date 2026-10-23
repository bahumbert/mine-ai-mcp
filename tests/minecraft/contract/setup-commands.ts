/** The Mine Labs arrangement of a contract fixture: the setup commands, the player and the entities its YAML must hold. */
import { WITHOUT_RUNTIME_FLAG } from "../client-host-args.ts";
import { blockArgument } from "./subject.ts";
import type { ContractCheck, ContractFixture } from "./checks.ts";

/** The arena every check stays in: a stone floor at `FLOOR_Y`, air above, `RADIUS` blocks around the origin. */
export const ARENA = { radius: 6, floorY: -61, airTopY: -55 } as const;

export interface ContractArrangement {
  /** The YAML's `setup` lines, in order. */
  readonly setup: readonly string[];
  readonly player: { readonly pos: readonly [number, number, number]; readonly inventory: readonly { item: string; count: number }[] };
  readonly entities: readonly { readonly type: string; readonly pos: readonly [number, number, number] }[];
}

/** Throws when a cell or the feet leave the arena: outside it the reset and the snapshot do not reach. */
function assertInArena(label: string, [x, y, z]: readonly number[]): void {
  const inside = Math.abs(x!) <= ARENA.radius && Math.abs(z!) <= ARENA.radius && y! >= ARENA.floorY && y! <= ARENA.airTopY;
  if (!inside) throw new Error(`${label} ${x},${y},${z} is outside the contract arena (radius ${ARENA.radius}, y ${ARENA.floorY}..${ARENA.airTopY})`);
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
    ...(fixture.timeOfDay === undefined ? [] : [`time set ${fixture.timeOfDay}`]),
    ...(fixture.weather === undefined ? [] : [`weather ${fixture.weather}`]),
  ];
  assertInArena("feet", fixture.position);
  return {
    setup: [
      `fill ${-radius} ${floorY} ${-radius} ${radius} ${floorY} ${radius} stone`,
      `fill ${-radius} ${floorY + 1} ${-radius} ${radius} ${airTopY} ${radius} air`,
      ...cellLines,
      ...worldLines,
    ],
    player: { pos: fixture.position, inventory: Object.entries(fixture.carried).map(([item, count]) => ({ item, count })) },
    entities: (fixture.entities ?? []).map(({ name, position }) => ({ type: name, pos: position })),
  };
}

/** The YAML's `client.args`: the host and the contract driver, bare when the check measures the server alone. */
export function contractClientArgs(check: Pick<ContractCheck, "withoutRuntime">): readonly string[] {
  return ["client-host.ts", "drivers/bot-contract.ts", ...(check.withoutRuntime === true ? [WITHOUT_RUNTIME_FLAG] : [])];
}
