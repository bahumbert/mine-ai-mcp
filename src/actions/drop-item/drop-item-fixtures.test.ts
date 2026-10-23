/** What the drop-item tests share: a bot on the shared fake with its stacks, the scripted toss failures, and the pit. */
import test from "node:test";
import { Vec3 } from "vec3";
import { setCarriedCount } from "../../test-support/carried-counts.js";
import { EQUIPMENT_SLOTS, type FakeBot, type FakeClock, createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { createDiscardedItems } from "../../world/discarded-items.js";
import { parseDropItemRequest } from "./contract.js";
import { type DropItemDependencies, beginDropItem } from "./drop-item.js";

export interface Stack {
  readonly name: string;
  readonly count: number;
  readonly durabilityUsed?: number;
}

export interface DropBotOptions {
  readonly carried: readonly Stack[];
  readonly worn?: Partial<Record<"head" | "torso" | "legs" | "feet" | "off-hand", string>>;
  readonly held?: string;
  /** Toss this item name throws instead of removing it. */
  readonly rejects?: string;
  /** Toss this item name silently succeeds without the inventory changing. */
  readonly swallows?: string;
  readonly players?: Record<string, { id: number; position: { x: number; y: number; z: number } }>;
  readonly position?: { x: number; y: number; z: number };
  /**
   * A toss returns only once the server's item entity is on the bot. Stopgap for a bug reported to the master: a real server
   * spawns it 3-8 ms after the click (contract check `toss-count-and-entity`), `rememberDiscards` claims at once and finds none.
   */
  readonly tossWaitsForSpawn?: boolean;
  /** Item entities already on the ground before the action runs. */
  readonly existingItems?: readonly { id: number; name: string; distance?: number }[];
}

/** The longest a run may take on the fake clock: far above any wait the action has. */
const RUN_MAX_MS = 60_000;
/** An item entity with `PickupDelay:32767s`: the server never lets a player pick it up (`ItemEntity.setNeverPickUp`). */
const NEVER_PICKED_UP_TICKS = 32_767;
/** How long the server takes to spawn a toss's item entity on the fake clock: one slice. */
const TOSS_ANSWER_MS = 100;
const MAIN_START = 9;
const HOTBAR_START = 36;
/** A tossed stack is kept 40 ticks (contract check `tossed-item-kept-before-delay`); a wait past it sees the stack come back. */
export const PICKED_UP_BY_MS = 2_500;

export interface DropTestContext {
  readonly clock: FakeClock;
  /** Let the fake clock run until `promise` settles (its result, or its error). */
  run<T>(promise: Promise<T>): Promise<T>;
}

/** A test on a mocked clock, so the action's waits and the server's pickup delays run on the clock the test moves. */
export function dropTest(name: string, body: (context: DropTestContext) => Promise<void>): void {
  test(name, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    await body({ clock, run: (promise) => clock.settle(promise, RUN_MAX_MS) });
  });
}

/** The stacks in the main slots in request order, the held one in the hotbar, the worn pieces in their equipment slots. */
function slotsOf(options: DropBotOptions) {
  const slots: Record<number, { name: string; count: number }> = {};
  options.carried.forEach((stack, index) => {
    slots[stack.name === options.held ? HOTBAR_START : MAIN_START + index] = { name: stack.name, count: stack.count };
  });
  for (const [slot, name] of Object.entries(options.worn ?? {})) slots[EQUIPMENT_SLOTS[slot as keyof typeof EQUIPMENT_SLOTS]] = { name, count: 1 };
  return slots;
}

/** The scripted toss failures of a test: `rejects` throws as a server refusal would, `swallows` returns with the inventory unchanged. */
function scriptTossFailures(bot: FakeBot, options: DropBotOptions, clock: FakeClock): void {
  const answered = () => (options.tossWaitsForSpawn ? clock.sleep(TOSS_ANSWER_MS) : Promise.resolve());
  const tossStack = bot.tossStack.bind(bot);
  bot.tossStack = async (stack) => {
    if (stack.name === options.rejects) throw new Error("server refused");
    if (stack.name !== options.swallows) await tossStack(stack);
    await answered();
  };
  const toss = bot.toss.bind(bot);
  bot.toss = async (type, metadata, count) => {
    const name = bot.registry.items[type]?.name;
    if (name === options.rejects) throw new Error("server refused");
    if (name !== options.swallows) await toss(type, metadata, count);
    await answered();
  };
}

/** A bot on the shared fake carrying `options.carried`; `lookedAt` lists where it turned to face. */
export function dropBot(options: DropBotOptions, clock: FakeClock) {
  const players = Object.entries(options.players ?? {});
  const harness = createFakeBot({
    clock,
    position: options.position,
    slots: slotsOf(options),
    entities: Object.fromEntries(players.map(([name, { id, position }]) => [id, { name: "player", username: name, position }])),
    players: Object.fromEntries(players.map(([name]) => [name, { username: name }])),
  });
  const { bot, inventory } = harness;
  for (const [name, { id }] of players) bot.players[name]!.entity = bot.entities[id]!;
  for (const [index, stack] of options.carried.entries()) {
    const placed = inventory.slots[stack.name === options.held ? HOTBAR_START : MAIN_START + index];
    if (stack.durabilityUsed !== undefined && placed) placed.durabilityUsed = stack.durabilityUsed;
  }
  for (const { id, name, distance = 1 } of options.existingItems ?? []) {
    harness.entities.spawn({ id, name: "item", position: new Vec3(0.5, 64, 0.5 + distance), item: { name, count: 1 }, pickupDelayTicks: NEVER_PICKED_UP_TICKS });
  }
  const lookedAt: { x: number; y: number; z: number }[] = [];
  const lookAt = bot.lookAt.bind(bot);
  bot.lookAt = (position, force) => {
    lookedAt.push({ x: position.x, y: position.y, z: position.z });
    return lookAt(position, force);
  };
  scriptTossFailures(bot, options, clock);
  return { harness, bot, items: () => bot.inventory.items(), lookedAt };
}

/** A bot carrying an iron chestplate it wears and a diamond pickaxe it holds. */
export function wearingChestplateHoldingPickaxe(clock: FakeClock) {
  return dropBot(
    {
      carried: [
        { name: "iron_chestplate", count: 1 },
        { name: "diamond_pickaxe", count: 1 },
      ],
      worn: { torso: "iron_chestplate" },
      held: "diamond_pickaxe",
    },
    clock,
  );
}

export function deps(overrides: Partial<DropItemDependencies> = {}): DropItemDependencies {
  return {
    navigate: async () => ({ status: "completed", elapsedMs: 10 }) as never,
    breakInPlace: async () => ({ status: "broken" }),
    placeInto: async () => ({ kind: "failed", error: "not placed in this test" }),
    createMovements: (() => ({})) as never,
    settleMs: 50,
    pickupWaitMs: 150,
    ...overrides,
  };
}

/** One request's attempts: `begin` once, then an executor call per attempt with its own signal. */
export function dropAttempts(bot: FakeBot, input: unknown, dependencies = deps()) {
  const run = beginDropItem(bot, parseDropItemRequest(input), () => {}, dependencies, createDiscardedItems());
  return (signal?: AbortSignal) => run({ signal });
}

/** Aborts the request once the nth toss has resolved (a reflex took the body); later tosses go through. */
export function abortAfterToss(bot: FakeBot, owner: AbortController, nth: number): { tosses: number } {
  const count = { tosses: 0 };
  const afterToss = () => {
    count.tosses += 1;
    if (count.tosses === nth) owner.abort(new Error("hunger reflex"));
  };
  const tossStack = bot.tossStack.bind(bot);
  bot.tossStack = async (stack) => {
    await tossStack(stack);
    afterToss();
  };
  const toss = bot.toss.bind(bot);
  bot.toss = async (type, metadata, quantity) => {
    await toss(type, metadata, quantity);
    afterToss();
  };
  return count;
}

export const DEFAULT_PIT_CARRIED: readonly Stack[] = [{ name: "dirt", count: 3 }, { name: "cobblestone", count: 2 }];

/**
 * Open ground (stone below y 64) the dig and the plug change cell by cell; each toss lands its item at the pit's bottom
 * (one entity per item name, its count growing) and each plug block placed is spent from the inventory.
 */
export function pitWorld(clock: FakeClock, carried: readonly Stack[] = DEFAULT_PIT_CARRIED, options: { readonly plugFails?: boolean; readonly spawnAfterMs?: number } = {}) {
  const { harness, bot, items } = dropBot({ carried, position: { x: 0.5, y: 64, z: 0.5 } }, clock);
  const lying = new Map<string, number>();
  const land = (name: string, count: number) => {
    lying.set(name, (lying.get(name) ?? 0) + count);
    const id = 77 + [...lying.keys()].indexOf(name);
    const show = () => {
      const stack = { name, count: lying.get(name)! };
      if (bot.entities[id]) harness.entities.restack(id, stack.count);
      else harness.entities.spawn({ id, name: "item", position: new Vec3(1.5, 62.2, 0.5), item: stack, pickupDelayTicks: NEVER_PICKED_UP_TICKS });
    };
    // The server's spawn packet can arrive after the toss resolved (a server seconds behind).
    if (options.spawnAfterMs === undefined) show();
    else setTimeout(show, options.spawnAfterMs);
  };
  // A toss over the pit lands in it: the window loses the stack (the click's prediction) and `land` is the one entity the
  // server spawns, so the fake's own drop at the bot's eye is not added.
  bot.tossStack = async (stack) => {
    const { name, count } = stack;
    harness.inventory.tossStack(stack);
    land(name, count);
  };
  bot.toss = async (type, _metadata, count) => {
    const name = bot.registry.items[type]?.name ?? "";
    harness.inventory.toss(type, count ?? null);
    land(name, count ?? 0);
  };
  const dug: string[] = [];
  const plugged: string[] = [];
  const dependencies = deps({
    breakInPlace: async ({ position }) => {
      dug.push(`${position.x},${position.y},${position.z}`);
      harness.world.setCell(new Vec3(position.x, position.y, position.z), "air");
      return { status: "broken" };
    },
    placeInto: async (placer, cell, item) => {
      if (options.plugFails) return { kind: "failed", error: "not placed in this test" } as never;
      harness.world.setCell(new Vec3(cell.x, cell.y, cell.z), item?.name ?? "cobblestone");
      plugged.push(item?.name ?? "");
      if (item) setCarriedCount(harness.inventory, bot.registry, item.type, harness.inventory.count(item.type, null) - 1);
      return { kind: "placed", block: placer.blockAt(new Vec3(cell.x, cell.y, cell.z))! } as never;
    },
    navigate: async () => {
      bot.entity.position.set(4.5, 64, 0.5);
      return { status: "completed", elapsedMs: 0 } as never;
    },
  });
  return { bot, items, dug, plugged, dependencies, blockNameAt: (cell: Vec3) => bot.blockAt(cell)?.name };
}
