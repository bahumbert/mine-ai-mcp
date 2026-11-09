// Paces own-goal thinking while allowing orders to take priority.
import type { AgentOptions } from "../agent.ts";
import { monotonicNow } from "../monotonic-clock.ts";
import type { Work } from "./work.ts";

/** What the guards read from the agent they belong to. `runSignal` is a getter: `Agent.run` replaces the signal at start. */
interface StepGuardHost {
  readonly options: AgentOptions;
  /** How often the agent polls, in milliseconds: the longest slice of a wait. */
  readonly pollMs: number;
  runSignal(): AbortSignal;
  top(): Work | undefined;
  idle(ms: number): Promise<void>;
}

export class StepGuards {
  private nextGoalCall = 0;

  constructor(private readonly host: StepGuardHost) {}

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
