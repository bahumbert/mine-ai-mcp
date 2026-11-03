// The stack in order: Ollama, the Minecraft server, then one host + brain pair per bot; and the ordered stop (spec D3).
import type { Manifest } from "./manifest.ts";
import type { ChildExit, StopResult } from "./processes.ts";
import { settingsPath, type Settings } from "./settings.ts";
import { chatCommandDeps, startChatCommands } from "./chat/sources.ts";
import { startBot, stopBot } from "./stack-bots.ts";
import { checkRemoteServer, startLocalServer, startOllama, stopLocalServer, stopOllama } from "./stack-services.ts";
import { isStopRequested, realStackDeps, type ChildRunner, type StackDeps, type StackState } from "./stack-state.ts";

export { startBot, stopBot, type BotOutcome } from "./stack-bots.ts";
export { describeStack, realStackDeps, type BotStatus, type ChildRunner, type RunningBot, type StackDeps, type StackPhase, type StackState, type StackStatus } from "./stack-state.ts";

/** An empty stack in phase `starting`, so the control server can answer `/status` while `bringUpStack` runs. */
export function createStack(settings: Settings, manifest: Manifest, children: ChildRunner, root: string, deps: StackDeps = realStackDeps(() => {}, root)): StackState {
  return { settings, manifest, children, root, deps, settingsFound: deps.settingsFileExists(), phase: "starting", problem: null, bots: new Map(), ollama: null, server: null, serverTarget: null, bringUp: null, stopping: null, botQueue: Promise.resolve(), listenerJoined: null, chatCommands: null };
}

/** Starts what the settings ask for. A service that cannot start ends the start with `state.problem` set and nothing left running. */
export function bringUpStack(state: StackState): Promise<void> {
  state.bringUp ??= runBringUp(state);
  return state.bringUp;
}

export async function startStack(settings: Settings, manifest: Manifest, children: ChildRunner, root: string, deps?: StackDeps): Promise<StackState> {
  const state = createStack(settings, manifest, children, root, deps);
  await bringUpStack(state);
  return state;
}

/** Why no bot starts with no server: a settings file that was not found (the wrong folder, or no setup) is told apart from one that sets no server. */
function noServerLine(state: StackState): string {
  const file = settingsPath(state.root);
  if (!state.settingsFound) return `No settings file at ${file}, so no bot starts. Run the Mine AI setup again, or mine-ai configure --server-local, then start again.`;
  return `No Minecraft server is set, so no bot starts. Put one in ${file} ("server": { "kind": "remote", "host": ..., "port": ... }) or run \`mine-ai configure --server-local\`, then start again.`;
}

/** The first service problem, or null. A remote server is checked before the model is loaded: a wrong server makes the load useless. */
async function startServices(state: StackState): Promise<string | null> {
  const { server, llm } = state.settings;
  if (server.kind === "none") {
    state.deps.say(noServerLine(state));
    return null;
  }
  const remoteProblem = await checkRemoteServer(state);
  if (remoteProblem !== null) return remoteProblem;
  const ollamaProblem = llm.kind === "local" ? await startOllama(state) : null;
  if (ollamaProblem !== null) return ollamaProblem;
  return await startLocalServer(state);
}

async function runBringUp(state: StackState): Promise<void> {
  const problem = await startServices(state);
  if (problem !== null) {
    await stopServices(state);
    // A start cut short by a stop is no failure: the launcher ends with exit 0 and the console shows nothing alarming.
    if (isStopRequested(state)) return;
    state.problem = problem;
    state.deps.say(problem);
    state.phase = "failed";
    return;
  }
  // Running from here: the services are up, and a `bot start` may come in while the first bots load.
  if (!isStopRequested(state)) state.phase = "running";
  // With no server there is no bot to start; the line about it was said above.
  if (state.serverTarget === null || isStopRequested(state)) return;
  // Before the first bot, so every host is polled from its first moment.
  state.chatCommands = (state.deps.startChatCommands ?? ((stack) => startChatCommands(stack, chatCommandDeps(stack))))(state);
  for (const id of state.settings.bots) {
    if (isStopRequested(state)) return;
    state.deps.say((await startBot(state, id)).message);
  }
}

/** The server ended on its `stop` line: saved only when it exited with code 0 (a server that fails while saving also ends). */
function serverStopLine(exit: ChildExit): string {
  if (exit.code === 0) return "The Minecraft server saved the world and stopped.";
  const how = exit.code === null ? `signal ${exit.signal ?? "unknown"}` : `code ${exit.code}`;
  return `The Minecraft server ended with ${how} while stopping: its last save may be missing.`;
}

async function stopServices(state: StackState): Promise<{ server: StopResult; ollamaStopped: boolean }> {
  const server = await stopLocalServer(state);
  return { server, ollamaStopped: await stopOllama(state) };
}

/**
 * The ordered stop: the chat command sources (so no command starts a bot now, and no answer is written to a closing
 * server), each bot (brain, then host), the server by its `stop` line so the world is saved, the model
 * unloaded, our Ollama and its runners. Safe to call twice (the second call returns the first stop, which says nothing
 * more), and while the stack is still starting (the start gives up). `reason` is the first line's "why"; each step says
 * what it did through `deps.say`, so `launcher.log` and every console show whether the world was saved.
 */
export function stopStack(state: StackState, reason: string): Promise<void> {
  state.stopping ??= runStop(state, reason);
  return state.stopping;
}

async function runStop(state: StackState, reason: string): Promise<void> {
  const { say, now } = state.deps;
  const began = now();
  say(`Stopping Mine AI (${reason})...`);
  state.phase = "stopping";
  // First, even while a bot still loads: a chat command typed now must not start another one.
  await state.chatCommands?.stop();
  await state.bringUp?.catch(() => undefined);
  await state.botQueue;
  for (const id of [...state.bots.keys()]) say((await stopBot(state, id)).message);
  const { server, ollamaStopped } = await stopServices(state);
  if (server === "killed") say(`The Minecraft server did not stop within ${state.manifest.waits.serverStopMs / 1_000} s and was ended; the world may not be saved.`);
  else if (server !== "not-running") say(serverStopLine(server.ended));
  if (ollamaStopped) say("Ollama stopped.");
  await state.children.stopAll([]);
  state.phase = "stopped";
  say(`Mine AI stopped (${Math.round((now() - began) / 1_000)} s).`);
}
