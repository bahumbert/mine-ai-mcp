import assert from "node:assert/strict";
import test from "node:test";
import type { FakeServerOptions } from "../../../../src/test-support/fake-bot/index.ts";
import { tossedItemKeptBeforeDelay } from "./tossed-item-kept-before-delay.ts";
import { runOnFake } from "./run-on-fake.ts";

/** Run the check on the fake (`run-on-fake.ts`): `change` rewrites the subject before it runs, `stalls` stop the server. */
const runCheck = (server: FakeServerOptions, change?: Parameters<typeof runOnFake>[2], stalls?: Parameters<typeof runOnFake>[3]) => runOnFake(tossedItemKeptBeforeDelay, server, change, stalls);

test("tossed-item-kept-before-delay judges the 40 ticks by the server's tick: a server at 14 ticks a second (2.9 s of wall) passes", async () => {
  await runCheck({ ticksPerSecond: 14 });
});

test("tossed-item-kept-before-delay holds when the server stalls for under 2 s and catches up, at any point of the delay", async () => {
  for (const atMs of [0, 300, 900, 1_500]) await runCheck({}, undefined, [{ atMs, ms: 700 }]);
});

test("tossed-item-kept-before-delay holds when the server stalls over 2 s and the game drops the stall", async () => {
  for (const atMs of [0, 500, 1_500]) await runCheck({}, undefined, [{ atMs, ms: 2_500 }]);
});

test("tossed-item-kept-before-delay fails, naming the ticks read, when the toss came back before its 40 ticks", async () => {
  // The read sent at the pickup says 10 ticks after the toss's: the item was taken 30 ticks early.
  let reading = 0;
  await assert.rejects(
    runCheck({}, (subject) => ({ ...subject, serverGameTime: async () => ((reading += 1) === 1 ? 1_000 : 1_010) })),
    /the toss came back at server tick 1010, 10 ticks after the toss at tick 1000 \(\d+ ms apart by the client\): the delay is 40 ticks, not less than 38 \(readings \+-2\) and not more than 240/,
  );
});

test("tossed-item-kept-before-delay fails when the toss came back later than the wait allows", async () => {
  let reading = 0;
  await assert.rejects(
    runCheck({}, (subject) => ({ ...subject, serverGameTime: async () => ((reading += 1) === 1 ? 1_000 : 5_000) })),
    /the toss came back at server tick 5000, 4000 ticks after the toss at tick 1000 \(\d+ ms apart by the client\): the delay is 40 ticks, not less than 38 \(readings \+-2\) and not more than 240/,
  );
});
