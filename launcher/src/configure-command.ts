// `mine-ai configure`: the installer's (and the player's) way to write settings.json without opening it.
import { totalmem } from "node:os";
import { UsageError, type CliContext } from "./cli-context.ts";
import { serverMemoryMb } from "./install/server.ts";
import type { Manifest } from "./manifest.ts";
import { COMMAND_PLAYER_NAME, loadSettings, saveSettings, settingsPath, type Settings } from "./settings.ts";

/** The port a vanilla server listens on; `install server` writes the settings' port into server.properties. */
const DEFAULT_LOCAL_SERVER_PORT = 25_565;

export interface ConfigureDeps {
  totalRamBytes(): number;
}

type LlmChoice = { kind: "local" } | { kind: "remote"; baseUrl: string; apiKey: string; model: string };
type ServerChoice = { kind: "none" } | { kind: "local" } | { kind: "remote"; host: string; port: number };
interface Choices {
  llm?: LlmChoice;
  server?: ServerChoice;
  /** The players allowed to give chat commands; an empty list clears them. */
  commandPlayers?: string[];
}

/** How many values each flag takes after it. */
export const CONFIGURE_FLAGS: Readonly<Record<string, number>> = { "--llm-local": 0, "--llm-remote": 3, "--server-none": 0, "--server-local": 0, "--server-remote": 2, "--command-players": 1 };
const USAGE = "configure takes --llm-local | --llm-remote <url> <key> <model> and/or --server-none | --server-local | --server-remote <host> <port> and/or --command-players <name,name,...> (\"\" clears them).";

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

function remoteLlm([baseUrl, apiKey, model]: string[]): LlmChoice {
  if (!/^https?:\/\/\S+$/u.test(baseUrl!)) throw new UsageError(`The endpoint URL "${baseUrl}" must start with http:// or https:// and have no spaces.`);
  if (model!.trim() === "") throw new UsageError("The model name must not be empty: it is the model the endpoint serves.");
  return { kind: "remote", baseUrl: baseUrl!, apiKey: apiKey!, model: model! };
}

function remoteServer([host, port]: string[]): ServerChoice {
  if (host!.trim() === "" || /\s/u.test(host!)) throw new UsageError("The server address must not be empty or hold spaces.");
  return { kind: "remote", host: host!, port: parsePort(port!) };
}

function applyChoices(settings: Settings, choices: Choices, manifest: Manifest, deps: ConfigureDeps): Settings {
  const next = { ...settings };
  if (choices.llm) next.llm = choices.llm.kind === "local" ? { kind: "local", model: manifest.ollama.model } : choices.llm;
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
  try {
    saveSettings(context.root, applyChoices(loadSettings(context.root, manifest), choices, manifest, deps));
  } catch (error) {
    context.err((error as Error).message);
    return 1;
  }
  context.out(`Saved ${settingsPath(context.root)}`);
  return 0;
}
