import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findPersona, listPersonas } from "./personas.ts";

function withPersonas(files: Record<string, string>, run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "personas-"));
  try {
    mkdirSync(join(root, "personas"));
    for (const [name, content] of Object.entries(files)) writeFileSync(join(root, "personas", name), content);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const persona = (username: unknown): string => JSON.stringify({ username });

test("listPersonas: lists persona files sorted by id and skips files that are no persona", () => {
  withPersonas(
    {
      "brea.json": persona("Brea"),
      "ayla.json": persona("Ayla"),
      "no-name.json": JSON.stringify({ role: "x" }),
      "empty-name.json": persona(""),
      "number-name.json": persona(7),
      "bad-name.json": persona("Not A Name"),
      "broken.json": "{ not json",
      "notes.txt": "hello",
    },
    (root) => {
      const list = listPersonas(root);
      assert.deepEqual(
        list.map((entry) => [entry.id, entry.username]),
        [["ayla", "Ayla"], ["brea", "Brea"]],
      );
      assert.equal(list[0]!.path, join(root, "personas", "ayla.json"));
    },
  );
});

test("listPersonas: no personas folder gives an empty list", () => {
  const root = mkdtempSync(join(tmpdir(), "personas-"));
  try {
    assert.deepEqual(listPersonas(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("findPersona: by username and by id, without case", () => {
  withPersonas({ "ayla-v2.json": persona("Ayla"), "brea.json": persona("Brea") }, (root) => {
    const list = listPersonas(root);
    assert.equal(findPersona(list, "AYLA")?.id, "ayla-v2");
    assert.equal(findPersona(list, "ayla-V2")?.username, "Ayla");
    assert.equal(findPersona(list, "brea")?.id, "brea");
  });
});

test("findPersona: an exact id wins over a username that spells the same, whatever the file order", () => {
  withPersonas({ "brea.json": persona("Cleo"), "cleo.json": persona("Dara") }, (root) => {
    const list = listPersonas(root);
    assert.equal(findPersona(list, "cleo")?.id, "cleo");
    assert.equal(findPersona(list, "CLEO")?.id, "cleo");
    assert.equal(findPersona(list, "dara")?.id, "cleo");
  });
});

test("findPersona: names that are paths, long, or hold control characters find nothing", () => {
  withPersonas({ "ayla.json": persona("Ayla") }, (root) => {
    const list = listPersonas(root);
    for (const name of ["../ayla", "ayla.json", "con", "x".repeat(200), "ay\u0000la", "", " ayla"]) {
      assert.equal(findPersona(list, name), null, JSON.stringify(name));
    }
  });
});
