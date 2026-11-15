// Inventory confirmation and interrupted toss accounting on the shared server clock.
import assert from "node:assert/strict";
import test from "node:test";
import { carriedCountField } from "../../test-support/carried-counts.js";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { watch } from "../../test-support/pending.js";
import { SERVER_CLOCK_STOPPED_MS } from "../../world/world-age.js";
import { tossItem, type ItemToss } from "./toss-item.js";

/** Keep toss prediction, then inject a mismatching slot count to exercise receipt reconciliation. */
function tossRig(ticksPerSecond = 5) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, server: { ticksPerSecond, startAge: 0 }, carried: { gravel: 20 } });
  const carried = carriedCountField(harness, "gravel");
  const toss: ItemToss = { baseline: 20, tossed: 0, keptForPlug: 0, pending: null };
  const sends: number[] = [];
  const nativeToss = harness.bot.toss.bind(harness.bot);
  const send: typeof nativeToss = async (type, metadata, count) => {
    await nativeToss(type, metadata, count);
    sends.push(count!);
  };
  // Stopgap: a post-prediction server correction is unmeasured; needs contract `toss-corrected-inventory-answer`
  // before this exceptional sequence can be claimed as game behavior (task-review T9b, 2026-11-15).
  harness.bot.toss = async (type, metadata, count) => {
    await send(type, metadata, count);
    carried.count += count!;
    harness.bot.entity.position = harness.bot.entity.position.offset(0, 0, 5);
  };
  const attempt = (signal?: AbortSignal) => tossItem(harness.bot, "gravel", 10, { signal }, toss);
  return { ...harness, clock, carried, toss, sends, send, attempt };
}

for (const { rate, answerMs } of [{ rate: 20, answerMs: 2_000 }, { rate: 5, answerMs: 8_000 }]) {
  test(`confirms the requested toss at age +40, ${answerMs} ms at ${rate} tps`, async () => {
    const rig = tossRig(rate);
    using _installed = rig.clock.install();
    const age = rig.bot.time.age;
    rig.clock.after(answerMs, () => { rig.carried.count = 10; });

    const result = await rig.clock.settle(rig.attempt(), answerMs);

    assert.equal(rig.clock.now(), answerMs);
    assert.equal(rig.bot.time.age, age + 40);
    assert.deepEqual([result.dropped, result.carriedAfter, result.error], [10, 10, undefined]);
    assert.equal(rig.toss.pending, null);
  });
}

test("a still world age ends the toss unconfirmed at 20 s, crediting only the inventory loss", async () => {
  const rig = tossRig();
  using _installed = rig.clock.install();
  rig.server.stop();
  const pending = rig.attempt();
  const state = watch(pending);
  await rig.clock.advance(SERVER_CLOCK_STOPPED_MS - 50);
  assert.equal(state.over, false, "the stopped-clock bound has not elapsed");
  const result = await rig.clock.settle(pending, 50);

  assert.equal(rig.bot.time.age, 0);
  assert.equal(rig.clock.now(), 20_000);
  assert.deepEqual([result.dropped, result.carriedAfter], [0, 20]);
  assert.match(result.error ?? "", /^\[DROP_NOT_OBSERVED\]/);
  assert.equal(rig.toss.pending, null);
});

for (const row of [
  { name: "applied toss is credited once without another toss", applied: true, pickup: 0, sends: [10] },
  { name: "refused toss is sent again", applied: false, pickup: 0, sends: [10, 10] },
  { name: "pickup during interruption credits the exact net loss", applied: true, pickup: 1, sends: [10, 1] },
]) {
  test(`abort at 4010 ms, age +20: ${row.name}`, async () => {
    const rig = tossRig();
    using _installed = rig.clock.install();
    const owner = new AbortController();
    rig.clock.after(4_010, () => owner.abort(new Error("reflex needs the body")));
    const pending = rig.attempt(owner.signal);
    await assert.rejects(rig.clock.settle(pending, 4_010, 10), /reflex needs the body/);
    assert.equal(rig.bot.time.age, 20);
    assert.deepEqual(rig.toss.pending, { before: 20, count: 10 });

    await rig.clock.advance(3_990);
    rig.carried.count = (row.applied ? 10 : 20) + row.pickup;
    rig.bot.toss = rig.send;
    const result = await rig.clock.settle(rig.attempt(), 8_000);

    assert.deepEqual([result.dropped, result.carriedAfter, result.error], [10, 10, undefined]);
    assert.deepEqual(rig.sends, row.sends);
    assert.equal(rig.toss.pending, null);
  });
}
