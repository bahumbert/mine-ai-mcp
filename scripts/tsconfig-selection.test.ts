import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { configFiles, configTypechecks, FULL_SUITE_POINTER, tsconfigExtends } from "./tsconfig-selection.js";

const { extendsOf: EXTENDS } = tsconfigExtends(
  new Map([
    ["tsconfig.json", '{ "extends": "./tsconfig.check.json" }'],
    ["tsconfig.check.json", '{\n  // comment with "quotes" and a trailing comma below\n  "extends": "./tsconfig.build.json",\n  "include": ["src/**/*.ts",],\n}'],
    ["tsconfig.build.json", '{ "compilerOptions": { "outDir": "dist" /* block // comment */ } }'],
    ["tests/tsconfig.json", '﻿{ "extends": "../tsconfig.build.json" }'],
    ["scenarios/tsconfig.json", '{ "extends": "../tests/tsconfig" }'],
    ["scripts/tsconfig.json", '{ "extends": ["@tsconfig/bun", "../tsconfig.build.json"] }'],
  ]),
);

const PROJECT_DIRS = ["src/", "scenarios/", "tests/", "brain/", "monitor/", "scripts/"];

test("a tsconfig's extends is read from the file: comments, trailing commas, a BOM, a missing .json, a package name", () => {
  expect(EXTENDS.get("tsconfig.check.json")).toEqual(["tsconfig.build.json"]);
  expect(EXTENDS.get("tests/tsconfig.json")).toEqual(["tsconfig.build.json"]);
  expect(EXTENDS.get("scenarios/tsconfig.json")).toEqual(["tests/tsconfig.json"]);
  expect(EXTENDS.get("scripts/tsconfig.json")).toEqual(["tsconfig.build.json"]);
  expect(EXTENDS.get("tsconfig.build.json")).toEqual([]);
});

test("a tsconfig that does not parse is named and extends nothing", () => {
  const { extendsOf, unparsed } = tsconfigExtends(new Map([["tests/tsconfig.json", '{ "extends": ']]));
  expect(unparsed).toEqual(["tests/tsconfig.json"]);
  expect(extendsOf.get("tests/tsconfig.json")).toEqual([]);
});

// check-reads: tsconfig*.json, */tsconfig*.json
test("the repository's own tsconfig files parse: every project present extends the build config", () => {
  const root = join(import.meta.dir, "..");
  const present = PROJECT_DIRS.map((dir) => `${dir}tsconfig.json`).filter((file) => existsSync(join(root, file)));
  const { extendsOf, unparsed } = tsconfigExtends(new Map(["tsconfig.json", "tsconfig.check.json", ...present].map((file) => [file, readFileSync(join(root, file), "utf8")] as const)));
  expect(unparsed).toEqual([]);
  expect(extendsOf.get("tsconfig.json")).toEqual(["tsconfig.check.json"]);
  expect(extendsOf.get("tsconfig.check.json")).toEqual(["tsconfig.build.json"]);
  for (const file of present) expect(extendsOf.get(file)).toEqual(["tsconfig.build.json"]);
});

const CHAIN = new Map([["a/tsconfig.json", ["b/tsconfig.json"]], ["b/tsconfig.json", ["c/tsconfig.json"]], ["c/tsconfig.json", []]]);
const WITHOUT_TESTS = new Map(EXTENDS);
WITHOUT_TESTS.delete("tests/tsconfig.json");

test.each([
  ["a project tsconfig: its project and the project extending it", ["tests/tsconfig.json"], EXTENDS, PROJECT_DIRS, [["scenarios/", "tests/tsconfig.json changed (scenarios/tsconfig.json extends it)"], ["tests/", "tests/tsconfig.json changed"]]],
  ["a deleted project tsconfig: the same, read from the files that remain", ["tests/tsconfig.json"], WITHOUT_TESTS, PROJECT_DIRS, [["scenarios/", "tests/tsconfig.json changed (scenarios/tsconfig.json extends it)"], ["tests/", "tests/tsconfig.json changed"]]],
  ["a chain: the project at its end", ["c/tsconfig.json"], CHAIN, ["a/", "b/", "c/"], [["a/", "c/tsconfig.json changed (a/tsconfig.json extends it)"], ["b/", "c/tsconfig.json changed (b/tsconfig.json extends it)"], ["c/", "c/tsconfig.json changed"]]],
  ["json files that are no config: nothing", ["scenarios/foo.json", "tests/data/tsconfig-notes.json", "docker/package.json"], EXTENDS, PROJECT_DIRS, []],
] as const)("%s", (_name, changed, extendsOf, dirs, expected) => {
  const { reasons, pointer } = configTypechecks(changed, extendsOf, dirs);
  expect([...reasons] as string[][]).toEqual(expected.map((pair) => [...pair]));
  expect(pointer).toBeUndefined();
});

test("a changed root config, package.json or bun.lock selects every typecheck and points to the full suite", () => {
  for (const file of ["tsconfig.json", "tsconfig.check.json", "tsconfig.build.json", "package.json", "bun.lock"]) {
    const { reasons, pointer } = configTypechecks([file], EXTENDS, PROJECT_DIRS);
    expect([...reasons]).toEqual(PROJECT_DIRS.map((dir) => [dir, `${file} changed`]));
    expect(pointer).toBe(FULL_SUITE_POINTER);
  }
});

test("the changed files that can select a typecheck, with the root ones and a nested tsconfig", () => {
  expect(configFiles(["bun.lock", "src/a.ts", "tests/tsconfig.json", "docker/package.json", "scenarios/foo.json", "tsconfig.build.json"])).toEqual([
    "bun.lock",
    "tests/tsconfig.json",
    "tsconfig.build.json",
  ]);
});
