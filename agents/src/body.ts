import { setTimeout as sleep } from "node:timers/promises";
import type { ActionStatus, BotRuntime, ForegroundState, ForegroundTool } from "./runtime-client.ts";

/** How long one MCP wait may block; also the reaction time to stop, speech, and re-plan checks. */
export const WAIT_SLICE_MS = 1_000;

/** Longest wait for a survival reflex to hand the body back before an action is reported as refused. */
export const REFLEX_WAIT_MS = 30_000;

/** `send_message` refuses longer lines. */
const MAX_CHAT_LENGTH = 256;

export interface ActOutcome {
  readonly status: ActionStatus | "refused";
  readonly error: string | null;
  /** The body cancelled the action itself: to speak, or because `interruptWhen` asked to. */
  readonly preempted: boolean;
}

export interface ActOptions {
  /** Aborting cancels the running action; the outcome is then `cancelled`. */
  readonly signal?: AbortSignal;
  /** Movement that can be dropped and re-planned: pending speech cancels it so the agent can answer at once. */
  readonly interruptible?: boolean;
  /** Checked between wait slices; true cancels the action as preempted (e.g. the followed player moved away). */
  readonly interruptWhen?: () => Promise<boolean>;
}

/**
 * The single owner of a bot's foreground slot.
 *
 * The runtime runs one body-locking task at a time and refuses the next one (`ACTION_BUSY`), and `send_message` is
 * such a task, so the bot cannot talk while it walks. The body therefore serialises every foreground call, lets
 * speech pre-empt interruptible movement, and always retrieves each result so the runtime never answers
 * `RESULT_NOT_RETRIEVED`.
 */
export class Body {
  private queue: Promise<unknown> = Promise.resolve();
  private speechWaiting = 0;

  constructor(private readonly runtime: BotRuntime, private readonly log: (line: string) => void) {}

  act(tool: ForegroundTool, input: Readonly<Record<string, unknown>>, rationale: string, options: ActOptions = {}): Promise<ActOutcome> {
    return this.exclusive(() => this.run(tool, input, rationale, options));
  }

  /** Says one chat line; empty text says nothing. Resolves once the runtime settled the message. */
  async say(text: string): Promise<void> {
    const message = toChatLine(text);
    if (message === "") return;
    this.speechWaiting += 1;
    try {
      const outcome = await this.exclusive(() => this.run("send_message", { message }, "Speak in character.", {}));
      if (outcome.status !== "succeeded") this.log(`say failed (${outcome.status}): ${outcome.error ?? ""}`);
    } finally {
      this.speechWaiting -= 1;
    }
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async run(tool: ForegroundTool, input: Readonly<Record<string, unknown>>, rationale: string, options: ActOptions): Promise<ActOutcome> {
    if (options.signal?.aborted) return { status: "cancelled", error: "stopped before it started", preempted: false };
    let state = await this.submit(tool, input, rationale, options.signal);
    let cancelled = false;
    let preempted = false;
    while (state.state === "pending") {
      if (!cancelled) {
        const stop = options.signal?.aborted === true;
        const yieldToSpeech = options.interruptible === true && this.speechWaiting > 0;
        if (stop || yieldToSpeech || (options.interruptWhen !== undefined && await options.interruptWhen())) {
          cancelled = true;
          preempted = !stop;
          await this.runtime.cancel(state.actionId, stop ? "Stopped by the agent." : "Re-planning.");
        }
      }
      state = await this.runtime.wait(state.actionId, WAIT_SLICE_MS);
    }
    if (state.state === "refused") return { status: "refused", error: `${state.code}: ${state.error}`, preempted: false };
    return { status: state.status, error: state.error, preempted };
  }

  /**
   * Submits, getting past the refusals that only mean "not now":
   * - an action of another client, or one left unretrieved by a previous brain run (the runtime persists them),
   *   holds the slot: this brain owns the bot, so it settles that action and resubmits;
   * - a survival reflex holds the body (`ACTION_BUSY` without an action id; observed live on 2026-09-30 with
   *   `body owner: hostile_reflex`): the reflex is protecting the bot, so wait for it, up to {@link REFLEX_WAIT_MS}.
   */
  private async submit(tool: ForegroundTool, input: Readonly<Record<string, unknown>>, rationale: string, signal: AbortSignal | undefined): Promise<ForegroundState> {
    const deadline = Date.now() + REFLEX_WAIT_MS;
    let settledBlocker = false;
    for (;;) {
      const state = await this.runtime.submit(tool, input, rationale, WAIT_SLICE_MS);
      if (state.state !== "refused") return state;
      const blocking = state.unretrievedActionId ?? state.activeActionId;
      if (blocking !== null && !settledBlocker) {
        this.log(`${tool} refused (${state.code}); settling ${blocking} first`);
        await this.settle(blocking, "Superseded by the agent brain.");
        settledBlocker = true;
        continue;
      }
      if (state.code !== "ACTION_BUSY" || blocking !== null || Date.now() >= deadline || signal?.aborted) return state;
      await sleep(WAIT_SLICE_MS, undefined, { signal }).catch(() => undefined);
    }
  }

  private async settle(actionId: string, reason: string): Promise<void> {
    await this.runtime.cancel(actionId, reason);
    let state = await this.runtime.wait(actionId, WAIT_SLICE_MS);
    while (state.state === "pending") state = await this.runtime.wait(actionId, WAIT_SLICE_MS);
  }
}

/** One legal chat line: single line, no command slash, at most 256 characters (cut at a word when possible). */
export function toChatLine(text: string): string {
  // Control characters and the legacy formatting sign are illegal in chat; model output may contain them.
  const line = text.replace(/[\u0000-\u001f\u007f\u00a7\s]+/gu, " ").trim().replace(/^\/+/u, "").trim();
  if (line.length <= MAX_CHAT_LENGTH) return line;
  const cut = line.slice(0, MAX_CHAT_LENGTH - 3);
  const space = cut.lastIndexOf(" ");
  return `${space > MAX_CHAT_LENGTH / 2 ? cut.slice(0, space) : cut}...`;
}
