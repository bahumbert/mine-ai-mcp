/**
 * The checks that wait for a server's answer hold when the answer is late (the fake's `lagMs` delays every answer, not the time
 * packets: a stall that freezes the ticks too is in `server-answer.test.ts`), and a check that waits for an absence fails, not
 * passes, when the server's ticks do not come: a wall wait of 0.7-1 s read too early on the one and proved nothing on the other.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ZERO_ARENA, arenaFrame } from "../arena/frame.ts";
import { CONTRACT_CHECKS } from "./checks.ts";
import { fakeHarnessFor } from "./fake-harness.ts";
import { fakeContractSubject } from "./subject.ts";

const FRAME = arenaFrame(ZERO_ARENA);
/** Longer than the 1 s (and 0.7 s) wall waits these checks had before the answers were awaited. */
const LATE_ANSWER_MS = 1_500;
/**
 * Checks that wait for an answer the server sends (each was red on the old 0.7-1 s waits under this lag) and whose other server calls
 * (`hurtBot`, `summonItem`...) a late fake does not hold. `chest-open-take-close` and `equip-hand-and-off-hand` wait for absences only:
 * the lag cannot break them, the stopped-server test does.
 */
const ANSWER_WAITERS = [
  "attack-out-of-reach",
  "click-window-hotbar-swap",
  "click-window-onto-variant",
  "click-window-shift-move",
  "click-window-variant-split",
  "variant-transfer-clicks",
];

function checkNamed(name: string) {
  const check = CONTRACT_CHECKS.find((candidate) => candidate.name === name);
  assert.ok(check, `no contract check ${name}`);
  return check;
}

for (const name of ANSWER_WAITERS) {
  test(`contract ${name} holds on a fake that answers ${LATE_ANSWER_MS} ms late`, async () => {
    const check = checkNamed(name);
    const harness = fakeHarnessFor(check.fixture, FRAME, {}, LATE_ANSWER_MS);
    using _installed = harness.clock.install();
    await check.run(fakeContractSubject(harness, FRAME));
  });
}

test("contract columns-hold-cells fails on a server whose ticks do not come: nothing proves no chunk is late", async () => {
  const check = checkNamed("columns-hold-cells");
  const harness = fakeHarnessFor(check.fixture, FRAME);
  using _installed = harness.clock.install();
  await harness.clock.advance(1_500);
  harness.server.stop();
  await assert.rejects(check.run(fakeContractSubject(harness, FRAME)), /the server is stalled/);
});
