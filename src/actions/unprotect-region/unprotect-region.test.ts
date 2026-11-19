import assert from "node:assert/strict";
import test from "node:test";
import { ProtectedRegionStore } from "../../bot-data/protected-regions.js";
import { persistentBotData } from "../../test-support/bot-data.js";
import { createUnprotectRegionAction } from "./index.js";

test("a region another bot holds is refused with [REGION_NOT_HELD] naming its holder, and stays", async (t) => {
  const storage = persistentBotData(t);
  const ayla = new ProtectedRegionStore(storage.open("shared-world"), "Ayla");
  const tom = new ProtectedRegionStore(storage.open("shared-world"), "Tom");
  tom.protect({
    dimension: "overworld", min: { x: 0, y: 63, z: 0 }, max: { x: 5, y: 70, z: 5 },
    owner: "Tom", label: "Tom's place", reason: "his", createdBy: "Tom",
  });
  ayla.refresh();
  const unprotect = createUnprotectRegionAction(ayla);
  const result = await unprotect.execute(unprotect.parse({ region_id: 1 }), {});
  unprotect.resultSchema.parse(result);
  assert.equal(result.status, "failed");
  assert.equal("error" in result && result.error.startsWith("[REGION_NOT_HELD]"), true);
  assert.match("error" in result ? result.error : "", /Tom/);
  assert.equal(result.region, null);
  assert.equal(ayla.list().length, 1, "the region is still there");
  assert.equal(unprotect.formatResult(result).startsWith("**Not removed:** [REGION_NOT_HELD]"), true);
});

test("an own region is removed and reported without its internal fields", async (t) => {
  const storage = persistentBotData(t);
  const ayla = new ProtectedRegionStore(storage.open("shared-world"), "Ayla");
  ayla.protect({
    dimension: "overworld", min: { x: 0, y: 63, z: 0 }, max: { x: 5, y: 70, z: 5 },
    owner: "Ayla", label: "house", reason: "mine", createdBy: "Ayla",
  });
  const unprotect = createUnprotectRegionAction(ayla);
  const result = await unprotect.execute(unprotect.parse({ region_id: 1 }), {});
  unprotect.resultSchema.parse(result);
  assert.equal(result.status, "succeeded");
  assert.deepEqual(ayla.list(), []);
});
