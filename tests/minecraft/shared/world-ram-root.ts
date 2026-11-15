// A lane server's root in RAM (spec 2026-11-15-scenario-disk-stalls D1, 3.1): the template copy, the chunk saves and the stop's save of a lane server go to a tmpfs
// directory, so a batch's 16 copies of 436 MB never reach the disk. Only `logs/` is a link back to the disk root, so the server logs outlive the root.
import { mkdir, rm, statfs } from "node:fs/promises";
import { join } from "node:path";

const BYTES_PER_MB = 1024 * 1024;

/** A server root made in RAM: the directory to start the server in, and its removal (the stop's, which frees the RAM). */
export interface RamRoot {
  readonly root: string;
  remove(): Promise<void>;
}

export interface RamRootInput {
  /** The daemon's directory of RAM roots; made if missing. */
  readonly ramDir: string;
  /** The root's own name under `ramDir`. */
  readonly name: string;
  readonly id: string;
  /** The disk directory the root's `logs/` points at. */
  readonly diskLogs: string;
  /** What the root's world will hold at least (the template's size), MB. */
  readonly needMb: number;
  readonly symlink: (target: string, path: string) => Promise<void>;
  readonly log: (message: string) => void;
}

/**
 * Makes the RAM root of one server with `logs/` linked to the disk. Null (the caller starts a disk root as before, the log says why) when the RAM dir has
 * less than `needMb` free, or when any step fails (no room to make a directory, a link refused): a RAM step costs the RAM root, never the server.
 * The free-space check is the template's size only; the RAM itself is shared with the JVMs and is the admission ledger's concern.
 */
export async function makeRamRoot(input: RamRootInput): Promise<RamRoot | null> {
  const { ramDir, id, log } = input;
  const root = join(ramDir, input.name);
  try {
    await mkdir(ramDir, { recursive: true });
    const space = await statfs(ramDir);
    const freeMb = Math.floor(space.bavail * space.bsize / BYTES_PER_MB);
    if (freeMb < input.needMb) {
      log(`world in RAM skipped for ${id}: ${freeMb} MB free in ${ramDir}, ${input.needMb} MB needed`);
      return null;
    }
    await mkdir(root, { recursive: true });
    await mkdir(input.diskLogs, { recursive: true });
    await input.symlink(input.diskLogs, join(root, "logs"));
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    log(`world in RAM failed for ${id}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  // `rm` of a link removes the link, never the disk logs it points at.
  return { root, remove: () => rm(root, { recursive: true, force: true }) };
}
