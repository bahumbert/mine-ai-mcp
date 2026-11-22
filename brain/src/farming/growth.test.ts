import assert from "node:assert/strict";
import test from "node:test";
import * as growth from "./growth.ts";
import type { KnownFarm } from "../memory.ts";
const { cropStage, describeStage, nextPace, ripeInNearMinutes, describeGrowthSince } = growth;

// Keys are `tend_crops` evidence: `<block> age <n>`, ` ripe` appended when ripe (src/actions/tend-crops/contract.ts).

test("stage averages the farm's crop without mixing crop-name prefixes", () => {
  for (const [crops, ripeAge, block, stage] of [
    [{ "wheat age 3": 6, "wheat age 7 ripe": 2 }, 7, "wheat", 4],
    [{ "beetroots age 1": 2, "beet age 7": 5 }, 3, "beetroots", 1],
  ] as const) assert.deepEqual(cropStage(crops, ripeAge, block), { stage, ripeAge });
});

test("no crop standing gives no stage", () => {
  assert.equal(cropStage({}, 7, "wheat"), null);
  assert.equal(cropStage({ "carrots age 1": 3 }, 7, "wheat"), null);
});

test("describeStage wording", () => {
  assert.equal(describeStage({ planted: 24, ripe: 0, empty: 0, stage: 3, ripeAge: 7 }), "at stage 3.0 of 7");
  assert.equal(
    describeStage({ planted: 24, ripe: 0, empty: 0, stage: 3, ripeAge: 7, dry: 2 }),
    "at stage 3.0 of 7, 2 dry farmland (grows slower; water within 4 blocks hydrates it)",
  );
  assert.equal(
    describeStage({ planted: 0, ripe: 0, empty: 5, dry: 5 }),
    "5 dry farmland (grows slower; water within 4 blocks hydrates it)",
  );
  assert.equal(describeStage({ planted: 24, ripe: 0, empty: 0, dry: 0 }), "");
  assert.equal(describeStage({ planted: 24, ripe: 0, empty: 0 }), "");
});

const growing: KnownFarm = { crop: "wheat_seeds", size: 3, centre: { x: 0, y: 63, z: 0 }, madeAt: "t0", tendedAt: "t0", state: { planted: 8, ripe: 0, empty: 0, stage: 2, ripeAge: 7 }, pace: 0.12 };

test("pace per near-minute uses only a fresh nondecreasing reading with a known near-minute", () => {
  const previous = { ...growing, state: { ...growing.state, stage: 0 } };
  for (const [name, farm, stage, near, want] of [
    ["pace per near-minute", previous, 2, { near: 20, unknown: 0, since: 20 }, 0.1],
    ["any unknown time measures no pace", previous, 2, { near: 20, unknown: 3, since: 23 }, 0.12],
    ["under a near-minute measures no pace", previous, 2, { near: 0.5, unknown: 0, since: 1 }, 0.12],
    ["a stage drop measures no pace", growing, 1, { near: 20, unknown: 0, since: 20 }, 0.12],
    ["a stale reading measures no pace", { ...previous, paceFresh: false }, 2, { near: 20, unknown: 0, since: 20 }, 0.12],
    ["an empty before measures no pace", previous, null, { near: 20, unknown: 0, since: 20 }, 0.12],
    ["a restart measures no pace", previous, 2, null, 0.12],
    ["no previous tend measures no pace", undefined, 2, { near: 20, unknown: 0, since: 20 }, undefined],
  ] as const) assert.equal(nextPace(farm, stage, near), want, name);
});

test("ripe in near-minutes needs a positive measured pace and a known stage and near time", () => {
  const farm = { ...growing, state: { ...growing.state, stage: 3 }, pace: 0.1 };
  const near = { near: 10, unknown: 0, since: 30 };
  assert.equal(ripeInNearMinutes(farm, near), 30);
  assert.ok(ripeInNearMinutes({ ...farm, state: { ...farm.state, stage: 7 } }, near)! <= 0);
  for (const pace of [undefined, 0]) assert.equal(ripeInNearMinutes({ ...farm, pace }, near), null);
  assert.equal(ripeInNearMinutes(farm, null), null);
  assert.equal(ripeInNearMinutes({ ...farm, state: { planted: 8, ripe: 0, empty: 0 } }, near), null);
});

test("describeGrowthSince wording", () => {
  const near = { near: 6, unknown: 0, since: 30 };
  const start = "stage 2.0/7; tend 30 min ago; near 6 min";
  assert.equal(describeGrowthSince(growing, 30, near), `${start}; seen pace 1.2 stages/10 near-min; ripe in ~36 more near-min`);
  assert.equal(describeGrowthSince({ ...growing, pace: 1 }, 30, near), `${start}; seen pace: ripe now`);
  assert.equal(describeGrowthSince({ ...growing, pace: undefined }, 30, near), `${start}; pace unknown`);
  assert.equal(describeGrowthSince({ ...growing, pace: 0 }, 30, near), `${start}; seen pace 0; ripe time unknown`);
  assert.equal(describeGrowthSince(growing, 30, null), "stage 2.0/7; tend 30 min ago; near time unknown");
});
