import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { findDataDirectory, STYLES, STYLES_DIRECTORY, styleSchema } from "./styles.ts";

test("a data folder (styles, templates) is found from the source depth (brain/src/building) and from the bundle's (brain/src)", () => {
  const root = mkdtempSync(join(tmpdir(), "styles-"));
  try {
    mkdirSync(join(root, "brain", "building-styles"), { recursive: true });
    mkdirSync(join(root, "brain", "building-templates"), { recursive: true });
    mkdirSync(join(root, "brain", "src", "building"), { recursive: true });
    for (const name of ["building-styles", "building-templates"]) {
      const expected = pathToFileURL(join(root, "brain", name) + "/").href;
      assert.equal(findDataDirectory(name, pathToFileURL(join(root, "brain", "src", "building", "styles.ts"))).href, expected);
      assert.equal(findDataDirectory(name, pathToFileURL(join(root, "brain", "src", "main.js"))).href, expected);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every shipped style names a kebab-case family of house templates", () => {
  assert.deepEqual([...STYLES.values()].map((style) => [style.id, style.family]), [["japanese", "east-asia"], ["medieval", "europe"], ["rustic", "europe"]]);
  assert.equal(styleSchema.safeParse({ ...STYLES.get("medieval"), family: "Not Kebab" }).success, false);
});

test("a folder with no styles above it fails, naming where it looked", () => {
  const root = mkdtempSync(join(tmpdir(), "styles-"));
  try {
    writeFileSync(join(root, "main.js"), "");
    assert.throws(() => findDataDirectory("building-styles", pathToFileURL(join(root, "main.js")), 1), /building-styles/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a style holds only a persona's taste: id, family and description, no blocks and no house options", () => {
  for (const style of STYLES.values()) assert.deepEqual(Object.keys(style).sort(), ["description", "family", "id"], style.id);
  const medieval = STYLES.get("medieval")!;
  assert.equal(styleSchema.safeParse(medieval).success, true);
  assert.equal(styleSchema.safeParse({ ...medieval, palette: { wall: "oak_planks" } }).success, false, "a palette belongs to a template");
  assert.equal(styleSchema.safeParse({ ...medieval, house: { roof: "gable", overhang: 1 } }).success, false, "house options belong to a template");
});

test("the shipped styles load from the source tree", () => {
  assert.ok(STYLES_DIRECTORY.pathname.endsWith("/brain/building-styles/"));
  assert.ok(STYLES.size >= 1);
});
