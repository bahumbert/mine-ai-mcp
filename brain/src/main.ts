import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { Agent } from "./agent.ts";
import { BRAIN_LOG_FILE, BrainLog } from "./brain-log.ts";
import { OpenAiCompatibleModel } from "./chat-model.ts";
import { readLocalizedChat } from "./chat-range.ts";
import { LlmMind } from "./llm-mind.ts";
import { ModelQueue, MODEL_QUEUE_FILE, startStaggered } from "./model-queue.ts";
import { loadPersona, type Persona, type Tier } from "./persona.ts";
import { McpBotRuntime } from "./runtime-client.ts";
import { TillFacts } from "./farming/site.ts";

const USAGE = `Usage: bun brain/src/main.ts --agent <persona.json>=<mcp url> [--agent ...] [--chat-model <id>] [--action-model <id>] [--planner-model <id>] [--model-slots <n>] [--start-gap <seconds>] [--start-when-free]

  --agent            A persona file and the MCP endpoint of the bot host playing it (repeat for more agents).
                     The persona's username must match that host's --username.
  --known-names      Comma list of people the agents are talked to who are not players here (e.g. Opus): a message opening
                     a sentence with one of these names and a comma or colon is read as spoken to them.
  --<tier>-model     Model id for that tier, for every agent (overrides personas and environment).
  --model-slots      How many model calls the server runs at once (Ollama's OLLAMA_NUM_PARALLEL; default: env MODEL_SLOTS,
                     else unknown). Once known, a call takes a slot before it is sent and waits in the brain beyond them, so
                     the model timeout covers inference only; the monitor's "Model queue" panel shows how many wait.
  --start-gap        Seconds between one agent's start and the next one's (default 0: all at once). The model server
                     queues first calls from many bots at once for a minute or more.
  --start-when-free  Also start the next agent only once a model slot is free (needs --model-slots).

Each agent thinks with three LLM tiers (ADR-008): chat (fast: answers and routes every message), action (turns a
request into skill steps) and planner (bigger jobs). They may all use the same model.

LLM environment (Bun also reads a .env file in the working directory):
  MINE_AI_LLM_BASE_URL          OpenAI-compatible base URL, e.g. https://openrouter.ai/api/v1 or http://127.0.0.1:11434/v1
  MINE_AI_LLM_API_KEY           API key if the provider needs one
  MINE_AI_LLM_MODEL             default model id for every tier
  MINE_AI_LLM_<TIER>_MODEL      per tier (CHAT, ACTION, PLANNER); a persona's "models" wins over these
  MINE_AI_LLM_<TIER>_BASE_URL   per-tier provider, e.g. a fast host for CHAT (falls back to MINE_AI_LLM_BASE_URL)
  MINE_AI_LLM_<TIER>_API_KEY    key for that provider (falls back to MINE_AI_LLM_API_KEY)
  MINE_AI_LLM_JSON_MODE         "false" if the provider rejects response_format json_object (default true)
  MINE_AI_LLM_TIMEOUT_MS        per request, default 90000: with --model-slots it times the inference only (a call waits for a slot
                                in the brain first), without it the server's queue wait counts too
  MINE_AI_LLM_CONTEXT_TOKENS    the model's context window (also per tier), for the monitor's "context full" warning;
                                unset: read from Ollama (its OpenAI API cuts a longer prompt silently)
  MINE_AI_LLM_REASONING_EFFORT  thinking models (also per tier): sent as reasoning_effort, "none" turns thinking off
                                (much faster; recent Ollama models think by default); unset: the model's default

Chat range (the server's Localized Chat mod):
  MC_LOCALIZED_CHAT             "true" when the server limits how far talk carries (default false): the chat tier is told,
                                and may shout
  MC_CHAT_RANGE                 blocks talk carries (Manhattan; default 64)
  MC_SHOUT_FOOD_COST            hunger a shout costs, told to the chat tier (optional)`;

const DEFAULT_LLM_TIMEOUT_MS = 90_000;
// Chat routes as well as it speaks: at 0.7 the same line was read as for another player one time and as an order the
// next (addressee bench, 2026-10-04: the "Opus" lines 10/18 at 0.7, 14/18 at 0.4).
const TIER_TEMPERATURE: Readonly<Record<Tier, number>> = { chat: 0.4, action: 0.2, planner: 0.3 };

interface AgentSpec {
  readonly personaPath: string;
  readonly url: string;
}

function readSpecs(values: readonly string[]): AgentSpec[] {
  return values.map((value) => {
    const split = value.indexOf("=");
    if (split <= 0 || split === value.length - 1) throw new Error(`[BAD_AGENT_ARG] expected <persona.json>=<mcp url>, got ${value}`);
    return { personaPath: value.slice(0, split), url: value.slice(split + 1) };
  });
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

function createModel(persona: Persona, tier: Tier, override: string | undefined): OpenAiCompatibleModel {
  const key = tier.toUpperCase();
  const model = override ?? persona.models[tier] ?? env(`MINE_AI_LLM_${key}_MODEL`) ?? env("MINE_AI_LLM_MODEL");
  const baseUrl = env(`MINE_AI_LLM_${key}_BASE_URL`) ?? env("MINE_AI_LLM_BASE_URL");
  if (model === undefined || baseUrl === undefined) {
    throw new Error(`[LLM_NOT_CONFIGURED] ${persona.id}: no ${tier} model or base URL; set MINE_AI_LLM_BASE_URL and MINE_AI_LLM_MODEL (see --help)`);
  }
  return new OpenAiCompatibleModel({
    baseUrl,
    apiKey: env(`MINE_AI_LLM_${key}_API_KEY`) ?? env("MINE_AI_LLM_API_KEY") ?? null,
    model,
    jsonMode: env("MINE_AI_LLM_JSON_MODE") !== "false",
    timeoutMs: Number(env("MINE_AI_LLM_TIMEOUT_MS") ?? DEFAULT_LLM_TIMEOUT_MS),
    temperature: TIER_TEMPERATURE[tier],
    contextTokens: positiveInteger(env(`MINE_AI_LLM_${key}_CONTEXT_TOKENS`) ?? env("MINE_AI_LLM_CONTEXT_TOKENS")),
    reasoningEffort: env(`MINE_AI_LLM_${key}_REASONING_EFFORT`) ?? env("MINE_AI_LLM_REASONING_EFFORT") ?? null,
  });
}

function startGapMs(value: string | undefined): number {
  if (value === undefined) return 0;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`[BAD_START_ARG] --start-gap expects seconds (0 or more), got ${value}`);
  return seconds * 1000;
}

function positiveInteger(value: string | undefined): number | null {
  const number = Number(value);
  return value !== undefined && Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * The brain log of the bot an MCP url plays, next to its bot-data file (the host's `/health` says where), so the
 * monitor finds it beside the database it already reads; null when the host does not say (no log, the agent runs).
 */
async function openBrainLog(url: string): Promise<BrainLog | null> {
  try {
    const health = await (await fetch(new URL("/health", url))).json() as { minecraft?: { botData?: { file?: unknown } } };
    const file = health.minecraft?.botData?.file;
    return typeof file === "string" ? new BrainLog(join(dirname(file), BRAIN_LOG_FILE)) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      agent: { type: "string", multiple: true },
      "chat-model": { type: "string" },
      "action-model": { type: "string" },
      "planner-model": { type: "string" },
      "known-names": { type: "string" },
      "model-slots": { type: "string" },
      "start-gap": { type: "string" },
      "start-when-free": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help || values.agent === undefined) {
    console.log(USAGE);
    return;
  }
  const specs = readSpecs(values.agent);
  const personas = await Promise.all(specs.map((spec) => loadPersona(spec.personaPath)));
  const knownNames = (values["known-names"] ?? "").split(",").map((name) => name.trim()).filter((name) => name.length > 0);
  const usernames = personas.map((persona) => persona.username);
  const brainLogs = await Promise.all(specs.map((spec) => openBrainLog(spec.url)));
  const slots = positiveInteger(values["model-slots"] ?? env("MODEL_SLOTS"));
  const gapMs = startGapMs(values["start-gap"]);
  if (values["start-when-free"] && slots === null) throw new Error("[BAD_START_ARG] --start-when-free needs --model-slots (or MODEL_SLOTS)");
  // <server dir>/bots/<bot>/brain.jsonl: the queue file goes in the server folder, where the monitor finds it from any bot.
  const firstLog = brainLogs.find((log) => log !== null);
  const queue = new ModelQueue({ slots, file: firstLog === undefined ? null : join(dirname(dirname(dirname(firstLog.path))), MODEL_QUEUE_FILE), log: (line) => console.log(`${new Date().toISOString()} [queue] ${line}`) });
  const localizedChat = readLocalizedChat(env);
  if (localizedChat !== undefined) console.log(`localized chat: talk carries ${localizedChat.range} blocks`);
  const minds = personas.map((persona, index) => {
    const models = {
      chat: queue.track(createModel(persona, "chat", values["chat-model"]), persona.id),
      action: queue.track(createModel(persona, "action", values["action-model"]), persona.id),
      planner: queue.track(createModel(persona, "planner", values["planner-model"]), persona.id),
    };
    console.log(`[${persona.id}] models: chat ${models.chat.name}, action ${models.action.name}, planner ${models.planner.name}`);
    const brainLog = brainLogs[index];
    console.log(`[${persona.id}] brain log: ${brainLog?.path ?? "none (the host did not say where its bot data is)"}`);
    return new LlmMind(models, brainLog === null ? undefined : (call) => brainLog?.write({ kind: "model", ...call }), localizedChat);
  });
  // What a till failed on is learned once for every character of the process.
  const soil = new TillFacts();
  const runtimes = await Promise.all(specs.map((spec, index) => McpBotRuntime.connect(spec.url, `agent-${personas[index]!.id}`)));

  const shutdown = new AbortController();
  process.once("SIGINT", () => shutdown.abort());
  process.once("SIGTERM", () => shutdown.abort());

  const runs: Promise<void>[] = [];
  await startStaggered(
    personas.map((persona, index) => ({ persona, index })),
    ({ persona, index }, afterMs) => {
      const log = (line: string) => console.log(`${new Date().toISOString()} [${persona.id}] ${line}`);
      const agent = new Agent({
        persona,
        runtime: runtimes[index]!,
        mind: minds[index]!,
        otherAgents: usernames.filter((name) => name !== persona.username),
        knownNames,
        soil,
        log,
        ...(brainLogs[index] !== null && { journal: (event) => brainLogs[index]?.write(event) }),
      });
      queue.started(persona.id);
      const after = afterMs === null ? "first" : `+${(afterMs / 1000).toFixed(1)}s after the previous`;
      log(`started ${persona.id} (${after}, ${queue.inFlight()} model calls in flight)`);
      runs.push(agent.run(shutdown.signal).catch((error: unknown) => log(`stopped on error: ${String(error)}`)));
    },
    { gapMs, whenFree: values["start-when-free"] ? (signal) => queue.whenFree(signal) : null, signal: shutdown.signal },
  );
  await Promise.all(runs);
  queue.flush();
  await Promise.all(runtimes.map((runtime) => runtime.close()));
}

await main();
