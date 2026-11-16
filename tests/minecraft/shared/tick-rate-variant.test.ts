// A rate is applied after loading so template setup survives.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScenario, type Scenario } from "mine-labs";
import { settingsOf } from "../arena/settings.ts";
import { withTickRate } from "./tick-rate-variant.ts";

test("loaded template setup survives, explicit setup follows it, and the lane key carries the rate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tick-rate-"));
  try {
    const template = readFileSync(new URL("../templates/flat-single-action.yaml", import.meta.url), "utf8");
    writeFileSync(join(dir, "template.yaml"), `${template}\nsetup: ["difficulty normal"]\n`);
    const original = readFileSync(new URL("../contract/scenarios/air-supply-under-water.yaml", import.meta.url), "utf8");
    const yaml = original.replace("../../templates/flat-single-action.yaml", join(dir, "template.yaml"));
    const withoutSetup = yaml.replace(/setup:\n(?:  - .*\n)+/u, "");
    writeFileSync(join(dir, "scenario.yaml"), withoutSetup);
    const scenario = await loadScenario(join(dir, "scenario.yaml"));
    const variant = withTickRate(scenario, 10);
    assert.deepEqual(variant.scenario.setup, ["difficulty normal", "tick rate 10"]);
    assert.equal(variant.changed, true);
    assert.equal(settingsOf(variant.scenario, {}).settings.tickRate, 10);
    assert.deepEqual(withTickRate({ ...scenario, setup: ["time set noon"] }, 5).scenario.setup, ["time set noon", "tick rate 5"]);
    for (const [input, rate, reason] of [
      [{ ...scenario, setup: ["tick rate 2"] }, 10, "sets its own tick rate"],
      [{ ...scenario, tags: ["exclusive"] }, 10, "exclusive"],
      [scenario, 20, "already 20"],
    ] satisfies [Scenario, number, string][]) {
      assert.deepEqual(withTickRate(input, rate), { scenario: input, changed: false, reason });
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
