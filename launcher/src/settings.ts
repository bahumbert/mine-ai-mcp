import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { dpapiCipher, type KeyCipher } from "./dpapi.ts";
import { keyMigrationLine, llmForFile, llmFromFile } from "./secret.ts";

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
const localLlmSchema = z.looseObject({ kind: z.literal("local"), model: z.string().min(1) });
const remoteLlmShape = { kind: z.literal("remote"), baseUrl: z.string().min(1), model: z.string().min(1) };
/** `llm` as settings.json holds it: a remote key is clear (`apiKey`) or encrypted (`apiKeyProtected`), or neither (spec D3 "Two types"). */
const llmFileSchema = z.discriminatedUnion("kind", [
  localLlmSchema,
  z.looseObject({ ...remoteLlmShape, apiKey: z.string().optional(), apiKeyProtected: z.string().optional() }),
]);
/** `llm` in memory: a remote key is always the clear string, so the brain's environment and the endpoint test need no change. */
const llmSchema = z.discriminatedUnion("kind", [
  localLlmSchema,
  z.looseObject({
    ...remoteLlmShape,
    apiKey: z.string(),
    apiKeyProtected: z.string().optional(),
    loadedKey: z.string().optional(),
    keyUnreadable: z.boolean().optional(),
    clearKeyInFile: z.boolean().optional(),
  }),
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

const settingsShape = {
  server: serverSchema,
  bots: z.array(personaId),
  hostBasePort: port,
  controlPort: port,
  checkUpdates: z.boolean(),
  commands: commandsSchema.prefault({}),
};
/** The file form: what `loadSettings` parses. */
const settingsFileSchema = z.looseObject({ llm: llmFileSchema, ...settingsShape });
/** The in-memory form every other module gets (`Settings`). */
const settingsSchema = z.looseObject({ llm: llmSchema, ...settingsShape });
export type Settings = z.infer<typeof settingsSchema>;

/** How the key is protected: the OS (`platform` decides the file mode) and the cipher for it, or none. Tests pass fakes. */
export interface SettingsOptions {
  readonly platform: NodeJS.Platform;
  readonly cipher: KeyCipher | null;
}

/** DPAPI on Windows; elsewhere no cipher: the key stays in clear and the file is mode 600 (spec D3, Open choice 2). */
export function realSettingsOptions(): SettingsOptions {
  return { platform: process.platform, cipher: process.platform === "win32" ? dpapiCipher() : null };
}

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
 * path and the first issue, and is never replaced. A remote key comes back clear; one that cannot be decrypted (another
 * Windows user or PC) comes back empty with `keyUnreadable`, never as an error.
 */
export function loadSettings(root: string, manifest: ManifestDefaults, options: SettingsOptions = realSettingsOptions()): Settings {
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
  const parsed = settingsFileSchema.safeParse({ ...defaults, ...raw });
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw invalidFile(file, `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  return { ...parsed.data, llm: llmFromFile(parsed.data.llm, options.cipher) };
}

/**
 * Writes the settings whole (unknown keys included) through a temporary file, so a crash never leaves half a file.
 * On Windows the remote key is written encrypted; elsewhere in clear, and the file is mode 600 (a temporary file made
 * with it, and `chmod` after the rename for a file that was wider before).
 */
export function saveSettings(root: string, settings: Settings, options: SettingsOptions = realSettingsOptions()): void {
  mkdirSync(root, { recursive: true });
  const file = settingsPath(root);
  const temporary = `${file}.tmp`;
  const text = `${JSON.stringify({ ...settings, llm: llmForFile(settings.llm, options.cipher) }, null, 2)}\n`;
  const ownerOnly = options.platform !== "win32";
  writeFileSync(temporary, text, ownerOnly ? { mode: 0o600 } : undefined);
  renameSync(temporary, file);
  if (ownerOnly) chmodSync(file, 0o600);
}

/** The line to say after a save encrypted a key that was in clear (these settings, as loaded, carry `clearKeyInFile`), else null. */
export function clearKeyMigrationLine(root: string, settings: Settings): string | null {
  if (settings.llm.kind !== "remote" || settings.llm.clearKeyInFile !== true) return null;
  return keyMigrationLine(settingsPath(root), userInfo().username);
}
