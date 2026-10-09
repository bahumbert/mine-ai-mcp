import assert from "node:assert/strict";
import test from "node:test";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { STYLES } from "./building/styles.ts";
import { loadPersona, personaSchema } from "./persona.ts";

/** The characters live in the private part of the project (`personas/`): checked only where it is present. */
const PERSONAS = new URL("../../personas/", import.meta.url);
const noPersonas = { skip: existsSync(PERSONAS) ? false : "no personas/ in this checkout" };

test("the personas are valid and build in a shipped style", noPersonas, async () => {
  for (const name of ["ayla", "vex", "real-world/ayla", "real-world/vex"]) {
    const persona = await loadPersona(fileURLToPath(new URL(`${name}.json`, PERSONAS)));
    assert.equal(persona.id, name.split("/").at(-1));
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

test("preferences name four different activities: one loved, one liked, one disliked, one hated", () => {
  const base = { id: "x", username: "Xena", displayName: "X", stance: "companion", description: "d", voice: "v" };
  const preferences = { loves: "farming", likes: "building", dislikes: "mob_combat", hates: "mining" };
  assert.deepEqual(personaSchema.parse({ ...base, preferences }).preferences, preferences);
  assert.equal(personaSchema.parse(base).preferences, undefined);
  assert.equal(personaSchema.safeParse({ ...base, preferences: { ...preferences, hates: "farming" } }).success, false, "the same activity twice");
  assert.equal(personaSchema.safeParse({ ...base, preferences: { loves: "farming", likes: "building", dislikes: "mob_combat" } }).success, false, "all four");
  assert.equal(personaSchema.safeParse({ ...base, preferences: { ...preferences, loves: "knitting" } }).success, false, "an activity of ours");
  assert.equal(personaSchema.safeParse({ ...base, preferences: { ...preferences, hates: "travelling" } }).success, false, "travelling is neutral");
  assert.equal(personaSchema.parse({ ...base, preferences: { ...preferences, loves: "following" } }).preferences?.loves, "following");
  assert.equal(personaSchema.safeParse({ ...base, aptitudes: { farmer: 0.5 } }).success, false, "aptitudes are gone");
});

test("the characters live differently: Ayla farms and builds, Vex mines and explores", noPersonas, async () => {
  const load = (name: string) => loadPersona(fileURLToPath(new URL(`${name}.json`, PERSONAS)));
  assert.deepEqual((await load("ayla")).preferences, { loves: "farming", likes: "building", dislikes: "mob_combat", hates: "mining" });
  assert.deepEqual((await load("vex")).preferences, { loves: "mining", likes: "exploring", dislikes: "building", hates: "farming" });
});
