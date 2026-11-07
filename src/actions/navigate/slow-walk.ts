/**
 * What a navigate call says when its walk barely moves: how much nearer it got, what it dug on the way and by what, and
 * which tool would have been faster (read from the registry, never from block names). The dig counter lives for one
 * call (its lifetime); the text is pure.
 */
import type { Bot } from "mineflayer";
import { observeNavigationDigs } from "../../navigation/index.js";
import type { Position3 } from "../../utils/index.js";
import { NAVIGATION_SLOW_CODE, type NavigationEvidence } from "./contract.js";

/**
 * What a call dug: the evidence's `digs` (`digFactsSchema` in `contract.ts`). `byHandBlocks` lists the blocks dug by hand,
 * most first; `fasterWith` the tool families that speed up those blocks, with how many of them each speeds up, most first.
 */
export type DigFacts = NavigationEvidence["digs"];

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
  if (digs.count === 0) return "no blocks broken: the way itself is slow (water, climbing, detours)";
  const broken = `${digs.count} blocks broken in ${Math.round(digs.ms / 1000)} s`;
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
    `Feet at ${Math.floor(x)},${Math.floor(y)},${Math.floor(z)}.`
  );
}
