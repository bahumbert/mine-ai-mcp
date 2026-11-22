// A disk for the install steps' tests: which folders exist, how many bytes each drive has free, which drive a path is on.
import type { DiskDeps } from "../disk.ts";

export type FakeDisk = DiskDeps & { statfsCalls: string[] };

/**
 * A disk where the `existing` folders exist and the longest `roots` prefix of a path (case ignored) says how many bytes are
 * free there (no prefix: the ENOENT of a drive that is not there). Off Windows the `dev` number is the longest `devs` prefix.
 */
export function fakeDisk(options: { platform: NodeJS.Platform; existing: string[]; roots: Record<string, number>; devs?: Record<string, string> }): FakeDisk {
  const statfsCalls: string[] = [];
  const longestPrefix = (keys: string[], path: string, ignoreCase: boolean) =>
    keys.filter((key) => (ignoreCase ? path.toUpperCase().startsWith(key.toUpperCase()) : path.startsWith(key))).sort((a, b) => b.length - a.length)[0];
  return {
    platform: options.platform,
    statfsCalls,
    exists: (path) => options.existing.includes(path),
    statfs: async (path) => {
      statfsCalls.push(path);
      const root = longestPrefix(Object.keys(options.roots), path, true);
      if (root === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, statfs '${path}'`), { code: "ENOENT" });
      return { bavail: BigInt(Math.floor(options.roots[root])), bsize: 1n };
    },
    dev: (path) => options.devs?.[longestPrefix(Object.keys(options.devs ?? {}), path, false) ?? ""] ?? "0",
  };
}

/** A disk where every folder exists on one drive with 1000 GiB free: for tests that are not about space (their steps still read it). */
export function diskWithRoomForAnything(): FakeDisk {
  const statfsCalls: string[] = [];
  return {
    platform: process.platform,
    statfsCalls,
    exists: () => true,
    statfs: async (path) => {
      statfsCalls.push(path);
      return { bavail: 1000n * 1024n ** 3n, bsize: 1n };
    },
    dev: () => "0",
  };
}

/**
 * Two drives on whatever platform the test runs on: the one `dataFolder` (a real temp folder) is on, and another that holds
 * `otherFolder(...)` paths. On Windows the other drive is `Z:` (the data folder's letter is the machine's); elsewhere a second device.
 */
export function twoDrives(dataFolder: string, free: { data: number; other: number }): { disk: FakeDisk; otherFolder(...parts: string[]): string } {
  if (process.platform === "win32") {
    return { disk: fakeDisk({ platform: "win32", existing: [dataFolder, "Z:\\"], roots: { [dataFolder]: free.data, "Z:": free.other } }), otherFolder: (...parts) => ["Z:", ...parts].join("\\") };
  }
  const other = `${dataFolder}-other-drive`;
  return {
    disk: fakeDisk({ platform: process.platform, existing: [dataFolder, other], roots: { [dataFolder]: free.data, [other]: free.other }, devs: { [dataFolder]: "data", [other]: "other" } }),
    otherFolder: (...parts) => [other, ...parts].join("/"),
  };
}
