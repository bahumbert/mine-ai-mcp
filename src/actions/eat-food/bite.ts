/**
 * How long a bite lasts and whether it landed, read from the held stack: what `eatAgainstBaseline` waits for in server
 * ticks (spec 2026-11-08-p4-eat-lag D1, D2).
 */
import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";

/** Server ticks in a second. */
const TICKS_PER_SECOND = 20;

/**
 * 32 ticks: contract check consume-food (1558-1576 ms at 20 a second, 2026-10-23; a vanilla stack carries no `consumable`
 * component on 1.21.4, 3 + 3 runs, 2026-11-08); vanilla Consumable default consume_seconds 1.6.
 */
export const DEFAULT_BITE_TICKS = 32;

/**
 * The bite's length in server ticks: the stack's own `consumable` component when the server sent one (a datapack or modded
 * food), else `DEFAULT_BITE_TICKS`. It is a deadline for a bite the server ignores, never a wait: the caller ends on the
 * bite itself. prismarine-item's `Item` type has no `componentMap`, so it is read with `Reflect.get`.
 */
export function biteTicks(item: Item): number {
  const components: unknown = Reflect.get(item, "componentMap");
  const consumable: unknown = components instanceof Map ? components.get("consumable") : undefined;
  const data: unknown = typeof consumable === "object" && consumable !== null ? Reflect.get(consumable, "data") : undefined;
  const seconds: unknown = typeof data === "object" && data !== null ? Reflect.get(data, "consume_seconds") : undefined;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return DEFAULT_BITE_TICKS;
  return Math.ceil(seconds * TICKS_PER_SECOND);
}

/** `entity_status` that ends a bite (`inventory.js:74-82`). */
const FINISHED_EATING = 9;

/** What the server said of our bite since `watchBiteStatus`. */
export interface BiteStatus {
  /** Status 9 for our entity: the server ended the bite (the stack, the effects and the health follow it, contract check consume-food). */
  finished(): boolean;
}

/** Listen to `entity_status` for our entity until `resources` is disposed. */
export function watchBiteStatus(bot: Bot, resources: DisposableStack): BiteStatus {
  let finished = false;
  const onStatus = (packet: { readonly entityId: number; readonly entityStatus: number }) => {
    if (packet.entityId === bot.entity.id && packet.entityStatus === FINISHED_EATING) finished = true;
  };
  bot._client.on("entity_status", onStatus);
  resources.defer(() => bot._client.removeListener("entity_status", onStatus));
  return { finished: () => finished };
}

const deathCounts = new WeakMap<Bot, { deaths: number }>();

/**
 * How many times `bot` has died since this was first called for it: one `death` listener per bot, for its lifetime, so a
 * bite's mark can tell a death between two attempts (a death empties the slots and the respawn brings full health back:
 * an emptied slot after one is no meal, whatever the attempt's own listeners saw).
 */
function deathCountOf(bot: Bot): number {
  let record = deathCounts.get(bot);
  if (record === undefined) {
    const created = { deaths: 0 };
    record = created;
    deathCounts.set(bot, created);
    bot.on("death", () => { created.deaths += 1; });
  }
  return record.deaths;
}

/** Whether `bot` died since `mark`'s bite began. */
export function diedSince(bot: Bot, mark: BiteMark): boolean {
  return deathCountOf(bot) !== mark.deathsAtStart;
}

/** One bite as the attempt made it: where it was made, and whether the use went out. */
export interface BiteMark {
  readonly slot: number;
  /** The held stack's count when the bite began. */
  readonly countAtStart: number;
  /** `deathCountOf` when the bite began. */
  readonly deathsAtStart: number;
  /** The world age when the use went out (null: no time packet heard yet). */
  readonly sentAtAge: number | undefined;
  /** The hand was in use right after `consume` was called: Mineflayer refuses ("Food is full") before it activates, so false means no packet went out. */
  readonly sent: boolean;
}

/** How the client's `consume` call ended. */
export type ConsumeEnd = { readonly kind: "pending" } | { readonly kind: "resolved" } | { readonly kind: "rejected"; readonly cause: unknown };

/** A `consume` call under way. */
export interface Bite {
  readonly mark: BiteMark;
  end(): ConsumeEnd;
}

/**
 * Call `consume` and keep its promise without making it the verdict: Mineflayer gives up on it at 2500 ms of wall clock
 * (`inventory.js:15`) but leaves the bite running on the server, so how it ended is only recorded (its late rejection is
 * handled here, never unhandled).
 */
export function startBite(bot: Bot, consume: () => Promise<void>, held: Item): Bite {
  const { slot, count: countAtStart } = held;
  const deathsAtStart = deathCountOf(bot);
  const sentAtAge = bot.time?.age ?? undefined;
  let promise: Promise<void>;
  try {
    promise = consume();
  } catch (cause) {
    promise = Promise.reject(cause);
  }
  const mark: BiteMark = { slot, countAtStart, deathsAtStart, sentAtAge, sent: bot.usingHeldItem === true };
  let end: ConsumeEnd = { kind: "pending" };
  promise.then(
    () => { end = { kind: "resolved" }; },
    (cause: unknown) => { end = { kind: "rejected", cause }; },
  );
  return { mark, end: () => end };
}

/**
 * Whether the slot the bite was made from shows the bite: the same item, one fewer than `countAtStart` (an emptied slot
 * when it was one). Judging by that slot, not the carried total, keeps a same-food pickup into another slot mid-bite from
 * hiding the meal. A dead bot's emptied slots are no meal (a death clears the inventory).
 */
export function heldBiteLanded(bot: Bot, slot: number, itemName: string, countAtStart: number): boolean {
  if (bot.health <= 0) return false;
  const held = bot.inventory.slots[slot];
  if (held == null) return countAtStart === 1;
  return held.name === itemName && held.count === countAtStart - 1;
}
