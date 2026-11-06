// `mine-ai configure`: the installer's (and the player's) way to write settings.json without opening it.
import { totalmem } from "node:os";
import { UsageError, type CliContext } from "./cli-context.ts";
import { serverMemoryMb } from "./install/server.ts";
import type { Manifest } from "./manifest.ts";
import { keyUnreadableStartText } from "./secret.ts";
import { clearKeyMigrationLine, COMMAND_PLAYER_NAME, loadSettings, realSettingsOptions, saveSettings, settingsPath, type Settings, type SettingsOptions } from "./settings.ts";

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
  /** The players allowed to give chat commands; an empty list clears them. */
  commandPlayers?: string[];
}

/** How many values each flag takes after it. */
export const CONFIGURE_FLAGS: Readonly<Record<string, number>> = { "--llm-local": 0, "--llm-remote": 3, "--llm-remote-saved-key": 2, "--server-none": 0, "--server-local": 0, "--server-remote": 2, "--command-players": 1 };
const USAGE = "configure takes --llm-local | --llm-remote <url> <key> <model> | --llm-remote-saved-key <url> <model> (keeps the saved key) and/or --server-none | --server-local | --server-remote <host> <port> and/or --command-players <name,name,...> (\"\" clears them).";

function parsePort(text: string): number {
  const port = Number(text);
  if (!/^\d+$/u.test(text) || port < 1 || port > 65_535) throw new UsageError(`"${text}" is not a port (1 to 65535). ${USAGE}`);
  return port;
}

function setOnce<K extends keyof Choices>(choices: Choices, key: K, value: NonNullable<Choices[K]>): void {
  if (choices[key] !== undefined) throw new UsageError(`Give only one ${key === "commandPlayers" ? "--command-players list" : `of the --${key} choices`}. ${USAGE}`);
  choices[key] = value;
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
    else if (flag === "--command-players") setOnce(choices, "commandPlayers", commandPlayers(values[0]!));
    else setOnce(choices, "server", remoteServer(values));
  }
  if (choices.llm === undefined && choices.server === undefined && choices.commandPlayers === undefined) throw new UsageError(USAGE);
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

function applyChoices(settings: Settings, choices: Choices, manifest: Manifest, deps: ConfigureDeps, root: string): Settings {
  const next = { ...settings };
  if (choices.llm) next.llm = chosenLlm(settings, choices.llm, manifest, root);
  if (choices.server) {
    if (choices.server.kind !== "local") next.server = choices.server;
    else next.server = { kind: "local", port: settings.server.kind === "local" ? settings.server.port : DEFAULT_LOCAL_SERVER_PORT, memoryMb: serverMemoryMb(manifest, deps.totalRamBytes()) };
  }
  if (choices.commandPlayers) next.commands = { ...settings.commands, players: choices.commandPlayers };
  return next;
}

/** Writes the chosen model and server into settings.json (everything else in the file is kept). Exit code 0, or 1 when the file cannot be used. */
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
  const next = applyChoices(loaded, choices, manifest, deps, context.root); // a UsageError (no saved key) leaves the file as it is
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
