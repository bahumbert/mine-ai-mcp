import assert from "node:assert/strict";
import test from "node:test";
import { captureStderr } from "../test-support/stderr.js";
import { guardObservedWrite } from "./observed-write.js";

const failing = (message: string) => () => {
  throw new Error(message);
};

test("a throwing write is caught and logged once per distinct message", (t) => {
  const lines = captureStderr(t);
  const guard = guardObservedWrite("player-events");
  guard(failing("database is locked"));
  guard(failing("database is locked"));
  guard(failing("disk is full"));
  guard(failing("disk is full"));
  guard(failing("database is locked"));
  assert.deepEqual(lines, [
    "[player-events] database is locked\n",
    "[player-events] disk is full\n",
    "[player-events] database is locked\n",
  ]);
});

test("a success after a failure lets the same message be logged again", (t) => {
  const lines = captureStderr(t);
  const guard = guardObservedWrite("equipment-events");
  let written = 0;
  guard(failing("database is locked"));
  guard(() => { written += 1; });
  guard(failing("database is locked"));
  assert.equal(written, 1, "a write that succeeds still runs");
  assert.deepEqual(lines, ["[equipment-events] database is locked\n", "[equipment-events] database is locked\n"]);
});

test("two sources keep separate last messages", (t) => {
  const lines = captureStderr(t);
  const players = guardObservedWrite("player-events");
  const navigation = guardObservedWrite("navigation-events");
  players(failing("database is locked"));
  navigation(failing("database is locked"));
  players(failing("database is locked"));
  navigation(failing("database is locked"));
  assert.deepEqual(lines, ["[player-events] database is locked\n", "[navigation-events] database is locked\n"]);
});

test("two guards of one source (two bots) keep separate last messages", (t) => {
  const lines = captureStderr(t);
  const first = guardObservedWrite("player-events");
  const second = guardObservedWrite("player-events");
  first(failing("database is locked"));
  second(failing("database is locked"));
  assert.equal(lines.length, 2, "a failure on one bot's store does not silence another bot's");
});

test("a storm of 100 identical failures logs one line and never throws", (t) => {
  const lines = captureStderr(t);
  const guard = guardObservedWrite("player-events");
  for (let call = 0; call < 100; call += 1) guard(failing("database is locked"));
  assert.equal(lines.length, 1);
});

test("a thrown value that is not an Error is logged by its text", (t) => {
  const lines = captureStderr(t);
  guardObservedWrite("bot-status")(() => { throw "SQLITE_FULL"; });
  assert.deepEqual(lines, ["[bot-status] SQLITE_FULL\n"]);
});
