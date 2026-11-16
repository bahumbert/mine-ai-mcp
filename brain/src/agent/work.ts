// One objective on the agent's stack (Work), the step decision and run it is worked with, and the kinds of work that end an objective.
import type { Step } from "../actions.ts";
import type { Activity, ActionTime, ActivityPhase } from "../activities.ts";
import type { Objective, StepRecord, WorkDecision } from "../mind.ts";
import { monotonicNow } from "../monotonic-clock.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import type { SkillResult } from "../skills.ts";
import type { SituationInfo } from "./situations.ts";

/** A situation event on the stack (a night, a respawn, low health): what raised it and the order that was on top when it came. */
export interface SituationState {
  readonly info: SituationInfo;
  /** The order that was on top when the situation came, or null: a situation over the own goal has none. */
  readonly order: Work | null;
  /** Whether the model was told this situation's latest decision (a decision per situation, not per poll). */
  told: boolean;
}

/** One objective on the stack and what was done for it. */
export interface Work {
  readonly objective: Objective;
  readonly steps: StepRecord[];
  /** What was carried after each of `steps` (name:count, sorted; null when unknown); not shown to the model, so prompts do not change. */
  readonly carried: (string | null)[];
  taken: number;
  badReplies: number;
  sentBacks: number;
  /** Aborts the step running now: the objective is set aside or stopped, the agent goes on. */
  step: AbortController | null;
  /** The step running now and its controller, for the monitor and the situation events (null when none runs). */
  running: { readonly step: Step; readonly controller: AbortController } | null;
  /** A situation's state, or null for an objective the character or a player took on. */
  situation: SituationState | null;
  /** The step a situation chose already, run next without a model call (its decision was made when it was raised). */
  planned: StepDecision | null;
  /** The last thing a skill said it started doing, and when a line about it was last asked for (an order's progress). */
  lastFact: string;
  spokenAt: number;
  /** The skill whose steps failed last, and how many times in a row. */
  failing: { skill: string; count: number };
  /** Who the order came from by whisper: its progress and its end are whispered back to them (spec 2026-10-09, C). */
  whisperTo: string | null;
  /** Step key -> refusals since that step last ran (rule 2: three end the objective); counted by the mind, reset here. */
  readonly refused: Map<string, number>;
  /** The items its get_items and craft_item steps went out to obtain: not junk when a full inventory is cleared. */
  readonly wanted: Set<string>;
  /** Where a level_area around each player (lower-case name) was first aimed in this objective: later steps reuse it (run 13). */
  readonly levelSites: Map<string, { readonly x: number; readonly y: number; readonly z: number }>;
  /** The tool classes whose tool broke in this objective and was not made again: the next fetch makes it first (N7). */
  readonly toolsLost: Set<string>;
  /**
   * What its time counts for: the objective's purpose, until one of its steps builds, improves a house or farms; from
   * then on that (run 11, 2026-10-14: houses were labelled crafting, mining or woodcutting by the goal tier).
   */
  purpose: Activity | null;
}

/** A decision to run a step. */
export type StepDecision = Extract<WorkDecision, { readonly kind: "step" }>;

/** What a step run left, before it is recorded: its result, when it started, the runtime actions and phases it went through. */
export interface StepRun {
  readonly after: BotSnapshot | null;
  readonly label: string;
  readonly result: SkillResult;
  readonly started: number;
  readonly actions: readonly ActionTime[];
  readonly phases: readonly ActivityPhase[];
  /** Why the no-gain watch stopped the step, or null. */
  readonly stalled: string | null;
  /** Why the death watch ended the step (`you died during this step at x y z (cause)`), or null. */
  readonly died: string | null;
}

/** What is carried, as `name:count` sorted (totals per name): compared to tell whether the inventory changed. */
export function carriedOf(snapshot: BotSnapshot): string {
  const totals = new Map<string, number>();
  for (const { name, count } of snapshot.inventory) totals.set(name, (totals.get(name) ?? 0) + count);
  return [...totals].map(([name, count]) => `${name}:${count}`).sort().join(",");
}

/** Skills that are an end in themselves: an objective that runs one is for that work (its fetches included). */
export const ENDS: ReadonlyMap<Step["skill"], Activity> = new Map([["build", "building"], ["improve_house", "building"], ["farm", "farming"]]);

export function newWork(objective: Objective, whisperTo: string | null = null, situation: SituationState | null = null, planned: StepDecision | null = null): Work {
  return { objective, steps: [], carried: [], taken: 0, badReplies: 0, sentBacks: 0, step: null, running: null, situation, planned, lastFact: "", spokenAt: monotonicNow(), failing: { skill: "", count: 0 }, whisperTo, refused: new Map(), wanted: new Set(), levelSites: new Map(), toolsLost: new Set(), purpose: objective.purpose };
}
