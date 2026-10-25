import assert from "node:assert/strict";
import test from "node:test";
import { ProtectedRegionStore } from "../../bot-data/protected-regions.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { createUnprotectRegionAction, parseUnprotectRegionRequest } from "../unprotect-region/index.js";
import { createProtectRegionAction, parseProtectRegionRequest } from "./index.js";

test("a region is given by two corners or by a centre and radius, never both or half of one", () => {
  assert.deepEqual(parseProtectRegionRequest({ corner_a: { x: 3, y: 70, z: -1 }, corner_b: { x: -2, y: 63, z: 4 }, label: "house", reason: "mine" }), {
    min: { x: -2, y: 63, z: -1 }, max: { x: 3, y: 70, z: 4 }, owner: null, label: "house", reason: "mine",
  });
  assert.deepEqual(parseProtectRegionRequest({ center: { x: 10, y: 64, z: 0 }, radius: 2, owner: "Tom", label: "Tom's place", reason: "he asked" }), {
    min: { x: 8, y: 62, z: -2 }, max: { x: 12, y: 66, z: 2 }, owner: "Tom", label: "Tom's place", reason: "he asked",
  });
  for (const input of [
    { label: "x", reason: "y" },
    { corner_a: { x: 0, y: 0, z: 0 }, label: "x", reason: "y" },
    { center: { x: 0, y: 0, z: 0 }, label: "x", reason: "y" },
    { corner_a: { x: 0, y: 0, z: 0 }, corner_b: { x: 1, y: 1, z: 1 }, radius: 1, label: "x", reason: "y" },
    { center: { x: 0, y: 0, z: 0 }, radius: 32, label: "x", reason: "y" },
    { center: { x: 0, y: 0, z: 0 }, radius: 1, label: " ", reason: "y" },
  ]) {
    assert.throws(() => parseProtectRegionRequest(input), JSON.stringify(input));
  }
  assert.throws(() => parseUnprotectRegionRequest({ region_id: 0 }));
});

test("protecting stores the region for this bot by default, again returns it, and unprotecting removes it", async (t) => {
  const { bot } = createFakeBot({ username: "Ayla" });
  const regions = new ProtectedRegionStore(temporaryBotData({ closeAfter: t }));
  const protect = createProtectRegionAction(bot, regions);
  const unprotect = createUnprotectRegionAction(regions);
  assert.equal(protect.execution.kind, "concurrent");
  const input = { corner_a: { x: -6, y: 63, z: -3 }, corner_b: { x: 0, y: 70, z: 3 }, label: "small medieval house", reason: "My own house." };

  const first = await protect.execute(protect.parse(input), {});
  protect.resultSchema.parse(first);
  assert.deepEqual(first, {
    status: "succeeded", created: true,
    region: { regionId: 1, dimension: "overworld", min: { x: -6, y: 63, z: -3 }, max: { x: 0, y: 70, z: 3 }, owner: "Ayla", label: "small medieval house" },
  });
  assert.equal(protect.formatResult(first), "Stored protected region #1 'small medieval house' (owner Ayla): -6,63,-3 to 0,70,3 in `overworld`.");
  const again = await protect.execute(protect.parse(input), {});
  assert.equal(again.status === "succeeded" && again.created, false);

  const tooLarge = await protect.execute(protect.parse({ ...input, corner_b: { x: 70, y: 70, z: 3 } }), {});
  assert.deepEqual(tooLarge, { status: "failed", error: "[REGION_TOO_LARGE] A side of 77 blocks is over the 64-block limit.", region: null, created: false });

  const removed = await unprotect.execute(unprotect.parse({ region_id: 1 }), {});
  unprotect.resultSchema.parse(removed);
  assert.equal(removed.status, "succeeded");
  assert.deepEqual(await unprotect.execute(unprotect.parse({ region_id: 1 }), {}), {
    status: "failed", error: "[REGION_NOT_FOUND] There is no protected region #1.", region: null,
  });
  assert.deepEqual(regions.list(), []);
});
