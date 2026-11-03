import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

const port = z.number().int().min(1).max(65_535);
/** A persona id names `<root>/personas/<id>.json`: no folder part, no hidden file. */
const personaId = z.string().regex(/^[^\\/:\0.][^\\/:\0]*$/u, "a persona id is a file name without a folder part");
/** True when `id` is a persona id the settings accept; the chat commands list personas with the same rule. */
export const isPersonaId = (id: string): boolean => personaId.safeParse(id).success;

/** A Minecraft account name allowed to give chat commands, or the listener's: 3 to 16 letters, digits or underscores. */
export const COMMAND_PLAYER_NAME = /^[A-Za-z0-9_]{3,16}$/u;
const commandPlayer = z.string().regex(COMMAND_PLAYER_NAME, "a player name is 3 to 16 letters, digits or underscores");
/**
 * One to three visible characters, never `/` (a line starting with `/` would reach the console as a command of its own),
 * never `§` or a control character (an answer that shows the prefix is a whisper, and a host refuses those characters in one),
 * never a letter or digit (a brain hides a command line from the model: `ro` would hide `Robots`).
 */
const commandPrefix = z.string().regex(/^[^\s/§\p{Cc}\p{L}\p{N}]{1,3}$/u, "the prefix is 1 to 3 symbols: no letter, no digit, no space, no control character, not / and not §");

/** Every object is loose: a key this version does not know (a newer launcher's, a note of the player) is kept on save. */
const llmSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("local"), model: z.string().min(1) }),
  z.looseObject({ kind: z.literal("remote"), baseUrl: z.string().min(1), apiKey: z.string(), model: z.string().min(1) }),
]);
const serverSchema = z.discriminatedUnion("kind", [
  z.looseObject({ kind: z.literal("none") }),
  z.looseObject({ kind: z.literal("local"), port, memoryMb: z.number().int().min(512) }),
  z.looseObject({ kind: z.literal("remote"), host: z.string().min(1), port }),
]);

/** In-game bot commands (`!bots`, `!bot start <name>`); each key has its default, so a file may hold any of them. */
const commandsSchema = z.looseObject({
  enabled: z.boolean().default(true),
  prefix: commandPrefix.default("!"),
  players: z.array(commandPlayer).default([]),
  listenerName: commandPlayer.default("MineAI"),
});

export const settingsSchema = z.looseObject({
  llm: llmSchema,
  server: serverSchema,
  bots: z.array(personaId),
  hostBasePort: port,
  controlPort: port,
  checkUpdates: z.boolean(),
  commands: commandsSchema.prefault({}),
});
export type Settings = z.infer<typeof settingsSchema>;

/** What the settings defaults need from the manifest (`manifest.ts` satisfies it). */
export interface ManifestDefaults {
  readonly ollama: { readonly model: string };
  readonly defaultBots: readonly string[];
}

export const settingsPath = (root: string): string => join(root, "settings.json");

/**
 * True when `<root>/settings.json` exists. `loadSettings` gives the defaults for a missing file with no word; the console
 * and the start line use this to tell the player which folder was read when nothing was there (a setup that wrote its
 * settings to another view of the folder, spec "MSIX split").
 */
export const settingsFileExists = (root: string): boolean => existsSync(settingsPath(root));

function defaultSettings(manifest: ManifestDefaults): Settings {
  return {
    llm: { kind: "local", model: manifest.ollama.model },
    server: { kind: "none" },
    bots: [...manifest.defaultBots],
    hostBasePort: 25_575,
    controlPort: 25_599,
    checkUpdates: true,
    commands: commandsSchema.parse({}),
  };
}

function invalidFile(file: string, reason: string): Error {
  return new Error(`${file} is invalid: ${reason}. The file was not changed: fix it, or delete it to get the defaults back.`);
}

/**
 * The settings in `<root>/settings.json`; keys the file lacks take the defaults (bots and model from the manifest).
 * A missing file gives the defaults and writes nothing. A file that does not parse or fails the schema throws with its
 * path and the first issue, and is never replaced.
 */
export function loadSettings(root: string, manifest: ManifestDefaults): Settings {
  const file = settingsPath(root);
  const defaults = defaultSettings(manifest);
  if (!settingsFileExists(root)) return defaults;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw invalidFile(file, `not valid JSON (${(error as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw invalidFile(file, "it must hold a JSON object");
  const parsed = settingsSchema.safeParse({ ...defaults, ...raw });
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw invalidFile(file, `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  return parsed.data;
}

/** Writes the settings whole (unknown keys included) through a temporary file, so a crash never leaves half a file. */
export function saveSettings(root: string, settings: Settings): void {
  mkdirSync(root, { recursive: true });
  const file = settingsPath(root);
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(temporary, file);
}
