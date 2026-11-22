/**
 * Points `os.tmpdir()` at tmpfs for the test run: when `TMPDIR` is unset and `/dev/shm` is a writable folder, sets
 * `TMPDIR` to this user's folder `/dev/shm/mine-ai-tests-<uid>` (mode 0700). Tests make their fixture folders with
 * `tmpdir()`; on this machine (WSL2, ext4 root) that is a disk folder, and the disk flush of a database's checkpoint
 * missed its bound under load (spec D5, `src/bot-data/wal-checkpointer.test.ts`). Bun reads `TMPDIR` at each
 * `os.tmpdir()` call, and a child process a test spawns inherits it.
 *
 * Loaded by `bunfig.toml` (`[test] preload`), so it runs before any test file. A `TMPDIR` already set is left alone;
 * a machine with no writable `/dev/shm` keeps `tmpdir()`. A folder at the place of the user's folder that is not a
 * real folder of this user (a symlink, another owner) is not used.
 *
 * Under `scripts/` for the Bun types, as `test-limit.ts` is.
 */
import { accessSync, chmodSync, constants, lstatSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";

export const TEST_TMPFS_DIRECTORY = "/dev/shm";
const USER_FOLDER_MODE = 0o700;

export interface TmpfsOptions {
  /** The tmpfs folder; the test sets another one. */
  directory?: string;
  /** The user id in the folder name; the test sets one. */
  uid?: number;
}

export function isWritableDirectory(directory: string): boolean {
  try {
    accessSync(directory, constants.W_OK);
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/** This user's folder inside `directory`, created at mode 0700, or undefined when a real one cannot be had there. */
function ensureUserFolder(directory: string, uid: number): string | undefined {
  const folder = path.join(directory, `mine-ai-tests-${uid}`);
  try {
    mkdirSync(folder, { mode: USER_FOLDER_MODE });
  } catch {
    // It exists already (an earlier run); checked below.
  }
  try {
    const entry = lstatSync(folder);
    if (!entry.isDirectory() || entry.uid !== uid) return undefined;
    if ((entry.mode & 0o777) !== USER_FOLDER_MODE) chmodSync(folder, USER_FOLDER_MODE);
    return folder;
  } catch {
    return undefined;
  }
}

/**
 * Sets `env.TMPDIR` to the user's tmpfs folder when `TMPDIR` is unset. Returns that folder, or undefined when it left
 * `env` as it was.
 */
export function useTmpfsForTests(env: Record<string, string | undefined>, options: TmpfsOptions = {}): string | undefined {
  if (env.TMPDIR !== undefined) return undefined;
  const directory = options.directory ?? TEST_TMPFS_DIRECTORY;
  if (!isWritableDirectory(directory)) return undefined;
  const folder = ensureUserFolder(directory, options.uid ?? process.getuid?.() ?? 0);
  if (folder === undefined) return undefined;
  env.TMPDIR = folder;
  return folder;
}

useTmpfsForTests(process.env);
