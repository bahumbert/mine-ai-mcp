import assert from "node:assert/strict";
import test from "node:test";
import { outranksReflex, REFLEX_PRIORITY } from "./priority.js";

test("each reflex outranks the next one in the priority order and is outranked by the one before", () => {
  const ORDER = ["fire_reflex", "breath_reflex", "recover_footing", "dragon_reflex", "hostile_reflex", "hunger_reflex"];
  for (let i = 0; i < ORDER.length - 1; i++) {
    assert.equal(outranksReflex(ORDER[i]!, ORDER[i + 1]!), true, `${ORDER[i]} must outrank ${ORDER[i + 1]}`);
    assert.equal(outranksReflex(ORDER[i + 1]!, ORDER[i]!), false, `${ORDER[i + 1]} must not outrank ${ORDER[i]}`);
  }
  for (const name of ORDER) assert.equal(outranksReflex(name, name), false, `${name} must not outrank itself`);
  assert.deepEqual([...REFLEX_PRIORITY], ORDER);
});
