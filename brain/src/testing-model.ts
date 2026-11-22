// Test doubles for the brain's chat model and its clocks: a persona, a scripted model, the mind over it, and the polling and
// stepped-clock helpers. Moved out of testing.ts, which must not grow past 600 lines (plan 2026-11-16-stepd-review-fixes T8).
// testing.ts re-exports these names, so importers keep `./testing.ts`.
import { sleepMs } from "./wall-timers.ts";
import { ModelUnavailable, type ChatModel, type ChatReply, type ChatTurn } from "./chat-model.ts";
import { LlmMind } from "./llm-mind.ts";
import type { Persona } from "./persona.ts";

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
    settings: { signLineChars: 15, goalCallsPerMinute: 600, maxStepsPerObjective: 40, maxSameStepInARow: 3, maxSkillFailuresInARow: 6, restAfterStopSeconds: 0, narrateEverySeconds: 3_600, chatBurstMs: 0, digStraightDown: false, feelingMultipliers: { loves: 2, likes: 1.5, neutral: 1, dislikes: 0.6, hates: 0.3 } },
    models: {},
    ...overrides,
  };
}

/** A chat model replying from a script, recording what it was sent. */
export class ScriptedModel implements ChatModel {
  readonly requests: (readonly ChatTurn[])[] = [];
  private readonly replies: { readonly text: string; readonly counts: ReplyCounts }[];
  constructor(readonly name: string, replies: string[] = []) {
    this.replies = replies.map((text) => ({ text, counts: NO_COUNTS }));
  }

  /** Queue replies, as objects (sent as JSON) or raw text. They come with no token count, as an OpenAI-compatible server may send. */
  reply(...replies: (string | object)[]): this {
    return this.replyCounted(NO_COUNTS, ...replies);
  }

  /** Queue replies that come with the server's token counts (`promptTokens`, and the window as `contextTokens`). */
  replyCounted(counts: ReplyCounts, ...replies: (string | object)[]): this {
    this.replies.push(...replies.map((reply) => ({ text: typeof reply === "string" ? reply : JSON.stringify(reply), counts })));
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

  async complete(turns: readonly ChatTurn[]): Promise<ChatReply> {
    this.requests.push([...turns]);
    const hold = this.holds.shift();
    if (hold !== undefined) await hold;
    if (this.unavailableCalls > 0) {
      this.unavailableCalls -= 1;
      throw new ModelUnavailable(`[LLM_UNAVAILABLE] ${this.name}: the model server did not answer`);
    }
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error(`${this.name}: no scripted reply left`);
    return { text: reply.text, ...reply.counts };
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
export function scriptedMind() {
  const models = { chat: new ScriptedModel("chat"), action: new ScriptedModel("action"), planner: new ScriptedModel("planner") };
  return { ...models, mind: new LlmMind(models) };
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
