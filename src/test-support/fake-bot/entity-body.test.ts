import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { entityBodyOf } from "./entity-body.js";

test("entityBodyOf makes a body of the spec's kind, position and metadata", () => {
  const metadata = [undefined, undefined, undefined, 7];
  const body = entityBodyOf(42, { name: "end_crystal", position: new Vec3(30, 80, 0), metadata });
  assert.equal(body.name, "end_crystal");
  assert.deepEqual(body.position, new Vec3(30, 80, 0));
  assert.equal(body.metadata[3], 7);
});

test("entityBodyOf makes a different object each call, also for the same id and kind", () => {
  const spec = { name: "end_crystal", position: new Vec3(0, 64, 0) };
  assert.notEqual(entityBodyOf(42, spec), entityBodyOf(42, spec));
});
