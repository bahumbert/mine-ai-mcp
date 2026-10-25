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
 * (`hurtBot`, `summonItem`...) a late fake does not hold. `equip-hand-and-off-hand` waits for absences only: the lag cannot break it, the
 * stopped-server test does. The chest-open checks (`chest-open-take-close`, `click-window-onto-variant`, `click-window-variant-split`,
 * `variant-transfer-clicks`) are in the table below, at a lag past their old 5 s bound.
 */
const ANSWER_WAITERS = [
  "attack-out-of-reach",
  "click-window-hotbar-swap",
  "click-window-shift-move",
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

/**
 * Checks whose own answer bounds (0.5 to 6 s) sat under the shared `ANSWER_WALL_MS` (10 s): each holds on a fake that answers later than its
 * old bound, so a lane's server behind its schedule no longer reads red (review 2026-10-25 #10; plan 2026-10-25-review-fixes R9). The lag is just
 * over the check's old bound. Out of this table, because a late fake breaks something other than the bound: `air-supply-under-water` (its air
 * readings pile up at the lag's end), `boat-follows-vehicle-move` (the getOff), `deflect-fireball` (the launch returns no ball), `rain-and-thunder-state`
 * (the ramp is judged on the wall clock), `bow-draw-and-release` (its 1 s draw is read at once, the use bit comes late) and the checks whose wait is Mineflayer's own timer (`bed-sleep-and-wake` and `bed-scene`'s sleep 3 s,
 * `place-block-with-options` 5 s).
 */
const LATER_THAN_OLD_BOUND_MS: Readonly<Record<string, number>> = {
  "attack-hurts-and-kills": 3_000,
  "bed-refused-monster-near": 2_500,
  "damage-event-to-bot": 1_000,
  "chest-open-take-close": 6_000,
  "click-window-onto-variant": 6_000,
  "click-window-variant-split": 6_000,
  "item-variant-components": 6_000,
  "toss-count-and-entity": 4_000,
  "variant-transfer-clicks": 6_000,
};

for (const [name, lagMs] of Object.entries(LATER_THAN_OLD_BOUND_MS)) {
  test(`contract ${name} holds on a fake that answers ${lagMs} ms late, past its old local bound`, async () => {
    const check = checkNamed(name);
    const harness = fakeHarnessFor(check.fixture, FRAME, {}, lagMs);
    using _installed = harness.clock.install();
    await check.run(fakeContractSubject(harness, FRAME));
  });
}
