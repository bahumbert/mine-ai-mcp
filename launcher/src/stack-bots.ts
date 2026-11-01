// One bot = one host process and one brain process, started and stopped together (spec D3).
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appEntry } from "./paths.ts";
import { findPersona, listPersonas, type PersonaEntry } from "./personas.ts";
import { isPersonaId, settingsPath } from "./settings.ts";
import { isStopRequested, logFile, waitUntilReady, type BotStatus, type RunningBot, type StackState } from "./stack-state.ts";

const HEALTH_REQUEST_TIMEOUT_MS = 2_000;
const BOT_STOP_TIMEOUT_MS = 10_000;

export type BotOutcome =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly reason: "unknown-persona" | "not-ready" | "already-running" | "not-running" | "failed"; readonly message: string };

const personasFolder = (state: StackState): string => join(state.root, "personas");
const otherAgentsFile = (state: StackState): string => join(state.root, "run", "other-agents.json");

/**
 * The personas a bot can start from: a file whose id the settings refuse (a hidden file, a folder part) is none, so a bot
 * started from chat follows the rule of `settings.bots`. The chat commands list and look up with this, never `listPersonas`.
 */
export function startablePersonas(root: string): PersonaEntry[] {
  return listPersonas(root).filter((persona) => isPersonaId(persona.id));
}

/** The startable persona whose id, else username, is `name` (no case). */
function findStartablePersona(state: StackState, name: string): PersonaEntry | null {
  return findPersona(startablePersonas(state.root), name);
}

function unknownPersona(state: StackState, name: string): BotOutcome {
  return { ok: false, reason: "unknown-persona", message: `No persona "${name}": no file in ${personasFolder(state)} has that id or username. A persona file is <id>.json holding a "username" of 1 to 16 letters, digits or underscores; its id must not start with a dot.` };
}

/** Failed writes already said: a failed state is said once, and a write that works makes the next failure news again. */
const writeFailureSaid = new WeakSet<StackState>();

/**
 * Writes `<root>/run/other-agents.json` `{ "usernames": [...] }` (temporary file, then rename) for the brains
 * (`--other-agents-file`): the bots starting, running or stopping, plus the listener while it is joined. Called on every
 * bot status change; a brain re-reads the file, so two bots never answer each other. A failed write is said to the
 * player once, never thrown: running brains keep their last list, a brain started since has none.
 */
export function writeOtherAgents(state: StackState, listenerName: string | null = state.listenerJoined): void {
  const usernames = [...state.bots.values()].filter((bot) => bot.status !== "ended").map((bot) => bot.username);
  if (listenerName !== null) usernames.push(listenerName);
  const file = otherAgentsFile(state);
  try {
    mkdirSync(join(state.root, "run"), { recursive: true });
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ usernames })}\n`);
    renameSync(`${file}.tmp`, file);
    writeFailureSaid.delete(state);
  } catch (error) {
    if (writeFailureSaid.has(state)) return;
    writeFailureSaid.add(state);
    state.deps.say(`Could not write ${file} (${(error as Error).message}). A bot started now does not know the other bots and may answer each other. Delete or fix ${join(state.root, "run")}, then stop and start the bots.`);
  }
}

/** Sets the status of a bot and tells the brains. */
function setStatus(state: StackState, bot: RunningBot, status: BotStatus): void {
  bot.status = status;
  writeOtherAgents(state);
}

/** Drops `bot` from the stack; a newer bot with the same id (started after this one was stopped) stays. */
function forgetBot(state: StackState, bot: RunningBot): void {
  if (state.bots.get(bot.id) === bot) state.bots.delete(bot.id);
  writeOtherAgents(state);
}

function hostArguments(state: StackState, bot: RunningBot): string[] {
  const target = state.serverTarget!;
  const { commands } = state.settings;
  return [
    appEntry(state.deps.appRoot, "src/server/host.ts"),
    "--minecraft-host", target.host,
    "--minecraft-port", String(target.port),
    "--version", state.manifest.minecraft.version,
    "--username", bot.username,
    "--instance-id", bot.id,
    "--listen-port", String(bot.hostPort),
    "--data-root", join(state.root, "bot-data"),
    ...(commands.enabled ? ["--chat-command-prefix", commands.prefix] : []),
  ];
}

function brainArguments(state: StackState, bot: RunningBot, persona: PersonaEntry): string[] {
  return [
    appEntry(state.deps.appRoot, "brain/src/main.ts"),
    "--agent", `${persona.path}=http://127.0.0.1:${bot.hostPort}/mcp`,
    "--other-agents-file", otherAgentsFile(state),
    "--model-slots", String(state.manifest.brainModelSlots),
  ];
}

/** The manifest's `brainEnv` plus the model endpoint from the settings: the brain's only configuration besides flags. */
function brainEnvironment(state: StackState): Record<string, string> {
  const { llm } = state.settings;
  const endpoint: Record<string, string> = llm.kind === "remote" ? { MINE_AI_LLM_BASE_URL: llm.baseUrl, MINE_AI_LLM_API_KEY: llm.apiKey } : { MINE_AI_LLM_BASE_URL: `${state.ollama?.baseUrl}/v1` };
  return { ...state.manifest.brainEnv, ...endpoint, MINE_AI_LLM_MODEL: llm.model };
}

function usedPorts(state: StackState): Set<number> {
  return new Set([state.settings.controlPort, ...[...state.bots.values()].map((bot) => bot.hostPort)]);
}

async function hostIsHealthy(state: StackState, port: number): Promise<boolean> {
  try {
    return (await state.deps.fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS) })).ok;
  } catch {
    return false;
  }
}

function describeExit(exit: { code: number | null; error?: string }): string {
  return exit.error ?? `code ${exit.code}`;
}

/** Tells the player when a process of a running bot ends by itself; its own stop is not reported. */
function reportEndOf(state: StackState, bot: RunningBot, what: "host" | "brain", exited: Promise<{ code: number | null; error?: string }>): void {
  void exited.then((exit) => {
    if (bot.status !== "running") return;
    setStatus(state, bot, "ended");
    state.deps.say(`The ${what} of ${bot.username} ended (${describeExit(exit)}); ${bot.username} is no longer playing. See ${logFile(state, `${what}-${bot.id}`)}. Start it again with: mine-ai bot start ${bot.id}`);
  });
}

/**
 * Starts the host, waits for its `/health`, then starts the brain. Returns the failure line, or null. The bot may be
 * stopped at any await (while it waits in the queue, for a port, for the health): it is looked at again after each, before
 * anything is spawned and before the outcome is classified, so a stopped bot leaves no host or brain behind.
 */
async function launchBot(state: StackState, bot: RunningBot, persona: PersonaEntry): Promise<string | null> {
  const { deps, manifest } = state;
  const stopped = `${bot.username} was stopped while it was starting.`;
  const stillStarting = (): boolean => !isStopRequested(state) && state.bots.get(bot.id) === bot && bot.status === "starting";
  if (!stillStarting()) return stopped;
  bot.hostPort = await deps.freePort(state.settings.hostBasePort, usedPorts(state));
  if (!stillStarting()) return stopped;
  const host = state.children.spawn(`host-${bot.id}`, deps.bunPath, hostArguments(state, bot), { env: {}, cwd: deps.appRoot, logFile: logFile(state, `host-${bot.id}`) });
  const outcome = await waitUntilReady(state, () => hostIsHealthy(state, bot.hostPort), host.exited, manifest.waits.hostHealthMs);
  if (outcome !== "ready" || !stillStarting()) {
    await state.children.stop(`host-${bot.id}`, { timeoutMs: BOT_STOP_TIMEOUT_MS });
    if (!stillStarting()) return stopped;
    const reason = outcome === "exited" ? `ended before it was ready (${describeExit(await host.exited)})` : `did not answer within ${manifest.waits.hostHealthMs / 1_000} s`;
    return `The host of ${bot.username} ${reason}. See ${logFile(state, `host-${bot.id}`)}.`;
  }
  writeOtherAgents(state);
  const brain = state.children.spawn(`brain-${bot.id}`, deps.bunPath, brainArguments(state, bot, persona), { env: brainEnvironment(state), cwd: deps.appRoot, logFile: logFile(state, `brain-${bot.id}`) });
  setStatus(state, bot, "running");
  reportEndOf(state, bot, "host", host.exited);
  reportEndOf(state, bot, "brain", brain.exited);
  return null;
}

/** Why a bot has no server to join: a settings file that was not found (no setup yet) is told apart from one that sets none. */
function noServerToJoin(state: StackState): string {
  const file = settingsPath(state.root);
  if (!state.settingsFound) return `There is no settings file at ${file}, so there is no Minecraft server to join. Run the Mine AI setup again, or mine-ai configure --server-local, then start Mine AI again.`;
  return `There is no Minecraft server to join. Set one in ${file} ("server"), then start Mine AI again.`;
}

/**
 * Starts the bot with the persona file `<root>/personas/<id>.json`: its host first, its brain once the host answers
 * `/health`. Starts run one at a time. A failure is reported to the player and leaves nothing running for that bot.
 */
export async function startBot(state: StackState, name: string): Promise<BotOutcome> {
  const notReady = (message: string): BotOutcome => ({ ok: false, reason: "not-ready", message });
  if (state.phase === "starting") return notReady("Mine AI is still starting; start the bot when the console says it is ready.");
  if (state.phase === "failed") return notReady(`Mine AI did not start: ${state.problem}`);
  if (state.phase !== "running") return notReady("Mine AI is stopping.");
  if (state.serverTarget === null) return notReady(noServerToJoin(state));
  const persona = findStartablePersona(state, name);
  if (persona === null) return unknownPersona(state, name);
  const id = persona.id;
  const existing = state.bots.get(id);
  if (existing?.status === "ended") await stopBot(state, id);
  else if (existing?.status === "stopping") return notReady(`${persona.username} is stopping; start it again once it has stopped.`);
  else if (existing) return { ok: false, reason: "already-running", message: `${persona.username} is already ${existing.status === "starting" ? "starting" : "running"}.` };
  const bot: RunningBot = { id, username: persona.username, hostPort: 0, status: "starting" };
  state.bots.set(id, bot);
  writeOtherAgents(state);
  const run = state.botQueue.then(() => launchBot(state, bot, persona));
  state.botQueue = run.catch(() => undefined);
  let failure: string | null;
  try {
    failure = await run;
  } catch (error) {
    failure = `${persona.username} could not start: ${(error as Error).message}`;
  }
  if (failure === null) return { ok: true, message: `${persona.username} is running (host port ${bot.hostPort}).` };
  // Only this start's own bot is cleaned up: after a stop the id may belong to a newer start, and a bot being stopped is forgotten by `stopBot`.
  if (state.bots.get(id) === bot) {
    if (bot.status === "starting") forgetBot(state, bot);
    await state.children.stop(`host-${id}`, { timeoutMs: BOT_STOP_TIMEOUT_MS });
  }
  return { ok: false, reason: "failed", message: failure };
}

/** The running bot `name` means: its id first (a bot outlives its persona file), else its persona's id, else its username (no case). */
function findRunningBot(state: StackState, name: string): RunningBot | null {
  const byId = state.bots.get(name) ?? state.bots.get(findStartablePersona(state, name)?.id ?? "");
  if (byId) return byId;
  const wanted = name.toLowerCase();
  return [...state.bots.values()].find((bot) => bot.username.toLowerCase() === wanted) ?? null;
}

/** Ends the brain, then the host. `name` is a persona id or username. A bot that does not run is a `not-running` answer, not an error. */
export async function stopBot(state: StackState, name: string): Promise<BotOutcome> {
  const bot = findRunningBot(state, name);
  if (!bot) return { ok: false, reason: "not-running", message: `${findStartablePersona(state, name)?.username ?? name} is not running.` };
  const id = bot.id;
  if (bot.status === "stopping") return { ok: false, reason: "not-running", message: `${bot.username} is already stopping.` };
  setStatus(state, bot, "stopping");
  await state.children.stop(`brain-${id}`, { timeoutMs: BOT_STOP_TIMEOUT_MS });
  await state.children.stop(`host-${id}`, { timeoutMs: BOT_STOP_TIMEOUT_MS });
  forgetBot(state, bot);
  return { ok: true, message: `${bot.username} stopped.` };
}
