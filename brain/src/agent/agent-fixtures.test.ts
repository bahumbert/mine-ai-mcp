// Helpers shared by the agent tests of this folder: a running agent over a fake runtime, chat lines, other agents.
import { Agent, type AgentOptions } from "../agent.ts";
import { INSTANT_TYPING } from "../body.ts";
import type { BrainEvent } from "../brain-log.ts";
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

/** A running agent (chat handling and work loop) over a fake runtime; stopped when the test ends. */
export function agentFor(t: { after(fn: () => Promise<void>): void }, runtime: FakeRuntime, persona: Partial<Persona> = {}, options: Partial<AgentOptions> = {}) {
  const tiers = scriptedMind();
  const agent = new Agent({ persona: testPersona(persona), runtime, mind: tiers.mind, otherAgents: others("Vex"), log: () => undefined, typing: INSTANT_TYPING, pollMs: 5, ...options });
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
  const agent = new Agent({ persona: testPersona(persona), runtime, mind: tiers.mind, otherAgents: others(), log: () => undefined, typing: INSTANT_TYPING, pollMs: 5, journal: (event) => events.push(event), ...options });
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
