// Exercise dependency stamps and the test-process guard in isolated trees.
import { afterEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modulesHash } from "../tests/minecraft/shared/mirror-modules.ts";
import { checkModules, guardHash, stampModules, unstampModules } from "./modules-guard.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "modules-guard-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), "{}\n");
  writeFileSync(join(root, "bun.lock"), "lock\n");
  return root;
}

test("stamps reject changed inputs and a failure after preinstall", () => {
  const root = fixture();
  mkdirSync(join(root, "node_modules"));
  expect(checkModules(root).ok).toBe(false);
  stampModules(root);
  expect(checkModules(root).ok).toBe(true);
  for (const [name, changed] of [["bun.lock", "changed\n"], ["package.json", '{"dependencies":{"vec3":"0.1.7"}}']] as const) {
    stampModules(root);
    writeFileSync(join(root, name), changed);
    const result = checkModules(root);
    expect(result.ok).toBe(false);
    expect(result.line).toContain("bun install --frozen-lockfile");
  }
  // Model a failed install after its preinstall hook removed the stamp.
  unstampModules(root);
  expect(checkModules(root).line).toContain("no stamp");
  expect(checkModules(root).ok).toBe(false);
});

test("walk-up accepts matching inputs and rejects an extra patch", () => {
  const parent = fixture();
  mkdirSync(join(parent, "node_modules"));
  stampModules(parent);
  const child = join(parent, "child");
  mkdirSync(child);
  writeFileSync(join(child, "package.json"), "{}\n");
  writeFileSync(join(child, "bun.lock"), "lock\n");
  expect(checkModules(child).ok).toBe(true);
  mkdirSync(join(child, "patches"));
  writeFileSync(join(child, "patches", "x.patch"), "x");
  expect(checkModules(child).line).toContain("bun install --frozen-lockfile");
  expect(checkModules(child).line).toContain(child);
  expect(checkModules(child).ok).toBe(false);
});

test("guard hash agrees with the snapshot hash including nested patches", () => {
  const root = fixture();
  mkdirSync(join(root, "patches", "nested"), { recursive: true });
  writeFileSync(join(root, "patches", "nested", "x.patch"), "patch\n");
  expect(guardHash(root)).toBe(modulesHash(root));
});

test("CLI refuses stale modules and override warns on stderr", () => {
  const root = fixture();
  const cli = join(import.meta.dir, "modules-guard.ts");
  const refused = Bun.spawnSync(["bun", cli, "check", root], { env: { ...process.env, RUN_GUARD_OVERRIDE: "" } });
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr.toString()).toContain("refused:");
  const overridden = Bun.spawnSync(["bun", cli, "check", root], { env: { ...process.env, RUN_GUARD_OVERRIDE: "deps" } });
  expect(overridden.exitCode).toBe(0);
  expect(overridden.stderr.toString()).toContain("warning: refused:");
  // One grammar with deps.py and win-gpu.py: a comma list, items stripped, exact names.
  const listed = Bun.spawnSync(["bun", cli, "check", root], { env: { ...process.env, RUN_GUARD_OVERRIDE: "gpu, deps" } });
  expect(listed.exitCode).toBe(0);
  const lookalike = Bun.spawnSync(["bun", cli, "check", root], { env: { ...process.env, RUN_GUARD_OVERRIDE: "nodeps" } });
  expect(lookalike.exitCode).toBe(1);
});

test("preload rejects before loading tests and an override permits them", () => {
  const root = fixture();
  mkdirSync(join(root, "node_modules"));
  mkdirSync(join(root, "scripts"));
  for (const name of ["modules-guard.ts", "modules-guard-preload.ts", "test-limit.ts", "test-clock-cleanup.ts", "test-tmpfs.ts"]) copyFileSync(join(import.meta.dir, name), join(root, "scripts", name));
  stampModules(root);
  writeFileSync(join(root, "bun.lock"), "changed\n");
  copyFileSync(join(import.meta.dir, "..", "bunfig.toml"), join(root, "bunfig.toml"));
  const marker = join(root, "loaded");
  writeFileSync(join(root, "case.test.ts"), 'import { writeFileSync } from "node:fs"; import { test } from "bun:test"; writeFileSync("loaded", "yes"); test("fixture", () => {});');
  const options = { cwd: root, env: { ...process.env, RUN_GUARD_OVERRIDE: "" } };
  const result = Bun.spawnSync(["bun", "test", "case.test.ts"], options);
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("bun install --frozen-lockfile");
  expect(existsSync(marker)).toBe(false);
  const override = Bun.spawnSync(["bun", "test", "case.test.ts"], { ...options, env: { ...options.env, RUN_GUARD_OVERRIDE: "deps" } });
  expect(override.exitCode).toBe(0);
  expect(override.stderr.toString()).toContain("warning: refused:");
  expect(existsSync(marker)).toBe(true);
});

test("guard preload fresh-process overhead averages under 30 ms", () => {
  const root = fixture();
  const preload = join(import.meta.dir, "modules-guard-preload.ts");
  const empty = join(root, "empty.ts");
  writeFileSync(empty, "export {};\n");
  writeFileSync(join(root, "case.test.ts"), 'import { test } from "bun:test"; test("fixture", () => {});');
  const times = [0, 0];
  for (let i = 0; i < 20; i++) {
    for (const index of i % 2 === 0 ? [0, 1] : [1, 0]) {
      const start = performance.now();
      const child = Bun.spawnSync(["bun", "test", "--preload", index === 0 ? empty : preload, "case.test.ts"], { cwd: root, stdout: "ignore", stderr: "ignore" });
      times[index]! += performance.now() - start;
      expect(child.exitCode).toBe(0);
    }
  }
  const delta = (times[1]! - times[0]!) / 20;
  console.log(`modules guard fresh-process mean delta: ${delta.toFixed(2)} ms`);
  expect(delta).toBeLessThan(30);
});
