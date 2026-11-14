// `mine-ai configure`: the installer's (and the player's) way to write settings.json without opening it.
import { existsSync } from "node:fs";
import { totalmem } from "node:os";
import { join } from "node:path";
import { UsageError, type CliContext } from "./cli-context.ts";
import { serverMemoryMb } from "./install/server.ts";
import type { Manifest } from "./manifest.ts";
import { keyUnreadableStartText } from "./secret.ts";
import { clearKeyMigrationLine, COMMAND_PLAYER_NAME, loadSettings, realSettingsOptions, saveSettings, SERVER_PROGRAMS, settingsPath, type ServerProgram, type Settings, type SettingsOptions } from "./settings.ts";

/** The port a vanilla server listens on; `install server` writes the settings' port into server.properties. */
const DEFAULT_LOCAL_SERVER_PORT = 25_565;

export interface ConfigureDeps {
  totalRamBytes(): number;
  /** How the API key is protected on this system; tests pass a fake Windows. Default: the real one. */
  settings?: SettingsOptions;
}

type LlmChoice = { kind: "local" } | { kind: "remote"; baseUrl: string; apiKey: string; model: string } | { kind: "remoteSavedKey"; baseUrl: string; model: string };
type ServerChoice = { kind: "none" } | { kind: "local" } | { kind: "remote"; host: string; port: number };
interface Choices {
  llm?: LlmChoice;
  server?: ServerChoice;
  /** The program of the local server (`settings.server.program`); it needs a local server. */
  serverProgram?: ServerProgram;
  /** The players allowed to give chat commands; an empty list clears them. */
  commandPlayers?: string[];
  /** Whether the start checks for a newer release (`settings.checkUpdates`). */
  checkUpdates?: boolean;
}

/** How many values each flag takes after it. */
export const CONFIGURE_FLAGS: Readonly<Record<string, number>> = { "--llm-local": 0, "--llm-remote": 3, "--llm-remote-saved-key": 2, "--server-none": 0, "--server-local": 0, "--server-remote": 2, "--server-program": 1, "--command-players": 1, "--check-updates": 1 };
const USAGE = "configure takes --llm-local | --llm-remote <url> <key> <model> | --llm-remote-saved-key <url> <model> (keeps the saved key) and/or --server-none | --server-local | --server-remote <host> <port> and/or --server-program paper|vanilla (the program of the local server: with --server-local, or once one is set up) and/or --command-players <name,name,...> (\"\" clears them) and/or --check-updates on|off.";

function parsePort(text: string): number {
  const port = Number(text);
  if (!/^\d+$/u.test(text) || port < 1 || port > 65_535) throw new UsageError(`"${text}" is not a port (1 to 65535). ${USAGE}`);
  return port;
}

function setOnce<K extends keyof Choices>(choices: Choices, key: K, value: NonNullable<Choices[K]>): void {
  if (choices[key] !== undefined) throw new UsageError(`Give only one ${key === "commandPlayers" ? "--command-players list" : `of the --${key} choices`}. ${USAGE}`);
  choices[key] = value;
}

function checkUpdatesChoice(choices: Choices, text: string): void {
  if (choices.checkUpdates !== undefined) throw new UsageError(`Give --check-updates only once. ${USAGE}`);
  if (text !== "on" && text !== "off") throw new UsageError(`--check-updates takes on or off, not "${text}". ${USAGE}`);
  choices.checkUpdates = text === "on";
}

function serverProgramChoice(choices: Choices, text: string): void {
  if (choices.serverProgram !== undefined) throw new UsageError(`Give --server-program only once. ${USAGE}`);
  choices.serverProgram = parseServerProgram(text);
}

function parseChoices(args: readonly string[]): Choices {
  const choices: Choices = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    const count = CONFIGURE_FLAGS[flag];
    if (count === undefined) throw new UsageError(`Unknown argument "${flag}". ${USAGE}`);
    const values = args.slice(i + 1, i + 1 + count);
    if (values.length < count) throw new UsageError(`${flag} needs ${count} values. ${USAGE}`);
    i += count;
    if (flag === "--llm-local") setOnce(choices, "llm", { kind: "local" });
    else if (flag === "--llm-remote") setOnce(choices, "llm", remoteLlm(values));
    else if (flag === "--llm-remote-saved-key") setOnce(choices, "llm", remoteSavedKeyLlm(values));
    else if (flag === "--server-none") setOnce(choices, "server", { kind: "none" });
    else if (flag === "--server-local") setOnce(choices, "server", { kind: "local" });
    else if (flag === "--server-program") serverProgramChoice(choices, values[0]!);
    else if (flag === "--command-players") setOnce(choices, "commandPlayers", commandPlayers(values[0]!));
    else if (flag === "--check-updates") checkUpdatesChoice(choices, values[0]!);
    else setOnce(choices, "server", remoteServer(values));
  }
  if (choices.llm === undefined && choices.server === undefined && choices.serverProgram === undefined && choices.commandPlayers === undefined && choices.checkUpdates === undefined) throw new UsageError(USAGE);
  return choices;
}

/** "Tom, Dara_2" -> ["Tom", "Dara_2"]; "" -> []. Each name must be a Minecraft account name (the settings refuse others at load). */
function commandPlayers(text: string): string[] {
  const names = text.split(",").map((name) => name.trim()).filter((name) => name !== "");
  const bad = names.find((name) => !COMMAND_PLAYER_NAME.test(name));
  if (bad !== undefined) throw new UsageError(`"${bad}" is not a player name (3 to 16 letters, digits or underscores). ${USAGE}`);
  return names;
}

function checkEndpoint(baseUrl: string, model: string): void {
  if (!/^https?:\/\/\S+$/u.test(baseUrl)) throw new UsageError(`The endpoint URL "${baseUrl}" must start with http:// or https:// and have no spaces.`);
  if (model.trim() === "") throw new UsageError("The model name must not be empty: it is the model the endpoint serves.");
}

function remoteLlm([baseUrl, apiKey, model]: string[]): LlmChoice {
  checkEndpoint(baseUrl!, model!);
  return { kind: "remote", baseUrl: baseUrl!, apiKey: apiKey!, model: model! };
}

/** The setup's form for an update that keeps the saved key: the key never travels on a command line (spec D3). */
function remoteSavedKeyLlm([baseUrl, model]: string[]): LlmChoice {
  checkEndpoint(baseUrl!, model!);
  return { kind: "remoteSavedKey", baseUrl: baseUrl!, model: model! };
}

/** The saved remote `llm` with a new URL and model: every key field as loaded, so the blob is written back as it is. */
function withSavedKey(current: Settings["llm"], choice: { baseUrl: string; model: string }, settingsFile: string): Settings["llm"] {
  if (current.kind === "remote" && current.keyUnreadable === true) throw new UsageError(keyUnreadableStartText(settingsFile));
  if (current.kind !== "remote" || current.apiKey === "") throw new UsageError("No API key is saved: use --llm-remote <url> <key> <model>.");
  return { ...current, baseUrl: choice.baseUrl, model: choice.model };
}

function remoteServer([host, port]: string[]): ServerChoice {
  if (host!.trim() === "" || /\s/u.test(host!)) throw new UsageError("The server address must not be empty or hold spaces.");
  return { kind: "remote", host: host!, port: parsePort(port!) };
}

function chosenLlm(settings: Settings, choice: LlmChoice, manifest: Manifest, root: string): Settings["llm"] {
  if (choice.kind === "local") return { kind: "local", model: manifest.ollama.model };
  if (choice.kind === "remoteSavedKey") return withSavedKey(settings.llm, choice, settingsPath(root));
  return choice;
}

/** A refusal the player can act on (not a wrong command line): `runConfigureCommand` says it and leaves settings.json as it is. */
class ConfigureRefusal extends Error {}

/** True when the world in `serverDir` ran on Paper: Paper keeps the Nether and the End in `world_nether` and `world_the_end`, vanilla inside `world`. */
export function worldRanOnPaper(serverDir: string): boolean {
  return existsSync(join(serverDir, "world_nether")) || existsSync(join(serverDir, "world_the_end"));
}

function parseServerProgram(text: string): ServerProgram {
  if (!(SERVER_PROGRAMS as readonly string[]).includes(text)) throw new UsageError(`--server-program takes ${SERVER_PROGRAMS.join(" or ")}, not "${text}". ${USAGE}`);
  return text as ServerProgram;
}

/** The program of the local server these choices leave: the one asked for, else the one it already ran, else Paper for a server set up now. */
function chosenProgram(settings: Settings, choices: Choices): ServerProgram {
  if (choices.serverProgram !== undefined) return choices.serverProgram;
  return settings.server.kind === "local" ? settings.server.program : "paper";
}

/** Going back to vanilla from anything but vanilla is refused on a world that ran on Paper: vanilla would start a new Nether and End beside the old ones. */
function checkWorldAllowsVanilla(settings: Settings, program: ServerProgram, root: string): void {
  const wasVanilla = settings.server.kind === "local" && settings.server.program === "vanilla";
  if (program !== "vanilla" || wasVanilla || !worldRanOnPaper(join(root, "server"))) return;
  throw new ConfigureRefusal("This world has run on Paper, which keeps the Nether and the End in folders of their own (world_nether, world_the_end). Going back to vanilla is not offered yet: keep Paper, or move the world folders aside to start a new world on vanilla.");
}

const SERVER_PROGRAM_NEEDS_LOCAL = `--server-program needs a local server: give --server-local with it, or set one up first. ${USAGE}`;

function chosenServer(settings: Settings, choices: Choices, manifest: Manifest, deps: ConfigureDeps, root: string): Settings["server"] {
  if (choices.server !== undefined && choices.server.kind !== "local") {
    if (choices.serverProgram !== undefined) throw new UsageError(SERVER_PROGRAM_NEEDS_LOCAL);
    return choices.server;
  }
  if (choices.server === undefined) {
    if (choices.serverProgram === undefined) return settings.server;
    if (settings.server.kind !== "local") throw new UsageError(SERVER_PROGRAM_NEEDS_LOCAL);
    checkWorldAllowsVanilla(settings, choices.serverProgram, root);
    return { ...settings.server, program: choices.serverProgram };
  }
  const program = chosenProgram(settings, choices);
  checkWorldAllowsVanilla(settings, program, root);
  return { kind: "local", port: settings.server.kind === "local" ? settings.server.port : DEFAULT_LOCAL_SERVER_PORT, memoryMb: serverMemoryMb(manifest, deps.totalRamBytes()), program };
}

function applyChoices(settings: Settings, choices: Choices, manifest: Manifest, deps: ConfigureDeps, root: string): Settings {
  const next = { ...settings };
  if (choices.llm) next.llm = chosenLlm(settings, choices.llm, manifest, root);
  next.server = chosenServer(settings, choices, manifest, deps, root);
  if (choices.commandPlayers) next.commands = { ...settings.commands, players: choices.commandPlayers };
  if (choices.checkUpdates !== undefined) next.checkUpdates = choices.checkUpdates;
  return next;
}

/** Writes the chosen model, server, command players and update check into settings.json (everything else in the file is kept). Exit code 0, or 1 when the file cannot be used. */
export async function runConfigureCommand(args: readonly string[], context: CliContext, deps: ConfigureDeps = { totalRamBytes: totalmem }): Promise<number> {
  const choices = parseChoices(args);
  const manifest = context.loadManifest();
  const options = deps.settings ?? realSettingsOptions();
  let loaded: Settings;
  try {
    loaded = loadSettings(context.root, manifest, options);
  } catch (error) {
    context.err((error as Error).message);
    return 1;
  }
  let next: Settings;
  try {
    next = applyChoices(loaded, choices, manifest, deps, context.root); // a UsageError (no saved key, no local server) leaves the file as it is
  } catch (error) {
    if (!(error instanceof ConfigureRefusal)) throw error;
    context.err(error.message);
    return 1;
  }
  try {
    saveSettings(context.root, next, options);
  } catch (error) {
    context.err((error as Error).message);
    return 1;
  }
  context.out(`Saved ${settingsPath(context.root)}`);
  const migration = clearKeyMigrationLine(context.root, next);
  if (migration !== null) context.out(migration);
  return 0;
}
