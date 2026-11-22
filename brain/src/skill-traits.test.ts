// The skill traits: which skills finish in place and which answer the night, over every skill name (spec 2026-11-15-p4-18 D2).
import assert from "node:assert/strict";
import test from "node:test";
import * as actions from "./actions.ts";

type Traits = Readonly<Record<string, { readonly finishesInPlace?: true; readonly answersNight?: true }>>;

test("every skill has a traits entry and only eat, equip, sleep and dig_shelter carry one", () => {
  // Read through the namespace so a missing export fails this assertion, not the module load.
  const traits = (actions as { SKILL_TRAITS?: Traits }).SKILL_TRAITS;
  assert.ok(traits, "actions.ts exports SKILL_TRAITS");
  assert.deepEqual(Object.keys(traits).sort(), [...actions.SKILL_NAMES].sort());
  const carrying = Object.entries(traits)
    .filter(([, entry]) => Object.keys(entry).length > 0)
    .map(([skill, entry]) => [skill, entry])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));
  assert.deepEqual(carrying, [
    ["dig_shelter", { answersNight: true }],
    ["eat", { finishesInPlace: true }],
    ["equip", { finishesInPlace: true }],
    ["sleep", { finishesInPlace: true }],
  ]);
});
