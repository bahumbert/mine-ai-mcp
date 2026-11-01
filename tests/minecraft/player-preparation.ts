import type { Bot } from "mineflayer";
import type { ScenarioDefinition } from "mine-labs/client";

const POSITION_TOLERANCE = 1.5;
/** Regeneration can add half a heart between the arranged wound and this observation. */
const HEALTH_TOLERANCE = 1;

export interface PlayerPreparationObservation {
  wait(): Promise<void>;
  close(): void;
  /** What the wait still lacks: each declared update seen or never seen with the last event heard for it, and each state that differs. */
  describePending(): string;
}

/** How often one client event came since the wait was armed, and when the last one did. */
interface EventHeard {
  readonly count: number;
  readonly afterMs: number;
}

/** One kind of server update the preparation waits for, named by what it proves, with the client events that carry it. */
interface AwaitedUpdate {
  readonly name: string;
  readonly declared: boolean;
  readonly observed: () => boolean;
  readonly events: readonly string[];
}

/** One state the arranged player must show once its updates arrived. */
interface ExpectedState {
  readonly name: string;
  readonly matches: () => boolean;
  readonly detail: () => string;
}

/**
 * Arm before reporting ready, then prove that declared player setup reached
 * this Mineflayer client after Mine Labs provisioned the server-side player:
 * its inventory and equipment, its dimension and position, and its starting health.
 */
export function observeScenarioPlayerPreparation(
  bot: Bot,
  scenario: ScenarioDefinition,
  signal?: AbortSignal,
): PlayerPreparationObservation {
  const player = scenario.players.find(({ name }) => name === bot.username);
  if (!player) throw new Error(`scenario does not declare player '${bot.username}'`);

  // The main hand occupies a normal hotbar slot; armour and offhand do not.
  const expectedInventory = expectedInventoryCounts(bot, [
    ...player.inventory,
    ...(player.equipment?.mainhand ? [{ item: player.equipment.mainhand, count: 1 }] : []),
  ]);
  const equipmentSlots = { head: 5, chest: 6, legs: 7, feet: 8, mainhand: 36 + bot.quickBarSlot, offhand: 45 };
  const expectedEquipment = Object.entries(player.equipment ?? {}).map(([name, item]) => {
    const slot = equipmentSlots[name as keyof typeof equipmentSlots];
    const type = scenarioItemType(bot, item);
    return { slot, type };
  });
  const expectedPosition = Array.isArray(player.pos) ? player.pos : undefined;
  const expectedDimension = scenario.world.dimension;
  const expectedHealth = player.health;
  const observed = {
    inventory: expectedInventory.size === 0 && expectedEquipment.length === 0,
    position: expectedPosition === undefined,
    health: expectedHealth === undefined,
  };
  let settle: (() => void) | undefined;

  const armedAt = performance.now();
  const lastHeard = new Map<string, EventHeard>();
  const hear = (event: string) => {
    lastHeard.set(event, { count: (lastHeard.get(event)?.count ?? 0) + 1, afterMs: performance.now() - armedAt });
  };
  const awaitedUpdates: readonly AwaitedUpdate[] = [
    { name: "inventory update", declared: expectedInventory.size > 0 || expectedEquipment.length > 0, observed: () => observed.inventory, events: ["updateSlot"] },
    { name: "position update", declared: expectedPosition !== undefined, observed: () => observed.position, events: ["move", "forcedMove", "spawn"] },
    { name: "health update", declared: expectedHealth !== undefined, observed: () => observed.health, events: ["health"] },
  ];
  const expectedStates = expectedPlayerStates(bot, { inventory: expectedInventory, equipment: expectedEquipment, dimension: expectedDimension, position: expectedPosition, health: expectedHealth });

  const preparationMatches = () =>
    awaitedUpdates.every(({ observed }) => observed()) && expectedStates.every(({ matches }) => matches());
  const check = () => {
    if (preparationMatches()) settle?.();
  };
  const close = listenForUpdates(bot, (update, event) => {
    hear(event);
    observed[update] = true;
    check();
  });

  return {
    async wait(): Promise<void> {
      signal?.throwIfAborted();
      if (preparationMatches()) return;
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          signal?.removeEventListener("abort", onAbort);
          settle = undefined;
          resolve();
        };
        const onAbort = () => {
          settle = undefined;
          reject(signal?.reason);
        };
        settle = finish;
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    close,
    describePending: () => describePendingPreparation(awaitedUpdates, expectedStates, lastHeard),
  };
}

/** What the wait still lacks: each declared update seen (with the last event heard for it) or never seen, then each state that differs. */
function describePendingPreparation(
  awaitedUpdates: readonly AwaitedUpdate[],
  expectedStates: readonly ExpectedState[],
  lastHeard: ReadonlyMap<string, EventHeard>,
): string {
  const updates = awaitedUpdates.filter(({ declared }) => declared).map(({ name, observed, events }) => {
    if (!observed()) return `${name}: never seen`;
    const heardOf = events.flatMap((kind) => (lastHeard.has(kind) ? [{ kind, ...lastHeard.get(kind)! }] : []));
    // An update is observed only through a listener that heard it first, so the list is never empty here.
    const last = heardOf.sort((a, b) => b.afterMs - a.afterMs)[0]!;
    return `${name}: seen, last ${last.kind} (${last.count} heard) ${(last.afterMs / 1000).toFixed(1)} s after arming`;
  });
  const differing = expectedStates.filter(({ matches }) => !matches()).map(({ name, detail }) => `differs: ${name} ${detail()}`);
  return [...updates, ...differing].join("; ") || "every update seen and every state matching";
}

/** Report each client event that carries one of the updates the wait needs; the returned function removes every listener. */
function listenForUpdates(bot: Bot, heard: (update: "inventory" | "position" | "health", event: string) => void): () => void {
  const inventory = () => heard("inventory", "updateSlot");
  const position = (event: string) => () => heard("position", event);
  const move = position("move");
  const forcedMove = position("forcedMove");
  const spawn = position("spawn");
  const health = () => heard("health", "health");
  bot.inventory.on("updateSlot", inventory);
  bot.on("move", move);
  // A teleport is a server-set position, which arrives as a forced move — and
  // as a fresh spawn when it crosses into another dimension. Neither is a
  // physics step, so neither reaches `move` while the client is standing still.
  bot.on("forcedMove", forcedMove);
  bot.on("spawn", spawn);
  bot.on("health", health);
  return () => {
    bot.inventory.removeListener("updateSlot", inventory);
    bot.removeListener("move", move);
    bot.removeListener("forcedMove", forcedMove);
    bot.removeListener("spawn", spawn);
    bot.removeListener("health", health);
  };
}

/** The player state the scenario declared, one entry per thing the preparation compares with the client's own view. */
function expectedPlayerStates(
  bot: Bot,
  expected: {
    readonly inventory: ReadonlyMap<number, number>;
    readonly equipment: readonly { readonly slot: number; readonly type: number }[];
    readonly dimension: string;
    readonly position: readonly [number, number, number] | undefined;
    readonly health: number | undefined;
  },
): readonly ExpectedState[] {
  const wanted = [...expected.inventory].map(([type, count]) => `${count} ${itemName(bot, type)}`).join(", ") || "nothing";
  return [
    { name: "inventory", matches: () => inventoryMatches(bot, expected.inventory), detail: () => `holds ${inventoryText(bot)}, expected ${wanted}` },
    { name: "equipment", matches: () => expected.equipment.every(({ slot, type }) => bot.inventory.slots[slot]?.type === type), detail: () => `slots ${expected.equipment.map(({ slot, type }) => `${slot}=${itemNameIn(bot, slot)} (expected ${itemName(bot, type)})`).join(", ")}` },
    { name: "dimension", matches: () => bot.game.dimension === expected.dimension, detail: () => `is ${bot.game.dimension}, expected ${expected.dimension}` },
    { name: "position", matches: () => positionMatches(bot, expected.position), detail: () => `is ${vectorText(bot.entity.position)}, expected ${expected.position ? vectorText(expected.position) : "anywhere"}` },
    { name: "health", matches: () => healthMatches(bot, expected.health), detail: () => `is ${bot.health}, expected ${expected.health}` },
  ];
}

function vectorText(point: { readonly x: number; readonly y: number; readonly z: number } | readonly [number, number, number]): string {
  const [x, y, z] = "x" in point ? [point.x, point.y, point.z] : point;
  return `(${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)})`;
}

function inventoryText(bot: Bot): string {
  return bot.inventory.items().map((item) => `${item.count} ${itemName(bot, item.type)}`).join(", ") || "nothing";
}

function itemName(bot: Bot, type: number): string {
  return bot.registry.items[type]?.name ?? `item ${type}`;
}

function itemNameIn(bot: Bot, slot: number): string {
  const held = bot.inventory.slots[slot];
  return held ? itemName(bot, held.type) : "empty";
}

function expectedInventoryCounts(
  bot: Bot,
  inventory: ScenarioDefinition["players"][number]["inventory"],
): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  for (const stack of inventory) {
    const type = scenarioItemType(bot, stack.item);
    counts.set(type, (counts.get(type) ?? 0) + stack.count);
  }
  return counts;
}

function scenarioItemType(bot: Bot, name: string): number {
  const item = bot.registry.itemsByName[name.replace(/^minecraft:/u, "")];
  if (!item) throw new Error(`scenario item '${name}' is unknown to client ${bot.version}`);
  return item.id;
}

function inventoryMatches(bot: Bot, expected: ReadonlyMap<number, number>): boolean {
  const actual = new Map<number, number>();
  for (const item of bot.inventory.items()) {
    actual.set(item.type, (actual.get(item.type) ?? 0) + item.count);
  }
  if (actual.size !== expected.size) return false;
  for (const [itemId, count] of expected) {
    if (actual.get(itemId) !== count) return false;
  }
  return true;
}

function positionMatches(bot: Bot, expected: readonly [number, number, number] | undefined): boolean {
  if (!expected) return true;
  const [x, y, z] = expected;
  const dx = bot.entity.position.x - x;
  const dy = bot.entity.position.y - y;
  const dz = bot.entity.position.z - z;
  return dx * dx + dy * dy + dz * dz <= POSITION_TOLERANCE * POSITION_TOLERANCE;
}

function healthMatches(bot: Bot, expected: number | undefined): boolean {
  return expected === undefined || Math.abs(bot.health - expected) <= HEALTH_TOLERANCE;
}
