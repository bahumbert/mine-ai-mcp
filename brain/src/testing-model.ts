// Test doubles for the brain's chat model and its clocks: a persona, a scripted model, the mind over it, and the polling and
// stepped-clock helpers. Moved out of testing.ts, which must not grow past 600 lines (plan 2026-11-16-stepd-review-fixes T8).
// testing.ts re-exports these names, so importers keep `./testing.ts`.
import { sleepMs } from "./wall-timers.ts";
import { ModelUnavailable, type ChatModel, type ChatReply, type ChatTurn, type CompleteOptions } from "./chat-model.ts";
import { LlmMind, type LocalizedChat } from "./llm-mind.ts";
import type { Persona } from "./persona.ts";
import { scoringOf } from "./relations/score.ts";
import type { Scoring } from "./relations/types.ts";

export function testPersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "ayla",
    username: "Ayla",
    displayName: "Ayla",
    stance: "companion",
    description: "A test companion.",
    traits: [],
    voice: "Plain.",
    boldness: "steady",
    listensTo: [],
    authority: ["*"],
    // Tests never wait on pacing: 600 goal calls a minute is one every 100 ms. No progress lines unless a test asks.
    settings: { signLineChars: 15, goalCallsPerMinute: 600, maxStepsPerObjective: 40, maxSameStepInARow: 3, maxSkillFailuresInARow: 6, restAfterStopSeconds: 0, narrateEverySeconds: 3_600, chatBurstMs: 0, chat: { burstMaxLines: 8, burstMaxChars: 1_000, burstMaxSeconds: 8, openOrdersPerRequester: 3 }, digStraightDown: false, feelingMultipliers: { loves: 2, likes: 1.5, neutral: 1, dislikes: 0.6, hates: 0.3 }, conversation: { sociability: 0.3, checkEverySeconds: 30, pairCooldownMinutes: 10, maxLines: 24, maxMinutes: 6, outOfRangeSeconds: 20, silenceSeconds: 60, groupReplyJitterMs: [0, 0], openingDistance: 16, stayingDistance: 32, gistLines: 60 }, relations: { enabled: true, payBackMinutes: 10, startMinutes: 3, handoffDistance: 4, offersForgetMinutes: 60, maxOpenTrades: 3, tradeReach: 32, seekReach: 64, obey: { halfAt: -4, spread: 4, moodMinutes: 5, rerollOnChange: 10 }, temperament: { firstImpression: 0, sensitivity: 1, forgiveness: 5 }, score: { amounts: { tradeDone: 8, keptLate: 3, promiseBroken: -20, giftReceived: 10, requestHelped: 6, requestRefused: -3, requestIgnored: -5, hurt: -25 }, nudgeMax: 10, ledgerSize: 10, bands: { enemy: -60, dislike: -20, like: 20, friend: 60 }, requestAnswerMinutes: 2, hurtDebounceSeconds: 60 } } },
    models: {},
    ...overrides,
  };
}

/** Whether a scripted reply object routes "act" or "later". */
function asksForOrder(reply: object): boolean {
  const { route } = reply as { readonly route?: unknown };
  return route === "act" || route === "later";
}

/** A chat model replying from a script, recording what it was sent. */
export class ScriptedModel implements ChatModel {
  readonly requests: (readonly ChatTurn[])[] = [];
  /** The options of each call, in the order of {@link requests}. */
  readonly options: (CompleteOptions | undefined)[] = [];
  private readonly waits: number[] = [];
  private readonly replies: { readonly text: string; readonly counts: ReplyCounts }[];
  constructor(readonly name: string, replies: string[] = []) {
    this.replies = replies.map((text) => ({ text, counts: NO_COUNTS }));
  }

  /** The next replies report these waits (`waitMs`, as the brain's model queue does); calls past the list report none. */
  waitMs(...waits: number[]): this {
    this.waits.push(...waits);
    return this;
  }

  /**
   * Queue replies, as objects (sent as JSON) or raw text. They come with no token count, as an OpenAI-compatible server may send.
   * An object routing "act" or "later" with no `type` key is sent as a request (the chat tier holds those routes to one, spec
   * 2026-11-18-complaint-not-order): a test that wants no type writes `type: undefined` (the key is present, so no default; JSON
   * drops it). Raw text is sent as it is.
   */
  reply(...replies: (string | object)[]): this {
    return this.replyCounted(NO_COUNTS, ...replies);
  }

  /** Queue replies that come with the server's token counts (`promptTokens`, and the window as `contextTokens`). */
  replyCounted(counts: ReplyCounts, ...replies: (string | object)[]): this {
    this.replies.push(...replies.map((reply) => ({ text: typeof reply === "string" ? reply : JSON.stringify(asksForOrder(reply) && !("type" in reply) ? { ...reply, type: "request" } : reply), counts })));
    return this;
  }

  private readonly holds: Promise<void>[] = [];

  /** The next call waits (after it is recorded) until the returned function is called: a slow model. */
  hold(): () => void {
    let release!: () => void;
    this.holds.push(new Promise((resolve) => { release = resolve; }));
    return release;
  }

  private unavailableCalls = 0;

  /** The next `times` calls (after any hold) find the model server away, as the real client reports it. */
  unavailable(times = 1): this {
    this.unavailableCalls += times;
    return this;
  }

  async complete(turns: readonly ChatTurn[], _signal?: AbortSignal, options?: CompleteOptions): Promise<ChatReply> {
    this.requests.push([...turns]);
    this.options.push(options);
    const hold = this.holds.shift();
    if (hold !== undefined) await hold;
    if (this.unavailableCalls > 0) {
      this.unavailableCalls -= 1;
      throw new ModelUnavailable(`[LLM_UNAVAILABLE] ${this.name}: the model server did not answer`);
    }
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error(`${this.name}: no scripted reply left`);
    const waitMs = this.waits.shift();
    return { text: reply.text, ...reply.counts, ...(waitMs === undefined ? {} : { waitMs }) };
  }
}

/** What a model reply tells about the prompt it read: null when the server does not say. */
export interface ReplyCounts {
  readonly promptTokens: number | null;
  readonly contextTokens: number | null;
  readonly replyTokens?: number | null;
}
const NO_COUNTS: ReplyCounts = { promptTokens: null, contextTokens: null };

/** One scripted model per tier, plus the mind using them. */
export function scriptedMind(localizedChat?: LocalizedChat) {
  const models = { chat: new ScriptedModel("chat"), action: new ScriptedModel("action"), planner: new ScriptedModel("planner") };
  return { ...models, mind: new LlmMind(models, undefined, localizedChat) };
}

/** Lets queued promise callbacks run (a few microtask turns, no timer). */
export const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const CONTROLLED_REPLY: ChatReply = { text: "{}", promptTokens: null, contextTokens: null };

/** A model whose calls stay open until the test settles them (the model queue's tests). */
export function controlledModel(name = "fake"): {
  model: ChatModel;
  settle: (index: number, error?: Error) => void;
  calls: () => number;
  /** What each call that reached the model said (its first turn), in the order they reached it. */
  entered: string[];
  /** Settles every call that reaches the model, including those a slot lets in meanwhile, until none is left. */
  drain: () => Promise<void>;
} {
  const pending: { resolve: (reply: ChatReply) => void; reject: (error: Error) => void }[] = [];
  const entered: string[] = [];
  let settled = 0;
  return {
    model: {
      name,
      complete: (turns) => {
        entered.push(turns[0]?.content ?? "");
        return new Promise<ChatReply>((resolve, reject) => pending.push({ resolve, reject }));
      },
    },
    settle: (index, error) => (error === undefined ? pending[index]!.resolve(CONTROLLED_REPLY) : pending[index]!.reject(error)),
    calls: () => pending.length,
    entered,
    drain: async () => {
      for (;;) {
        await sleepMs(0);
        if (settled >= pending.length) return;
        while (settled < pending.length) pending[settled++]!.resolve(CONTROLLED_REPLY);
      }
    },
  };
}

/** The default score amounts and temperament, as a persona without overrides has them. */
export function testScoring(): Scoring {
  return scoringOf(testPersona().settings.relations);
}

/** The real monotonic clock, bound at load: a test that moves `performance.now` (`steppedClocks`) never drives `until`'s own timeout. */
const realMonotonicNow = performance.now.bind(performance);

/** Polls until the condition holds; fails the test after `timeoutMs` of real time. */
export async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = realMonotonicNow() + timeoutMs;
  while (!condition()) {
    if (realMonotonicNow() > deadline) throw new Error("condition not reached in time");
    await sleepMs(5);
  }
}

/**
 * Moves the two clocks a test reads apart, as WSL does when it steps its wall clock: `wall(ms)` shifts `Date.now()` only,
 * `monotonic(ms)` shifts `performance.now()` only (time that really passed). Both are restored by `restore()` or when
 * the test ends. One per test at a time: a second call, or one over another mock of these clocks, throws (restoring
 * the outer mock first would leave the inner one's offset in the next test).
 */
export function steppedClocks(t: { mock: { method(object: object, name: "now", implementation: () => number): { mock: { restore(): void } } } }) {
  if ("mock" in Date.now || "mock" in performance.now) throw new Error("steppedClocks: the clocks are already mocked in this test; restore() the first one");
  const realDate = Date.now.bind(Date);
  const realPerformance = performance.now.bind(performance);
  let wallOffset = 0;
  let monotonicOffset = 0;
  const date = t.mock.method(Date, "now", () => realDate() + wallOffset);
  const clock = t.mock.method(performance, "now", () => realPerformance() + monotonicOffset);
  return {
    restore(): void {
      date.mock.restore();
      clock.mock.restore();
    },
    wall(ms: number): void {
      wallOffset += ms;
    },
    monotonic(ms: number): void {
      monotonicOffset += ms;
    },
  };
}

/**
 * `steppedClocks` with both clocks moved together, for code that reads both (the relations): `offset` is how far both are
 * ahead of the real clocks (assign or `+=`); `wall(ms)` and `monotonic(ms)` still move one alone.
 */
export function movedClocks(t: Parameters<typeof steppedClocks>[0]) {
  const clocks = steppedClocks(t);
  let moved = 0;
  return {
    get offset(): number { return moved; },
    set offset(value: number) { clocks.wall(value - moved); clocks.monotonic(value - moved); moved = value; },
    wall: clocks.wall,
    monotonic: clocks.monotonic,
    restore: clocks.restore,
  };
}
