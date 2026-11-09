import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { sourceImports } from "../../test-support/imports.js";

// check-reads: src/survival/policy/**/*.ts, src/survival/perception/**/*.ts, src/survival/responses/**/*.ts
const survival = fileURLToPath(new URL("../", import.meta.url));

test("survival policy selects from facts without importing the bot, mutable stores or physical execution", () => {
  const invalid = sourceImports(survival, "policy").filter(({ from, target, typeOnly }) => {
    if (target === "mineflayer") return true;
    if (typeOnly) return false;
    // Food and combat data/formulas are immutable facts; legacy replay also needs version and reach constants.
    return !(
      target.startsWith("policy/") ||
      target === "../world/food.js" ||
      target === "../world/combat-data.js" ||
      target === "perception/combat/threat-assessment.js" ||
      (from === "policy/combat/replay.ts" && (target === "weapons/equipment.js" || target === "../server/config.js")) ||
      target === "zod" ||
      target === "node:util"
    );
  });
  assert.deepEqual(invalid, []);
});

test("survival observations cannot import execution, body ownership or the live policy store", () => {
  const invalid = sourceImports(survival, "perception").filter(
    ({ target, typeOnly }) =>
      !typeOnly &&
      (target.startsWith("responses/") ||
        target.startsWith("reflexes/") ||
        target.startsWith("baseline/") ||
        target.startsWith("guards/") ||
        target.startsWith("control/") ||
        target.startsWith("../session/") ||
        target.startsWith("../actions/") ||
        target === "state/survival-policy.js"),
  );
  assert.deepEqual(invalid, []);
});

test("physical responses cannot register reflexes or own an idle baseline", () => {
  const invalid = sourceImports(survival, "responses").filter(
    ({ target, typeOnly }) =>
      !typeOnly &&
      (target.startsWith("reflexes/") ||
        target.startsWith("baseline/") ||
        target.startsWith("guards/") ||
        target === "control/driver.js" ||
        target === "../session/action-runner.js"),
  );
  assert.deepEqual(invalid, [], "Runtime attaches lifetimes; physical responses execute under the admitted signal.");
});
