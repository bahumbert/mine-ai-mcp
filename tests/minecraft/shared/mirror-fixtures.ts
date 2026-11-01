// Shared set-up of the scenario mirror's tests: a source root, a mirror over a temp dir with the real rsync (or a fake `run`), and the snapshot directories prune reads.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ScenarioMirror, type MirrorPorts } from "./mirror.ts";
import type { ModulesState } from "./mirror-modules.ts";
import { rootSlug } from "./source-root.ts";
import { runBounded } from "./run-bounded.ts";

export const SYNC_BOUND_MS = 30_000;
export const DAEMON_SLUG = "daemon-a";

export function write(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

export async function withTemp(body: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "mirror-"));
  try { await body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** A worktree-shaped source root: `bun.lock` at its top, a client directory and a few source files. */
export function makeSourceRoot(dir: string, name = "root"): string {
  const root = join(dir, name);
  write(join(root, "bun.lock"), "lock v1");
  write(join(root, "package.json"), '{"name":"x"}');
  write(join(root, "src", "a.ts"), "export const a = 1;");
  write(join(root, "src", "b.ts"), "export const b = 1;");
  write(join(root, "tests", "minecraft", "client-host.ts"), "export {};");
  return root;
}

/** `/proc/mounts` text that puts everything under `nineP` on a 9P mount and the rest on ext4, as `/mnt/d` and `/` are in WSL. */
export function mountsWithNineP(nineP: string): string {
  return `drvfs ${nineP} 9p rw 0 0\n/dev/sdc / ext4 rw 0 0\n`;
}

export interface MirrorHarness {
  readonly mirror: ScenarioMirror;
  readonly lines: string[];
  readonly mirrorDir: string;
  /** The modules tree the fake `modulesFor` answers ready with. */
  readonly nodeModules: string;
  readonly pruned: ReadonlySet<string>[];
}

/** The real `run` (rsync), `/mnt/d`-like mounts (the temp dir is 9P), a ready modules tree under the temp dir; `overrides` replace any port. */
export function makeMirror(dir: string, overrides: Partial<MirrorPorts> = {}, options: { daemonSlug?: string; enabled?: boolean; syncBoundMs?: number; slowSyncNoticeMs?: number } = {}): MirrorHarness {
  const lines: string[] = [];
  const pruned: ReadonlySet<string>[] = [];
  const nodeModules = join(dir, "modules", "node_modules");
  mkdirSync(join(nodeModules, "mine-labs"), { recursive: true });
  const ports: MirrorPorts = {
    run: runBounded,
    mounts: () => mountsWithNineP(dir),
    modulesFor: (): ModulesState => ({ state: "ready", hash: "hash-1", nodeModules }),
    pruneModules: async linked => { pruned.push(linked); return []; },
    now: () => performance.timeOrigin + performance.now(),
    pidAlive: () => true,
    ...overrides,
  };
  const mirrorDir = join(dir, "mirror");
  const mirror = new ScenarioMirror({
    mirrorDir,
    daemonSlug: options.daemonSlug ?? DAEMON_SLUG,
    enabled: options.enabled ?? true,
    syncBoundMs: options.syncBoundMs ?? SYNC_BOUND_MS,
    slowSyncNoticeMs: options.slowSyncNoticeMs,
    log: line => lines.push(line),
  }, ports);
  return { mirror, lines, mirrorDir, nodeModules, pruned };
}

/** `<mirror>/<daemon>/<root slug>`: where the root's `g<n>` directories live. */
export function rootDirOf(mirrorDir: string, root: string, daemonSlug = DAEMON_SLUG): string {
  return join(mirrorDir, daemonSlug, rootSlug(root));
}
