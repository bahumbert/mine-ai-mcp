import type { Activity } from "./activities.ts";
import { describeStep, type Step } from "./actions.ts";
import type { Materials, Site } from "./building/plan.ts";
import type { Variants } from "./building/blueprint.ts";
import type { Template } from "./building/templates.ts";
import { abandonHouse } from "./building/abandon-house.ts";
import type { Body } from "./body.ts";
import type { KnownPlace, SignLinesInput } from "./mind.ts";
import type { ClaimResult } from "./skills/claim-sign.ts";
import type { KnownFarm } from "./memory.ts";
import { farm } from "./farming/farm-skill.ts";
import type { TillFacts } from "./farming/site.ts";
import type { HostileInterruptions } from "./gathering/hostile-interruptions.ts";
import type { OwedItem } from "./relations/items.ts";
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
import { listHouses } from "./skills/list-houses.ts";
import type { Near } from "./farming/growth.ts";
import { protectArea, releaseArea } from "./skills/protect-area.ts";
import { collectBlock, eat, equip, goTo, hunt, sleep } from "./skills/single-action.ts";
import { houseReserve } from "./walks.ts";

export interface SkillContext {
  readonly runtime: BotRuntime;
  readonly body: Body;
  readonly signal: AbortSignal;
  /** Who asked: a house faces them. */
  readonly requester?: string;
  /** The persona's building style (always its own: the model cannot pick another). */
  readonly style?: string;
  /** Optional model-written lines after the claim's mandatory owner line. */
  readonly signLines?: (input: Omit<SignLinesInput, "persona">, signal: AbortSignal) => Promise<string[]>;
  /** Told about places worth remembering (a finished house), so later requests such as "go to the roof" can use them. */
  readonly remember?: (place: KnownPlace) => void;
  /** The house left unfinished by an earlier build step, which the next build of the same kind resumes. */
  readonly building?: { unfinished: UnfinishedHouse | null };
  /** Told that `building.unfinished` just changed: saved as a note at once, so a stop that throws (run 17b) still leaves the house on record. */
  readonly saveBuilding?: () => void;
  /** The house templates it may build (default: the shipped registry); tests inject fixtures. */
  readonly templates?: ReadonlyMap<string, Template>;
  /** The places it knows (the houses it built among them): an own area around one of their doors is named as that house. */
  readonly places?: () => readonly KnownPlace[];
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
  /** My side not yet given of the agreed trades (every objective, orders too): `give_item` and `drop_item` keep it, the hand-off gives only what other trades do not owe. */
  readonly owed?: () => readonly OwedItem[];
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
  /** The template's id and family (an older note has none: the template is the one whose name is `kind`). */
  readonly template?: string;
  readonly family?: string;
  /** The stage reached (0-based index of the stage now being built or next), how many there are and its name: for the model's lines and the monitor; `part` is what resumes. */
  readonly stage?: number;
  readonly stages?: number;
  readonly stageName?: string;
  readonly site: Site;
  readonly owner?: string;
  readonly dimension?: string;
  readonly claim?: NonNullable<ClaimResult["claim"]>;
  /** The first part (batch) not yet built. */
  readonly part: number;
  /** False while its site is still to be leveled (an older note has none: its site counts as ready). */
  readonly prepared?: boolean;
  /** The roles built with other blocks than the template's (an older note has none: as the template). */
  readonly materials?: Materials;
  /** Remembered substitute shapes; an older note without them keeps full blocks. */
  readonly shapes?: Variants;
  /**
   * The cells the runtime refused in the last run that stopped on them (an older note has none). A refusal is often
   * transient (an animal in the cell, a route that timed out), so the house is kept; it is given up only when a
   * resume is refused at one of these cells again.
   */
  readonly refused?: readonly { readonly x: number; readonly y: number; readonly z: number }[];
}

/** Why a skill failed, for the code that must tell failures apart (the detail is for the model and the journal only). */
export type FailReason = "items_gone" | "not_taken" | "no_talk" | "did_not_come" | "recipient_busy" | "recipient_unreachable";

export type SkillResult =
  /** `taken`: for a give, how many items the recipient picked up (absent when the runtime named no recipient). */
  /** `usedOwn`: for a fetch, "used 3 oak_planks of what you carried" when its crafts took carried items and none was near to replace them. */
  | { readonly status: "done"; readonly detail: string; readonly taken?: number; readonly usedOwn?: string }
  | { readonly status: "failed"; readonly detail: string; readonly reason?: FailReason }
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
      case "get_items": {
        // An unfinished house's bill is kept from the crafts as well as from the walks: the logs of its walls are not planks' stock.
        const house = await houseReserve(context);
        return await getItems(context, step.items, { walkKeep: house.keep, reserve: house.bill });
      }
      case "eat": return await eat(context, step, why);
      case "equip": return await equip(context, step, why);
      case "sleep": return await sleep(context, step, why);
      case "dig_shelter": return await digShelter(context, step);
      case "hunt": return await hunt(context, step, why);
      case "level_area": return await levelArea(context, step);
      case "protect_area": return await protectArea(context, step);
      case "release_area": return await releaseArea(context, step.area);
      case "build": return await build(context, step);
      case "list_houses": return listHouses(step);
      case "improve_house": return await improveHouse(context, step);
      case "abandon_house": return await abandonHouse(context);
      case "farm": return await farm(context, step);
    }
  } catch (error) {
    if (context.signal.aborted) return { status: "stopped" };
    throw error;
  }
}
