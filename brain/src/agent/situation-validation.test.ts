// A concurrent situation must fence mutations made during work-reply validation too.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock, flush } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { describeStep, stepKey } from "../actions.ts";
import { CARRY, FETCH, HOME, ordinary, reaches, setup } from "./situation-fixtures.test.ts";

for (const carry of [false, true]) test(`work validation before a thrown reply is ${carry ? "committed" : "discarded"} after the held event`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const h = setup(clock);
  const work = ordinary(h, "Bob");
  const key = stepKey(FETCH.step);
  for (let i = 0; i < 2; i++) h.agent["failedSteps"].remember(work.objective, describeStep(FETCH.step), key, "blocked", "", h.runtime.snapshot.position);
  const workAnswer = h.hold();
  const eventAnswer = h.hold();
  // Content send-backs and format repairs have separate budgets: exhaust all three format attempts.
  h.action.reply(FETCH, "nope", "nope", "nope", carry ? CARRY : HOME);
  try {
    await h.start();
    await reaches(clock, () => h.action.requests.length === 1);
    await h.night();
    workAnswer();
    await flush();
    assert.equal(work.refused.size, 0, "the thrown reply is still behind the event fence");
    h.hold();
    eventAnswer();
    await reaches(clock, () => carry ? work.badReplies === 1 : h.runtime.submitted.some((call) => call.tool === "navigate"));
    assert.equal(work.refused.get(key) ?? 0, carry ? 1 : 0);
    assert.equal(work.badReplies, carry ? 1 : 0);
    assert.ok(h.stack.includes(work));
  } finally { await h.stop(); }
});
