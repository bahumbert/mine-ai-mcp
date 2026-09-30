import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { STYLES } from "./building/styles.ts";
import { loadPersona, personaSchema } from "./persona.ts";

test("the sample personas are valid and build in a shipped style", async () => {
  for (const name of ["ayla", "vex"]) {
    const persona = await loadPersona(fileURLToPath(new URL(`../personas/${name}.json`, import.meta.url)));
    assert.equal(persona.id, name);
    assert.ok(persona.style !== undefined && STYLES.has(persona.style), `${name} style ${persona.style}`);
  }
});

test("a persona with an impossible Minecraft username is rejected", () => {
  const result = personaSchema.safeParse({
    id: "x", username: "no spaces allowed", displayName: "X", stance: "companion", description: "d", voice: "v",
  });
  assert.equal(result.success, false);
});

test("per-tier models are optional overrides", () => {
  const base = { id: "x", username: "Xena", displayName: "X", stance: "companion", description: "d", voice: "v" };
  assert.deepEqual(personaSchema.parse(base).models, {});
  assert.equal(personaSchema.parse({ ...base, models: { planner: "big-model" } }).models.planner, "big-model");
  assert.equal(personaSchema.safeParse({ ...base, models: { dialogue: "rules" } }).success, false);
});
