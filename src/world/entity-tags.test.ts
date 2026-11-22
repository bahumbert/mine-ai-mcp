import assert from "node:assert/strict";
import test from "node:test";
import { entityTagsOf } from "./entity-tags.js";

test("the entity tag `arrows` holds arrow and spectral_arrow on 1.21.4", () => {
  assert.ok(entityTagsOf("arrow", "1.21.4").includes("arrows"));
  assert.ok(entityTagsOf("spectral_arrow", "1.21.4").includes("arrows"));
  assert.ok(!entityTagsOf("snowball", "1.21.4").includes("arrows"));
});

test("a version is served its own file: `undead` exists from 1.20.4, not on 1.19.4; a newer patch takes the nearest older; unknowns have none", () => {
  // Measured in the server jars (task 2): 1.19.4 ships no `undead` entity tag, 1.20.4 does.
  assert.equal(entityTagsOf("zombie", "1.19.4").includes("undead"), false);
  assert.ok(entityTagsOf("zombie", "1.20.4").includes("undead"));
  assert.ok(entityTagsOf("zombie", "1.21.4").includes("undead"));
  assert.ok(entityTagsOf("arrow", "1.21.8").includes("arrows"));
  assert.deepEqual(entityTagsOf("arrow", "1.8.9"), []);
  assert.deepEqual(entityTagsOf("not_an_entity", "1.21.4"), []);
});
