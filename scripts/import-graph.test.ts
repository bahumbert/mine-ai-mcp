import { expect, test } from "bun:test";
import {
  aliasesFromPackageJson,
  buildReverseGraph,
  isReexportOnly,
  localSpecifierTarget,
  projectsImporting,
  testsReachedBy,
  type ImportAliases,
} from "./import-graph.js";

const ALIASES: ImportAliases = aliasesFromPackageJson({
  name: "@aibengineering/mine-ai-mcp",
  imports: { "#src/*": "./src/*", "#brain/*": "./brain/src/*" },
  exports: {
    ".": { types: "./src/index.ts", import: "./src/index.ts" },
    "./transport": { types: "./src/server/http.ts", import: "./src/server/http.ts" },
  },
});

const SUITE = ["src/", "brain/", "tests/", "scripts/"];

function graphOf(files: Record<string, string>, extraKnown: string[] = []) {
  const sources = new Map(Object.entries(files));
  return buildReverseGraph(sources, { known: new Set([...sources.keys(), ...extraKnown]), aliases: ALIASES });
}

function reached(files: Record<string, string>, starts: string[], depth = 2, cap = 150, extraKnown: string[] = []) {
  return testsReachedBy(starts, graphOf(files, extraKnown), { depth, cap, testRoots: SUITE });
}

function testNames(result: ReturnType<typeof testsReachedBy>): string[] {
  return result.tests.map((entry) => entry.file).sort();
}

test("type-only imports and type re-exports give no edge", () => {
  const result = reached(
    {
      "src/a.ts": "export type A = number;",
      "src/a.test.ts": 'import type { A } from "./a.js";\nconst x: A = 1;',
      "src/b.test.ts": 'import { type A } from "./a.js";\nconst x: A = 1;',
      "src/c.test.ts": 'export type { A } from "./a.js";',
    },
    ["src/a.ts"],
  );
  expect(testNames(result)).toEqual([]);
});

test("a value import used only as a type still gives an edge (Bun keeps it)", () => {
  const result = reached(
    { "src/a.ts": "export class B {}", "src/a2.test.ts": 'import { B } from "./a.js";\nlet x: B | undefined;' },
    ["src/a.ts"],
  );
  expect(testNames(result)).toEqual(["src/a2.test.ts"]);
});

test("a barrel costs no level: a test importing actions/x/index.ts is reached from actions/x/x.ts at depth 1", () => {
  const result = reached(
    {
      "src/actions/x/x.ts": "export const x = 1;",
      "src/actions/x/index.ts": 'export * from "./x.js";\nexport { x as y } from "./x.js";',
      "src/actions/use.test.ts": 'import { x } from "./x/index.js";\nconsole.log(x);',
    },
    ["src/actions/x/x.ts"],
    1,
  );
  expect(result.tests).toEqual([{ file: "src/actions/use.test.ts", depth: 1, from: "src/actions/x/x.ts" }]);
});

test("#src/ from brain/ resolves to src/, so a brain/ test is reached from a src/ change", () => {
  const files = {
    "src/world/a.ts": "export const a = 1;",
    "brain/src/b.ts": 'import { a } from "#src/world/a.js";\nexport const b = a;',
    "brain/src/b.test.ts": 'import { b } from "./b.js";\nconsole.log(b);',
  };
  expect(localSpecifierTarget("brain/src/b.ts", "#src/world/a.js", new Set(Object.keys(files)), ALIASES)).toBe("src/world/a.ts");
  expect(testNames(reached(files, ["src/world/a.ts"]))).toEqual(["brain/src/b.test.ts"]);
});

test("#brain/ resolves to brain/src/", () => {
  expect(localSpecifierTarget("tests/x.ts", "#brain/c.js", new Set(["brain/src/c.ts"]), ALIASES)).toBe("brain/src/c.ts");
});

test("a directory resolves to its index.ts, .js to .ts or .tsx; node: and packages give no edge", () => {
  const known = new Set(["src/dir/index.ts", "src/a.ts", "src/view.tsx"]);
  expect(localSpecifierTarget("src/m.ts", "./dir", known, ALIASES)).toBe("src/dir/index.ts");
  expect(localSpecifierTarget("src/m.ts", "./a.js", known, ALIASES)).toBe("src/a.ts");
  expect(localSpecifierTarget("src/m.ts", "./view.js", known, ALIASES)).toBe("src/view.tsx");
  expect(localSpecifierTarget("src/m.ts", "./a", known, ALIASES)).toBe("src/a.ts");
  expect(localSpecifierTarget("src/m.ts", "node:fs", known, ALIASES)).toBeUndefined();
  expect(localSpecifierTarget("src/m.ts", "vec3", known, ALIASES)).toBeUndefined();
  expect(localSpecifierTarget("src/m.ts", "./missing.js", known, ALIASES)).toBeUndefined();
});

test("a changed .json reaches the tests of its importers", () => {
  const result = reached(
    {
      "src/world/data/tags.ts": 'import tags from "./tags.json" with { type: "json" };\nexport const t = tags;',
      "src/world/data/tags.test.ts": 'import { t } from "./tags.js";\nconsole.log(t);',
    },
    ["src/world/data/tags.json"],
    2,
    150,
    ["src/world/data/tags.json"],
  );
  expect(result.tests).toEqual([{ file: "src/world/data/tags.test.ts", depth: 2, from: "src/world/data/tags.json" }]);
});

const CHAIN = {
  "src/a.ts": "export const a = 1;",
  "src/b.ts": 'import { a } from "./a.js";\nexport const b = a;',
  "src/c.ts": 'import { b } from "./b.js";\nexport const c = b;',
  "src/t.test.ts": 'import { c } from "./c.js";\nconsole.log(c);',
};

test("depth bound: t.test -> c -> b -> a is out of reach at depth 2, in at depth 3, nothing at depth 0", () => {
  expect(testNames(reached(CHAIN, ["src/a.ts"], 2))).toEqual([]);
  expect(reached(CHAIN, ["src/a.ts"], 3).tests).toEqual([{ file: "src/t.test.ts", depth: 3, from: "src/a.ts" }]);
  expect(testNames(reached(CHAIN, ["src/a.ts"], 0))).toEqual([]);
});

test("the nearest start wins the test's depth and origin", () => {
  expect(reached(CHAIN, ["src/a.ts", "src/c.ts"], 3).tests).toEqual([{ file: "src/t.test.ts", depth: 1, from: "src/c.ts" }]);
});

function fanOut(atOne: number, atTwo: number): Record<string, string> {
  const files: Record<string, string> = { "src/a.ts": "export const a = 1;", "src/m.ts": 'import { a } from "./a.js";\nexport const m = a;' };
  for (let i = 0; i < atOne; i++) files[`src/one${i}.test.ts`] = 'import { a } from "./a.js";\nconsole.log(a);';
  for (let i = 0; i < atTwo; i++) files[`src/two${i}.test.ts`] = 'import { m } from "./m.js";\nconsole.log(m);';
  return files;
}

test("over the cap the direct tests stay and deeper ones are dropped and counted", () => {
  const result = reached(fanOut(3, 5), ["src/a.ts"], 2, 4);
  expect(result.tests.map((entry) => entry.depth)).toEqual([1, 1, 1]);
  expect(result.dropped).toBe(5);
  expect(result.depthOneOverCap).toBe(false);
});

test("direct tests alone over the cap all run, and the result says so", () => {
  const result = reached(fanOut(6, 0), ["src/a.ts"], 2, 4);
  expect(result.tests).toHaveLength(6);
  expect(result.dropped).toBe(0);
  expect(result.depthOneOverCap).toBe(true);
});

test("the package's own name resolves through its exports; an unknown subpath gives no edge", () => {
  const known = new Set(["src/index.ts", "src/server/http.ts"]);
  expect(localSpecifierTarget("tests/x.test.ts", "@aibengineering/mine-ai-mcp", known, ALIASES)).toBe("src/index.ts");
  expect(localSpecifierTarget("tests/x.test.ts", "@aibengineering/mine-ai-mcp/transport", known, ALIASES)).toBe("src/server/http.ts");
  expect(localSpecifierTarget("tests/x.test.ts", "@aibengineering/mine-ai-mcp/other", known, ALIASES)).toBeUndefined();
});

test("a test outside the suite's test paths is reported, not run", () => {
  const result = reached(
    {
      "src/a.ts": "export const a = 1;",
      "scenarios/flat/combat/reflex.test.ts": 'import { a } from "#src/a.js";\nconsole.log(a);',
    },
    ["src/a.ts"],
  );
  expect(result.tests).toEqual([]);
  expect(result.outsideSuite).toEqual(["scenarios/flat/combat/reflex.test.ts"]);
});

test("a changed test file is in the set at depth 0, and tests importing it at depth 1", () => {
  const result = reached(
    {
      "src/helpers.test.ts": "export const shared = 1;",
      "src/user.test.ts": 'import { shared } from "./helpers.test.js";\nconsole.log(shared);',
    },
    ["src/helpers.test.ts"],
  );
  expect(result.tests).toEqual([
    { file: "src/helpers.test.ts", depth: 0, from: "src/helpers.test.ts" },
    { file: "src/user.test.ts", depth: 1, from: "src/helpers.test.ts" },
  ]);
});

test("a deleted start still reaches its importers' tests", () => {
  const result = reached({ "src/gone.test.ts": 'import { g } from "./gone.js";\nconsole.log(g);' }, ["src/gone.ts"], 2, 150, [
    "src/gone.ts",
  ]);
  expect(testNames(result)).toEqual(["src/gone.test.ts"]);
});

test("an import cycle terminates", () => {
  const result = reached(
    {
      "src/a.ts": 'import { b } from "./b.js";\nexport const a = () => b;',
      "src/b.ts": 'import { a } from "./a.js";\nexport const b = () => a;',
      "src/b.test.ts": 'import { b } from "./b.js";\nconsole.log(b);',
    },
    ["src/a.ts"],
    5,
  );
  expect(testNames(result)).toEqual(["src/b.test.ts"]);
});

test("a #! first line parses; a file with a syntax error is listed as unparsed and the rest is built", () => {
  const graph = graphOf({
    "src/a.ts": "export const a = 1;",
    "src/cli.ts": '#!/usr/bin/env bun\nimport { a } from "./a.js";\nconsole.log(a);',
    "src/broken.ts": 'import { a } from "./a.js";\nconst = = ;',
  });
  expect([...(graph.importers.get("src/a.ts") ?? [])]).toEqual(["src/cli.ts"]);
  expect(graph.unparsed).toEqual(["src/broken.ts"]);
});

test("a dynamic import with a literal path gives an edge; a computed one gives none", () => {
  const graph = graphOf({
    "src/g.ts": "export const g = 1;",
    "src/h.ts": "export const h = 1;",
    "src/load.ts": 'const name = "./h.js";\nexport const load = () => [import("./g.js"), import(name)];',
  });
  expect([...(graph.importers.get("src/g.ts") ?? [])]).toEqual(["src/load.ts"]);
  expect(graph.importers.get("src/h.ts")).toBeUndefined();
});

test("re-export-only files: barrels yes, a file with any other statement no", () => {
  expect(isReexportOnly('// barrel\nexport * from "./a.js";\nexport { b, c as d } from "./b.js";\nexport type { T } from "./t.js";\n')).toBe(true);
  expect(isReexportOnly('/* doc */\nexport * as ns from "./a.js"')).toBe(true);
  expect(isReexportOnly('export * from "./a.js";\nexport const x = 1;')).toBe(false);
  expect(isReexportOnly('import { a } from "./a.js";\nexport { a };')).toBe(false);
  expect(isReexportOnly("")).toBe(false);
});

const PROJECT_DIRS = ["src/", "scenarios/", "tests/", "brain/"];

test("a project importing a changed file only for its types is a project to typecheck", () => {
  const graph = graphOf({
    "src/a.ts": "export type A = number;",
    "tests/x.ts": 'import type { A } from "#src/a.js";\nexport const x: A = 1;',
  });
  expect(projectsImporting(["src/a.ts"], graph, PROJECT_DIRS)).toEqual(new Map([["tests/", "tests/x.ts"]]));
});

test("projects are found through any number of importers, type re-exports included", () => {
  const graph = graphOf({
    "src/a.ts": "export type A = number;",
    "src/b.ts": 'export type { A } from "./a.js";',
    "src/c.ts": 'import { type A } from "./b.js";\nexport const c: A = 1;',
    "scenarios/src/s.ts": 'import { c } from "@aibengineering/mine-ai-mcp";\nconsole.log(c);',
    "src/index.ts": 'export * from "./c.js";',
  });
  expect([...projectsImporting(["src/a.ts"], graph, PROJECT_DIRS).keys()].sort()).toEqual(["scenarios/", "src/"]);
});

test("a changed file nobody imports gives no project, not even its own", () => {
  expect(projectsImporting(["src/a.ts"], graphOf({ "src/a.ts": "export const a = 1;" }), PROJECT_DIRS).size).toBe(0);
});

test("a file the transpiler cannot parse still counts as an importer for the typecheck", () => {
  const graph = graphOf({ "src/a.ts": "export const a = 1;", "brain/src/b.ts": 'import { a } from "#src/a.js";\nconst = = ;' });
  expect(projectsImporting(["src/a.ts"], graph, PROJECT_DIRS)).toEqual(new Map([["brain/", "brain/src/b.ts"]]));
});

test("import text inside a string (a test fixture) does not make its file an importer for the typecheck", () => {
  const graph = graphOf({
    "src/index.ts": "export const c = 1;",
    "scripts/fixture.test.ts": 'const files = {\n  "s.ts": \'import { c } from "@aibengineering/mine-ai-mcp";\',\n};\nconsole.log(files);',
  });
  expect(projectsImporting(["src/index.ts"], graph, [...PROJECT_DIRS, "scripts/"]).size).toBe(0);
});

test("import = require, a multi-line type import and a dynamic import are importers for the typecheck", () => {
  const graph = graphOf({
    "src/a.ts": "export type A = number;\nexport const a = 1;",
    "tests/req.ts": 'import a = require("../src/a.js");\nexport const y = a;',
    "brain/src/multi.ts": 'import type {\n  A,\n} from "#src/a.js";\nexport const z: A = 1;',
    "scenarios/src/lazy.ts": 'export const load = () => import("#src/a.js");',
  });
  expect([...projectsImporting(["src/a.ts"], graph, PROJECT_DIRS).keys()].sort()).toEqual(["brain/", "scenarios/", "tests/"]);
});
