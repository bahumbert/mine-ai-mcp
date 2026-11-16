import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { STYLES } from "./building/styles.ts";
import { loadPersona, personaSchema, personaSkills } from "./persona.ts";

/** The characters are not shipped with the code (`personas/`): checked only where they are present. */
const PERSONAS = new URL("../../personas/", import.meta.url);
const PERSONAS_DIR = fileURLToPath(PERSONAS);
const noPersonas = { skip: existsSync(PERSONAS) ? false : "no personas/ in this checkout" };

test("sign line length defaults to 15", () => {
  const base = { id: "x", username: "Xena", displayName: "X", stance: "companion", description: "d", voice: "v" };
  assert.equal(personaSchema.parse(base).settings.signLineChars, 15);
  assert.equal(personaSchema.safeParse({ ...base, settings: { signLineChars: 4 } }).success, false);
  assert.equal(personaSchema.safeParse({ ...base, settings: { signLineChars: 46 } }).success, false);
});

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

test("a persona file that still carries the removed step time limit parses; the setting does nothing", () => {
  const base = { id: "x", username: "Xena", displayName: "X", stance: "companion", description: "d", voice: "v" };
  assert.equal(personaSchema.parse(base).settings.maxStepMinutes, undefined);
  assert.equal(personaSchema.safeParse({ ...base, settings: { maxStepMinutes: 10 } }).success, true);
});

test("feeling multipliers default to the owner's pick and each may be set from 0 to 10 (spec 2026-10-09-activity-draw)", () => {
  const base = { id: "x", username: "Xena", displayName: "X", stance: "companion", description: "d", voice: "v" };
  const defaults = { loves: 2, likes: 1.5, neutral: 1, dislikes: 0.6, hates: 0.3 };
  assert.deepEqual(personaSchema.parse(base).settings.feelingMultipliers, defaults);
  assert.deepEqual(personaSchema.parse({ ...base, settings: {} }).settings.feelingMultipliers, defaults);
  assert.deepEqual(personaSchema.parse({ ...base, settings: { feelingMultipliers: { loves: 5, hates: 0 } } }).settings.feelingMultipliers, { ...defaults, loves: 5, hates: 0 }, "the others keep their defaults");
  assert.equal(personaSchema.parse({ ...base, settings: { feelingMultipliers: { neutral: 10 } } }).settings.feelingMultipliers.neutral, 10);
  assert.equal(personaSchema.safeParse({ ...base, settings: { feelingMultipliers: { loves: 11 } } }).success, false, "above 10");
  assert.equal(personaSchema.safeParse({ ...base, settings: { feelingMultipliers: { hates: -0.1 } } }).success, false, "below 0");
  assert.equal(personaSchema.safeParse({ ...base, settings: { feelingMultipliers: { adores: 3 } } }).success, false, "a feeling of ours");
});

test("a persona allowed to build may improve its house too", () => {
  const base = { id: "x", username: "Xena", displayName: "X", stance: "companion", description: "d", voice: "v" };
  assert.deepEqual(personaSkills(personaSchema.parse({ ...base, skills: ["go_to", "build"] })), ["go_to", "build", "improve_house"]);
  assert.deepEqual(personaSkills(personaSchema.parse({ ...base, skills: ["go_to"] })), ["go_to"]);
  assert.ok(personaSkills(personaSchema.parse(base)).includes("improve_house"));
});

const BOLDNESS_VALUES = ["cautious", "steady", "bold"];
const fixtureBase = { id: "x", username: "Xena", displayName: "X", stance: "companion", description: "d", voice: "v" };

const TMPFS_DIRECTORY = "/dev/shm";

/** A temporary folder for fixture personas on tmpfs when the machine has one, removed when the test ends (the private catalog is never written). */
async function withFixtureFolder(run: (folder: string) => Promise<void>): Promise<void> {
  const parent = existsSync(TMPFS_DIRECTORY) ? TMPFS_DIRECTORY : tmpdir();
  const folder = await mkdtemp(join(parent, "persona-test-"));
  try {
    await run(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test("boldness defaults to steady", () => {
  assert.equal(personaSchema.parse(fixtureBase).boldness, "steady");
});

test("boldness takes cautious, steady or bold", () => {
  for (const boldness of BOLDNESS_VALUES) {
    assert.equal(personaSchema.parse({ ...fixtureBase, boldness }).boldness, boldness);
  }
});

test("the loader takes cautious and bold, and refuses another boldness", () => withFixtureFolder(async (folder) => {
  assert.equal(personaSchema.safeParse({ ...fixtureBase, boldness: "steady" }).success, true, "a listed value is accepted");
  for (const boldness of ["cautious", "bold"]) {
    const path = join(folder, `${boldness}.json`);
    await writeFile(path, JSON.stringify({ ...fixtureBase, boldness }));
    assert.equal((await loadPersona(path)).boldness, boldness);
  }
  const path = join(folder, "brave.json");
  await writeFile(path, JSON.stringify({ ...fixtureBase, boldness: "brave" }));
  await assert.rejects(loadPersona(path), /\[PERSONA_INVALID\]/u);
}));

test("an old shelterAtNight setting parses but does nothing", () => {
  assert.equal(personaSchema.parse({ ...fixtureBase, settings: { shelterAtNight: false } }).settings.shelterAtNight, false);
  assert.equal(personaSchema.parse(fixtureBase).settings.shelterAtNight, undefined);
});

/** Every persona file of the private catalog: `personas/*.json` and `personas/real-world/*.json`, where present. */
function catalogFiles(): string[] {
  const folders = [PERSONAS_DIR, join(PERSONAS_DIR, "real-world")].filter((folder) => existsSync(folder));
  return folders.flatMap((folder) => readdirSync(folder).filter((name) => name.endsWith(".json")).map((name) => join(folder, name)));
}

test("every persona file in the private catalog states its boldness itself, one of the three values", noPersonas, async () => {
  const files = catalogFiles();
  assert.ok(files.length > 0, "the catalog has files");
  for (const file of files) {
    assert.ok(Object.hasOwn(JSON.parse(readFileSync(file, "utf8")), "boldness"), file);
    assert.ok(BOLDNESS_VALUES.includes((await loadPersona(file)).boldness), file);
  }
});
