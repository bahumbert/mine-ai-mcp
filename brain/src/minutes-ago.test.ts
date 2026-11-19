import assert from "node:assert/strict";
import test from "node:test";
import { minutesAgo } from "./minutes-ago.ts";

const before = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

test("minutesAgo says just now, minutes, then hours, and tolerates a bad date", () => {
  assert.equal(minutesAgo(before(0)), "just now");
  assert.equal(minutesAgo(before(14)), "14 min ago");
  assert.equal(minutesAgo(before(180)), "3 h ago");
  assert.equal(minutesAgo("not a date"), "some time ago");
});
