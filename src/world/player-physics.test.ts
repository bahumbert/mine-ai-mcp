// `footprintStandsOnCell`: the geometry of a 0.6-wide body over a cell column (plan 2026-11-15-p4-34-cleanup-footprint T1).
import assert from "node:assert/strict";
import test from "node:test";
import { footprintStandsOnCell } from "./player-physics.js";

const CELL = { x: 1, y: 64, z: 0 };
const none = () => false;
/** The columns holding a body-carrying block at the cell's height, as "x,z". */
const carrying = (...columns: string[]) => (x: number, _y: number, z: number) => columns.includes(`${x},${z}`);

// Arrival x 2.19 is the nearest end of the cleanup's walk measured on the 16 probe runs (cell x + 1.19, run `uadb` of
// rc-lava/probe-15runs.log); the z positions mirror the x ones (not measured: the probe only walked along x).
for (const [name, feet, carriedBy, stands] of [
  ["centre over the open column beside the step", { x: 0.85, z: 0.5 }, none, true],
  ["centred on the step", { x: 1.5, z: 0.5 }, none, true],
  ["centre over the bank, footprint clear of the step", { x: 2.5, z: 0.5 }, none, false],
  ["the same on z: centre past the step", { x: 1.5, z: -0.15 }, none, true],
  ["the same on z: centre over the bank", { x: 1.5, z: 1.5 }, none, false],
  ["a corner of the step", { x: 0.85, z: -0.15 }, none, true],
  ["a footprint that only touches the boundary", { x: 0.7, z: 0.5 }, none, false],
  ["over the step's edge with a solid neighbour column", { x: 2.19, z: 0.5 }, carrying("2,0"), false],
  ["the same feet with the neighbour column open", { x: 2.19, z: 0.5 }, none, true],
  ["a corner with one of three overlapped columns carrying", { x: 0.85, z: -0.15 }, carrying("0,-1"), false],
  ["a carrying column the footprint does not reach", { x: 1.5, z: 0.5 }, carrying("2,0", "0,0"), true],
] as const) {
  test(`footprintStandsOnCell: ${name} -> ${stands}`, () => {
    assert.equal(footprintStandsOnCell({ ...feet, y: CELL.y + 1 }, CELL, carriedBy), stands);
  });
}
