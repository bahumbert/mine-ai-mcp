import { setTimeout as sleep } from "node:timers/promises";
import type { ChatModel, ChatTurn } from "./chat-model.ts";
import { LlmMind } from "./llm-mind.ts";
import type { Persona } from "./persona.ts";
import type { BotRuntime, BotSnapshot, CraftingNeeds, ForegroundState, ForegroundTool, ItemCount, PlayerMessage } from "./runtime-client.ts";

/** A one-level recipe for the fake crafting planner: `makes` items per application. */
export interface FakeRecipe {
  readonly makes: number;
  readonly needs: readonly ItemCount[];
}

/** Drops of blocks that do not drop themselves, for the fake `collect_block`. */
const FAKE_DROPS: Readonly<Record<string, string>> = { stone: "cobblestone" };

/** Exactly the blocks of a small medieval house: carrying them, the build skill gathers nothing. */
export const SMALL_MEDIEVAL_HOUSE: BotSnapshot["inventory"] = [
  { name: "spruce_planks", count: 49 },
  { name: "oak_planks", count: 36 },
  { name: "oak_log", count: 24 },
  { name: "cobblestone", count: 16 },
  { name: "oak_fence", count: 3 },
  { name: "oak_door", count: 1 },
];

/** Test double for one bot: scripted durations, recorded calls, no Minecraft. */
export class FakeRuntime implements BotRuntime {
  snapshot: BotSnapshot = {
    position: { x: 0, y: 64, z: 0 },
    health: 20,
    food: 20,
    inventory: [],
    players: [],
    policy: null,
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
  /** The next call of that tool fails once with this error, after `effect` (what it got done before failing). */
  failNext: Partial<Record<ForegroundTool, { readonly error: string; readonly effect?: () => void }>> = {};
  /** Recipes known to the fake crafting planner; items without one are uncraftable. */
  recipes: Readonly<Record<string, FakeRecipe>> = {};
  /** Successful `collect_block` and `craft_item` calls change the snapshot's inventory. */
  simulateInventory = false;
  /** Every foreground call, plus chat lines as `send_message` (they do not take the body). */
  readonly submitted: { readonly tool: ForegroundTool | "send_message"; readonly input: Readonly<Record<string, unknown>> }[] = [];
  readonly cancelled: string[] = [];
  private readonly actions = new Map<string, { tool: ForegroundTool; input: Readonly<Record<string, unknown>>; remaining: number; cancelled: boolean }>();
  private nextId = 1;

  get said(): string[] {
    return this.submitted.filter((call) => call.tool === "send_message").map((call) => String(call.input.message));
  }

  async status(): Promise<BotSnapshot> {
    return this.snapshot;
  }

  async say(message: string): Promise<{ readonly status: "succeeded"; readonly error: null }> {
    this.submitted.push({ tool: "send_message", input: { message } });
    return { status: "succeeded", error: null };
  }

  /** Every `setDigStraightDown` call, in order. */
  readonly digSettings: boolean[] = [];

  async setDigStraightDown(allowed: boolean, revision: string): Promise<boolean> {
    this.digSettings.push(allowed);
    if (this.snapshot.policy === null || this.snapshot.policy.revision !== revision) return false;
    this.snapshot = { ...this.snapshot, policy: { revision: `${revision}+`, digStraightDown: allowed } };
    return true;
  }

  async craftingNeeds(items: readonly ItemCount[]): Promise<CraftingNeeds> {
    if (items.some(({ item }) => this.recipes[item] === undefined)) return { status: "uncraftable", missing: [] };
    const leaves = new Map<string, number>();
    for (const { item, count } of items) this.leaves(item, count, leaves);
    const missing = [...leaves]
      .map(([item, count]) => ({ item, count: count - this.carried(item) }))
      .filter((entry) => entry.count > 0);
    return { status: missing.length === 0 ? "ready" : "missing_materials", missing };
  }

  async readMessages(): Promise<readonly PlayerMessage[]> {
    const messages = this.inbox;
    this.inbox = [];
    return messages;
  }

  /** Notes saved with `note_save`, oldest first; a test may seed them to stand for an earlier run. */
  notes: { readonly note: string; readonly context: string }[] = [];
  /** Every SQL statement asked of `queryBotData`. */
  readonly queries: string[] = [];

  /** Answers any query with every saved note as `[note_id, context]`, newest first (the SQL is not run). */
  async queryBotData(sql: string): Promise<readonly (readonly (string | number | null)[])[]> {
    this.queries.push(sql);
    return this.notes.map((note, index) => [index + 1, note.context]).reverse();
  }

  async submit(tool: ForegroundTool, input: Readonly<Record<string, unknown>>): Promise<ForegroundState> {
    if (this.refuseNext !== null) {
      const refusal = this.refuseNext;
      this.refuseNext = null;
      return refusal;
    }
    this.submitted.push({ tool, input });
    if (tool === "note_save") this.notes.push({ note: String(input.note), context: String(input.context) });
    const actionId = `action-${this.nextId++}`;
    this.actions.set(actionId, { tool, input, remaining: this.durations[tool] ?? 0, cancelled: false });
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

  private carried(item: string): number {
    return this.snapshot.inventory.filter((stack) => stack.name === item).reduce((sum, stack) => sum + stack.count, 0);
  }

  private leaves(item: string, count: number, into: Map<string, number>): void {
    const recipe = this.recipes[item];
    if (recipe === undefined) {
      into.set(item, (into.get(item) ?? 0) + count);
      return;
    }
    const applications = Math.ceil(count / recipe.makes);
    for (const need of recipe.needs) this.leaves(need.item, need.count * applications, into);
  }

  /** Adds (or with a negative delta removes) carried items. */
  addItem(item: string, delta: number): void {
    const total = this.carried(item) + delta;
    const others = this.snapshot.inventory.filter((stack) => stack.name !== item);
    this.snapshot = { ...this.snapshot, inventory: total > 0 ? [...others, { name: item, count: total }] : others };
  }

  /** What a successful action does to the inventory (leaves only: the fake crafts in one go). */
  private applyEffects(tool: ForegroundTool, input: Readonly<Record<string, unknown>>): void {
    if (!this.simulateInventory) return;
    if (tool === "collect_block") {
      const block = String(input.block_name);
      this.addItem(FAKE_DROPS[block] ?? block, Number(input.count));
    }
    if (tool === "craft_item") {
      for (const { item_name: item, count } of input.items as { item_name: string; count: number }[]) {
        const leaves = new Map<string, number>();
        this.leaves(item, count, leaves);
        for (const [leaf, used] of leaves) this.addItem(leaf, -used);
        this.addItem(item, count);
      }
    }
  }

  private step(actionId: string): ForegroundState {
    const action = this.actions.get(actionId);
    if (action === undefined) return { state: "settled", actionId, status: "succeeded", error: null };
    if (action.cancelled) return { state: "settled", actionId, status: "cancelled", error: "cancelled by caller" };
    if (action.remaining > 0) {
      action.remaining -= 1;
      return { state: "pending", actionId };
    }
    const once = this.failNext[action.tool];
    if (once !== undefined) {
      delete this.failNext[action.tool];
      once.effect?.();
      return { state: "settled", actionId, status: "failed", error: once.error };
    }
    const failure = this.failures[action.tool];
    if (failure !== undefined) {
      const result = this.failureResults[action.tool];
      return { state: "settled", actionId, status: "failed", error: failure, ...(result !== undefined && { result }) };
    }
    this.applyEffects(action.tool, action.input);
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
    authority: ["*"],
    // Tests never wait on pacing: 600 goal calls a minute is one every 100 ms.
    settings: { goalCallsPerMinute: 600, maxStepsPerObjective: 40, maxSameStepInARow: 3, restAfterStopSeconds: 0, digStraightDown: false },
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
