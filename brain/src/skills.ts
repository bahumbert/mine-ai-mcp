import type { Activity } from "./activities.ts";
import { describeStep, type Step } from "./actions.ts";
import type { Materials, Site } from "./building/plan.ts";
import type { Body } from "./body.ts";
import type { KnownPlace } from "./mind.ts";
import type { KnownFarm } from "./memory.ts";
import { farm } from "./farming/farm-skill.ts";
import type { TillFacts } from "./farming/site.ts";
import type { HostileInterruptions } from "./gathering/hostile-interruptions.ts";
import type { BotRuntime, BotSnapshot, ProtectedArea } from "./runtime-client.ts";
import { build } from "./skills/build-house.ts";
import { craftItem } from "./skills/craft-item.ts";
import { dropItems } from "./skills/drop-items.ts";
import { digShelter } from "./skills/dig-shelter.ts";
import type { ShelterHole } from "./shelter/dig-in.ts";
import { explore } from "./skills/explore.ts";
import { come, follow } from "./skills/follow.ts";
import { getItems } from "./skills/get-items.ts";
import { giveItem } from "./skills/give-item.ts";
import { improveHouse } from "./skills/improve-house.ts";
import { levelArea } from "./skills/level-area.ts";
import type { Near } from "./farming/growth.ts";
import { protectArea, releaseArea } from "./skills/protect-area.ts";
import { collectBlock, eat, equip, goTo, hunt, sleep } from "./skills/single-action.ts";

export interface SkillContext {
  readonly runtime: BotRuntime;
  readonly body: Body;
  readonly signal: AbortSignal;
  /** Who asked: a house faces them. */
  readonly requester?: string;
  /** The persona's building style (always its own: the model cannot pick another). */
  readonly style?: string;
  /** Told about places worth remembering (a finished house), so later requests such as "go to the roof" can use them. */
  readonly remember?: (place: KnownPlace) => void;
  /** The house left unfinished by an earlier build step, which the next build of the same kind resumes. */
  readonly building?: { unfinished: UnfinishedHouse | null };
  /** Its own house that still has temporary parts, as last remembered (a place with a `house` whose materials are not empty). */
  readonly ownHouse?: () => KnownPlace | null;
  /** The protected areas the agent knows (ADR-012), updated in place when a skill protects or releases one. */
  readonly areas?: ProtectedArea[];
  /** The character's own username: areas it owns are its own builds. */
  readonly self?: string;
  /** Told what it starts doing now and why, at a skill's phase changes (see {@link GatherContext.progress}). */
  readonly progress?: (fact: string) => void;
  /** Told where a fetch is travelling to (a place it saw the block), and null when it arrived or gave up: getting nearer counts as progress for the no-gain stop. */
  readonly heading?: (target: { readonly x: number; readonly z: number } | null) => void;
  /** Told that the step is alive without doing anything the brain can see (a follower holding beside a player who stands still): resets the silence limit. */
  readonly alive?: () => void;
  /** Told that the step's work is another activity from now on (the house's site preparation is terraforming). */
  readonly phase?: (activity: Activity) => void;
  /** When the player who asked for this step last said anything (a `monotonicNow()` reading); unset for her own goals. */
  readonly heardFrom?: () => number;
  /** The farms it made, as at their last tend; farming near one tends it. */
  readonly farms?: readonly KnownFarm[];
  /** Sampled minutes near a farm since its last tend; absent or null after a restart. */
  readonly nearMinutes?: (farm: KnownFarm) => Near | null;
  /** Told about a farm made or tended, to remember it. */
  readonly rememberFarm?: (farm: KnownFarm) => void;
  /** Told about the hole after its roof step, so the memory and monitor keep the newest shelter. */
  readonly rememberShelter?: (hole: ShelterHole) => void;
  /** The block names a till failed on, shared by every character: a farm site never has them as soil. */
  readonly soil?: TillFacts;
  /** The carried items its own work needs (set for its own objectives only): a drop of its own keeps them; an order drops anything asked. */
  readonly needed?: (snapshot: BotSnapshot) => ReadonlySet<string>;
  /**
   * The place a `level_area` around a player was first aimed at in this objective, by the player's lower-case name: later
   * steps around the same player level the same place, wherever the player has gone since (run 13: Brea's second level
   * followed the owner, flying, 4 blocks up and 20 away). Kept for the objective's life by the agent.
   */
  readonly levelSites?: Map<string, { readonly x: number; readonly y: number; readonly z: number }>;
  /** The tool classes whose tool broke and was not made again, kept for the objective's life by the agent: the next fetch makes the tool before it digs (N7). */
  readonly toolsLost?: Set<string>;
  /** The agent's hostile-interruption memory, retained across objectives and gatherings. */
  readonly hostileInterruptions?: HostileInterruptions;
}

export interface UnfinishedHouse {
  readonly kind: string;
  readonly site: Site;
  /** The first part (batch) not yet built. */
  readonly part: number;
  /** False while its site is still to be leveled (an older note has none: its site counts as ready). */
  readonly prepared?: boolean;
  /** The roles built with other blocks than the style's (an older note has none: as the style). */
  readonly materials?: Materials;
  /**
   * The cells the runtime refused in the last run that stopped on them (an older note has none). A refusal is often
   * transient (an animal in the cell, a route that timed out), so the house is kept; it is given up only when a
   * resume is refused at one of these cells again.
   */
  readonly refused?: readonly { readonly x: number; readonly y: number; readonly z: number }[];
}

export type SkillResult =
  | { readonly status: "done"; readonly detail: string }
  | { readonly status: "failed"; readonly detail: string }
  /** Aborted by the agent (a new order or "stop"); nothing to report. */
  | { readonly status: "stopped" };

/**
 * Brain-level skills: short programs over atomic actions, one per step the model chooses (ADR-011). Following is done
 * here with repeated `navigate` rather than a new runtime action; if that proves too jerky it becomes a
 * `follow_entity` action (backlog).
 */
export async function runStep(step: Step, context: SkillContext): Promise<SkillResult> {
  const why = `I chose to ${describeStep(step)}.`;
  try {
    switch (step.skill) {
      case "follow_player": return await follow(context, step.player, step.distance, step.minutes);
      case "go_to_player": return await come(context, step.player);
      case "go_to": return await goTo(context, step, why);
      case "explore": return await explore(context, step, why);
      case "collect_block": return await collectBlock(context, step, why);
      case "give_item": return await giveItem(context, step.player, step.item, step.count);
      case "drop_item": return await dropItems(context, step, why);
      case "craft_item": return await craftItem(context, step, why);
      case "get_items": return await getItems(context, step.items);
      case "eat": return await eat(context, step, why);
      case "equip": return await equip(context, step, why);
      case "sleep": return await sleep(context, step, why);
      case "dig_shelter": return await digShelter(context, step);
      case "hunt": return await hunt(context, step, why);
      case "level_area": return await levelArea(context, step);
      case "protect_area": return await protectArea(context, step);
      case "release_area": return await releaseArea(context, step.area);
      case "build": return await build(context, step);
      case "improve_house": return await improveHouse(context, step);
      case "farm": return await farm(context, step);
    }
  } catch (error) {
    if (context.signal.aborted) return { status: "stopped" };
    throw error;
  }
}
