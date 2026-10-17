import { setTimeout as sleep } from "node:timers/promises";
import type { ActionStatus, BotRuntime, ForegroundState, ForegroundTool } from "./runtime-client.ts";

/** How long one MCP wait may block; also the reaction time to stop, speech, and re-plan checks. */
export const WAIT_SLICE_MS = 1_000;

/** Longest wait for a survival reflex to hand the body back before an action is reported as refused. */
export const REFLEX_WAIT_MS = 30_000;

/**
 * How often a cancel is sent again to an action that stays pending, and how long after the first cancel the step is
 * given back as failed. Live 2026-10-11 (orders test, Vex): a collect_block stayed `stopping` for 6 minutes after one
 * cancel, and the brain waited for it, deaf to "stop", to the no-gain stop and to a new order.
 */
export const RECANCEL_MS = 5_000;
export const STOP_GIVE_UP_MS = 30_000;

export interface StopPace {
  readonly recancelMs: number;
  readonly giveUpMs: number;
}

const GAVE_UP = Symbol("gave up");
const WOKEN = Symbol("woken");

/** `send_message` refuses longer lines. */
const MAX_CHAT_LENGTH = 256;

/** A whisper is one `/tell <name> ` command: the longest header leaves this much (src/actions/send-message/contract.ts). */
const MAX_WHISPER_LENGTH = 233;

export interface ActOutcome {
  readonly status: ActionStatus | "refused";
  readonly error: string | null;
  /** The body cancelled the action itself: to speak, or because `interruptWhen` asked to. */
  readonly preempted: boolean;
  /** The action's whole result, when the runtime returned one. */
  readonly result?: Readonly<Record<string, unknown>>;
}

export interface ActOptions {
  /** Aborting cancels the running action; the outcome is then `cancelled`. */
  readonly signal?: AbortSignal;
  /** Checked between wait slices; true cancels the action as preempted (e.g. the followed player moved away). */
  readonly interruptWhen?: () => Promise<boolean>;
}

/** How fast the character types (owner, 2026-09-30: instant replies read as a machine). */
export interface TypingPace {
  readonly msPerChar: number;
  /** A long line never waits longer than this. */
  readonly maxMs: number;
}

/** About eight characters a second, a quick typist; thinking time already spent counts as typing. */
export const HUMAN_TYPING: TypingPace = { msPerChar: 120, maxMs: 6_000 };
export const INSTANT_TYPING: TypingPace = { msPerChar: 0, maxMs: 0 };

/**
 * The single owner of a bot's foreground slot.
 *
 * The runtime runs one body-locking task at a time and refuses the next one (`ACTION_BUSY`): the body serialises
 * every foreground call and always retrieves each result so the runtime never answers `RESULT_NOT_RETRIEVED`. Chat
 * does not take the body (`send_message` runs beside the foreground action), so speaking never stops or waits for
 * the work in progress; lines keep their order.
 */
export class Body {
  private queue: Promise<unknown> = Promise.resolve();
  private speech: Promise<unknown> = Promise.resolve();
  /** Told about every foreground action once it ends, with how long it ran (the time per activity counts it). */
  onAction: ((tool: ForegroundTool, input: Readonly<Record<string, unknown>>, ms: number) => void) | null = null;

  constructor(private readonly runtime: BotRuntime, private readonly log: (line: string) => void, private readonly typing: TypingPace = HUMAN_TYPING, private readonly pace: StopPace = { recancelMs: RECANCEL_MS, giveUpMs: STOP_GIVE_UP_MS }) {}

  act(tool: ForegroundTool, input: Readonly<Record<string, unknown>>, rationale: string, options: ActOptions = {}): Promise<ActOutcome> {
    return this.exclusive(async () => {
      const started = Date.now();
      try {
        return await this.run(tool, input, rationale, options);
      } finally {
        this.onAction?.(tool, input, Date.now() - started);
      }
    });
  }

  /**
   * Says an answer as one chat line, or two when it is long (`toChatLines`), each after as long as typing it would take
   * counted from `since` (when the message it answers was heard); with `to`, as a whisper to that player. Empty text
   * says nothing. Resolves once the runtime settled the last line.
   */
  say(text: string, since = Date.now(), to?: string): Promise<void> {
    const messages = toChatLines(text, to === undefined ? MAX_CHAT_LENGTH : MAX_WHISPER_LENGTH);
    if (messages.length === 0) return Promise.resolve();
    const line = this.speech.then(async () => {
      let from = since;
      for (const message of messages) {
        const wait = Math.min(message.length * this.typing.msPerChar, this.typing.maxMs) - (Date.now() - from);
        if (wait > 0) await sleep(wait);
        const outcome = await this.runtime.say(message, to);
        if (outcome.status !== "succeeded") this.log(`say failed (${outcome.status}): ${outcome.error ?? ""}`);
        from = Date.now();
      }
    });
    this.speech = line.catch(() => undefined);
    return line;
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
    let cancelledAt = 0;
    let lastCancel = 0;
    while (state.state === "pending") {
      if (!cancelled) {
        const stop = options.signal?.aborted === true;
        if (stop || (options.interruptWhen !== undefined && await options.interruptWhen())) {
          cancelled = true;
          preempted = !stop;
          cancelledAt = lastCancel = Date.now();
          await this.runtime.cancel(state.actionId, stop ? "Stopped by the agent." : "Re-planning.");
        }
      } else {
        const waited = Date.now() - cancelledAt;
        if (waited >= this.pace.giveUpMs) {
          this.log(`${tool} ${state.actionId} did not stop ${Math.round(waited / 1_000)} s after its cancel; giving the step back`);
          return { status: "failed", error: `the action did not stop ${Math.round(waited / 1_000)} s after it was cancelled`, preempted };
        }
        if (Date.now() - lastCancel >= this.pace.recancelMs) {
          lastCancel = Date.now();
          await this.runtime.cancel(state.actionId, "Stopped by the agent.");
        }
      }
      const slice = await this.waitSlice(state.actionId, cancelled ? cancelledAt + this.pace.giveUpMs : null, options.signal);
      if (slice === WOKEN) continue;
      if (slice === GAVE_UP) {
        const waited = Date.now() - cancelledAt;
        this.log(`${tool} did not answer ${Math.round(waited / 1_000)} s after its cancel; giving the step back`);
        return { status: "failed", error: `the action did not stop ${Math.round(waited / 1_000)} s after it was cancelled`, preempted };
      }
      state = slice;
    }
    if (state.state === "refused") return { status: "refused", error: `${state.code}: ${state.error}`, preempted: false };
    return { status: state.status, error: state.error, preempted, ...(state.result !== undefined && { result: state.result }) };
  }

  /**
   * One wait. A runtime that does not answer must not hold the step: before a cancel, an abort of `signal` ends the
   * wait ({@link WOKEN}) so the cancel goes out; after it, the give-up deadline does ({@link GAVE_UP}).
   */
  private async waitSlice(actionId: string, deadline: number | null, signal: AbortSignal | undefined): Promise<ForegroundState | typeof GAVE_UP | typeof WOKEN> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const stopped = new Promise<typeof GAVE_UP | typeof WOKEN>((resolve) => {
      if (deadline !== null) timer = setTimeout(() => resolve(GAVE_UP), Math.max(0, deadline - Date.now()) + WAIT_SLICE_MS);
      else if (signal !== undefined) {
        onAbort = () => resolve(WOKEN);
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([this.runtime.wait(actionId, WAIT_SLICE_MS), stopped]);
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
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
    const started = Date.now();
    let lastCancel = started;
    let state = await this.runtime.wait(actionId, WAIT_SLICE_MS);
    while (state.state === "pending") {
      // The same bound as in run: an action that will not stop must not hold the next one for ever.
      if (Date.now() - started >= this.pace.giveUpMs) return;
      if (Date.now() - lastCancel >= this.pace.recancelMs) {
        lastCancel = Date.now();
        await this.runtime.cancel(actionId, reason);
      }
      state = await this.runtime.wait(actionId, WAIT_SLICE_MS);
    }
  }
}

/** Where an answer too long for one line is split: a sentence end (any script) followed by a space. */
const SENTENCE_END = /[.!?\u2026\u3002\uFF01\uFF1F]\s/gu;

/**
 * An answer as legal chat lines: single lines, no command slash, none past `limit` characters, at most two. A long one
 * is split at the last sentence end that fits, else at a word, instead of being cut; what does not fit in two lines is
 * cut at a word of the second, ending "...".
 */
export function toChatLines(text: string, limit = MAX_CHAT_LENGTH): string[] {
  // Control characters and the legacy formatting sign are illegal in chat; model output may contain them.
  const line = text.replace(/[\u0000-\u001f\u007f\u00A7\s]+/gu, " ").trim().replace(/^\/+/u, "").trim();
  if (line === "") return [];
  if (line.length <= limit) return [line];
  let end = -1;
  for (const match of line.slice(0, limit + 1).matchAll(SENTENCE_END)) end = match.index + 1;
  const space = line.lastIndexOf(" ", limit);
  const at = end > limit / 4 ? end : space > limit / 4 ? space : limit;
  return [line.slice(0, at).trim(), cutAtWord(line.slice(at).trim(), limit)];
}

/** `text` as it is when it fits, else cut at a word and ended with "...". */
function cutAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 3);
  const space = cut.lastIndexOf(" ");
  return `${space > limit / 2 ? cut.slice(0, space) : cut}...`;
}
