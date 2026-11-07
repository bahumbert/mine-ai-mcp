import assert from "node:assert/strict";
import test from "node:test";
import { cropStage, describeStage } from "./growth.ts";

// Keys are `tend_crops` evidence: `<block> age <n>`, ` ripe` appended when ripe (src/actions/tend-crops/contract.ts).

test("stage is the mean age of the farm's crop", () => {
  assert.deepEqual(cropStage({ "wheat age 3": 6, "wheat age 7 ripe": 2 }, 7, "wheat"), { stage: 4, ripeAge: 7 });
});

test("no crop standing gives no stage", () => {
  assert.equal(cropStage({}, 7, "wheat"), null);
  assert.equal(cropStage({ "carrots age 1": 3 }, 7, "wheat"), null);
});

test("a block whose name starts like another is not mixed with it", () => {
  assert.deepEqual(cropStage({ "beetroots age 1": 2, "beet age 7": 5 }, 3, "beetroots"), { stage: 1, ripeAge: 3 });
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
