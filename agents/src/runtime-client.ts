import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";

export interface Position {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface NearbyPlayer {
  readonly username: string;
  /** Null when the player is online but not loaded around the bot. */
  readonly position: Position | null;
}

/** The slice of `view_status` the brain reasons about. */
export interface BotSnapshot {
  readonly position: Position;
  readonly health: number;
  readonly food: number;
  readonly inventory: readonly { readonly name: string; readonly count: number }[];
  readonly players: readonly NearbyPlayer[];
  /** The survival policy's revision and the setting the brain manages; null when the runtime did not report it. */
  readonly policy: { readonly revision: string; readonly digStraightDown: boolean } | null;
}

export interface PlayerMessage {
  readonly username: string;
  readonly channel: "chat" | "whisper";
  readonly message: string;
  /** The runtime's own check: the message names the bot's username as a word. */
  readonly addressed: boolean;
}

export type ActionStatus = "succeeded" | "partial" | "failed" | "cancelled";

/** Foreground tools the brain drives (all are body-locking tasks in the runtime). */
export type ForegroundTool =
  | "navigate" | "collect_block" | "drop_item"
  | "craft_item" | "eat_food" | "equip" | "sleep" | "collect_mob_drop" | "build_structure" | "note_save";

export type ForegroundState =
  | { readonly state: "pending"; readonly actionId: string }
  | {
    readonly state: "settled";
    readonly actionId: string;
    readonly status: ActionStatus;
    readonly error: string | null;
    /** The action's whole `result` (e.g. `build_structure`'s `structure` audit), when the runtime returned one. */
    readonly result?: Readonly<Record<string, unknown>>;
  }
  | {
    readonly state: "refused";
    readonly code: string;
    readonly error: string;
    readonly activeActionId: string | null;
    readonly unretrievedActionId: string | null;
  };

export interface ItemCount {
  readonly item: string;
  readonly count: number;
}

/** The runtime's recursive crafting plan for a batch (`view_crafting_requirements`), reduced to what the brain uses. */
export interface CraftingNeeds {
  /** `unknown`: Minecraft has no such item. `uncraftable`: no recipe (gathered, not crafted). */
  readonly status: "ready" | "missing_materials" | "uncraftable" | "planner_failed" | "unknown";
  /** Leaf materials the bot lacks, including a crafting table's own when none is carried or in reach. */
  readonly missing: readonly ItemCount[];
}

/** What a brain needs from one bot. Implemented over MCP ({@link McpBotRuntime}) and by fakes in tests. */
export interface BotRuntime {
  status(): Promise<BotSnapshot>;
  /** What crafting these items would take from the current inventory; crafts nothing. */
  craftingNeeds(items: readonly ItemCount[]): Promise<CraftingNeeds>;
  /** One public chat line; runs beside the foreground action (chat does not take the body). */
  say(message: string): Promise<{ readonly status: ActionStatus; readonly error: string | null }>;
  /**
   * Whether routes may dig the block under the bot (a survival-policy setting, merged with the others). The runtime
   * resets every override on death and dimension change, so the brain checks it again from each snapshot.
   */
  setDigStraightDown(allowed: boolean, revision: string): Promise<boolean>;
  /** Incoming player messages since the last call (the runtime keeps the read cursor). */
  readMessages(): Promise<readonly PlayerMessage[]>;
  /** One read-only SQL statement over the bot's data (`query_bot_data`), as rows of cells in column order. */
  queryBotData(sql: string): Promise<readonly (readonly (string | number | null)[])[]>;
  submit(tool: ForegroundTool, input: Readonly<Record<string, unknown>>, rationale: string, waitMs: number): Promise<ForegroundState>;
  wait(actionId: string, timeoutMs: number): Promise<ForegroundState>;
  cancel(actionId: string, reason: string): Promise<void>;
  close(): Promise<void>;
}

const positionSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });

const viewStatusSchema = z.object({
  result: z.object({
    situation: z.object({
      position: positionSchema,
      vitals: z.object({ health: z.number(), food: z.number() }),
      inventory: z.object({ stacks: z.array(z.object({ name: z.string(), count: z.number() })) }),
      nearby: z.object({ players: z.array(z.object({ username: z.string(), position: positionSchema.nullable() })) }),
    }),
  }),
  survivalPolicy: z.object({
    revision: z.string(),
    effective: z.object({ navigation: z.object({ dig_straight_down: z.boolean().default(true) }) }),
  }).optional(),
});

const policyEditSchema = z.object({ result: z.object({ status: z.string() }) });

const craftingRequirementsSchema = z.object({
  result: z.object({
    status: z.string(),
    requirements: z.object({
      plan: z.object({
        status: z.enum(["ready", "missing_materials", "uncraftable", "planner_failed"]),
        missingMaterials: z.array(z.object({ item: z.string(), count: z.number() })),
      }).optional(),
    }).optional(),
  }),
});

const sayResultSchema = z.object({
  result: z.object({ status: z.enum(["succeeded", "partial", "failed", "cancelled"]), error: z.string().optional() }),
});

const queryResultSchema = z.object({
  result: z.object({
    status: z.string(),
    error: z.string().optional(),
    query: z.object({ rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))) }).optional(),
  }),
});

const eventsSchema = z.object({
  result: z.object({
    events: z.array(z.object({ type: z.string(), payload: z.unknown() })),
    remainingEventCount: z.number(),
  }),
});

const playerMessagePayloadSchema = z.object({
  username: z.string(),
  channel: z.enum(["chat", "whisper"]),
  direction: z.enum(["incoming", "outgoing"]),
  message: z.string(),
  addressed: z.boolean(),
});

const actionOutputSchema = z.object({
  result: z.looseObject({ status: z.enum(["succeeded", "partial", "failed", "cancelled"]), error: z.string().optional() }),
});

const foregroundDataSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("accepted"), actionId: z.string() }),
  z.object({ state: z.literal("pending"), actionId: z.string() }),
  z.object({ state: z.literal("settled"), actionId: z.string(), output: actionOutputSchema }),
  z.object({ state: z.literal("storage_failed"), actionId: z.string(), error: z.string(), output: actionOutputSchema }),
  z.object({
    state: z.literal("refused"),
    code: z.string(),
    error: z.string(),
    activeActionId: z.string().optional(),
    unretrievedActionId: z.string().optional(),
  }),
]);

const jsonReplySchema = z.object({ response: z.object({ format: z.literal("json"), data: z.unknown() }) });

/** Largest page `read_recent_events` accepts. */
const EVENT_PAGE = 100;

/** The runtime's outcome code: the bracketed prefix its errors start with, e.g. `HOSTILE_CONTACT`. */
export function errorCode(error: string | null | undefined): string | null {
  return /^\[([A-Z_]+)\]/u.exec(error ?? "")?.[1] ?? null;
}

/** {@link BotRuntime} over one mine-ai-mcp host's Streamable HTTP endpoint (ADR-002: one MCP connection per bot). */
export class McpBotRuntime implements BotRuntime {
  private constructor(private readonly client: Client) {}

  static async connect(url: string, clientName: string): Promise<McpBotRuntime> {
    const client = new Client({ name: clientName, version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    return new McpBotRuntime(client);
  }

  async status(): Promise<BotSnapshot> {
    const data = viewStatusSchema.parse(await this.call("view_status", {}, "Look around before deciding."));
    const { situation } = data.result;
    return {
      position: situation.position,
      health: situation.vitals.health,
      food: situation.vitals.food,
      inventory: situation.inventory.stacks.map(({ name, count }) => ({ name, count })),
      players: situation.nearby.players,
      policy: data.survivalPolicy === undefined
        ? null
        : { revision: data.survivalPolicy.revision, digStraightDown: data.survivalPolicy.effective.navigation.dig_straight_down },
    };
  }

  async setDigStraightDown(allowed: boolean, revision: string): Promise<boolean> {
    const reason = allowed ? "I may dig straight down." : "I never dig straight down: I go down by staircase.";
    const input = { operation: "set", expected_revision: revision, changes: { navigation: { dig_straight_down: allowed } }, lifetime: { kind: "session" }, reason };
    const { result } = policyEditSchema.parse(await this.call("set_survival_policy", input, reason));
    return result.status === "succeeded";
  }

  async craftingNeeds(items: readonly ItemCount[]): Promise<CraftingNeeds> {
    const input = { items: items.map(({ item, count }) => ({ item_name: item, count })) };
    const { result } = craftingRequirementsSchema.parse(await this.call("view_crafting_requirements", input, "Work out what crafting these would take."));
    // Only an item Minecraft does not have fails without a plan.
    const plan = result.requirements?.plan;
    if (plan === undefined) return { status: "unknown", missing: [] };
    return { status: plan.status, missing: plan.missingMaterials.map(({ item, count }) => ({ item, count })) };
  }

  async say(message: string): Promise<{ readonly status: ActionStatus; readonly error: string | null }> {
    const { result } = sayResultSchema.parse(await this.call("send_message", { message }, "Speak in character."));
    return { status: result.status, error: result.error ?? null };
  }

  async queryBotData(sql: string): Promise<readonly (readonly (string | number | null)[])[]> {
    const { result } = queryResultSchema.parse(await this.call("query_bot_data", { sql }, "Remember what I knew."));
    if (result.query === undefined) throw new Error(`[QUERY_FAILED] ${result.error ?? result.status}`);
    return result.query.rows;
  }

  async readMessages(): Promise<readonly PlayerMessage[]> {
    const messages: PlayerMessage[] = [];
    for (;;) {
      const { result } = eventsSchema.parse(await this.call("read_recent_events", { limit: EVENT_PAGE }, "Check for players talking to me."));
      for (const event of result.events) {
        if (event.type !== "player_message") continue;
        const payload = playerMessagePayloadSchema.parse(event.payload);
        if (payload.direction !== "incoming") continue;
        messages.push({ username: payload.username, channel: payload.channel, message: payload.message, addressed: payload.addressed });
      }
      if (result.remainingEventCount === 0) return messages;
    }
  }

  async submit(tool: ForegroundTool, input: Readonly<Record<string, unknown>>, rationale: string, waitMs: number): Promise<ForegroundState> {
    return foregroundState(await this.call(tool, { ...input, submission_id: randomUUID(), wait_timeout_ms: waitMs }, rationale));
  }

  async wait(actionId: string, timeoutMs: number): Promise<ForegroundState> {
    return foregroundState(await this.call("wait_for_action", { action_id: actionId, timeout_ms: timeoutMs }, "Wait for my current action."));
  }

  async cancel(actionId: string, reason: string): Promise<void> {
    await this.call("cancel_foreground_action", { action_id: actionId, reason }, "Stop my current action.");
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /** Calls a tool in JSON mode and returns `response.data`; refused and failed results are data, not exceptions. */
  private async call(name: string, args: Readonly<Record<string, unknown>>, rationale: string): Promise<unknown> {
    const reply = await this.client.callTool({ name, arguments: { ...args, rationale, response_format: "json" } });
    const parsed = jsonReplySchema.safeParse(reply.structuredContent);
    if (parsed.success) return parsed.data.response.data;
    // Input validation and transport errors come back without structured content, only as text.
    const text = Array.isArray(reply.content) ? reply.content.map((part) => ("text" in part ? String(part.text) : "")).join(" ") : "";
    throw new Error(`[MCP_CALL_FAILED] ${name}: ${text || "no structured response"}`);
  }
}

function foregroundState(data: unknown): ForegroundState {
  const reply = foregroundDataSchema.parse(data);
  switch (reply.state) {
    case "accepted":
    case "pending":
      return { state: "pending", actionId: reply.actionId };
    case "settled":
      return { state: "settled", actionId: reply.actionId, status: reply.output.result.status, error: reply.output.result.error ?? null, result: reply.output.result };
    case "storage_failed":
      // The action ran; only its durable record failed. Report what the body did.
      return { state: "settled", actionId: reply.actionId, status: reply.output.result.status, error: reply.output.result.error ?? reply.error, result: reply.output.result };
    case "refused":
      return {
        state: "refused",
        code: reply.code,
        error: reply.error,
        activeActionId: reply.activeActionId ?? null,
        unretrievedActionId: reply.unretrievedActionId ?? null,
      };
  }
}
