import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import {
  createMinecraftMcpServer,
  createMinecraftRuntime,
  type PlayerDeathContext,
  queryBotDataResultSchema,
  rawActionResultSchema,
  readRecentEventsResultSchema,
} from "@aibengineering/mine-ai-mcp";

import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const cancelledResultSchema = z.strictObject({
  kind: z.literal("runtime_failure"),
  status: z.literal("cancelled"),
  error: z.string(),
});

const jsonResponseSchema = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.object({
    response: z.object({
      format: z.literal("json"),
      data: z.record(z.string(), z.unknown()),
    }),
  }),
});

/** An information tool's answer (`read_recent_events`, `query_bot_data`). */
function resultFrom(response: unknown): unknown {
  return jsonResponseSchema.parse(response).structuredContent.response.data.result;
}

const settledForegroundSchema = z.object({
  state: z.literal("settled"),
  output: z.object({ result: z.unknown() }),
});

/** A foreground tool's answer: submitted with `wait_timeout_ms`, it comes back settled with the action's output (`async-tools.ts` `waitSchema`). */
function foregroundResultFrom(response: unknown): unknown {
  const data = jsonResponseSchema.parse(response).structuredContent.response.data;
  return settledForegroundSchema.parse(data).output.result;
}

/** Longer than the scenario's 60 s goal: the wait ends by the death's cancellation, never by this bound. */
const FOREGROUND_WAIT_MS = 120_000;

async function waitUntil(check: () => boolean, description: string | (() => string), timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  if (!check()) throw new Error(`Timed out waiting for ${typeof description === "string" ? description : description()}.`);
}

type RuntimeBot = MineAiScenarioContext["bot"];
type GearReading = {
  held: string | null;
  head: string | null;
  items: number;
  food: number;
  position: { x: number; y: number; z: number };
};

function headSlotName(bot: RuntimeBot): string | null {
  return bot.inventory.slots[bot.getEquipmentDestSlot("head")]?.name ?? null;
}

function readGear(bot: RuntimeBot): GearReading {
  const { x, y, z } = bot.entity.position;
  return {
    held: bot.heldItem?.name ?? null,
    head: headSlotName(bot),
    items: bot.inventory.items().length,
    food: bot.food,
    position: { x, y, z },
  };
}

type RuntimeClient = InstanceType<typeof Client>;
type ScenarioRuntime = Awaited<ReturnType<typeof createMinecraftRuntime>>;

/** Far enough that the walk is still running when the bot is killed; the call comes back settled once death cancels it. */
async function startForegroundNavigation(client: RuntimeClient, runtime: ScenarioRuntime, bot: RuntimeBot) {
  const navigationCall = client.callTool({
    name: "navigate",
    arguments: {
      rationale: "Start real foreground movement so death must cancel its owner.",
      response_format: "json",
      submission_id: "death-event-navigate",
      wait_timeout_ms: FOREGROUND_WAIT_MS,
      x: 58,
      y: -60,
      z: 0,
      range: 1,
    },
  });
  let navigationAnswer: unknown = "no answer yet";
  void navigationCall.then((answer) => (navigationAnswer = answer));
  await waitUntil(
    () => runtime.status().busy,
    () => `foreground navigation admission (navigate answered: ${JSON.stringify(navigationAnswer)})`,
  );
  await bot.waitForTicks(10);
  // Boxed: an async function returning the promise itself would wait for the walk, which only death ends.
  return { navigationCall };
}

/** An iron sword in hand and an iron helmet on, the gear the death context must keep (keepInventory is false). */
async function giveAndWearGear(bot: RuntimeBot): Promise<void> {
  bot.chat("/give @s iron_sword");
  bot.chat("/item replace entity @s armor.head with iron_helmet");
  await waitUntil(
    () => bot.heldItem?.name === "iron_sword" && headSlotName(bot) === "iron_helmet",
    "the iron sword in hand and the iron helmet worn",
  );
}

/**
 * Measured 2026-11-06 (3 runs, `knowledge/facts/live-testing.md` "Gear at death"): the server sends the cause packet while
 * the gear is on, clears the slots, then the health packet makes `death` fire on empty hands. The shared fake follows
 * this order (`fake-bot-combat.ts`).
 */
function watchGearThroughDeath(bot: RuntimeBot) {
  let gearAtCauseEvent: GearReading | null = null;
  bot._client.once("raw.death_combat_event", () => {
    gearAtCauseEvent = readGear(bot);
  });
  const deathObserved = new Promise<{
    dimension: string;
    position: { x: number; y: number; z: number };
    gear: GearReading;
  }>((resolve) => {
    bot.once("death", () => {
      resolve({
        dimension: bot.game.dimension,
        position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
        gear: readGear(bot),
      });
    });
  });
  return { deathObserved, gearAtCauseEvent: () => gearAtCauseEvent as GearReading | null };
}

function assertGearClearedAfterTheCausePacket(atCause: GearReading | null, atDeath: GearReading): void {
  if (atCause?.held !== "iron_sword" || atCause.head !== "iron_helmet") {
    throw new Error(`The cause packet did not find the gear on: ${JSON.stringify(atCause)}.`);
  }
  if (atDeath.held !== null || atDeath.head !== null || atDeath.items !== 0) {
    throw new Error(`The gear was still on inside the death handler: ${JSON.stringify(atDeath)}.`);
  }
}

/** The server clears the gear before `death`; the record keeps what the cause packet found on (P4-01a task 3). */
function assertDeathRecordKeepsTheGear(recorded: PlayerDeathContext | undefined): void {
  if (
    recorded?.held !== "iron_sword" ||
    recorded.armour.head !== "iron_helmet" ||
    !recorded.carriesWeapon ||
    recorded.bestMelee !== "iron_sword"
  ) {
    throw new Error(`The death context lost the gear: ${JSON.stringify(recorded)}.`);
  }
}

/** send_message runs beside the foreground slot, so it cannot prove the slot was released: a raw_action does. */
async function proveForegroundWorkResumes(client: RuntimeClient): Promise<void> {
  const resumed = rawActionResultSchema.parse(
    foregroundResultFrom(
      await client.callTool({
        name: "raw_action",
        arguments: {
          rationale: "Prove a new foreground action completes after respawn.",
          response_format: "json",
          submission_id: "death-event-resumed",
          wait_timeout_ms: FOREGROUND_WAIT_MS,
          operation: "control",
          state: "sneak",
          ticks: 2,
        },
      }),
    ),
  );
  if (resumed.status !== "succeeded") throw new Error("A new foreground action did not complete after respawn.");
}

async function proveDeathStaysInHistory(client: RuntimeClient): Promise<void> {
  const historical = queryBotDataResultSchema.parse(
    resultFrom(
      await client.callTool({
        name: "query_bot_data",
        arguments: {
          rationale: "Confirm the read death remains in durable event history.",
          response_format: "json",
          sql: "SELECT event_type, payload_json FROM events WHERE event_type = 'player_death' ORDER BY event_id DESC LIMIT 1",
        },
      }),
    ),
  );
  if (historical.query.rows.length !== 1 || historical.query.rows[0]?.[0] !== "player_death") {
    throw new Error("The death event was not queryable after advancing the unread cursor.");
  }
}

/** Physically prove death cancellation, event delivery, respawn reuse, and durable history. */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const runtime = await createMinecraftRuntime(bot, {
    botData: {
      storage: { kind: "temporary" },
      identity: {
        worldId: "player-death-runtime-event",
        scope: { kind: "bot", botId: bot.username },
      },
    },
  });
  const server = createMinecraftMcpServer(runtime, bot.username);
  const client = new Client({ name: "player-death-runtime-event", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { navigationCall } = await startForegroundNavigation(client, runtime, bot);
    await giveAndWearGear(bot);
    const watch = watchGearThroughDeath(bot);
    const respawned = new Promise<void>((resolve) => bot.once("spawn", resolve));
    bot.chat("/kill @s");

    const death = await watch.deathObserved;
    const navigationResponse = jsonResponseSchema.parse(await navigationCall);

    const cancelled = cancelledResultSchema.parse(foregroundResultFrom(navigationResponse));
    if (navigationResponse.isError !== true || !cancelled.error.startsWith(`${bot.username} died`)) {
      throw new Error(`Foreground navigation did not return the expected death cancellation: ${cancelled.error}`);
    }

    const eventResponse = await client.callTool({
      name: "read_recent_events",
      arguments: {
        rationale: "Read the one unread death lifecycle event.",
        response_format: "json",
      },
    });
    const eventPage = readRecentEventsResultSchema.parse(resultFrom(eventResponse));
    const deathEvents = eventPage.events.filter((event) => event.type === "player_death");
    if (deathEvents.length !== 1) throw new Error(`Expected one player_death event, observed ${deathEvents.length}.`);
    const event = deathEvents[0];
    if (!event || event.payload.dimension !== death.dimension) {
      throw new Error("The death event did not preserve the observed dimension.");
    }
    assertDeathRecordKeepsTheGear(event.payload.context);
    if (
      event.payload.position.x !== death.position.x ||
      event.payload.position.y !== death.position.y ||
      event.payload.position.z !== death.position.z
    ) {
      throw new Error(
        `Death position ${JSON.stringify(event.payload.position)} did not match ${JSON.stringify(death.position)}.`,
      );
    }

    // The runtime now preserves the server's death cause in cancellation too.
    // Its text is evidence, rather than the old fixed "username died." phrase.
    if (event.payload.cause !== null && !cancelled.error.includes(event.payload.cause))
      throw new Error("Death cancellation omitted the observed cause stored in the event.");

    const combatGear = watch.gearAtCauseEvent();
    assertGearClearedAfterTheCausePacket(combatGear, death.gear);

    await respawned;
    const gearAfterSpawn = readGear(bot);
    await bot.waitForTicks(2);
    await proveForegroundWorkResumes(client);
    await proveDeathStaysInHistory(client);

    return {
      status: "succeeded",
      detail:
        `cancelled navigation, read one death at ${event.payload.position.x}, ${event.payload.position.y}, ` +
        `${event.payload.position.z} in ${event.payload.dimension}, resumed foreground work, and queried history; ` +
        `gear at the cause packet ${JSON.stringify(combatGear)}, at death ${JSON.stringify(death.gear)}, ` +
        `after spawn ${JSON.stringify(gearAfterSpawn)}`,
    };
  } finally {
    try {
      await client.close();
    } finally {
      try {
        await server.close();
      } finally {
        await runtime.close();
      }
    }
  }
}
