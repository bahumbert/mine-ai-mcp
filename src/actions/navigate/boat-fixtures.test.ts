/**
 * What the boat tests of this folder share: a bot on the shore of a flat open sea, on the shared fake bot with the sea
 * written as cells, and the reads of what the fake server received (shift presses, hits).
 */
import { Vec3 } from "vec3";
import type { Entity } from "prismarine-entity";
import { type FakeBotOptions, type FakeCell, type FakeHarness, createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";

/** The sea's top water level: water from the floor up to y 62, air above. */
const SURFACE_Y = 62;
/** Half the width of the sea in x, and how far it runs in z: past any ride a test makes. */
const SEA_HALF_WIDTH = 6;
const SEA_LENGTH = 70;
const SEA_START_Z = -6;

export interface SeaOptions {
  /** Blocks past this z are not loaded (the server sent no such chunk part). */
  readonly loadedTo?: number;
  /** Water this deep (default: stone from y 50, 13 deep). */
  readonly waterDepth?: number;
  /** Dry land (stone to the water's level) from this z on. */
  readonly landFromZ?: number;
  /** Dry land (stone to the water's level) up to this z (and below). */
  readonly landUntilZ?: number;
  /** Boats carried (one stack each). */
  readonly boatsCarried?: number;
  /** Other items carried (a sword for the strike tests). */
  readonly carries?: readonly string[];
  /** A block in the air over the water from this z on, which a boat on the water runs into: the server puts the boat back. */
  readonly barrierFromZ?: number;
  readonly lagMs?: number;
  /** Move the body by Mineflayer's physics (she swims after a boat's item). */
  readonly physics?: boolean;
  /** Entities in view from the start, by id (a boat to sit in, a threat). */
  readonly entities?: FakeBotOptions["entities"];
}

/** The cells of the sea: stone from the floor up, water above it, land and barrier as asked, unloaded cells as asked. */
function seaCells(options: SeaOptions): Record<string, FakeCell> {
  const floorTop = SURFACE_Y - (options.waterDepth ?? 13);
  const cells: Record<string, FakeCell> = {};
  for (let x = -SEA_HALF_WIDTH; x <= SEA_HALF_WIDTH; x += 1) {
    for (let z = SEA_START_Z; z <= SEA_START_Z + SEA_LENGTH; z += 1) {
      const land = (options.landUntilZ !== undefined && z <= options.landUntilZ) || (options.landFromZ !== undefined && z >= options.landFromZ);
      for (let y = floorTop + 1; y <= SURFACE_Y; y += 1) cells[`${x},${y},${z}`] = land ? "stone" : "water";
      if (options.barrierFromZ !== undefined && z >= options.barrierFromZ) cells[`${x},${SURFACE_Y + 1},${z}`] = "barrier";
      if (options.loadedTo !== undefined && z > options.loadedTo) {
        for (let y = floorTop; y <= SURFACE_Y + 1; y += 1) cells[`${x},${y},${z}`] = "void";
      }
    }
  }
  return cells;
}

/** A bot at the edge of a flat open sea (water y 50 to 62 over stone), one boat carried, on a mocked clock (install it with `using`). */
export function seaHarness(options: SeaOptions = {}): FakeHarness {
  // The boats first: the hand holds the first stack, and a sword carried after it is equipped when it is used.
  const carried: Record<string, number> = {};
  if ((options.boatsCarried ?? 1) > 0) carried.oak_boat = options.boatsCarried ?? 1;
  for (const name of options.carries ?? []) carried[name] = 1;
  return createFakeBot({
    clock: createFakeClock({ mode: "mocked" }),
    position: new Vec3(0.5, SURFACE_Y + 1, 0.5),
    groundY: SURFACE_Y - (options.waterDepth ?? 13),
    cells: seaCells(options),
    carried,
    lagMs: options.lagMs,
    entities: options.entities,
    simulatePhysics: options.physics,
  });
}

/** The shift presses (true) and releases (false) the client wrote, in order: a 1.21.4 server reads them from entity_action. */
export const shifts = ({ server }: FakeHarness): boolean[] =>
  server.packets.filter((packet) => packet.name === "entity_action").map((packet) => (packet.data as { actionId: number }).actionId === 0);

/** The `vehicle_move` packets the client wrote, in order. */
export const vehicleMoves = ({ server }: FakeHarness): Record<string, unknown>[] =>
  server.packets.filter((packet) => packet.name === "vehicle_move").map((packet) => packet.data as Record<string, unknown>);

/** Whether the client wrote a `player_input` or an `entity_action`: any shift. */
export const wroteAShift = ({ server }: FakeHarness): boolean => server.packets.some((packet) => packet.name === "player_input" || packet.name === "entity_action");

/** The boats in the inventory. */
export const boatsCarried = ({ inventory }: FakeHarness): number => inventory.items().filter((item) => item.name === "oak_boat").reduce((sum, item) => sum + item.count, 0);

/** The boat entities the client sees. */
export const boatsInView = ({ bot }: FakeHarness): Entity[] => Object.values(bot.entities).filter((entity) => entity.name === "oak_boat");

/** The one boat in view: the launched one. */
export function theBoat(harness: FakeHarness): Entity {
  const [boat, ...others] = boatsInView(harness);
  if (boat === undefined || others.length > 0) throw new Error(`${boatsInView(harness).length} boats in view, one expected`);
  return boat;
}

/** The id of the boat of {@link mountedSea}. */
export const SEATED_BOAT_ID = 7;

/** Seated in a boat floating 3 blocks ahead of her, as a ride leaves her (the mount confirmed by the server). */
export async function mountedSea(options: SeaOptions = {}): Promise<FakeHarness> {
  const harness = seaHarness({ ...options, entities: { [SEATED_BOAT_ID]: { name: "oak_boat", position: new Vec3(0.5, 62.52, 3.5) }, ...options.entities } });
  harness.bot.mount(harness.bot.entities[SEATED_BOAT_ID]!);
  await harness.clock.advance(100);
  return harness;
}

/** Run a promise of the code under test while the fake clock moves, up to a ceiling far past any ride of these tests. */
export const settled = <T>(harness: FakeHarness, promise: Promise<T>, maxMs = 120_000): Promise<T> => harness.clock.settle(promise, maxMs);

export interface ShoreOptions {
  readonly feet?: Vec3;
  /** A boat 7 floating there. */
  readonly boat?: Vec3;
  readonly carried?: Readonly<Record<string, number>>;
  /** On a mocked clock (install it with `using`), for code that waits on the wall clock. */
  readonly mocked?: boolean;
  readonly physics?: boolean;
}

/** Land (stone up to y 62) with a sea from x 10 to 40 (water y 50 to 62), 17 rows wide along z (deep water is read with room to the sides): what the shore-reading functions look along. */
export function shoreSea(options: ShoreOptions = {}): FakeHarness {
  const cells: Record<string, FakeCell> = {};
  for (let x = 10; x <= 40; x += 1) {
    for (let z = -8; z <= 8; z += 1) for (let y = 50; y <= SURFACE_Y; y += 1) cells[`${x},${y},${z}`] = "water";
  }
  return createFakeBot({
    clock: options.mocked === true ? createFakeClock({ mode: "mocked" }) : undefined,
    position: options.feet ?? new Vec3(0.5, SURFACE_Y + 1, 0.5),
    groundY: SURFACE_Y,
    cells,
    carried: options.carried,
    entities: options.boat === undefined ? undefined : { [SEATED_BOAT_ID]: { name: "oak_boat", position: options.boat } },
    simulatePhysics: options.physics,
  });
}

/** Sea (water y 50 to 62, kelp at the surface where z is a multiple of 3) up to x 40; beyond it a bank two blocks above the water, low (one above) where z >= `lowFrom`. */
export function farBankSea(lowFrom: number): FakeHarness {
  const cells: Record<string, FakeCell> = {};
  for (let z = -49; z <= 49; z += 1) {
    for (let x = 35; x <= 47; x += 1) {
      if (x <= 40) for (let y = 50; y <= SURFACE_Y; y += 1) cells[`${x},${y},${z}`] = z % 3 === 0 && y === SURFACE_Y ? "kelp" : "water";
      else for (let y = 50; y <= (z >= lowFrom ? 63 : 64); y += 1) cells[`${x},${y},${z}`] = "dirt";
    }
  }
  return createFakeBot({ groundY: 49, cells, position: new Vec3(39.5, SURFACE_Y + 1, 0.5) });
}
