import assert from "node:assert/strict";
import test from "node:test";
import { ZERO_ARENA, arenaFrame } from "../../arena/frame.ts";
import type { ContractCheck } from "../checks.ts";
import { fakeHarnessFor } from "../fake-harness.ts";
import { fakeContractSubject } from "../subject.ts";
import { TICK_MS } from "./combat-scene.ts";
import { weaponDamageAxes } from "./weapon-damage-axes.ts";
import { weaponDamagePickaxes } from "./weapon-damage-pickaxes.ts";
import { weaponDamageShovelsHoes } from "./weapon-damage-shovels-hoes.ts";
import { weaponDamageSwords } from "./weapon-damage-swords.ts";
import { TOOLS } from "./weapon-tools.ts";

const PARTS = [weaponDamageSwords, weaponDamageAxes, weaponDamagePickaxes, weaponDamageShovelsHoes];
const swungBy = (part: (typeof PARTS)[number]) => Object.keys(part.fixture.carried);

test("the four weapon checks swing disjoint parts of the table, together every tool of it, on the same zombie ring", () => {
  const swung = PARTS.flatMap(swungBy);
  assert.equal(new Set(swung).size, swung.length, `a tool is swung by two checks: ${swung.join(", ")}`);
  assert.deepEqual([...swung].sort(), TOOLS.map(({ name }) => name).sort());
  const rings = PARTS.map((part) => JSON.stringify(part.fixture.entities));
  assert.equal(new Set(rings).size, 1, "the parts stand on different rings");
});

/** The check on a fake whose server runs behind its schedule at `ticksPerSecond` instead of 20 (another lane's clone holding the server thread): the bot's wall gaps are unchanged, the server's ticks between the hits are fewer. Premise asserted: the waits of `gapMs` held at most the ticks of that server and, together, fewer than a server on schedule runs; the check is then judged by those ticks. */
async function runBehindSchedule(check: ContractCheck, gapMs: number, ticksPerSecond: number): Promise<void> {
  const frame = arenaFrame(ZERO_ARENA);
  const harness = fakeHarnessFor(check.fixture, frame, { ticksPerSecond });
  using _installed = harness.clock.install();
  const subject = fakeContractSubject(harness, frame);
  let gaps = 0;
  let ticksHeld = 0;
  await check.run({
    ...subject,
    async wait(ms) {
      if (ms !== gapMs) return subject.wait(ms);
      const before = harness.server.gameTime;
      await subject.wait(ms);
      const held = harness.server.gameTime - before;
      assert.ok(held <= Math.ceil((ms * ticksPerSecond) / 1000), `the wait of ${ms} ms held ${held} server ticks`);
      gaps += 1;
      ticksHeld += held;
    },
  });
  assert.ok(gaps > 0, `${check.name} never waited ${gapMs} ms: the premise was not exercised`);
  assert.ok(ticksHeld < (gaps * gapMs) / TICK_MS, `${gaps} waits of ${gapMs} ms held ${ticksHeld} ticks, not fewer than the ${(gaps * gapMs) / TICK_MS} of a server on schedule`);
}

/** At 14 ticks a second a 100 ms gap holds 1 or 2 ticks, the 2 of a server on schedule: only a server slow enough to hold 0 or 1 (7) shows a check that judges that gap by the wall (scratch mutation of task review T7d2a-merge: green at 14, red at 7). */
const BEHIND_RUNS = [
  { gapMs: 500, ticksPerSecond: 14 },
  { gapMs: 100, ticksPerSecond: 14 },
  { gapMs: 100, ticksPerSecond: 7 },
];

test("a swing gap the server spent short of its wall time (a server behind its schedule, no stop) is judged by the server's ticks between the hits, for the 500 ms gap and the 100 ms one", async () => {
  for (const part of PARTS) {
    for (const { gapMs, ticksPerSecond } of BEHIND_RUNS) await runBehindSchedule(part, gapMs, ticksPerSecond);
  }
});
