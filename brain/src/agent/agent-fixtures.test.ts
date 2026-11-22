// Helpers shared by the agent tests of this folder: a running agent over a fake runtime, chat lines, other agents.
import { Agent, type AgentOptions } from "../agent.ts";
import { INSTANT_TYPING } from "../body.ts";
import type { BrainEvent } from "../brain-log.ts";
import { ConversationBudget } from "../conversation/controller.ts";
import type { Heard } from "../inbox.ts";
import { BodyDown } from "../runtime-client.ts";
import type { Persona } from "../persona.ts";
import { OtherAgents } from "../other-agents.ts";
import { FakeRuntime, scriptedMind, testPersona } from "../testing.ts";
import type { FakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";

export function steveAt(x: number) {
  return { username: "Steve", position: { x, y: 64, z: 0 } };
}

/** The other agents of a test: the fixed names only, none of them the agent's own (no file, so no re-read). */
export function others(...names: string[]): OtherAgents {
  return new OtherAgents("", names, null);
}

/** A message the inbox handed out as one line, read now: for tests that call `agent.handle` directly. */
export function heardOnce(message: Heard["message"]): Heard {
  return { message, lines: 1, readAt: Date.now(), seq: 0, dropped: 0, lastLine: message.message, heldMs: 0 };
}

/** Who each spoken line went to: a player's name for a whisper, undefined for public chat. */
export function spokenTo(runtime: FakeRuntime): unknown[] {
  return runtime.submitted.filter((call) => call.tool === "send_message").map((call) => call.input.to);
}

/** The tools the runtime was asked to run for the body, in order (the spoken lines left out). */
export function bodyCalls(runtime: FakeRuntime): string[] {
  return runtime.submitted.filter((call) => call.tool !== "send_message").map((call) => call.tool);
}

/** Chat settings for the flood tests: quick lines join (60 ms window) and a message holds at most `burstMaxLines` lines. */
export function floodSettings(burstMaxLines: number) {
  const base = testPersona().settings;
  return { ...base, chatBurstMs: 60, chat: { ...base.chat, burstMaxLines } };
}

/** A talk reply spoken as `say`, for the speaker-budget tests (the scripted replies go out in the order the calls come). */
export const talk = (spoken: string) => ({ spoken_to: ["Ayla"], say: spoken, route: "talk", request: "" });

// Conversations (spec 2026-10-18-conversations-design).
export function talkOptions(extra: Partial<AgentOptions> = {}, modelFree = true): Partial<AgentOptions> {
  return { conversations: { budget: new ConversationBudget(2), modelFree: () => modelFree }, otherAgents: others("Vex", "Bruno"), ...extra };
}

// Plan 2026-11-08-runtime-restart-recovery Task 3: a body the supervisor keeps down shows in the journal state.
export function bodyDownAt(msAhead: number, attempt = 2): BodyDown {
  return new BodyDown({ at: new Date(Date.now() + msAhead).toISOString(), attempt, of: 6 }, new Error("[RUNTIME_UNRESPONSIVE] Runtime event-loop heartbeat absent"));
}

/** The next status reads, once the agent listens, throw these errors in turn; `calls` counts every read after that. */
export function failStatusReads(runtime: FakeRuntime, logs: readonly string[], errors: Error[], onRead: (call: number) => void = () => undefined): { readonly calls: number } {
  const original = runtime.status.bind(runtime);
  const seen = { calls: 0 };
  runtime.status = async () => {
    if (!logs.some((line) => line.startsWith("listening as"))) return original();
    seen.calls += 1;
    onRead(seen.calls);
    const error = errors.shift();
    if (error !== undefined) throw error;
    return original();
  };
  return seen;
}

export const toAyla = { spoken_to: ["Ayla"], route: "talk" };

/** The next call answers 400 ms after the test starts, as a live model takes seconds: every bot has registered its distance to the speaker before any claims the line. */
export function slowModel(model: { hold(): () => void }): void {
  const release = model.hold();
  setTimeout(release, 400);
}

/** A running agent (chat handling and work loop) over a fake runtime; stopped when the test ends. */
export function agentFor(t: { after(fn: () => Promise<void>): void }, runtime: FakeRuntime, persona: Partial<Persona> = {}, options: Partial<AgentOptions> = {}) {
  const tiers = scriptedMind();
  const agent = new Agent({ persona: testPersona(persona), runtime, mind: tiers.mind, otherAgents: others("Vex"), log: () => undefined, typing: INSTANT_TYPING, pollMs: 5, obeyRandom: () => 0, ...options });
  const controller = new AbortController();
  const running = agent.run(controller.signal);
  t.after(async () => {
    controller.abort();
    await running;
  });
  return { agent, ...tiers };
}

/** A chat line; addressed to her (her name in it) unless said otherwise: only those start a conversation (owner rule). */
export function say(username: string, message: string, addressed = true) {
  return { username, channel: "chat" as const, message, addressed };
}

/** A running agent that also reports its journal. */
export function journaledAgent(t: { after(fn: () => Promise<void>): void }, runtime: FakeRuntime, persona: Partial<Persona> = {}, options: Partial<AgentOptions> = {}) {
  const events: BrainEvent[] = [];
  const tiers = scriptedMind();
  const agent = new Agent({ persona: testPersona(persona), runtime, mind: tiers.mind, otherAgents: others(), log: () => undefined, typing: INSTANT_TYPING, pollMs: 5, obeyRandom: () => 0, journal: (event) => events.push(event), ...options });
  const controller = new AbortController();
  const running = agent.run(controller.signal);
  t.after(async () => {
    controller.abort();
    await running;
  });
  return { agent, events, ...tiers };
}

/** Drive the agent until its observable state changes. */
export async function clockUntil(clock: FakeClock, condition: () => boolean): Promise<void> {
  if (condition()) return;
  let cancel = () => {};
  try {
    await clock.settle(new Promise<void>((resolve) => { cancel = clock.every(() => { if (condition()) resolve(); }, 5); }), 10_000);
  } finally { cancel(); }
}

/** Run an agent on a mocked clock, stopping it before the clock is disposed. */
export function clockedAgentFor(clock: FakeClock, runtime: FakeRuntime, persona: Partial<Persona> = {}, options: Partial<AgentOptions> = {}) {
  let cleanup!: () => Promise<void>;
  const result = agentFor({ after: (fn) => { cleanup = fn; } }, runtime, persona, options);
  return { ...result, stop: () => clock.settle(cleanup(), 10_000) };
}

/** Run a journaled agent on a mocked clock, stopping it before the clock is disposed. */
export function clockedJournaledAgent(clock: FakeClock, runtime: FakeRuntime, persona: Partial<Persona> = {}, options: Partial<AgentOptions> = {}) {
  let cleanup!: () => Promise<void>;
  const result = journaledAgent({ after: (fn) => { cleanup = fn; } }, runtime, persona, options);
  return { ...result, stop: () => clock.settle(cleanup(), 10_000) };
}
