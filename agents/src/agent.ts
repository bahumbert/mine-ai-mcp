import { setTimeout as sleep } from "node:timers/promises";
import { allowedSkills, allowedStep, describePlan, describeStep, type Step } from "./actions.ts";
import { Body, HUMAN_TYPING, type TypingPace } from "./body.ts";
import type { ChatLine, KnownPlace, Mind, Resolution } from "./mind.ts";
import type { Persona } from "./persona.ts";
import type { BotRuntime, PlayerMessage } from "./runtime-client.ts";
import { runPlan, type SkillResult } from "./skills.ts";

/** How often the agent checks for new chat. */
const DEFAULT_POLL_MS = 500;
/** Chat lines kept as conversational context. */
const HISTORY_LINES = 12;
/** Known places shown to the models; the oldest is forgotten first. */
const KNOWN_PLACES = 8;

export interface AgentOptions {
  readonly persona: Persona;
  readonly runtime: BotRuntime;
  readonly mind: Mind;
  /**
   * Usernames of the other agents. Never answered in Phase 1, so two bots cannot talk each other into an endless
   * loop; real bot-to-bot conversation (with explicit start/end) is Phase 4.
   */
  readonly otherAgents: readonly string[];
  readonly log: (line: string) => void;
  readonly pollMs?: number;
  /** Chat typing pace; tests use instant typing. */
  readonly typing?: TypingPace;
}

interface Task {
  /** The request as restated by the chat tier. */
  readonly request: string;
  readonly controller: AbortController;
  /** Set once the action or planner tier has turned the request into steps. */
  steps: readonly Step[] | null;
}

/**
 * One character (ADR-008): every message it hears goes to the chat tier, which answers in character and routes it;
 * requests go to the action tier (and the planner when needed); code checks the stance and runs the skills.
 * At most one task at a time: a new request or "stop" replaces the current one.
 */
export class Agent {
  private readonly body: Body;
  private readonly history: ChatLine[] = [];
  private readonly places: KnownPlace[] = [];
  private task: Task | null = null;
  private runSignal: AbortSignal = new AbortController().signal;

  constructor(private readonly options: AgentOptions) {
    this.body = new Body(options.runtime, options.log, options.typing ?? HUMAN_TYPING);
  }

  get activity(): string {
    if (this.task === null) return "idle";
    return this.task.steps === null ? `working out how to: ${this.task.request}` : describePlan(this.task.steps);
  }

  async run(signal: AbortSignal): Promise<void> {
    this.runSignal = signal;
    // The runtime keeps chat from before this brain started; answering it now would be confusing.
    await this.options.runtime.readMessages();
    this.options.log(`listening as ${this.options.persona.username} (${this.options.persona.stance})`);
    try {
      while (!signal.aborted) {
        for (const message of await this.options.runtime.readMessages()) {
          await this.handle(message).catch((error: unknown) => this.options.log(`could not handle "${message.message}": ${String(error)}`));
        }
        await sleep(this.options.pollMs ?? DEFAULT_POLL_MS, undefined, { signal }).catch(() => undefined);
      }
    } finally {
      this.stopTask();
    }
  }

  /** Reacts to one incoming message. Returns once the reply is queued, not spoken, so "stop" is never stuck behind a task. */
  async handle(message: PlayerMessage): Promise<void> {
    const heardAt = Date.now();
    const { persona, mind, log } = this.options;
    this.remember(message.username, message.message);
    if (!this.listensTo(message.username)) return;
    let decision;
    try {
      const snapshot = await this.options.runtime.status();
      decision = await mind.chat({ persona, message, history: this.history.slice(0, -1), snapshot, activity: this.activity, places: [...this.places] }, this.runSignal);
    } catch (error) {
      log(`chat tier failed on "${message.message}": ${String(error)}`);
      return;
    }
    let route = decision.route;
    if ((route === "act" || route === "plan") && allowedSkills(persona.stance).length === 0) {
      log(`route ${route} refused by stance ${persona.stance}`);
      route = "talk";
    }
    const request = route === "act" || route === "plan" ? ` ${JSON.stringify(decision.request)}` : "";
    log(`${message.username}: ${JSON.stringify(message.message)} -> ${route}${request}, say ${JSON.stringify(decision.say)}`);
    if (route === "ignore") return;
    // Stop first so a new order or "stop" takes effect before the reply waits for the body.
    if (route !== "talk") this.stopTask();
    this.speak(decision.say, heardAt);
    if (route === "act" || route === "plan") this.startTask(route, decision.request, message.username);
  }

  /**
   * Who the agent hears at all; whether a message is meant for it is the chat tier's call (no name needed).
   * Other agents are never answered (see {@link AgentOptions.otherAgents}).
   */
  private listensTo(username: string): boolean {
    const { persona, otherAgents } = this.options;
    const speaker = username.toLowerCase();
    if (otherAgents.some((name) => name.toLowerCase() === speaker)) return false;
    return persona.listensTo.length === 0 || persona.listensTo.some((name) => name.toLowerCase() === speaker);
  }

  private startTask(route: "act" | "plan", request: string, requester: string): void {
    const task: Task = { request, controller: new AbortController(), steps: null };
    this.task = task;
    this.carryOut(task, route, requester).then(
      (result) => this.finishTask(task, result),
      (error: unknown) => this.finishTask(task, task.controller.signal.aborted
        ? { status: "stopped" }
        : { status: "failed", detail: error instanceof Error ? error.message : String(error) }),
    );
  }

  private async carryOut(task: Task, route: "act" | "plan", requester: string): Promise<SkillResult> {
    const { persona, mind, runtime, log } = this.options;
    const signal = task.controller.signal;
    const input = { persona, request: task.request, requester, snapshot: await runtime.status(), activity: "idle", places: [...this.places] };
    let resolution: Resolution = route === "act"
      ? await mind.resolve(input, signal)
      : { kind: "escalate", reason: "the chat tier asked for a plan" };
    if (resolution.kind === "escalate") {
      log(`planning "${task.request}" (${resolution.reason})`);
      // The ack promised a quick job: say it needs thinking, while the planner works (not after it).
      if (route === "act") void this.narrate(task, "escalated", resolution.reason);
      resolution = await mind.plan(input, signal);
    }
    if (signal.aborted) return { status: "stopped" };
    if (resolution.kind !== "steps") return { status: "failed", detail: `cannot do that: ${resolution.reason}` };
    const refused = resolution.steps.find((step) => !allowedStep(persona.stance, step));
    if (refused !== undefined) return { status: "failed", detail: `will not ${describeStep(refused)}` };
    task.steps = resolution.steps;
    log(`plan for "${task.request}": ${describePlan(task.steps)}`);
    return runPlan(task.steps, { runtime, body: this.body, signal, requester, style: persona.style, remember: (place) => this.learnPlace(place) });
  }

  private learnPlace(place: KnownPlace): void {
    this.options.log(`known place: ${place.name} (${place.detail})`);
    this.places.push(place);
    if (this.places.length > KNOWN_PLACES) this.places.splice(0, this.places.length - KNOWN_PLACES);
  }

  private async finishTask(task: Task, result: SkillResult): Promise<void> {
    if (this.task === task) this.task = null;
    this.options.log(`task "${task.request}": ${result.status}${result.status === "stopped" ? "" : ` (${result.detail})`}`);
    if (result.status === "stopped") return;
    await this.narrate(task, result.status, result.detail);
  }

  /** Has the chat tier tell the players how a task is going; a progress line is dropped once the task is replaced. */
  private async narrate(task: Task, outcome: "done" | "failed" | "escalated", detail: string): Promise<void> {
    if (this.runSignal.aborted) return;
    try {
      const line = await this.options.mind.narrate({
        persona: this.options.persona,
        task: task.steps === null ? task.request : describePlan(task.steps),
        outcome,
        detail,
        history: this.history,
      }, this.runSignal);
      const stale = outcome === "escalated" && this.task !== task;
      if (!stale) this.speak(line);
    } catch (error) {
      this.options.log(`narration failed: ${String(error)}`);
    }
  }

  private stopTask(): void {
    this.task?.controller.abort();
    this.task = null;
  }

  /** `since`: when the message being answered was heard (thinking time counts as typing time). */
  private speak(text: string, since = Date.now()): void {
    if (text.trim() === "") return;
    this.remember(this.options.persona.username, text);
    this.body.say(text, since).catch((error: unknown) => this.options.log(`say failed: ${String(error)}`));
  }

  private remember(speaker: string, text: string): void {
    this.history.push({ speaker, text });
    if (this.history.length > HISTORY_LINES) this.history.splice(0, this.history.length - HISTORY_LINES);
  }
}
