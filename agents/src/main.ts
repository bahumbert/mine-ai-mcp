import { parseArgs } from "node:util";
import { dirname, join } from "node:path";
import { Agent } from "./agent.ts";
import { BRAIN_LOG_FILE, BrainLog } from "./brain-log.ts";
import { OpenAiCompatibleModel } from "./chat-model.ts";
import { LlmMind } from "./llm-mind.ts";
import { loadPersona, type Persona, type Tier } from "./persona.ts";
import { McpBotRuntime } from "./runtime-client.ts";

const USAGE = `Usage: bun agents/src/main.ts --agent <persona.json>=<mcp url> [--agent ...] [--chat-model <id>] [--action-model <id>] [--planner-model <id>]

  --agent            A persona file and the MCP endpoint of the bot host playing it (repeat for more agents).
                     The persona's username must match that host's --username.
  --<tier>-model     Model id for that tier, for every agent (overrides personas and environment).

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
  MINE_AI_LLM_TIMEOUT_MS        per request, default 30000`;

const DEFAULT_LLM_TIMEOUT_MS = 30_000;
const TIER_TEMPERATURE: Readonly<Record<Tier, number>> = { chat: 0.7, action: 0.2, planner: 0.3 };

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
  });
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
      help: { type: "boolean" },
    },
  });
  if (values.help || values.agent === undefined) {
    console.log(USAGE);
    return;
  }
  const specs = readSpecs(values.agent);
  const personas = await Promise.all(specs.map((spec) => loadPersona(spec.personaPath)));
  const usernames = personas.map((persona) => persona.username);
  const brainLogs = await Promise.all(specs.map((spec) => openBrainLog(spec.url)));
  const minds = personas.map((persona, index) => {
    const models = {
      chat: createModel(persona, "chat", values["chat-model"]),
      action: createModel(persona, "action", values["action-model"]),
      planner: createModel(persona, "planner", values["planner-model"]),
    };
    console.log(`[${persona.id}] models: chat ${models.chat.name}, action ${models.action.name}, planner ${models.planner.name}`);
    const brainLog = brainLogs[index];
    console.log(`[${persona.id}] brain log: ${brainLog?.path ?? "none (the host did not say where its bot data is)"}`);
    return new LlmMind(models, brainLog === null ? undefined : (call) => brainLog?.write({ kind: "model", ...call }));
  });
  const runtimes = await Promise.all(specs.map((spec, index) => McpBotRuntime.connect(spec.url, `agent-${personas[index]!.id}`)));

  const shutdown = new AbortController();
  process.once("SIGINT", () => shutdown.abort());
  process.once("SIGTERM", () => shutdown.abort());

  const runs = personas.map((persona, index) => {
    const log = (line: string) => console.log(`${new Date().toISOString()} [${persona.id}] ${line}`);
    const agent = new Agent({
      persona,
      runtime: runtimes[index]!,
      mind: minds[index]!,
      otherAgents: usernames.filter((name) => name !== persona.username),
      log,
      ...(brainLogs[index] !== null && { journal: (event) => brainLogs[index]?.write(event) }),
    });
    return agent.run(shutdown.signal).catch((error: unknown) => log(`stopped on error: ${String(error)}`));
  });
  await Promise.all(runs);
  await Promise.all(runtimes.map((runtime) => runtime.close()));
}

await main();
