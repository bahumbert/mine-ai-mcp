// The Agent, scripted mind and explicit lifetimes shared by situation-loop tests.
import { flush, type FakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { Agent, type AgentOptions } from "../agent.ts";
import { INSTANT_TYPING } from "../body.ts";
import type { BrainEvent } from "../brain-log.ts";
import { FakeRuntime, scriptedMind, testPersona } from "../testing.ts";
import type { BotSnapshot } from "../runtime-client.ts";
import { others } from "./agent-fixtures.test.ts";
import { newWork, type Work } from "./work.ts";

export const FETCH = { step: { skill: "get_items" as const, items: [{ item: "oak_log", count: 2 }] } };
export const HOME = { step: { skill: "go_to", x: 100, y: 64, z: 0 } } as const;
export const CARRY = { done: "carry on" };
type SituationEvent = Extract<BrainEvent, { kind: "situation" }>;

/** Bound a state wait on the shared clock, cancelling its observer even on a failing assertion. */
export async function reaches(clock: FakeClock, condition: () => boolean): Promise<void> {
  if (condition()) return;
  let cancel = () => {};
  try {
    await clock.settle(new Promise<void>((resolve) => { cancel = clock.every(() => { if (condition()) resolve(); }, 10); }), 20_000);
  } finally { cancel(); }
}

/** The real Agent and LlmMind over the existing MCP fake, with explicit lifetime and status samples. */
export function setup(clock: FakeClock, options: Partial<AgentOptions> = {}) {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.snapshot = { ...runtime.snapshot, lastDeath: null, clock: { timeOfDay: 11_900, phase: "day", minutesUntilChange: 642 / 1_200, sleeping: false }, footing: { onGround: true, inWater: false, inLava: false }, vehicle: null, armourPoints: 0, combat: { melee: null, bow: null, arrows: 0, shield: null } };
  runtime.durations.collect_block = 100_000;
  runtime.durations.navigate = 100_000;
  const tiers = scriptedMind();
  const events: BrainEvent[] = [];
  const logs: string[] = [];
  const agent = new Agent({ persona: testPersona(), runtime, mind: tiers.mind, otherAgents: others(), log: (line) => logs.push(line), journal: (event) => events.push(event), typing: INSTANT_TYPING, pollMs: 500, random: () => 0, obeyRandom: () => 0, noGain: { minutes: 5, sampleMs: 100 }, ...options });
  const stack = (agent as unknown as { stack: Work[] }).stack;
  const controller = new AbortController();
  const releases: (() => void)[] = [];
  let running: Promise<void> | undefined;
  const hold = () => { const release = tiers.action.hold(); releases.push(release); return release; };
  const situations = () => events.filter((event): event is SituationEvent => event.kind === "situation");
  const start = async () => { running = agent.run(controller.signal); await reaches(clock, () => logs.some((line) => line.startsWith("listening"))); };
  const sample = async (change: Partial<BotSnapshot>) => {
    runtime.snapshot = { ...runtime.snapshot, ...change };
    const held = runtime.holdNextStatus();
    try { await clock.settle(held.started, 20_000); } finally { held.release(); }
    await flush();
  };
  const night = () => sample({ clock: { timeOfDay: 12_100, phase: "day", minutesUntilChange: 442 / 1_200, sleeping: false } });
  const stop = async () => {
    controller.abort();
    for (const release of releases) release();
    if (running !== undefined) await clock.settle(running, 20_000);
  };
  return { ...tiers, runtime, events, logs, agent, stack, hold, situations, start, sample, night, stop };
}

/** Put ordinary work on the stack before starting, without involving the unrelated chat model. */
export function ordinary(h: ReturnType<typeof setup>, requester: string | null = null): Work {
  const work = newWork({ text: "get 2 oak logs", requester, purpose: null });
  h.stack.push(work);
  return work;
}
