import assert from "node:assert/strict";
import test from "node:test";
import { createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import { ZERO_ARENA, arenaFrame } from "../arena/frame.ts";
import { ANSWER_WALL_MS, afterClientTicks, afterServerTicks, answerArrives, answerSettled, serverQuiet } from "./server-answer.ts";
import { fakeContractSubject } from "./subject.ts";

function subjectOn() {
  const harness = createFakeBot({ clock: createFakeClock({ mode: "mocked" }) });
  return { harness, subject: fakeContractSubject(harness, arenaFrame(ZERO_ARENA)) };
}

test("afterServerTicks asks for the ticks it proves plus the 19 the age read at the call may be stale; serverQuiet is 21 proven", async () => {
  const { harness, subject } = subjectOn();
  using _installed = harness.clock.install();
  let age = harness.bot.time.age;
  await afterServerTicks(subject, 2, "a held key");
  assert.ok(harness.bot.time.age - age >= 21 && harness.bot.time.age - age < 41, `the age moved ${harness.bot.time.age - age} ticks`);
  age = harness.bot.time.age;
  await serverQuiet(subject, "a click");
  assert.ok(harness.bot.time.age - age >= 40, `the age moved ${harness.bot.time.age - age} ticks: two time packets`);
});

test("serverQuiet fails naming the wait when the server's ticks do not come within the wall bound", async () => {
  const { harness, subject } = subjectOn();
  using _installed = harness.clock.install();
  await subject.wait(1_500);
  harness.server.stop();
  const calledAt = subject.now();
  await assert.rejects(serverQuiet(subject, "after the click on slot 3"), new RegExp(`after the click on slot 3: the world age did not move 40 ticks within ${ANSWER_WALL_MS} ms: the server is stalled`));
  assert.ok(subject.now() - calledAt >= ANSWER_WALL_MS, "it waited the wall bound before it gave up");
});

test("serverQuiet holds through a stall of 900 ms inside it: the ticks come late, the wait still ends on them", async () => {
  const { harness, subject } = subjectOn();
  using _installed = harness.clock.install();
  await subject.wait(1_500);
  const age = harness.bot.time.age;
  harness.server.stop();
  setTimeout(() => harness.server.resume(), 900);
  await serverQuiet(subject, "a click in a stall");
  assert.ok(harness.bot.time.age - age >= 40, `the age moved ${harness.bot.time.age - age} ticks`);
});

test("answerArrives resolves as soon as the answer is there and fails naming what never came; answerSettled adds the server's ticks", async () => {
  const { harness, subject } = subjectOn();
  using _installed = harness.clock.install();
  let arrived = false;
  setTimeout(() => void (arrived = true), 300);
  const startedAt = subject.now();
  await answerArrives(subject, () => arrived, "the slot correction");
  assert.ok(subject.now() - startedAt < 400, "it did not wait the wall bound");
  const age = harness.bot.time.age;
  await answerSettled(subject, () => true, "the cursor packet");
  assert.ok(harness.bot.time.age - age >= 40, "the ticks came after the answer");
  await assert.rejects(answerArrives(subject, () => false, "the cursor packet"), new RegExp(`the cursor packet: no answer within ${ANSWER_WALL_MS} ms`));
});

test("afterClientTicks counts the client's own physics ticks and removes its listener", async () => {
  const { harness, subject } = subjectOn();
  using _installed = harness.clock.install();
  const listening = harness.bot.listenerCount("physicsTick");
  const startedAt = subject.now();
  await afterClientTicks(subject, 10, "the body");
  assert.ok(subject.now() - startedAt >= 450, `${subject.now() - startedAt} ms for 10 ticks of 50 ms`);
  assert.equal(harness.bot.listenerCount("physicsTick"), listening, "its listener is gone");
});
