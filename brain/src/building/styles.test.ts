import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { findStylesDirectory, STYLES, STYLES_DIRECTORY } from "./styles.ts";

test("the styles folder is found from the source depth (brain/src/building) and from the bundle's (brain/src)", () => {
  const root = mkdtempSync(join(tmpdir(), "styles-"));
  try {
    mkdirSync(join(root, "brain", "building-styles"), { recursive: true });
    mkdirSync(join(root, "brain", "src", "building"), { recursive: true });
    const expected = pathToFileURL(join(root, "brain", "building-styles") + "/").href;
    assert.equal(findStylesDirectory(pathToFileURL(join(root, "brain", "src", "building", "styles.ts"))).href, expected);
    assert.equal(findStylesDirectory(pathToFileURL(join(root, "brain", "src", "main.js"))).href, expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a folder with no styles above it fails, naming where it looked", () => {
  const root = mkdtempSync(join(tmpdir(), "styles-"));
  try {
    writeFileSync(join(root, "main.js"), "");
    assert.throws(() => findStylesDirectory(pathToFileURL(join(root, "main.js")), 1), /building-styles/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the shipped styles load from the source tree", () => {
  assert.ok(STYLES_DIRECTORY.pathname.endsWith("/brain/building-styles/"));
  assert.ok(STYLES.size >= 1);
});
