import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { applyPaperSettings, loadPaperSettings, paperSettingsDigest, type PaperSettings } from "./paper-settings.ts";

const shippedSettingsPath = join(import.meta.dir, "..", "..", "..", "packaging", "paper-settings.json");
const cliPath = join(import.meta.dir, "paper-settings-cli.ts");
const MONSTERS_KEY = "spigot.yml: world-settings.default.entity-activation-range.monsters";

const tempDir = (): string => mkdtempSync(join(tmpdir(), "paper-settings-"));
const writeAt = (dir: string, file: string, text: string): void => {
  mkdirSync(dirname(join(dir, file)), { recursive: true });
  writeFileSync(join(dir, file), text);
};
const readYaml = (dir: string, file: string): any => Bun.YAML.parse(readFileSync(join(dir, file), "utf8"));
const activationRange = (monsters: number): PaperSettings => ({
  "spigot.yml": { "world-settings": { default: { "entity-activation-range": { monsters } } } },
});

async function runCli(args: string[], cwd?: string): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", cliPath, ...args], { stdout: "pipe", stderr: "pipe", cwd });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

test("creates a missing file from our keys", async () => {
  const dir = tempDir();
  const changed = await applyPaperSettings(dir, activationRange(24));
  assert.deepEqual(changed, [MONSTERS_KEY]);
  assert.equal(readYaml(dir, "spigot.yml")["world-settings"].default["entity-activation-range"].monsters, 24);
});

test("creates the folders of a nested file path", async () => {
  const dir = tempDir();
  await applyPaperSettings(dir, { "config/paper-world-defaults.yml": { entities: { spawning: { "per-player-mob-spawns": false } } } });
  assert.equal(readYaml(dir, "config/paper-world-defaults.yml").entities.spawning["per-player-mob-spawns"], false);
});

test("merges into an existing file and keeps its other keys", async () => {
  const dir = tempDir();
  writeAt(dir, "spigot.yml", "world-settings:\n  default:\n    mob-spawn-range: 8\n    entity-activation-range:\n      monsters: 32\n      animals: 32\n");
  const changed = await applyPaperSettings(dir, activationRange(24));
  assert.deepEqual(changed, [MONSTERS_KEY]);
  const doc = readYaml(dir, "spigot.yml")["world-settings"].default;
  assert.equal(doc["mob-spawn-range"], 8);
  assert.equal(doc["entity-activation-range"].animals, 32);
  assert.equal(doc["entity-activation-range"].monsters, 24);
});

test("an unchanged value is not reported", async () => {
  const dir = tempDir();
  await applyPaperSettings(dir, activationRange(24));
  assert.deepEqual(await applyPaperSettings(dir, activationRange(24)), []);
});

test("an array or a scalar of ours replaces what the file holds", async () => {
  const dir = tempDir();
  writeAt(dir, "a.yml", "list: [1, 2, 3]\nname: old\n");
  const changed = await applyPaperSettings(dir, { "a.yml": { list: [4], name: "new" } });
  assert.deepEqual(changed, ["a.yml: list", "a.yml: name"]);
  assert.deepEqual(readYaml(dir, "a.yml"), { list: [4], name: "new" });
});

test("refuses a path outside the server folder", async () => {
  const dir = tempDir();
  const outer = tempDir();
  for (const bad of ["../x.yml", join(outer, "x.yml"), "/etc/x.yml", "a/../../x.yml"]) {
    await assert.rejects(applyPaperSettings(dir, { [bad]: { a: 1 } }), (error: Error) => error.message.includes(bad));
  }
  assert.deepEqual(readdirSync(dir), []);
  assert.deepEqual(readdirSync(outer), []);
});

test("accepts a file name that only starts with two dots, and refuses a NUL in a path naming it", async () => {
  const dir = tempDir();
  assert.deepEqual(await applyPaperSettings(dir, { "..foo.yml": { a: 1 } }), ["..foo.yml: a"]);
  assert.equal(readYaml(dir, "..foo.yml").a, 1);
  await assert.rejects(applyPaperSettings(dir, { "a\0b.yml": { a: 1 } }), (error: Error) => error.message.includes("a\\u0000b.yml"));
  assert.deepEqual(readdirSync(dir), ["..foo.yml"]);
});

test("refuses a scalar where the file holds an object", async () => {
  const dir = tempDir();
  writeAt(dir, "p.yml", "entities: 3\n");
  await assert.rejects(
    applyPaperSettings(dir, { "p.yml": { entities: { spawning: { x: true } } } }),
    (error: Error) => error.message.includes("entities") && error.message.includes("p.yml"),
  );
  assert.equal(readFileSync(join(dir, "p.yml"), "utf8"), "entities: 3\n");
});

test("refuses a file that is not a mapping or does not parse", async () => {
  const dir = tempDir();
  writeAt(dir, "list.yml", "- a\n- b\n");
  await assert.rejects(applyPaperSettings(dir, { "list.yml": { a: 1 } }), (error: Error) => error.message.includes("list.yml"));
  writeAt(dir, "bad.yml", "a: [unclosed\n");
  await assert.rejects(applyPaperSettings(dir, { "bad.yml": { a: 1 } }), (error: Error) => error.message.includes("bad.yml"));
});

test("a refusal in a later file writes nothing in an earlier one", async () => {
  const dir = tempDir();
  writeAt(dir, "second.yml", "entities: 3\n");
  await assert.rejects(applyPaperSettings(dir, { "first.yml": { a: 1 }, "second.yml": { entities: { b: 1 } } }));
  assert.equal(existsSync(join(dir, "first.yml")), false);
});

test("loadPaperSettings names the file and the key path on a bad shape", () => {
  const dir = tempDir();
  const cases: [string, string][] = [
    ["[1]", "(root)"],
    [JSON.stringify({ "spigot.yml": 3 }), "spigot.yml"],
    [JSON.stringify({ "spigot.yml": { a: { b: null } } }), "spigot.yml: a.b"],
    ['{"spigot.yml":{"a":{"__proto__":{"x":1}}}}', "spigot.yml: a.__proto__"],
  ];
  for (const [text, path] of cases) {
    const file = join(dir, "s.json");
    writeFileSync(file, text);
    assert.throws(() => loadPaperSettings(file), (error: Error) => error.message.includes(file) && error.message.includes(path));
  }
  assert.throws(() => loadPaperSettings(join(dir, "missing.json")), (error: Error) => error.message.includes("missing.json"));
  writeFileSync(join(dir, "broken.json"), "{ nope");
  assert.throws(() => loadPaperSettings(join(dir, "broken.json")), (error: Error) => error.message.includes("broken.json"));
});

test("the digest ignores key order", () => {
  const first = paperSettingsDigest({ a: { x: 1, y: { p: 1, q: 2 } }, b: { z: 3 } });
  const second = paperSettingsDigest({ b: { z: 3 }, a: { y: { q: 2, p: 1 }, x: 1 } });
  assert.match(first, /^[0-9a-f]{12}$/u);
  assert.equal(first, second);
  assert.notEqual(first, paperSettingsDigest({ a: { x: 2, y: { p: 1, q: 2 } }, b: { z: 3 } }));
});

test("the shipped settings file loads", () => {
  const settings = loadPaperSettings(shippedSettingsPath);
  assert.deepEqual(Object.keys(settings).sort(), ["config/paper-world-defaults.yml", "spigot.yml"]);
  assert.deepEqual((settings["spigot.yml"] as any)["world-settings"].default["entity-activation-range"], {
    animals: 32, monsters: 32, raiders: 64, misc: 16, water: 16, villagers: 32, "flying-monsters": 32,
  });
  assert.deepEqual(settings["config/paper-world-defaults.yml"], { entities: { spawning: { "per-player-mob-spawns": true } } });
});

const paperFolder = join(homedir(), "mine-ai", "servers", "paper-1.21.4");
for (const file of ["spigot.yml", "config/paper-world-defaults.yml"]) {
  const source = join(paperFolder, file);
  test(`the file Paper wrote survives a parse and stringify: ${file}`, (t) => {
    if (!existsSync(source)) {
      t.skip(`${source} is absent: start Paper once to measure it`);
      return;
    }
    const original = Bun.YAML.parse(readFileSync(source, "utf8"));
    assert.deepEqual(Bun.YAML.parse(Bun.YAML.stringify(original, null, 2)), original);
  });
}

test("the cli writes the digest file, from the given settings or the shipped ones", async () => {
  const given = join(tempDir(), "s.json");
  writeFileSync(given, JSON.stringify(activationRange(24)));
  const rows: { args: (dir: string) => string[]; settings: PaperSettings; printed?: string[] }[] = [
    { args: (dir) => [dir, given], settings: activationRange(24), printed: [MONSTERS_KEY] },
    { args: (dir) => [dir], settings: loadPaperSettings(shippedSettingsPath) },
  ];
  for (const row of rows) {
    const dir = tempDir();
    const result = await runCli(row.args(dir));
    assert.equal(result.code, 0, result.err);
    const digest = paperSettingsDigest(row.settings);
    const lines = result.out.trim().split("\n");
    assert.equal(lines.at(-1), `paper settings ${digest}`);
    if (row.printed) assert.deepEqual(lines.slice(0, -1), row.printed);
    assert.equal(readFileSync(join(dir, ".paper-settings-digest"), "utf8").trim(), digest);
  }
});

test("the cli --digest prints 12 hex and writes nothing", async () => {
  const cwd = tempDir();
  const withSettings = await runCli(["--digest", shippedSettingsPath], cwd);
  assert.equal(withSettings.code, 0, withSettings.err);
  assert.match(withSettings.out.trim(), /^[0-9a-f]{12}$/u);
  const byDefault = await runCli(["--digest"], cwd);
  assert.equal(byDefault.out.trim(), withSettings.out.trim());
  assert.deepEqual(readdirSync(cwd), []);
});

test("the cli exits 1 with the error text on a refusal", async () => {
  const dir = tempDir();
  const settingsFile = join(tempDir(), "s.json");
  writeFileSync(settingsFile, JSON.stringify({ "../x.yml": { a: 1 } }));
  const result = await runCli([dir, settingsFile]);
  assert.equal(result.code, 1);
  assert.ok(result.err.includes("../x.yml"), result.err);
  assert.equal(existsSync(join(dir, ".paper-settings-digest")), false);
  assert.equal((await runCli([])).code, 1);
});

test("the applier files import only node modules", () => {
  for (const file of ["paper-settings.ts", "paper-settings-cli.ts"]) {
    const specifiers = [...readFileSync(join(import.meta.dir, file), "utf8").matchAll(/^\s*(?:import|export)\b[^;]*?from\s+"([^"]+)"/gmu)].map((match) => match[1]!);
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith("node:") || specifier === "./paper-settings.ts", `${file} imports ${specifier}`);
    }
  }
});
