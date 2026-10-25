import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot } from "../test-support/fake-bot/index.js";
import { findFlatPlacementCandidates } from "./placement-candidates.js";

test("finds supported flat footprints without placing through the player", () => {
  // Stone at y 63 and below under the feet, air above.
  const { bot } = createFakeBot({ position: new Vec3(0.8, 64, 0.5) });

  const candidates = findFlatPlacementCandidates(bot, [new Vec3(0, 0, 0), new Vec3(1, 0, 0)], 1);

  assert.ok(candidates.length > 0);
  assert.equal(
    candidates.some((origin) => origin.equals(new Vec3(1, 64, 0))),
    false,
  );
  assert.equal(
    candidates.every((origin) => origin.y === 64),
    true,
  );
});
