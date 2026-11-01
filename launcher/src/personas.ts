// The bots a player can start: one persona file per bot in `<root>/personas` (Rule #0: the folder is the list).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PLAYER_NAME } from "./chat/parse.ts";

export interface PersonaEntry {
  /** The file name without `.json`. */
  readonly id: string;
  /** The in-game name the bot logs in with. */
  readonly username: string;
  readonly path: string;
}

function readPersonaEntry(folder: string, file: string): PersonaEntry | null {
  const path = join(folder, file);
  try {
    const username = (JSON.parse(readFileSync(path, "utf8")) as { username?: unknown } | null)?.username;
    return typeof username === "string" && PLAYER_NAME.test(username) ? { id: file.slice(0, -".json".length), username, path } : null;
  } catch {
    return null;
  }
}

/** Every `<root>/personas/*.json` holding a valid string username, sorted by id; files that are no persona are skipped. */
export function listPersonas(root: string): PersonaEntry[] {
  const folder = join(root, "personas");
  let files: string[];
  try {
    files = readdirSync(folder);
  } catch {
    return [];
  }
  return files
    .filter((file) => file.endsWith(".json"))
    .flatMap((file) => readPersonaEntry(folder, file) ?? [])
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The persona whose id, else whose username, is `name`, without case. Compares only: a name from chat never builds a path. */
export function findPersona(personas: readonly PersonaEntry[], name: string): PersonaEntry | null {
  const wanted = name.toLowerCase();
  return personas.find((persona) => persona.id.toLowerCase() === wanted) ?? personas.find((persona) => persona.username.toLowerCase() === wanted) ?? null;
}
