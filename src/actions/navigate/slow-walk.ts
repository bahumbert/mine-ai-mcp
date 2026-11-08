/**
 * What a navigate call says when its walk barely moves: how much nearer it got, what it dug on the way and by what, and
 * which tool would have been faster (read from the registry, never from block names). The dig counter lives for one
 * call (its lifetime); the text is pure.
 */
import type { Bot } from "mineflayer";
import { observeNavigationDigs, type NavigationRuntime } from "../../navigation/index.js";
import type { Position3 } from "../../utils/index.js";
import { hasItemFamily, ITEM_FAMILIES } from "../../world/item-families.js";
import { MONOTONIC_CLOCK, type StallClock } from "../stall-watch.js";
import { NAVIGATION_SLOW_CODE, type NavigationEvidence } from "./contract.js";

/**
 * What a call dug: the evidence's `digs` (`digFactsSchema` in `contract.ts`). `byHandBlocks` lists the blocks dug by hand,
 * most first; `fasterWith` the tool families that speed up those blocks, with how many of them each speeds up, most first.
 */
export type DigFacts = NavigationEvidence["digs"];

export const SLOW_WINDOW_MS = 120_000;
export const SLOW_GAIN_BLOCKS = 12;

export interface SlowWalkWindow {
  readonly signal: AbortSignal;
  readonly reason: () => string | null;
  readonly resetLeg: (distance: number | null, range: number) => void;
  readonly pause: () => void;
  readonly resume: () => void;
  readonly close: () => void;
}

const slowWalkWindows = new WeakMap<AbortSignal, SlowWalkWindow>();

/** The goal and lifetime shared by a navigate leg and its progress window. */
export interface WalkLeg {
  readonly bot: Bot;
  readonly request: { readonly x: number; readonly z: number; readonly range: number };
  readonly destination: Position3 | null;
  readonly startDimension: string;
  readonly lifetime: AbortSignal;
  readonly dependencies: { readonly events?: Pick<NavigationRuntime, "onEvent"> };
}

const currentLegs = new WeakMap<AbortSignal, WalkLeg>();

/** Distance to the resolved goal, or horizontally to its unresolved column. */
export function walkLegDistance(leg: WalkLeg): number | null {
  if (leg.bot.game.dimension !== leg.startDimension) return null;
  const { x, y, z } = leg.bot.entity.position;
  const target = leg.destination;
  return target ? Math.hypot(x - target.x, y - target.y, z - target.z)
    : Math.hypot(x - leg.request.x, z - leg.request.z);
}

/** The window of a call, observing whichever leg currently owns it. */
export function walkWindowOf(leg: WalkLeg): SlowWalkWindow {
  return slowWalkWindowOf(leg.lifetime, { bot: leg.bot, events: leg.dependencies.events,
    distance: () => { const current = currentLegs.get(leg.lifetime); return current ? walkLegDistance(current) : null; } });
}

/** Run one leg with its own baseline, pausing during any later reflex suspension. */
export async function withWalkLeg<T>(leg: WalkLeg, run: () => Promise<T>): Promise<T> {
  const window = walkWindowOf(leg);
  const previous = currentLegs.get(leg.lifetime);
  currentLegs.set(leg.lifetime, leg);
  window.resume();
  window.resetLeg(walkLegDistance(leg), leg.request.range);
  try { return await run(); } finally {
    window.pause();
    if (previous) currentLegs.set(leg.lifetime, previous);
    else currentLegs.delete(leg.lifetime);
  }
}

/** Exclude non-walking work from the walking progress budget. */
export async function withoutWalkWindow<T>(leg: WalkLeg, run: () => Promise<T>): Promise<T> {
  const window = walkWindowOf(leg);
  window.pause();
  try { return await run(); } finally { window.resume(); }
}

/** One progress window per navigation lifetime, shared across legs. */
export function slowWalkWindowOf(lifetime: AbortSignal, options: {
  bot: Bot; distance: () => number | null; events?: Pick<NavigationRuntime, "onEvent">;
  clock?: StallClock; windowMs?: number; gainBlocks?: number;
}): SlowWalkWindow {
  const existing = slowWalkWindows.get(lifetime);
  if (existing) return existing;
  const clock = options.clock ?? MONOTONIC_CLOCK;
  const controller = new AbortController();
  let start: number | null = null;
  let best: number | null = null;
  let range = 0;
  let started = clock.now();
  let pausedAt: number | null = null;
  let reason: string | null = null;
  const resetLeg = (distance: number | null, nextRange: number) => {
    start = distance; best = distance; range = nextRange; started = clock.now();
  };
  const stop = clock.every(() => {
    if (pausedAt !== null || controller.signal.aborted) return;
    const distance = options.distance();
    if (distance === null) { start = null; best = null; return; }
    if (start === null || best === null) { resetLeg(distance, range); return; }
    best = Math.min(best, distance);
    const gain = start - best;
    const required = Math.min(options.gainBlocks ?? SLOW_GAIN_BLOCKS, Math.max(1, start - range));
    if (gain >= required) {
      resetLeg(best, range); return;
    }
    if (clock.now() - started < (options.windowMs ?? SLOW_WINDOW_MS)) return;
    reason = slowWalkText({ gained: gain, seconds: (clock.now() - started) / 1000, left: distance,
      required, windowSeconds: (options.windowMs ?? SLOW_WINDOW_MS) / 1000,
      feet: options.bot.entity.position, digs: digCounterOf(options.bot, lifetime).facts(),
      carried: (family) => {
        const known = ITEM_FAMILIES.find((name) => name === family);
        return known !== undefined && options.bot.inventory.items().some((item) => hasItemFamily(options.bot, item.name, known));
      } });
    controller.abort(new Error(reason));
  }, 1000);
  const unsubscribe = options.events?.onEvent((event) => {
    if (pausedAt === null && (event.kind === "escape_relaxed" || event.kind === "own_regions_opened"))
      resetLeg(options.distance(), range);
  });
  const close = () => { stop(); unsubscribe?.(); lifetime.removeEventListener("abort", close); };
  const window: SlowWalkWindow = { signal: controller.signal, reason: () => reason, resetLeg,
    pause: () => { if (pausedAt === null) pausedAt = clock.now(); },
    resume: () => { if (pausedAt !== null) { started = clock.now(); pausedAt = null; } }, close };
  slowWalkWindows.set(lifetime, window);
  lifetime.addEventListener("abort", close, { once: true });
  return window;
}

/** The most hand-dug block kinds the text names. */
const MAX_NAMED_BLOCKS = 5;

/**
 * The tool families a registry block `material` names: the `mineable/<family>` parts of its `;`-separated list.
 * minecraft-data 1.21.4: stone and deepslate are "mineable/pickaxe"; a composite is "plant;mineable/axe" (oak_sapling).
 */
export function toolFamiliesOf(material: string | undefined): string[] {
  return (material ?? "")
    .split(";")
    .filter((part) => part.startsWith("mineable/"))
    .map((part) => part.slice("mineable/".length));
}

function ranked(counts: ReadonlyMap<string, number>): { key: string; count: number }[] {
  return [...counts].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count);
}

/** Counts the digs reported on `bot` from now until `close`. */
export function digCounter(bot: Bot): { readonly facts: () => DigFacts; readonly close: () => void } {
  let count = 0;
  let ms = 0;
  let byHand = 0;
  let byHandMs = 0;
  const blocks = new Map<string, number>();
  const families = new Map<string, number>();
  const close = observeNavigationDigs(bot, (dig) => {
    count += 1;
    ms += dig.ms;
    if (dig.toolType !== null) return;
    byHand += 1;
    byHandMs += dig.ms;
    blocks.set(dig.block, (blocks.get(dig.block) ?? 0) + 1);
    for (const family of toolFamiliesOf(bot.registry.blocksByName[dig.block]?.material)) {
      families.set(family, (families.get(family) ?? 0) + 1);
    }
  });
  return {
    facts: () => ({
      count,
      ms,
      byHand,
      byHandMs,
      byHandBlocks: ranked(blocks).map(({ key, count: n }) => ({ block: key, count: n })),
      fasterWith: ranked(families).map(({ key, count: n }) => ({ family: key, count: n })),
    }),
    close,
  };
}

const digCounters = new WeakMap<AbortSignal, ReturnType<typeof digCounter>>();

/** The one dig counter of a navigate call: its legs share it, and it closes when the call's lifetime ends. */
export function digCounterOf(bot: Bot, lifetime: AbortSignal): ReturnType<typeof digCounter> {
  const known = digCounters.get(lifetime);
  if (known !== undefined) return known;
  const counter = digCounter(bot);
  digCounters.set(lifetime, counter);
  lifetime.addEventListener("abort", counter.close, { once: true });
  return counter;
}

/** "a pickaxe", "an axe": English grammar for a family word, not a list of families. */
function withArticle(word: string): string {
  return `${/^[aeiou]/.test(word) ? "an" : "a"} ${word}`;
}

function digSentence(digs: DigFacts, carried: (family: string) => boolean): string {
  if (digs.count === 0) return "no navigation dig attempts recorded";
  const broken = `${digs.count} dig attempts in ${Math.round(digs.ms / 1000)} s`;
  if (digs.byHand === 0) return `${broken}, none by hand`;
  const named = digs.byHandBlocks.slice(0, MAX_NAMED_BLOCKS).map(({ block, count }) => `${block} ${count}`);
  const more = digs.byHandBlocks.length - named.length;
  const list = more > 0 ? `${named.join(", ")} and ${more} more kinds` : named.join(", ");
  const families = digs.fasterWith.map(({ family }) => family);
  if (families.length === 0) return `${broken}, ${digs.byHand} of them by hand (${list})`;
  const faster = `mined faster with ${families.map(withArticle).join(" or ")}`;
  const none = families.some(carried) ? "" : ", none carried";
  return `${broken}, ${digs.byHand} of them by hand (${list}: ${faster}${none})`;
}

/** The `[NAVIGATION_SLOW]` error: the progress made in the window, what was dug, and where the feet are. */
export function slowWalkText(facts: {
  gained: number;
  seconds: number;
  required: number;
  windowSeconds: number;
  left: number | null;
  feet: Position3;
  digs: DigFacts;
  carried: (family: string) => boolean;
}): string {
  const perMinute = ((facts.gained / facts.seconds) * 60).toFixed(1);
  const left = facts.left === null ? "the distance left is unknown" : `${Math.round(facts.left)} blocks left`;
  const { x, y, z } = facts.feet;
  return (
    `${NAVIGATION_SLOW_CODE} Got ${Math.round(facts.gained)} blocks nearer in ${Math.round(facts.seconds)} s ` +
    `(${perMinute} blocks a minute); ${left}. On the way: ${digSentence(facts.digs, facts.carried)}. ` +
    `Feet at ${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}. ` +
    `The leg needed ${Number(facts.required.toFixed(2))} ${facts.required === 1 ? "block" : "blocks"} ` +
    `nearer in ${facts.windowSeconds} s. Try a different route or improve the tools you carry.`
  );
}
