/**
 * The boundary between shared test infrastructure and replaceable test logic.
 * Drivers receive scenario data and recorded action calls so they can express
 * a test without managing the bot, runtime, cancellation or recording themselves.
 */
import type { ClientCompletion, ScenarioDefinition } from "mine-labs/client";
import type { Bot } from "mineflayer";
import type { ActionOutput, ActionResult } from "@aibengineering/mine-ai-mcp";

/** Action evidence, independent of the test's expectation. */
export interface ScenarioCall extends ActionOutput<string, ActionResult> {
  readonly summary: string;
}

export interface ScenarioContext {
  readonly scenario: ScenarioDefinition;
  /** The bot, for reading state only (vehicle, position, inventory); every action goes through `call`. */
  readonly bot: Bot;
  /** Let a fixture settle after the trial starts, before taking action. */
  waitForTicks(ticks: number): Promise<void>;
  /**
   * Stop and restart the bot's client physics, as a ride or an unloaded chunk does: no physics tick is emitted
   * while paused, so `waitForTicks` never ends. A driver that pauses uses wall-clock delays.
   */
  readonly physics: { pause(): void; resume(): void };
  /** Run a registered action; the host owns cancellation, recording and cleanup. */
  call(action: string, input: Record<string, unknown>): Promise<ScenarioCall>;
}

export type ScenarioRun = (context: ScenarioContext) => Promise<ClientCompletion>;
