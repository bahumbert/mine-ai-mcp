/**
 * Developer tool: writes `src/world/data/combat-data/<version>.json`, the mob and item combat numbers `combat-data.ts`
 * serves. The numbers are measured on the real server by the Mine Labs checks `combat-data-mobs` and
 * `combat-data-items-*` (each logs a `MEASURED <json>` line when it runs); the jar adds the damage types.
 *
 * Usage: `bun src/world/combat-data-write.ts <server.jar> <version> <scenario log>...`
 * The logs are the ones `scenario-repeat.sh` leaves (`.tmp/scenario-repeat/<tag>-1.log`). Run once per measured version
 * and commit the file; the runtime never reads a jar or a log.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { CombatDataFile, MeasuredItemAttack, MeasuredMob, MeasuredPart } from "./combat-data-file.js";
import { extractDamageTypes } from "./damage-types-extract.js";

const MEASURED_MARK = "MEASURED ";

/** The JSON object that starts at `from` (balanced braces, strings skipped); throws when the text ends inside it. */
function objectTextAt(text: string, from: number): string {
  let depth = 0;
  let inString = false;
  for (let index = from; index < text.length; index += 1) {
    const char = text[index]!;
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) return text.slice(from, index + 1);
  }
  throw new Error(`${MEASURED_MARK}line cut off: ${text.slice(from, from + 80)}`);
}

/** Every `MEASURED <json>` object in a scenario log, in order; a cut-off or invalid one throws (a partial measurement must not be shipped). */
export function parseMeasuredLines(log: string): MeasuredPart[] {
  const parts: MeasuredPart[] = [];
  let at = log.indexOf(MEASURED_MARK);
  while (at >= 0) {
    const start = at + MEASURED_MARK.length;
    parts.push(JSON.parse(objectTextAt(log, start)) as MeasuredPart);
    at = log.indexOf(MEASURED_MARK, start);
  }
  return parts;
}

const sorted = <T>(record: Readonly<Record<string, T>>): Record<string, T> =>
  Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/** Add `entries` to `into`; a key already there with another value throws naming it (two runs disagreeing is a flake, not data). */
function unite<T>(into: Record<string, T>, entries: Readonly<Record<string, T>> | undefined, what: string): void {
  for (const [key, value] of Object.entries(entries ?? {})) {
    if (key in into && JSON.stringify(into[key]) !== JSON.stringify(value)) throw new Error(`${what} ${key}: measured twice with different numbers`);
    into[key] = value;
  }
}

/**
 * Add the mobs of one run to those of the runs before. A field that differs between two runs varies like one that differs
 * between two copies in a run (a slime's size, a horse's genes): it becomes null and is listed, so a species whose copies
 * happened to agree in one run is still marked by another.
 */
export function uniteMobs(into: Record<string, MeasuredMob>, varies: Record<string, Set<string>>, mobs: Readonly<Record<string, MeasuredMob>> | undefined): void {
  for (const [species, mob] of Object.entries(mobs ?? {})) {
    const before = into[species];
    if (before === undefined) {
      into[species] = mob;
      continue;
    }
    const merged: Record<string, unknown> = { ...before };
    for (const field of Object.keys(mob) as (keyof MeasuredMob)[]) {
      if (JSON.stringify(before[field]) === JSON.stringify(mob[field])) continue;
      merged[field] = null;
      (varies[species] ??= new Set()).add(field);
    }
    into[species] = merged as unknown as MeasuredMob;
  }
}

/** The file from the parts the checks logged and the jar's damage types. */
export function mergeCombatData(version: string, parts: readonly MeasuredPart[], damageTypes: Readonly<Record<string, { scaling: string }>>): CombatDataFile {
  const mobs: Record<string, MeasuredMob> = {};
  const items: Record<string, MeasuredItemAttack> = {};
  const varying: Record<string, Set<string>> = {};
  const skipped = new Set<string>();
  let bareHand: MeasuredItemAttack | undefined;
  for (const part of parts) {
    uniteMobs(mobs, varying, part.mobs);
    unite(items, part.items, "attack of");
    for (const [species, fields] of Object.entries(part.varies ?? {})) for (const field of fields) (varying[species] ??= new Set()).add(field);
    for (const species of part.skipped ?? []) skipped.add(species);
    if (part.bareHand === undefined) continue;
    if (bareHand !== undefined && JSON.stringify(bareHand) !== JSON.stringify(part.bareHand)) throw new Error("bare hand measured twice with different numbers");
    bareHand = part.bareHand;
  }
  if (bareHand === undefined) throw new Error("no bare hand measured: the item check's log is missing");
  return {
    version,
    bareHand,
    mobs: sorted(mobs),
    items: sorted(items),
    damageTypes: sorted(damageTypes),
    varies: sorted(Object.fromEntries(Object.entries(varying).map(([species, fields]) => [species, [...fields].sort()]))),
    skipped: [...skipped].sort(),
  };
}

/** The version argument names the output file, so only a game version (`1.21.4`, `1.21`) passes; anything else throws. */
export function gameVersionArgument(version: string): string {
  if (!/^\d+\.\d+(\.\d+)?$/u.test(version)) throw new Error(`not a game version: ${JSON.stringify(version)} (expected 1.21.4 or 1.21)`);
  return version;
}

if (import.meta.main) {
  const [jar, versionArgument, ...logs] = process.argv.slice(2);
  if (jar === undefined || versionArgument === undefined || logs.length === 0) {
    console.log("Usage: bun src/world/combat-data-write.ts <server.jar> <version> <scenario log>...");
    process.exit(2);
  }
  const version = gameVersionArgument(versionArgument);
  const parts = logs.flatMap((path) => parseMeasuredLines(readFileSync(path, "utf8")));
  const file = mergeCombatData(version, parts, extractDamageTypes(new Uint8Array(readFileSync(jar))));
  const target = new URL(`./data/combat-data/${version}.json`, import.meta.url);
  writeFileSync(target, `${JSON.stringify(file)}\n`);
  console.log(`${Object.keys(file.mobs).length} mobs, ${Object.keys(file.items).length} items, ${Object.keys(file.damageTypes).length} damage types written to ${target.pathname}`);
}
