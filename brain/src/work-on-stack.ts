// One objective on the agent's stack and what was done for it (moved out of agent.ts, which stays under its line budget).
import type { Activity } from "./activities.ts";
import { monotonicNow } from "./monotonic-clock.ts";
import type { Objective, StepRecord } from "./mind.ts";

/** One objective on the agent's stack and what was done for it. */
export interface Work {
  readonly objective: Objective;
  /** When it was taken on: wall ms for the socialising routine (a talk ended since then is the one it came for), and the same moment monotonic for the conversation controller's ask stamps. */
  readonly startedAt: number;
  readonly startedAtMonotonic: number;
  readonly steps: StepRecord[];
  /** What was carried after each of `steps` (name:count, sorted; null when unknown); not shown to the model, so prompts do not change. */
  readonly carried: (string | null)[];
  taken: number;
  badReplies: number;
  sentBacks: number;
  /** Aborts the step running now: the objective is set aside or stopped, the agent goes on. */
  step: AbortController | null;
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

export function newWork(objective: Objective, whisperTo: string | null = null): Work {
  return { objective, startedAt: Date.now(), startedAtMonotonic: monotonicNow(), steps: [], carried: [], taken: 0, badReplies: 0, sentBacks: 0, step: null, lastFact: "", spokenAt: monotonicNow(), failing: { skill: "", count: 0 }, whisperTo, refused: new Map(), wanted: new Set(), levelSites: new Map(), toolsLost: new Set(), purpose: objective.purpose };
}
