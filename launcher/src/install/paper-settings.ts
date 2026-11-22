/**
 * Applies `packaging/paper-settings.json` (spec 2026-11-14 D2) to a Paper server folder: for each config file, parse the
 * YAML Paper wrote, merge our keys over it, write it back. Imports only `node:` modules and the `Bun` global, so the
 * private scripts and Docker run it without the launcher's packages.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Paper config file (path relative to the server folder) -> a nested object of the keys we set. */
export type PaperSettings = Readonly<Record<string, Record<string, unknown>>>;

type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject => typeof value === "object" && value !== null && !Array.isArray(value);

/** The first problem of a value as `"<dotted path>: <reason>"`, or undefined when it is a JSON scalar, array or object of those. */
function findBadValue(value: unknown, path: string[]): string | undefined {
  const where = path.join(".");
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const bad = findBadValue(item, [...path, String(index)]);
      if (bad) return bad;
    }
    return undefined;
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (key === "__proto__") return `${[...path, key].join(".")}: this key is not allowed`;
      const bad = findBadValue(child, [...path, key]);
      if (bad) return bad;
    }
    return undefined;
  }
  if (typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return undefined;
  return `${where}: expected a string, number, boolean, array or object, got ${value === null ? "null" : typeof value}`;
}

/** Throws naming the file (`source`) and the key path of the first value that is not settings-shaped. */
function assertSettingsShape(settings: unknown, source: string): asserts settings is PaperSettings {
  if (!isPlainObject(settings)) throw new Error(`Invalid Paper settings ${source}: (root): expected an object of config files`);
  for (const [file, keys] of Object.entries(settings)) {
    if (!isPlainObject(keys)) throw new Error(`Invalid Paper settings ${source}: ${file}: expected an object of keys`);
    const bad = findBadValue(keys, []);
    if (bad) throw new Error(`Invalid Paper settings ${source}: ${file}: ${bad}`);
  }
}

/** Reads and validates a settings file; every failure names the file and, for a bad shape, the config file and key path. */
export function loadPaperSettings(path: string): PaperSettings {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read the Paper settings ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  assertSettingsShape(raw, path);
  return raw;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

/** 12 lowercase hex digits: sha256 of the settings' JSON with keys sorted at every level (the run JSON names them). */
export function paperSettingsDigest(settings: PaperSettings): string {
  return createHash("sha256").update(JSON.stringify(sortKeys(settings))).digest("hex").slice(0, 12);
}

/** The absolute path of a config file, refused when it is not inside the server folder. */
function configFilePath(serverDir: string, file: string): string {
  const root = resolve(serverDir);
  const target = resolve(root, file);
  const inside = relative(root, target);
  const escapes = inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
  if (file === "" || isAbsolute(file) || inside === "" || escapes) {
    throw new Error(`Paper settings file ${file} is outside the server folder ${serverDir}: use a path inside it (for example config/paper-world-defaults.yml).`);
  }
  if (file.includes("\0")) throw new Error(`Paper settings file ${JSON.stringify(file)} is not a valid file path: remove the NUL character.`);
  return target;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

/** Merges `ours` over `existing` in place; objects key by key, every other value replaced. Returns the dotted keys changed. */
function mergeInto(existing: PlainObject, ours: PlainObject, path: string[], file: string): string[] {
  const changed: string[] = [];
  for (const [key, value] of Object.entries(ours)) {
    const here = [...path, key];
    const current = Object.hasOwn(existing, key) ? existing[key] : undefined;
    if (!isPlainObject(value)) {
      if (!sameValue(current, value)) {
        existing[key] = value;
        changed.push(here.join("."));
      }
      continue;
    }
    if (current === undefined || current === null) existing[key] = {};
    else if (!isPlainObject(current)) {
      throw new Error(`Paper settings ${file}: ${here.join(".")} holds ${JSON.stringify(current)}, not an object: fix or delete that key in the file, then start again.`);
    }
    const before = changed.length;
    changed.push(...mergeInto(existing[key] as PlainObject, value, here, file));
    if (changed.length === before && current === undefined) delete existing[key];
  }
  return changed;
}

function readExisting(path: string, file: string): PlainObject {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse the Paper config ${file} (${path}): ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isPlainObject(parsed)) throw new Error(`Paper config ${file} (${path}) is not a YAML mapping: delete it to let Paper write a new one.`);
  return parsed;
}

/**
 * Merges `settings` into the config files of `serverDir` (a missing file is created from our keys alone) and returns
 * `"<file>: <dotted key>"` for each key whose value changed, in file then key order. Nothing is written unless every
 * file merges; a file with no change is left as Paper wrote it (comments kept; a written file loses them).
 */
export async function applyPaperSettings(serverDir: string, settings: PaperSettings): Promise<string[]> {
  assertSettingsShape(settings, "(given settings)");
  const pending: { path: string; document: PlainObject }[] = [];
  const changed: string[] = [];
  for (const [file, keys] of Object.entries(settings)) {
    const path = configFilePath(serverDir, file);
    const document = readExisting(path, file);
    const fileChanged = mergeInto(document, keys, [], file);
    changed.push(...fileChanged.map((key) => `${file}: ${key}`));
    if (fileChanged.length > 0) pending.push({ path, document });
  }
  for (const { path, document } of pending) {
    await mkdir(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.${process.pid}.paper-settings.tmp`);
    try {
      await writeFile(temporary, Bun.YAML.stringify(document, null, 2) + "\n");
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
  return changed;
}
