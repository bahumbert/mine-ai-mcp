import { setTimeout as sleep } from "node:timers/promises";
import type { ChatModel, ChatTurn } from "./chat-model.ts";
import { LlmMind } from "./llm-mind.ts";
import type { Persona } from "./persona.ts";
import type { BotRuntime, BotSnapshot, ForegroundState, ForegroundTool, PlayerMessage } from "./runtime-client.ts";

/** Test double for one bot: scripted durations, recorded calls, no Minecraft. */
export class FakeRuntime implements BotRuntime {
  snapshot: BotSnapshot = {
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    inventory: [],
    players: [],
  };
  inbox: PlayerMessage[] = [];
  /** Wait slices each tool stays pending before it succeeds. */
  durations: Partial<Record<ForegroundTool, number>> = {};
  /** Tools that settle as failed with this error. */
  failures: Partial<Record<ForegroundTool, string>> = {};
  /** The action result a failing tool settles with (e.g. a `build_structure` audit). */
  failureResults: Partial<Record<ForegroundTool, Readonly<Record<string, unknown>>>> = {};
  /** Returned by the next submit instead of accepting it. */
  refuseNext: Extract<ForegroundState, { state: "refused" }> | null = null;
  readonly submitted: { readonly tool: ForegroundTool; readonly input: Readonly<Record<string, unknown>> }[] = [];
  readonly cancelled: string[] = [];
  private readonly actions = new Map<string, { tool: ForegroundTool; remaining: number; cancelled: boolean }>();
  private nextId = 1;

  get said(): string[] {
    return this.submitted.filter((call) => call.tool === "send_message").map((call) => String(call.input.message));
  }

  async status(): Promise<BotSnapshot> {
    return this.snapshot;
  }

  async readMessages(): Promise<readonly PlayerMessage[]> {
    const messages = this.inbox;
    this.inbox = [];
    return messages;
  }

  async submit(tool: ForegroundTool, input: Readonly<Record<string, unknown>>): Promise<ForegroundState> {
    if (this.refuseNext !== null) {
      const refusal = this.refuseNext;
      this.refuseNext = null;
      return refusal;
    }
    this.submitted.push({ tool, input });
    const actionId = `action-${this.nextId++}`;
    this.actions.set(actionId, { tool, remaining: this.durations[tool] ?? 0, cancelled: false });
    return this.step(actionId);
  }

  async wait(actionId: string): Promise<ForegroundState> {
    // Yield to timers like a real network round trip, so pending loops never starve the test.
    await sleep(1);
    return this.step(actionId);
  }

  async cancel(actionId: string): Promise<void> {
    this.cancelled.push(actionId);
    const action = this.actions.get(actionId);
    if (action !== undefined) action.cancelled = true;
  }

  async close(): Promise<void> {}

  private step(actionId: string): ForegroundState {
    const action = this.actions.get(actionId);
    if (action === undefined) return { state: "settled", actionId, status: "succeeded", error: null };
    if (action.cancelled) return { state: "settled", actionId, status: "cancelled", error: "cancelled by caller" };
    if (action.remaining > 0) {
      action.remaining -= 1;
      return { state: "pending", actionId };
    }
    const failure = this.failures[action.tool];
    if (failure !== undefined) {
      const result = this.failureResults[action.tool];
      return { state: "settled", actionId, status: "failed", error: failure, ...(result !== undefined && { result }) };
    }
    return { state: "settled", actionId, status: "succeeded", error: null };
  }
}

export function testPersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "ayla",
    username: "Ayla",
    displayName: "Ayla",
    stance: "companion",
    description: "A test companion.",
    traits: [],
    voice: "Plain.",
    aptitudes: {},
    listensTo: [],
    models: {},
    ...overrides,
  };
}

/** A chat model replying from a script, recording what it was sent. */
export class ScriptedModel implements ChatModel {
  readonly requests: (readonly ChatTurn[])[] = [];
  constructor(readonly name: string, private readonly replies: string[] = []) {}

  /** Queue replies, as objects (sent as JSON) or raw text. */
  reply(...replies: (string | object)[]): this {
    this.replies.push(...replies.map((reply) => (typeof reply === "string" ? reply : JSON.stringify(reply))));
    return this;
  }

  async complete(turns: readonly ChatTurn[]): Promise<string> {
    this.requests.push([...turns]);
    const reply = this.replies.shift();
    if (reply === undefined) throw new Error(`${this.name}: no scripted reply left`);
    return reply;
  }
}

/** One scripted model per tier, plus the mind using them. */
export function scriptedMind() {
  const models = { chat: new ScriptedModel("chat"), action: new ScriptedModel("action"), planner: new ScriptedModel("planner") };
  return { ...models, mind: new LlmMind(models) };
}

/** Polls until the condition holds; fails the test after `timeoutMs`. */
export async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await sleep(5);
  }
}
