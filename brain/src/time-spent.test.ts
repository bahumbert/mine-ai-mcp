import assert from "node:assert/strict";
import test from "node:test";
import { describeTime, lastOfPlay, minutesByActivity, minutesByPurpose, type ActivityTime } from "./time-spent.ts";

const at = (minutesAgo: number) => new Date(Date.parse("2026-10-03T12:00:00Z") - minutesAgo * 60_000).toISOString();
const now = Date.parse("2026-10-03T12:00:00Z");
const hourAgo = now - 60 * 60_000;

const records: ActivityTime[] = [
  { activity: "farming", ended: at(90), minutes: 20 },
  { activity: "building", ended: at(40), minutes: 15 },
  { activity: "farming", ended: at(10), minutes: 25 },
  { activity: "exploring", ended: at(2), minutes: 0.4 },
];

test("the last hour sums each activity's minutes, most first, older work dropped out", () => {
  assert.deepEqual(minutesByActivity(records, hourAgo), [
    { activity: "farming", minutes: 25 },
    { activity: "building", minutes: 15 },
    { activity: "exploring", minutes: 0.4 },
  ]);
  assert.equal(describeTime(minutesByActivity(records, hourAgo)), "farming 25 min, building 15 min, exploring under a minute");
});

test("a step that started before the window counts only its part inside it; without a window, everything counts", () => {
  const straddling: ActivityTime[] = [{ activity: "mining", ended: at(55), minutes: 20 }];
  assert.deepEqual(minutesByActivity(straddling, hourAgo), [{ activity: "mining", minutes: 5 }]);
  assert.equal(minutesByActivity(records)[0]!.minutes, 45);
  assert.equal(describeTime([]), "nothing yet");
});

test("the last hour is of play: summed back from the newest step, offline time not counted, the oldest cut to fit", () => {
  // 20 + 15 + 25 + 0.4 = 60.4 min of play: the oldest farming keeps 19.6 min, however long ago it was.
  const kept = lastOfPlay(records);
  assert.deepEqual(kept.map((record) => [record.activity, Number(record.minutes.toFixed(1))]), [["farming", 19.6], ["building", 15], ["farming", 25], ["exploring", 0.4]]);
  assert.deepEqual(lastOfPlay(records, 30).map((record) => record.activity), ["building", "farming", "exploring"]);
});

test("purpose minutes count a step for what its objective was for; an old record without one counts its own activity", () => {
  const spent: ActivityTime[] = [
    { activity: "woodcutting", purpose: "building", ended: at(30), minutes: 10 },
    { activity: "building", purpose: "building", ended: at(20), minutes: 0.5 },
    { activity: "travelling", purpose: "mining", ended: at(10), minutes: 2 },
    { activity: "farming", ended: at(5), minutes: 4 },
    { activity: "mining", ended: at(90), minutes: 30 },
  ];
  assert.deepEqual(minutesByPurpose(spent, hourAgo), [
    { activity: "building", minutes: 10.5 },
    { activity: "farming", minutes: 4 },
    { activity: "mining", minutes: 2 },
  ]);
  assert.deepEqual(minutesByActivity(spent, hourAgo).map((total) => total.activity), ["woodcutting", "farming", "travelling", "building"], "by kind of work is unchanged");
});
