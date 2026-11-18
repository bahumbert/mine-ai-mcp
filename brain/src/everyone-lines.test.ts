import assert from "node:assert/strict";
import test from "node:test";
import { EveryoneLines } from "./everyone-lines.ts";
import { FakeRuntime } from "./testing.ts";

function lines() {
  const clock = { now: 0 };
  return { clock, lines: new EveryoneLines(() => clock.now) };
}

test("the bot nearest the speaker claims the line, the others cannot", () => {
  const { lines: record } = lines();
  record.heard("Steve", "sups boys ?", "Vex", 30);
  record.heard("Steve", "sups boys ?", "Ayla", 5);
  assert.equal(record.claim("Steve", "sups boys ?", "Vex"), false);
  assert.equal(record.claim("Steve", "sups boys ?", "Ayla"), true);
});

test("a tie in distance goes to the name that sorts first, case aside", () => {
  const { lines: record } = lines();
  record.heard("Steve", "hi", "vex", 10);
  record.heard("Steve", "hi", "Ayla", 10);
  assert.equal(record.claim("Steve", "hi", "vex"), false);
  assert.equal(record.claim("Steve", "hi", "Ayla"), true);
});

test("unknown distances rank after every number, and all unknown falls to the name", () => {
  const { lines: record } = lines();
  record.heard("Steve", "hi", "Ayla", null);
  record.heard("Steve", "hi", "Vex", 80);
  assert.equal(record.claim("Steve", "hi", "Ayla"), false);
  assert.equal(record.claim("Steve", "hi", "Vex"), true);

  record.heard("Steve", "yo", "Vex", null);
  record.heard("Steve", "yo", "Ayla", null);
  assert.equal(record.claim("Steve", "yo", "Vex"), false);
  assert.equal(record.claim("Steve", "yo", "Ayla"), true);
});

test("a later number replaces an unknown distance, and a later unknown never erases a number", () => {
  const { lines: record } = lines();
  record.heard("Steve", "hi", "Ayla", null);
  record.heard("Steve", "hi", "Vex", 20);
  record.heard("Steve", "hi", "Ayla", 4);
  record.heard("Steve", "hi", "Vex", null);
  assert.equal(record.claim("Steve", "hi", "Vex"), false);
  assert.equal(record.claim("Steve", "hi", "Ayla"), true);
});

test("a bot keeps the smallest distance it reported", () => {
  const { lines: record } = lines();
  record.heard("Steve", "hi", "Ayla", 40);
  record.heard("Steve", "hi", "Vex", 20);
  record.heard("Steve", "hi", "Ayla", 10);
  record.heard("Steve", "hi", "Ayla", 50);
  assert.equal(record.claim("Steve", "hi", "Ayla"), true);
});

test("a second claim is false, even from a nearer bot heard later or from the claimer itself", () => {
  const { lines: record } = lines();
  record.heard("Steve", "hi", "Vex", 30);
  assert.equal(record.claim("Steve", "hi", "Vex"), true);
  record.heard("Steve", "hi", "Ayla", 2);
  assert.equal(record.claim("Steve", "hi", "Ayla"), false);
  assert.equal(record.claim("Steve", "hi", "Vex"), false);
});

test("the line is forgotten 60 s after it was first heard, and can be claimed again", () => {
  const { clock, lines: record } = lines();
  record.heard("Steve", "hi", "Vex", 30);
  assert.equal(record.claim("Steve", "hi", "Vex"), true);
  clock.now = 59_999;
  assert.equal(record.claim("Steve", "hi", "Vex"), false);
  clock.now = 60_001;
  record.heard("Steve", "hi", "Vex", 30);
  assert.equal(record.claim("Steve", "hi", "Vex"), true);
});

test("two speakers saying the same text are two lines; the speaker's case does not matter", () => {
  const { lines: record } = lines();
  record.heard("Steve", "hi", "Vex", 30);
  record.heard("Bob", "hi", "Vex", 30);
  assert.equal(record.claim("Steve", "hi", "Vex"), true);
  assert.equal(record.claim("Bob", "hi", "Vex"), true);
  assert.equal(record.claim("STEVE", "hi", "Vex"), false);
});

test("claimFor keys the distance and the claim on the newest raw line, so a bot that merged lines is compared on the same line", () => {
  const { lines: record } = lines();
  const lookAt = (steveAt: number) => ({ ...new FakeRuntime().snapshot, position: { x: 0, y: 64, z: 0 }, players: [{ username: "Steve", position: { x: steveAt, y: 64, z: 0 } }] });
  const line = (message: string) => ({ username: "Steve", channel: "chat" as const, message, addressed: false });
  // Both bots heard "hi" and "everyone" as raw lines (no distance known); the nearer one merged them into one message.
  for (const bot of ["Ayla", "Vex"]) for (const text of ["hi", "everyone"]) record.heard("Steve", text, bot, null);
  const near = record.claimFor(line("hi everyone"), lookAt(5), "Ayla", "everyone");
  const far = record.claimFor(line("everyone"), lookAt(30), "Vex", "everyone");
  assert.equal(far?.(), false, "the farther bot does not win the line");
  assert.equal(near?.(), true, "the nearer bot answers, whatever it merged");
  assert.equal(record.claimFor({ ...line("hi"), channel: "whisper" }, lookAt(5), "Ayla", "hi"), undefined, "only public chat is a line to everyone");
});

test("a bot that never reported hearing the line still claims it when nobody else heard it", () => {
  const { lines: record } = lines();
  assert.equal(record.claim("Steve", "hi", "Vex"), true);
});
