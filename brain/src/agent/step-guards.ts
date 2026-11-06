// What keeps the agent's own work in check: the night measure (nightfall stops a step of its own, a shelter waits for the day) and the goal tier's pace.
import type { AgentOptions } from "../agent.ts";
import type { Body } from "../body.ts";
import { elapsedSince, monotonicNow } from "../monotonic-clock.ts";
import { shelterForNight, underCover } from "../night-shelter.ts";
import type { ProtectedArea } from "../runtime-client.ts";
import type { SkillResult } from "../skills.ts";
import type { Work } from "./work.ts";

/** How often a step of its own is checked for nightfall (TEMPORARY night shelter). */
const NIGHT_CHECK_MS = 20_000;
/** After a night shelter could not be made, how long before it is tried again. */
const SHELTER_RETRY_MS = 5 * 60_000;

/** What the guards read from the agent they belong to. `runSignal` is a getter: `Agent.run` replaces the signal at start. */
interface StepGuardHost {
  readonly options: AgentOptions;
  readonly body: Body;
  readonly areas: ProtectedArea[];
  /** How often the agent polls, in milliseconds: the longest slice of a wait. */
  readonly pollMs: number;
  runSignal(): AbortSignal;
  top(): Work | undefined;
  idle(ms: number): Promise<void>;
  journalState(step: string | null): void;
  rememberOwnOutcome(line: string): void;
}

export class StepGuards {
  /** The night shelter running now (see {@link shelterIfNight}); an order stops it. */
  private sheltering: AbortController | null = null;
  /** No shelter tried before then: the last one could not be dug here. */
  private shelterRetryAt = 0;
  /** When the sky was last looked at for nightfall during a step of its own. */
  private nightCheckedAt = Number.NEGATIVE_INFINITY;
  private nextGoalCall = 0;

  constructor(private readonly host: StepGuardHost) {}

  /** Stops the night shelter running now, if any (an order was taken). */
  stopShelter(): void {
    this.sheltering?.abort();
  }

  /**
   * TEMPORARY night measure (see night-shelter.ts): at nightfall, a step of its own goal is set aside (the objective
   * stays on the stack and resumes in the morning). Looked at every {@link NIGHT_CHECK_MS}.
   */
  async stopOwnStepAtNightfall(): Promise<void> {
    if (!this.host.options.persona.settings.shelterAtNight || monotonicNow() - this.nightCheckedAt < NIGHT_CHECK_MS) return;
    const top = this.host.top();
    if (top?.step == null || top.objective.requester !== null || monotonicNow() < this.shelterRetryAt) return;
    this.nightCheckedAt = monotonicNow();
    if (!(await this.outInTheNight())) return;
    this.host.options.log("night fell: setting the step aside to dig in");
    top.step.abort();
  }

  /** Night in the overworld, and nothing over its head (underground or under a roof the night is no worse). */
  private async outInTheNight(): Promise<boolean> {
    const { runtime } = this.host.options;
    const snapshot = await runtime.status();
    return snapshot.clock?.phase === "night" && !(await underCover(runtime, snapshot.position));
  }

  /**
   * TEMPORARY night measure (see night-shelter.ts): at night, unless working on an order, it digs in and waits for the
   * day. True when it took the turn (sheltered, or tried to); a shelter that could not be made is not tried again for
   * {@link SHELTER_RETRY_MS}, so it goes on with its work meanwhile.
   */
  async shelterIfNight(work: Work | undefined): Promise<boolean> {
    const { persona, runtime, log } = this.host.options;
    if (!persona.settings.shelterAtNight || monotonicNow() < this.shelterRetryAt) return false;
    if (work !== undefined && work.objective.requester !== null) return false;
    if (!(await this.outInTheNight())) return false;
    const controller = new AbortController();
    this.sheltering = controller;
    const objective = work?.objective.text ?? "(own goal)";
    const label = "shelter for the night";
    log(`night: ${label}`);
    this.host.journalState(label);
    const started = monotonicNow();
    let result: SkillResult;
    try {
      result = await shelterForNight({
        runtime,
        body: this.host.body,
        signal: AbortSignal.any([controller.signal, this.host.runSignal()]),
        areas: this.host.areas,
        dayCame: async () => (await runtime.status()).clock?.phase !== "night",
      });
    } catch (error) {
      result = { status: "failed", detail: error instanceof Error ? error.message : String(error) };
    } finally {
      this.sheltering = null;
    }
    if (result.status === "failed") this.shelterRetryAt = monotonicNow() + SHELTER_RETRY_MS;
    const outcome = result.status === "stopped" ? "interrupted" : result.status;
    const detail = result.status === "stopped" ? "left for an order, or stopped" : result.detail;
    log(`  -> ${label}: ${outcome}: ${detail}`);
    this.host.options.journal?.({ kind: "step", objective, requester: null, step: label, input: { skill: "shelter_for_night" }, thought: "", outcome, detail, ms: elapsedSince(started), activity: null });
    this.host.journalState(null);
    if (result.status === "done") this.host.rememberOwnOutcome(`${label}: ${detail}`);
    return true;
  }

  /**
   * Paces own-goal thinking (ADR-011): waits until the next call is allowed. False when an order to do now arrived
   * meanwhile (orders and chat are never held back; an order taken on for later waits its turn).
   */
  async waitForGoalBudget(): Promise<boolean> {
    const interval = 60_000 / this.host.options.persona.settings.goalCallsPerMinute;
    const orderOnTop = () => (this.host.top()?.objective.requester ?? null) !== null;
    while (monotonicNow() < this.nextGoalCall) {
      if (this.host.runSignal().aborted || orderOnTop()) return false;
      await this.host.idle(Math.min(this.nextGoalCall - monotonicNow(), this.host.pollMs));
    }
    if (orderOnTop()) return false;
    this.nextGoalCall = monotonicNow() + interval;
    return true;
  }
}
