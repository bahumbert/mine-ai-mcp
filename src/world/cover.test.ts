import assert from "node:assert/strict";
import test from "node:test";
import { coverOver } from "./cover.js";

test("cover needs loaded solid non-leaf blocks above the head, including tall cave ceilings and the build top", () => {
  const cell = { x: 2, y: 64, z: -3 };
  for (const { height, solid, tags, top, want } of [
    { height: 69, solid: true, tags: [], top: 319, want: true },
    { height: 69, solid: true, tags: ["leaves"], top: 319, want: false },
    { height: 69, solid: false, tags: [], top: 319, want: false },
    { height: 104, solid: true, tags: [], top: 319, want: true },
    { height: 319, solid: true, tags: [], top: 319, want: true },
    { height: 320, solid: true, tags: [], top: 319, want: false },
    { height: 65, solid: true, tags: [], top: 319, want: false },
    { height: 66, solid: true, tags: [], top: 319, want: true },
  ]) {
    const read = (x: number, y: number, z: number) => x === 2 && z === -3 && y === height ? { solid, tags } : null;
    assert.equal(coverOver(read, cell, top), want, JSON.stringify({ height, solid, tags }));
  }
  assert.equal(coverOver(() => null, cell, 319), false);
});
