/**
 * The ledger of blocks a life-saving reflex put inside someone else's protected region (owner choice 5 (a), plan
 * 2026-11-07-p4-06a-threat T5a): a footing block under a falling body is placed even there, and each is written down
 * so that it can be taken out again once the bot is safe (T5c). The ledger is per bot and lives in memory: a death
 * keeps it, because the block outlives the body.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { saveBotNote } from "../actions/note-save/note-save.js";
import type { SqlBotData } from "../bot-data/sql-bot-data.js";
import { createMovements, customGoal, DIG_REACH, isSafeSupport, liveBlockReader, watchServerChange, type Navigate } from "../navigation/index.js";
import { monotonicNow } from "../utils/monotonic-clock.js";
import { raceSignal } from "../utils/race-signal.js";
import { observedEyeHeight, visibleBlockAim } from "./block-visibility.js";
import { footprintStandsOnCell } from "./player-physics.js";
import { describeProtectedRegion, foreignRegionAt, regionChangeRefusal, type BlockCorner, type ProtectedRegion } from "./protected-regions.js";

export type LifeSavingKind = "block" | "water";

export interface LifeSavingPlacement {
  readonly cell: Vec3;
  /** The block the cell held when it was recorded. */
  readonly block: string;
  readonly regionId: number;
  readonly kind: LifeSavingKind;
  /** `monotonicNow()` at the record. */
  readonly recordedAt: number;
  readonly dimension: string;
  readonly region: ProtectedRegion;
}

const ledgers = new WeakMap<Bot, LifeSavingPlacement[]>();
const contexts = new WeakMap<Bot, LifeSavingRemovalContext>();
const waterHooks = new WeakMap<Bot, (cell: Vec3, signal: AbortSignal) => Promise<boolean>>();
const notedFailures = new WeakMap<LifeSavingPlacement, string>();

export const LIFE_SAVING_REMOVAL_MS = 30_000;
export const LIFE_SAVING_ROUTE_BLOCKS = 8;

export interface LifeSavingRemovalContext {
  readonly data: SqlBotData;
  readonly navigate?: Navigate;
}

type RemovalAttempt = { readonly kind: "removed" | "changed" } | { readonly kind: "left"; readonly why: string };
interface RemovalResult { removed: Vec3[]; left: { cell: Vec3; why: string }[] }

/** Runtime composition supplies the connected bot's note store and existing navigator. */
export function setLifeSavingRemovalContext(bot: Bot, context: LifeSavingRemovalContext): void {
  contexts.set(bot, context);
}

/** Fire/lava recovery supplies the bucket refill, without teaching the block ledger about buckets. */
export function setLifeSavingWaterHook(bot: Bot, hook: (cell: Vec3, signal: AbortSignal) => Promise<boolean>): void {
  waterHooks.set(bot, hook);
}

/**
 * Write down a placement made inside a region of someone else. A cell outside every foreign region is not recorded:
 * nothing there needs taking back. Called when the packet goes out, so a cut or a death after it still leaves the
 * record (the block may stand); `block` is what was placed, the cell's own block when omitted. A record whose cell no
 * longer holds that block is dropped by the removal (T5c), never dug.
 */
export function recordLifeSavingPlacement(bot: Bot, cell: Vec3, kind: LifeSavingKind, block?: string): void {
  const region = foreignRegionAt(bot, cell);
  if (region === null) return;
  const ledger = ledgers.get(bot) ?? [];
  ledgers.set(bot, ledger);
  if (ledger.some((entry) => entry.dimension === bot.game.dimension && entry.cell.equals(cell))) return;
  ledger.push({
    cell: cell.clone(),
    block: block ?? bot.blockAt(cell)?.name ?? "unobserved",
    regionId: region.regionId,
    kind,
    recordedAt: monotonicNow(),
    dimension: bot.game.dimension,
    region,
  });
}

/** The placements still standing in someone else's region, oldest first. */
export function pendingLifeSavingPlacements(bot: Bot): readonly LifeSavingPlacement[] {
  return ledgers.get(bot) ?? [];
}

/** The dig exemption ends as soon as the recorded block or dimension changes. */
export function isRecordedLifeSavingBlock(bot: Bot, cell: BlockCorner): boolean {
  return pendingLifeSavingPlacements(bot).some((entry) =>
    entry.kind === "block" && entry.dimension === bot.game.dimension &&
    entry.cell.x === cell.x && entry.cell.y === cell.y && entry.cell.z === cell.z &&
    bot.blockAt(entry.cell)?.name === entry.block);
}

/** Forget only this attempt's entry: another placement can be recorded while cleanup is settling. */
function forgetPlacement(bot: Bot, entry: LifeSavingPlacement): void {
  const ledger = ledgers.get(bot);
  const index = ledger?.indexOf(entry) ?? -1;
  if (index >= 0) ledger!.splice(index, 1);
}

/**
 * A block that carries the body cannot be removed from under it; approach from another safe stance first. The body
 * stands on the cell when any of its 0.6-wide footprint is over it and no other column under the footprint carries it
 * (`footprintStandsOnCell`): the centre of the feet over the neighbouring drop is no reason to dig (P4-34).
 */
function removalAim(bot: Bot, cell: Vec3, feet = bot.entity.position): Vec3 | null {
  const read = liveBlockReader(bot);
  if (Math.floor(feet.y) - 1 === cell.y && footprintStandsOnCell(feet, cell, (x, y, z) => isSafeSupport(read(x, y, z)))) return null;
  const block = bot.blockAt(cell);
  if (!block) return null;
  const eye = feet.offset(0, observedEyeHeight(bot.entity), 0);
  const shapes = block.shapes.map(([minX, minY, minZ, maxX, maxY, maxZ]) => ({ minX, minY, minZ, maxX, maxY, maxZ }));
  return visibleBlockAim(bot.world, eye, cell, DIG_REACH, shapes);
}

/** Walk only a short, non-destructive route; count travelled distance so detours cannot escape the bound. */
async function approachPlacement(bot: Bot, cell: Vec3, signal: AbortSignal): Promise<string | null> {
  if (removalAim(bot, cell)) return null;
  const navigate = contexts.get(bot)?.navigate;
  if (bot.entity.position.distanceTo(cell) > LIFE_SAVING_ROUTE_BLOCKS || !navigate) return "unreachable within 8 blocks";
  const route = new AbortController();
  let previous = bot.entity.position.clone();
  let travelled = 0;
  const countTravel = () => {
    travelled += previous.distanceTo(bot.entity.position);
    previous = bot.entity.position.clone();
    if (travelled > LIFE_SAVING_ROUTE_BLOCKS) route.abort(new Error("route exceeded 8 blocks"));
  };
  const movements = createMovements(bot, { allowDigging: false, scaffolding: false, allowParkour: false });
  const decideStep = movements.decideStep.bind(movements);
  const bounded = { ...movements, decideStep: (x: number, y: number, z: number, world: Parameters<typeof decideStep>[3]) =>
    travelled + bot.entity.position.distanceTo(new Vec3(x + 0.5, y, z + 0.5)) > LIFE_SAVING_ROUTE_BLOCKS
      ? { kind: "prohibited" as const, reason: "cleanup route is limited to 8 blocks" }
      : decideStep(x, y, z, world) };
  bot.on("physicsTick", countTravel);
  try {
    const result = await navigate({
      movements: bounded,
      goal: customGoal(`remove emergency placement ${cell}`, (node, { position }) => {
        // The node the body is in is judged where the body is: its centre may be over a drop while the footprint is on the step.
        const inThisNode = Math.floor(position.x) === node.feet.x && Math.floor(position.z) === node.feet.z && Math.abs(position.y - node.feet.y) < 0.5;
        return removalAim(bot, cell, inThisNode ? new Vec3(position.x, position.y, position.z) : new Vec3(node.feet.x + 0.5, node.feet.y, node.feet.z + 0.5)) !== null;
      }),
      signal: AbortSignal.any([signal, route.signal]),
    });
    if (result.status === "stopped") return `no route to the placement: ${result.reason}`;
    return removalAim(bot, cell) ? null : "the route ended outside removal reach";
  } catch (cause) {
    signal.throwIfAborted();
    return cause instanceof Error ? cause.message : String(cause);
  } finally {
    bot.off("physicsTick", countTravel);
  }
}

/** A dig owns its abort listener only after looking, as Mineflayer cannot stop a dig still in its look. */
async function removeRecordedBlock(bot: Bot, entry: LifeSavingPlacement, signal: AbortSignal): Promise<RemovalAttempt> {
  const aim = removalAim(bot, entry.cell);
  if (!aim) return { kind: "left", why: "the block is not visible within reach" };
  await raceSignal(bot.lookAt(aim, true), signal);
  signal.throwIfAborted();
  const block = bot.blockAt(entry.cell);
  if (!block) return { kind: "left", why: "the cell is unloaded" };
  if (block.name !== entry.block) return { kind: "changed" };
  const refusal = regionChangeRefusal(bot, entry.cell, "dig");
  if (refusal) return { kind: "left", why: refusal };
  const stop = () => bot.stopDigging();
  const watch = watchServerChange(bot, entry.cell);
  signal.addEventListener("abort", stop, { once: true });
  try {
    await raceSignal(bot.dig(block, "ignore"), signal);
    if (!await watch.answer(signal)) return { kind: "left", why: "the server did not confirm the dig" };
    const after = bot.blockAt(entry.cell);
    return after && after.type === 0 ? { kind: "removed" } : { kind: "left", why: "the dig did not confirm removal" };
  } finally {
    signal.removeEventListener("abort", stop);
    watch.dispose();
  }
}

/** One cell is re-observed after travel, so a changed build is never mistaken for our emergency block. */
async function removePlacement(bot: Bot, entry: LifeSavingPlacement, signal: AbortSignal): Promise<RemovalAttempt> {
  if (!bot.blockAt(entry.cell)) return { kind: "left", why: "the cell is unloaded" };
  const approach = await approachPlacement(bot, entry.cell, signal);
  if (approach) return { kind: "left", why: approach };
  signal.throwIfAborted();
  const block = bot.blockAt(entry.cell);
  if (!block) return { kind: "left", why: "the cell is unloaded" };
  if (block.name !== entry.block) return { kind: "changed" };
  if (entry.kind === "block") return removeRecordedBlock(bot, entry, signal);
  const hook = waterHooks.get(bot);
  if (!hook) return { kind: "left", why: "no hook is installed to refill this water" };
  const refilled = await raceSignal(hook(entry.cell.clone(), signal), signal);
  return refilled && bot.blockAt(entry.cell)?.name !== entry.block
    ? { kind: "removed" } : { kind: "left", why: "the bucket refill failed" };
}

/** Keep a failed removal and its note until a later safe moment confirms removal or a changed cell. */
async function settlePlacement(bot: Bot, entry: LifeSavingPlacement, signal: AbortSignal, parentSignal: AbortSignal, deadline: number): Promise<RemovalAttempt> {
  let attempt: RemovalAttempt;
  try {
    if (monotonicNow() >= deadline) throw new Error("the 30 s removal bound passed");
    signal.throwIfAborted();
    attempt = await removePlacement(bot, entry, signal);
  } catch (cause) {
    parentSignal.throwIfAborted();
    if (bot.health <= 0 || bot.game.dimension !== entry.dimension) throw cause;
    attempt = { kind: "left", why: cause instanceof Error ? cause.message : String(cause) };
  }
  if (attempt.kind === "left") {
    const { x, y, z } = entry.cell;
    const why = `left a ${entry.block} at ${x} ${y} ${z} inside ${describeProtectedRegion(entry.region)}: ${attempt.why}. Return to remove it when safe or ask its owner.`;
    const data = contexts.get(bot)?.data;
    if (!data) throw new Error(`${why} No bot note store is configured.`);
    if (notedFailures.get(entry) !== why) {
      saveBotNote(data, bot, why, "A life-saving placement could not be removed after the reflex ended.");
      notedFailures.set(entry, why);
    }
    attempt = { kind: "left", why };
  }
  if (attempt.kind !== "left") forgetPlacement(bot, entry);
  return attempt;
}

/** Danger can return while a dig or server answer is pending, including with no more physics ticks. */
function watchRemovalDanger(bot: Bot, isDangerous: () => boolean) {
  const controller = new AbortController();
  const check = () => {
    try {
      if (isDangerous()) controller.abort(new Error("Emergency placement cleanup waits for the danger to end."));
    } catch (cause) {
      controller.abort(cause);
    }
  };
  bot.on("physicsTick", check);
  bot.on("health", check);
  bot.on("blockUpdate", check);
  check();
  return {
    signal: controller.signal,
    stop() {
      bot.off("physicsTick", check);
      bot.off("health", check);
      bot.off("blockUpdate", check);
    },
  };
}

/** Remove one safe moment's ledger, bounded even when physics or a server answer stops. Interruptions retain work. */
export async function removeLifeSavingPlacements(
  bot: Bot,
  parentSignal: AbortSignal,
  onLeft?: (left: { cell: Vec3; why: string }) => void,
  isDangerous: () => boolean = () => false,
): Promise<RemovalResult> {
  parentSignal.throwIfAborted();
  const result: RemovalResult = { removed: [], left: [] };
  if (bot.health <= 0 || !bot.entity.onGround || isDangerous()) return result;
  const deadline = monotonicNow() + LIFE_SAVING_REMOVAL_MS;
  const lifetime = new AbortController();
  const timer = setTimeout(() => lifetime.abort(new Error("the 30 s removal bound passed")), LIFE_SAVING_REMOVAL_MS);
  const death = () => lifetime.abort(new Error("The bot died during removal."));
  const dimension = bot.game.dimension;
  const game = () => {
    if (bot.game.dimension !== dimension) lifetime.abort(new Error("The dimension changed during removal."));
  };
  bot.on("death", death);
  bot.on("game", game);
  const danger = watchRemovalDanger(bot, isDangerous);
  const interrupted = AbortSignal.any([parentSignal, danger.signal]);
  const signal = AbortSignal.any([interrupted, lifetime.signal]);
  try {
    for (const entry of [...pendingLifeSavingPlacements(bot)]) {
      if (entry.dimension !== bot.game.dimension) continue;
      interrupted.throwIfAborted();
      const block = bot.blockAt(entry.cell);
      if (block && block.name !== entry.block) { forgetPlacement(bot, entry); continue; }
      const attempt = await settlePlacement(bot, entry, signal, interrupted, deadline);
      if (attempt.kind === "left") {
        const left = { cell: entry.cell.clone(), why: attempt.why };
        result.left.push(left);
        onLeft?.(left);
      }
      if (attempt.kind === "removed") result.removed.push(entry.cell.clone());
    }
    return result;
  } catch (cause) {
    parentSignal.throwIfAborted();
    if (!danger.signal.aborted || bot.health <= 0 || bot.game.dimension !== dimension) throw cause;
    return result;
  } finally {
    danger.stop();
    clearTimeout(timer);
    bot.off("death", death);
    bot.off("game", game);
  }
}
