// Runs the step the model chose under a no-gain watch, gives the skill what it needs, and keeps what the step did.
import { describeStep, stepKey, targetItems } from "../actions.ts";
import type { AgentOptions } from "../agent.ts";
import type { ActionTime, ActivityPhase } from "../activities.ts";
import type { Body } from "../body.ts";
import { watchDeath } from "../death-watch.ts";
import type { HouseSize } from "../building/house.ts";
import { planHouse, styleOrDefault } from "../building/plan.ts";
import type { TillFacts } from "../farming/site.ts";
import { GAIN_SAMPLE_MS, NO_GAIN_MINUTES, watchGain, type GainWatch } from "../gain-watch.ts";
import { FULL_INVENTORY, junkHint, neededItems } from "../inventory-room.ts";
import type { StepRecord } from "../mind.ts";
import { monotonicNow } from "../monotonic-clock.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import { runStep, type SkillContext, type SkillResult } from "../skills.ts";
import type { AgentMemory } from "./agent-memory.ts";
import type { FailedSteps } from "./failed-steps.ts";
import type { GameFacts } from "./game-facts.ts";
import { ENDS, type StepDecision, type StepRun, type Work } from "./work.ts";

/** The error the runtime client throws when the body restarted under a call (see McpBotRuntime). */
const BODY_RESTARTED = "[BODY_RESTARTED]";
/** Steps kept per objective for the work tier. */
const STEP_MEMORY = 20;
/** A step shorter than this is not worth a memory note (it still counts until the brain stops). */
const MIN_RECORDED_MS = 5_000;

/** What the step runner reads from the agent it belongs to. `runSignal` is a getter: `Agent.run` replaces the signal at start. */
interface StepRunnerHost {
  readonly options: AgentOptions;
  readonly body: Body;
  readonly memory: AgentMemory;
  readonly facts: GameFacts;
  readonly failedSteps: FailedSteps;
  /** The block names a till failed on: `options.soil`, or the agent's own when none was given. */
  readonly soil: TillFacts;
  /** When each player (lower case) last said anything. */
  readonly lastHeard: ReadonlyMap<string, number>;
  progress(work: Work, fact: string): void;
  journalState(step: string | null): void;
  runSignal(): AbortSignal;
}

export class StepRunner {
  constructor(private readonly host: StepRunnerHost) {}

  /** Runs the step the model chose under a no-gain watch, timing it and the runtime actions and phases it went through. */
  async runChosenStep(work: Work, decision: StepDecision, snapshot: BotSnapshot): Promise<StepRun> {
    const { options, body } = this.host;
    const label = describeStep(decision.step);
    options.log(`step ${work.taken} for ${JSON.stringify(work.objective.text)}: ${label}${decision.thought === "" ? "" : ` (${decision.thought})`}`);
    const controller = new AbortController();
    work.step = controller;
    this.host.journalState(label);
    const started = monotonicNow();
    // The runtime actions the step runs, timed: what a get_items step mostly did is its activity, and its walking is
    // travelling; a skill's phases (the house's site preparation) change the activity from then on.
    const actions: ActionTime[] = [];
    // The step runs: its earlier refusals are forgotten (rule 2 counts refusals with no run in between).
    work.refused.delete(stepKey(decision.step));
    for (const { item } of targetItems(decision.step)) work.wanted.add(item);
    if (decision.step.skill === "collect_block") await this.wantMinedDrops(work, decision.step.block);
    // A death during the model call is not "during this step": the baseline is read now, not taken from the decision.
    const baseline = await options.runtime.status().then((current) => current.lastDeath, () => snapshot.lastDeath);
    const death = watchDeath({ baseline, controller, status: () => options.runtime.status(), log: options.log });
    const gain = watchGain(decision.step, snapshot, controller, { runtime: options.runtime, log: options.log, ...(options.noGain ?? { minutes: NO_GAIN_MINUTES, sampleMs: GAIN_SAMPLE_MS }), onSnapshot: [death.sample] });
    body.onAction = (tool, input, ms, outcome) => {
      gain.alive();
      death.actionEnded(outcome);
      if (tool !== "note_save" && tool !== "note_delete") actions.push({ tool, input, ms, ended: monotonicNow() });
    };
    const phases: ActivityPhase[] = [];
    let result: SkillResult;
    try {
      result = await runStep(decision.step, this.stepContext(work, controller, gain, started, phases));
    } catch (error) {
      result = { status: "failed", detail: error instanceof Error ? error.message : String(error) };
    } finally {
      gain.stop();
      work.step = null;
      body.onAction = null;
    }
    return { label, result, started, actions, phases, stalled: gain.stalled(), died: death.died() };
  }

  /** What a skill gets to run `work`'s step: the runtime, the body, what the agent knows and keeps, and the signals it reports back through. */
  private stepContext(work: Work, controller: AbortController, gain: GainWatch, started: number, phases: ActivityPhase[]): SkillContext {
    const { options, body, memory } = this.host;
    const { persona, runtime } = options;
    const { requester } = work.objective;
    return {
      runtime,
      body,
      signal: AbortSignal.any([controller.signal, this.host.runSignal()]),
      requester: requester ?? undefined,
      self: persona.username,
      style: persona.style,
      remember: (place) => memory.learnPlace(place),
      ownHouse: () => memory.temporaryHouse(),
      farms: memory.farms,
      rememberFarm: (farm) => memory.learnFarm(farm),
      soil: this.host.soil,
      building: memory.building,
      areas: memory.areas,
      levelSites: work.levelSites,
      toolsLost: work.toolsLost,
      ...(requester === null && { needed: (current: BotSnapshot) => this.neededFor(current, work) }),
      phase: (activity) => {
        gain.alive();
        phases.push({ activity, at: monotonicNow() });
      },
      heading: gain.heading,
      alive: gain.alive,
      ...(requester !== null && { heardFrom: () => this.host.lastHeard.get(requester.toLowerCase()) ?? started }),
      // Only an order is narrated (owner, 2026-10-02); its own goals show in the monitor.
      ...(requester !== null && { progress: (fact: string) => {
        gain.alive();
        this.host.progress(work, fact);
      } }),
    };
  }

  /**
   * Keeps what a finished step did: its time and activity, its record on the objective, its failure for the other
   * objectives, the journal. Null when the body restarted under it (shown as failed, but no refusal, no repeat and no
   * streak: the step was not wrong); else the record, for the loop rules.
   */
  async recordStep(work: Work, decision: StepDecision, run: StepRun, snapshot: BotSnapshot): Promise<StepRecord | null> {
    const { options, memory } = this.host;
    const { label, result, started, stalled, died } = run;
    const ended = monotonicNow();
    const endedAt = new Date().toISOString();
    const ms = Math.round(ended - started);
    const { activity, spans, carried, position, room } = await this.host.facts.activityOf(decision.step, run.actions, snapshot, started, ended, run.phases);
    // A house or a farm is what the objective turned out to be for, whatever its label said (the end decides).
    const endPurpose = ENDS.get(decision.step.skill);
    if (endPurpose !== undefined) work.purpose = endPurpose;
    const { purpose } = work;
    for (const span of spans) memory.spent({ activity: span.activity, ...(purpose !== null && { purpose }), ended: endedAt, minutes: span.ms / 60_000 }, span.ms >= MIN_RECORDED_MS);
    if (memory.activityNotesDue()) await memory.rotateActivityNotes();
    // A death ended the step: interrupted, not failed (it is not the step's fault, the same step may be sent again at once).
    // Else stopped for gaining nothing (not by an order or a "stop"): it failed, and the model is told how far it got.
    let record: StepRecord = died !== null && result.status !== "done"
      ? { step: label, outcome: "interrupted", detail: died }
      : stalled !== null && result.status !== "done"
        ? { step: label, outcome: "failed", detail: stalled }
        : result.status === "stopped"
          ? { step: label, outcome: "interrupted", detail: "set aside for something more urgent, or stopped" }
          : { step: label, outcome: result.status, detail: result.detail };
    // A full inventory names what to drop, with whole counts, and spares what the work needs (live 2026-10-10/11).
    if (record.outcome === "failed" && room !== null && FULL_INVENTORY.test(record.detail)) record = { ...record, detail: `${record.detail}; ${junkHint(room, this.neededFor(room, work))}` };
    work.steps.push(record);
    work.carried.push(carried);
    const restarted = record.outcome === "failed" && record.detail.includes(BODY_RESTARTED);
    if (record.outcome === "failed" && !restarted) this.host.failedSteps.remember(work.objective, label, stepKey(decision.step), record.detail, carried, position);
    options.journal?.({ kind: "step", objective: work.objective.text, requester: work.objective.requester, step: label, input: decision.step, thought: decision.thought, outcome: record.outcome, detail: record.detail, ms, activity, times: spans, purpose });
    this.host.journalState(null);
    if (work.steps.length > STEP_MEMORY) {
      work.steps.splice(0, work.steps.length - STEP_MEMORY);
      work.carried.splice(0, work.carried.length - STEP_MEMORY);
    }
    options.log(`  -> ${record.outcome}: ${record.detail}`);
    memory.memorizeUnfinishedHouse();
    return restarted ? null : record;
  }

  /** What mining `block` gives is wanted too (game data): the fresh loot is not buried to make room (run 15 N5). */
  private async wantMinedDrops(work: Work, block: string): Promise<void> {
    work.wanted.add(block);
    for (const drop of (await this.host.options.runtime.blockDrops([block]).catch(() => ({})))[block] ?? []) work.wanted.add(drop);
  }

  /** The carried items its work needs: tools, armour, stations, foods, the unfinished house's bill and what the objective is out to get. */
  private neededFor(snapshot: Pick<BotSnapshot, "inventory" | "foods">, work: Work): Set<string> {
    const house = this.host.memory.building.unfinished;
    const houseBill = house === null ? [] : planHouse(styleOrDefault(this.host.options.persona.style), (house.kind.split(" ")[0] ?? "small") as HouseSize, house.site, house.materials ?? {}).bill.map((entry) => entry.item);
    return neededItems(snapshot, { houseBill, wanted: work.wanted, objective: work.objective.text });
  }
}
