/**
 * The protected regions the other bots of this world keep in their own bot-data files (ADR-012), read-only, so every
 * bot respects every other bot's builds. Layout: `<root>/<world>/bots/<bot>/bot-data.sqlite` (sql-bot-data.ts).
 *
 * The host thread runs physics, so a read never waits and never takes a write lock: a file is opened `readOnly` with
 * `busy_timeout = 0`, read once and closed, and only when it changed since its last read (its own or its `-wal` mtime or
 * size: in WAL mode commits land in the `-wal` file). Nothing here can block the writer: WAL readers do not. (Opening
 * the file of a bot that has closed creates its `-wal` and `-shm` files once.) A read never throws: a file or folder
 * that cannot be read keeps the last list.
 */
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProtectedRegion } from "../world/protected-regions.js";
import { PROTECTED_REGION_COLUMNS, parseRegion } from "./protected-regions.js";

/** A region is made before its build starts and a build takes minutes: a few seconds of delay costs nothing. */
export const PEER_REGION_REFRESH_MS = 5_000;

const BOT_DATA_FILE = "bot-data.sqlite";
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

/** Reads every region of one bot-data file as a peer's region. Throws what SQLite throws (busy, no table, corrupt). */
export function readPeerRegionFile(file: string): readonly ProtectedRegion[] {
  const database = new DatabaseSync(file, { readOnly: true, allowExtension: false, enableDoubleQuotedStringLiterals: false });
  try {
    database.exec("PRAGMA busy_timeout = 0");
    const rows = database.prepare(`SELECT ${PROTECTED_REGION_COLUMNS} FROM protected_regions ORDER BY region_id`).all();
    return rows.map((row) => parseRegion(row, null));
  } finally {
    database.close();
  }
}

type FailureKind = "busy" | "missing_table" | "unreadable";

function failureKind(error: unknown): FailureKind {
  const { errcode, message } = error as { errcode?: unknown; message?: unknown };
  const text = typeof message === "string" ? message : "";
  if (errcode === SQLITE_BUSY || errcode === SQLITE_LOCKED || /locked|busy/i.test(text)) return "busy";
  if (/no such table/i.test(text)) return "missing_table";
  return "unreadable";
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

const sameRegions =(left: readonly ProtectedRegion[], right: readonly ProtectedRegion[]) =>
  left.length === right.length && left.every((region, index) => JSON.stringify(region) === JSON.stringify(right[index]));

interface PeerFile {
  readonly signature: string;
  readonly regions: readonly ProtectedRegion[];
}

/**
 * `mtime:size` of a file and its `-wal`: what changes when the file is written; null when there is no such file. A stat
 * that fails otherwise (no permission) is its own signature, so the open that follows fails too and keeps the last list.
 */
function signatureOf(file: string): string | null {
  try {
    const main = statSync(file, { throwIfNoEntry: false });
    if (main === undefined) return null;
    const wal = statSync(`${file}-wal`, { throwIfNoEntry: false });
    return `${main.mtimeMs}:${main.size}|${wal?.mtimeMs ?? 0}:${wal?.size ?? 0}`;
  } catch (error) {
    return `unreadable:${(error as { code?: unknown }).code ?? "error"}`;
  }
}

export class PeerRegionReader {
  readonly #ownFile: string;
  readonly #log: (line: string) => void;
  readonly #open: (file: string) => readonly ProtectedRegion[];
  readonly #files = new Map<string, PeerFile>();
  /** `<file>|<kind>` of each failure already logged, so one broken file says it once. */
  readonly #logged = new Set<string>();
  #combined: readonly ProtectedRegion[] = Object.freeze([]);

  /** `open` is injectable so tests can make a read fail the way a busy file does. */
  constructor(ownFile: string, log: (line: string) => void, open: (file: string) => readonly ProtectedRegion[] = readPeerRegionFile) {
    this.#ownFile = path.resolve(ownFile);
    this.#log = log;
    this.#open = open;
  }

  /**
   * The other bots' regions as of now: the bot folders are listed again at each call (a bot may appear after start),
   * only a changed file is opened. The array is the same one until a region changed, so a caller compares identity.
   */
  read(): readonly ProtectedRegion[] {
    const present = this.#siblingFiles();
    // A folder that cannot be listed says nothing about the peers: only a deleted file drops its list.
    if (present === null) return this.#combined;
    let changed = false;
    for (const file of [...this.#files.keys()]) {
      if (present.some((candidate) => candidate.file === file)) continue;
      this.#files.delete(file);
      this.#forget(file);
      changed = true;
    }
    for (const { file, signature } of present) {
      const known = this.#files.get(file);
      if (known?.signature === signature) continue;
      changed = this.#reload(file, signature, known) || changed;
    }
    if (changed) this.#combined = Object.freeze([...this.#files.values()].flatMap((entry) => entry.regions));
    return this.#combined;
  }

  /** True when the file's list differs from the last one. A busy or broken file keeps its last list. */
  #reload(file: string, signature: string, known: PeerFile | undefined): boolean {
    try {
      const regions = this.#open(file);
      this.#forget(file);
      const unchanged = known !== undefined && sameRegions(known.regions, regions);
      this.#files.set(file, { signature, regions: unchanged ? known.regions : regions });
      return !unchanged;
    } catch (error) {
      const kind = failureKind(error);
      this.#sayOnce(file, kind, `cannot read the regions of ${path.basename(path.dirname(file))} (${kind}): ${describe(error)}; its last list stays.`);
      // A busy file is read again at the next read; one with no table or a corrupt page stays as it is until it changes.
      if (kind !== "busy") this.#files.set(file, { signature, regions: known?.regions ?? [] });
      return false;
    }
  }

  /** Logs a failure once per subject and kind: a broken file or folder says it, not every 5 s. */
  #sayOnce(subject: string, kind: string, line: string): void {
    const key = `${subject}|${kind}`;
    if (this.#logged.has(key)) return;
    this.#logged.add(key);
    this.#log(`[minecraft-peer-regions] ${line}`);
  }

  /** The subject read well again: its next failure is news. */
  #forget(subject: string): void {
    for (const key of [...this.#logged]) if (key.startsWith(`${subject}|`)) this.#logged.delete(key);
  }

  /** The sibling files with their signatures; null when the folder cannot be listed (a missing folder has no siblings). */
  #siblingFiles(): { readonly file: string; readonly signature: string }[] | null {
    const botsDirectory = path.dirname(path.dirname(this.#ownFile));
    let entries: string[];
    try {
      entries = readdirSync(botsDirectory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") return [];
      this.#sayOnce(botsDirectory, "listing", `cannot list ${botsDirectory}: ${describe(error)}; the peers' last lists stay.`);
      return null;
    }
    this.#forget(botsDirectory);
    return entries.flatMap((name) => {
      const file = path.join(botsDirectory, name, BOT_DATA_FILE);
      if (file === this.#ownFile) return [];
      const signature = signatureOf(file);
      return signature === null ? [] : [{ file, signature }];
    });
  }
}
