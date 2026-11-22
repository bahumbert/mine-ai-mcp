/** Sign contract answers at both mandatory fake server rates and a stopped clock. */
import assert from "node:assert/strict";
import test from "node:test";
import { ZERO_ARENA, arenaFrame } from "../arena/frame.ts";
import { signEdit } from "./checks/sign-edit.ts";
import { fakeHarnessFor } from "./fake-harness.ts";
import { ANSWER_WALL_MS, serverQuiet } from "./server-answer.ts";
import { fakeContractSubject } from "./subject.ts";

for (const ticksPerSecond of [20, 10]) {
  test(`sign-edit contract holds and its stalled wait is bounded at ${ticksPerSecond} tps`, async () => {
    const frame = arenaFrame(ZERO_ARENA);
    const harness = fakeHarnessFor(signEdit.fixture, frame, { ticksPerSecond });
    using _installed = harness.clock.install();
    const subject = fakeContractSubject(harness, frame);
    const age = harness.bot.time.age;
    harness.server.stop();
    const started = subject.now();
    await assert.rejects(serverQuiet(subject, "sign answer"), /sign answer:.*server is stalled/);
    assert.equal(harness.bot.time.age, age);
    assert.ok(subject.now() - started >= ANSWER_WALL_MS);
    harness.server.resume();
    await signEdit.run(subject);
  });
}
