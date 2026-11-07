import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { bundledPackageFolders, packageNoticeSections, writeThirdPartyNotices } from "./third-party-notices.ts";

/** A package folder as `bun install` leaves it: a `package.json` (`manifest` merged over name and version) and the given files. */
function writePackage(folder: string, name: string, version: string, manifest: Record<string, unknown>, files: Record<string, string> = {}): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "package.json"), JSON.stringify({ name, version, ...manifest }));
  for (const [file, text] of Object.entries(files)) writeFileSync(join(folder, file), text);
}

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "notices-"));
}

function slashed(path: string): string {
  return path.replaceAll("\\", "/");
}

test("metafile keys are read from the build's working folder, not the stage: the package folder is found from either", () => {
  const stage = scratch();
  try {
    const elsewhere = join(stage, "..", "elsewhere");
    // Measured 2026-11-07: Bun gives input keys relative to process.cwd(), which is not the stage (`../mnt/d/...` from /tmp).
    const keys = [relative(elsewhere, join(stage, "node_modules", "ms", "index.js")), relative(elsewhere, join(stage, "launcher", "src", "main.ts"))];
    assert.deepEqual(bundledPackageFolders(keys, elsewhere), [slashed(join(stage, "node_modules", "ms"))]);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

test("a key written with backslashes finds the same package folder", () => {
  const cwd = scratch();
  try {
    assert.deepEqual(bundledPackageFolders(["..\\stage\\node_modules\\ms\\index.js"], join(cwd, "work")), [slashed(join(cwd, "stage", "node_modules", "ms"))]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a nested node_modules gives the inner package, a scope gives scope and name, and many files of one package give one folder", () => {
  const cwd = scratch();
  const root = slashed(cwd);
  try {
    const folders = bundledPackageFolders([
      "node_modules/protodef-validator/index.js", "node_modules/protodef-validator/node_modules/ajv/lib/ajv.js",
      "node_modules/protodef-validator/node_modules/ajv/lib/other.js", "node_modules/@modelcontextprotocol/sdk/dist/index.js", "node_modules/@modelcontextprotocol/sdk/dist/two.js",
    ], cwd);
    assert.deepEqual(folders, [
      `${root}/node_modules/@modelcontextprotocol/sdk`, `${root}/node_modules/protodef-validator`, `${root}/node_modules/protodef-validator/node_modules/ajv`,
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a metafile with no bundled package fails instead of shipping an empty notices file", () => {
  assert.throws(() => bundledPackageFolders([], "/tmp"), /\[BUILD_LICENSE\] no bundled package found in the metafile/u);
  assert.throws(() => bundledPackageFolders(["src/server/host.ts", "launcher/src/main.ts"], "/tmp"), /\[BUILD_LICENSE\] no bundled package found/u);
});

test("two versions of one package give two sections, sorted by name then version; one name@version in two folders gives one, from the first folder", () => {
  const root = scratch();
  try {
    writePackage(join(root, "node_modules/ajv"), "ajv", "8.17.1", { license: "MIT" }, { LICENSE: "ajv 8 text" });
    writePackage(join(root, "node_modules/protodef-validator/node_modules/ajv"), "ajv", "6.12.6", { license: "MIT" }, { LICENSE: "ajv 6 text" });
    writePackage(join(root, "node_modules/other/node_modules/ajv"), "ajv", "6.12.6", { license: "MIT" }, { LICENSE: "ajv 6 other text" });
    writePackage(join(root, "node_modules/@scope/a"), "@scope/a", "1.0.0", { license: "ISC" });
    const sections = packageNoticeSections([
      join(root, "node_modules/ajv"), join(root, "node_modules/protodef-validator/node_modules/ajv"), join(root, "node_modules/other/node_modules/ajv"), join(root, "node_modules/@scope/a"),
    ]);
    assert.deepEqual(sections.map((section) => section.title), ["@scope/a@1.0.0", "ajv@6.12.6", "ajv@8.17.1"]);
    assert.match(sections[1]!.body, /ajv 6 other text/u, "the folder that sorts first (other/) gives the text, whatever the order given");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("licence files at the package root are matched whatever their case; other files and sub-folders are not", () => {
  const root = scratch();
  try {
    const folder = join(root, "node_modules/ms");
    writePackage(folder, "ms", "2.1.3", { license: "MIT" }, { "license.md": "lower md", COPYING: "copying text", NOTICE: "notice text", "License-Info.txt": "info text", "README.md": "readme", "index.js": "code" });
    mkdirSync(join(folder, "LICENSES"));
    writeFileSync(join(folder, "LICENSES", "inner.txt"), "inside a licence folder");
    const [section] = packageNoticeSections([folder]);
    assert.ok(section);
    for (const text of ["lower md", "copying text", "notice text", "info text"]) assert.ok(section.body.includes(text), text);
    for (const text of ["readme", "code", "inside a licence folder"]) assert.equal(section.body.includes(text), false, text);
    assert.match(section.body, /License: MIT/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a package with no licence file gets its license field and says so", () => {
  const root = scratch();
  try {
    writePackage(join(root, "node_modules/vec3"), "vec3", "0.1.10", { license: "BSD" });
    const [section] = packageNoticeSections([join(root, "node_modules/vec3")]);
    assert.ok(section);
    assert.equal(section.body, "License: BSD\nno licence file in the package");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the license field may be an object or a licenses array, and a package with none fails naming it", () => {
  const root = scratch();
  try {
    writePackage(join(root, "node_modules/a"), "a", "1.0.0", { license: { type: "MIT", url: "x" } });
    writePackage(join(root, "node_modules/b"), "b", "1.0.0", { licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] });
    writePackage(join(root, "node_modules/c"), "c", "1.0.0", {}, { LICENSE: "text present but no field" });
    assert.deepEqual(packageNoticeSections([join(root, "node_modules/a"), join(root, "node_modules/b")]).map((section) => section.body.split("\n")[0]), ["License: MIT", "License: MIT, Apache-2.0"]);
    assert.throws(() => packageNoticeSections([join(root, "node_modules/c")]), /\[BUILD_LICENSE\] c has no license field/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a folder under node_modules that is no package (no package.json) fails as BUILD_LICENSE, naming it", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    assert.throws(() => packageNoticeSections([join(root, "node_modules/.bin")]), /\[BUILD_LICENSE\].*\.bin.*no package\.json/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the notices file holds one titled block per package, the copied packages and Bun, sorted, the packages' licence texts under their titles", () => {
  const stage = scratch();
  const app = scratch();
  try {
    writePackage(join(stage, "node_modules/zeta"), "zeta", "1.0.0", { license: "MIT" }, { LICENSE: "zeta licence text" });
    writePackage(join(stage, "node_modules/minecraft-data"), "minecraft-data", "3.1.0", { license: "MIT" });
    mkdirSync(join(stage, "packaging", "licenses"), { recursive: true });
    writeFileSync(join(stage, "packaging", "manifest.json"), JSON.stringify({ bun: { url: "https://example.test/bun-v1.2.3/bun-windows-x64.zip" } }));
    writeFileSync(join(stage, "packaging", "licenses", "bun-LICENSE.md"), "bun licence text\n");
    writeThirdPartyNotices(stage, app, ["node_modules/zeta/index.js"], [join(stage, "node_modules/minecraft-data")], stage);
    const text = readFileSync(join(app, "THIRD-PARTY-NOTICES.txt"), "utf8");
    assert.deepEqual(text.split("\n").filter((line) => line.startsWith("===== ")), ["===== minecraft-data@3.1.0 =====", "===== zeta@1.0.0 =====", "===== Bun 1.2.3 ====="]);
    assert.match(text, /===== zeta@1\.0\.0 =====\nLicense: MIT\n--- LICENSE ---\nzeta licence text\n/u);
    assert.ok(text.endsWith("bun licence text\n"));
  } finally {
    rmSync(stage, { recursive: true, force: true });
    rmSync(app, { recursive: true, force: true });
  }
});
