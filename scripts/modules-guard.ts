// Check that the modules Bun resolves were installed for this tree's dependency files.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const STAMP = ".mine-ai-modules-hash";

export function guardHash(root: string): string {
  const patches = join(root, "patches");
  const files = existsSync(patches) ? readdirSync(patches, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => `patches/${relative(patches, join(entry.parentPath, entry.name)).split("\\").join("/")}`).sort() : [];
  const hash = createHash("sha256");
  for (const name of ["package.json", "bun.lock", ...files]) {
    const file = join(root, name);
    const bytes = existsSync(file) ? readFileSync(file) : Buffer.alloc(0);
    hash.update(`${name}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest("hex");
}

export function resolvedModules(root: string): string | null {
  let dir = resolve(root);
  for (;;) {
    const candidate = join(dir, "node_modules");
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function stampModules(root: string): void {
  writeFileSync(join(root, "node_modules", STAMP), `${guardHash(root)} ${new Date().toISOString()}\n`);
}

export function unstampModules(root: string): void {
  rmSync(join(root, "node_modules", STAMP), { force: true });
}

export function checkModules(root: string): { ok: boolean; line: string } {
  root = resolve(root);
  const modules = resolvedModules(root);
  const stamp = modules === null ? null : join(modules, STAMP);
  const actual = stamp !== null && existsSync(stamp) ? readFileSync(stamp, "utf8").trim().split(/\s+/u)[0] : undefined;
  const want = guardHash(root);
  if (actual === want) return { ok: true, line: `ok: node_modules of ${root} match ${want}` };
  const reason = actual === undefined ? `no stamp${modules === null ? "; no node_modules found" : ` in ${modules}`}`
    : modules !== join(root, "node_modules") ? `resolved from ${modules} (other dependency files); stamp ${actual.slice(0, 12)} != ${want.slice(0, 12)}`
    : `stamp ${actual.slice(0, 12)} != ${want.slice(0, 12)}`;
  return { ok: false, line: `refused: node_modules of ${root} do not match its package.json/bun.lock/patches (${reason}): run \`bun install --frozen-lockfile\` in WSL in ${root}` };
}

export function enforceModules(root: string): boolean {
  const result = checkModules(root);
  if (result.ok) return true;
  if (process.env.RUN_GUARD_OVERRIDE?.includes("deps")) {
    console.error(`warning: ${result.line}`);
    return true;
  }
  console.error(result.line);
  return false;
}

if (import.meta.main) {
  const root = resolve(process.argv[3] ?? process.cwd());
  switch (process.argv[2]) {
    case "stamp": stampModules(root); break;
    case "unstamp": unstampModules(root); break;
    case "check": {
      const result = checkModules(root);
      if (result.ok) console.log(result.line);
      else if (!enforceModules(root)) process.exitCode = 1;
      break;
    }
    default: console.error("usage: modules-guard.ts stamp|unstamp|check [root]"); process.exitCode = 1;
  }
}
