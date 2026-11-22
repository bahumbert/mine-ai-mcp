import test from "node:test";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { arrangedEntityId, navigateWithRelease } from "../flat/combat/combat-handoff.ts";

test("release selects the declared entity, not an unrelated nearby mob of the same type", () => {
  const entities = [
    { id: 1, name: "creeper", position: new Vec3(5, 64, 0) },
    { id: 2, name: "creeper", position: new Vec3(0.7, 64, 0.5) },
  ];
  assert.equal(arrangedEntityId(entities, { type: "creeper", pos: [0.7, 64, 0.5] }, new Set()), 2);
  assert.equal(arrangedEntityId(entities, { type: "creeper", pos: [10, 64, 0] }, new Set()), undefined);
});

test("release failure aborts and waits for the started navigation to settle", async () => {
  let settled = false;
  const failure = new Error("release failed");
  const start = (signal: AbortSignal) => new Promise<void>((resolve) => {
    signal.addEventListener("abort", () => queueMicrotask(() => { settled = true; resolve(); }), { once: true });
  });
  await assert.rejects(navigateWithRelease(start, async () => { throw failure; }, new AbortController().signal), failure);
  assert.equal(settled, true);
});
