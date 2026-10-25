import assert from "node:assert/strict";
import test from "node:test";
import type { StallClock } from "../actions/stall-watch.js";
import type { ProgressPosition } from "./progress.js";
import { PinnedWatch } from "./pinned-watch.js";

const MINUTE = 60_000;

/** A clock the test steps by hand; `ticking: false` never fires the sampler, as when the event loop's timers are starved. */
function manualClock(ticking = true): StallClock & { advance: (ms: number) => void } {
  let now = 0;
  const timers = new Set<{ tick: () => void; ms: number; next: number }>();
  return {
    now: () => now,
    every: (tick, ms) => {
      const entry = { tick, ms, next: now + ms };
      if (ticking) timers.add(entry);
      return () => timers.delete(entry);
    },
    advance: (ms) => {
      const end = now + ms;
      for (;;) {
        const due = [...timers].filter((entry) => entry.next <= end).sort((a, b) => a.next - b.next)[0];
        if (!due) break;
        now = due.next;
        due.next += due.ms;
        due.tick();
      }
      now = end;
    },
  };
}

function bodyAt(x = 0, z = 0) {
  const position: ProgressPosition = { dimension: "overworld", x, y: 64, z };
  return { position: () => ({ ...position }), moveTo: (nx: number, nz: number, dimension = "overworld") => Object.assign(position, { x: nx, z: nz, dimension }) };
}

function watchWith(clock = manualClock(), body = bodyAt()) {
  const watch = new PinnedWatch({ position: body.position, clock });
  return { watch, clock, body };
}

test("a bot within one block for ten minutes while three movement actions failed is pinned", () => {
  const { watch, clock } = watchWith();
  for (const reason of ["no path", "no path", "dead end: dig into water 4"]) watch.recordFailure(reason);
  clock.advance(10 * MINUTE);
  assert.equal(watch.isPinned(), true);
});

test("nine minutes is not pinned", () => {
  const { watch, clock } = watchWith();
  for (let n = 0; n < 3; n++) watch.recordFailure("no path");
  clock.advance(9 * MINUTE);
  assert.equal(watch.isPinned(), false);
});

test("two failures in ten minutes is not pinned", () => {
  const { watch, clock } = watchWith();
  watch.recordFailure("no path");
  watch.recordFailure("no path");
  clock.advance(10 * MINUTE);
  assert.equal(watch.isPinned(), false);
});

test("an idle bot, with no failing action, is never pinned", () => {
  const { watch, clock } = watchWith();
  clock.advance(120 * MINUTE);
  assert.equal(watch.isPinned(), false);
});

test("a success between failures starts the count again", () => {
  const { watch, clock } = watchWith();
  watch.recordFailure("no path");
  watch.recordFailure("no path");
  watch.recordSuccess();
  watch.recordFailure("no path");
  clock.advance(10 * MINUTE);
  assert.equal(watch.isPinned(), false);
});

test("a move of two blocks clears a pinned bot", () => {
  const { watch, clock, body } = watchWith();
  for (let n = 0; n < 3; n++) watch.recordFailure("no path");
  clock.advance(10 * MINUTE);
  assert.equal(watch.isPinned(), true);
  body.moveTo(2, 0);
  clock.advance(10_000);
  assert.equal(watch.isPinned(), false);
  assert.equal(watch.refusal(), null);
});

test("a move of one and a half blocks does not clear a pinned bot", () => {
  const { watch, clock, body } = watchWith();
  for (let n = 0; n < 3; n++) watch.recordFailure("no path");
  clock.advance(10 * MINUTE);
  body.moveTo(1.5, 0);
  clock.advance(10_000);
  assert.equal(watch.isPinned(), true);
});

test("a bot that walked away and came back inside the window is not pinned", () => {
  const { watch, clock, body } = watchWith();
  for (let n = 0; n < 3; n++) watch.recordFailure("no path");
  clock.advance(6 * MINUTE);
  body.moveTo(30, 0);
  clock.advance(10_000);
  body.moveTo(0, 0);
  clock.advance(6 * MINUTE);
  assert.equal(watch.isPinned(), false);
});

test("the wall clock alone counts: no sampler tick fires and the window still ends", () => {
  const { watch, clock } = watchWith(manualClock(false));
  for (let n = 0; n < 3; n++) watch.recordFailure("no path");
  clock.advance(10 * MINUTE);
  assert.equal(watch.isPinned(), true);
});

test("two watches in one process are pinned and cleared independently", () => {
  const clock = manualClock();
  const one = watchWith(clock, bodyAt(0, 0));
  const other = watchWith(clock, bodyAt(100, 100));
  for (let n = 0; n < 3; n++) one.watch.recordFailure("no path");
  clock.advance(10 * MINUTE);
  assert.equal(one.watch.isPinned(), true);
  assert.equal(other.watch.isPinned(), false);
  other.watch.clear();
  assert.equal(one.watch.isPinned(), true);
});

test("a death clears a pinned bot", () => {
  const { watch, clock } = watchWith();
  for (let n = 0; n < 3; n++) watch.recordFailure("no path");
  clock.advance(10 * MINUTE);
  assert.equal(watch.isPinned(), true);
  watch.clear();
  assert.equal(watch.isPinned(), false);
  clock.advance(MINUTE);
  assert.equal(watch.isPinned(), false);
});

test("a failed escape makes movement actions fail at once, naming the last refusal, until a move clears it", () => {
  const { watch, clock, body } = watchWith();
  for (const reason of ["no path", "no path", "dig into water 4, policy 2"]) watch.recordFailure(reason);
  clock.advance(10 * MINUTE);
  assert.equal(watch.refusal(), null, "pinned alone runs the escape, it does not refuse");
  watch.escapeFailed();
  const refusal = watch.refusal() ?? "";
  assert.match(refusal, /^\[PINNED\]/u);
  assert.match(refusal, /dig into water 4, policy 2/u);
  body.moveTo(0, 3);
  clock.advance(10_000);
  assert.equal(watch.refusal(), null);
  assert.equal(watch.isPinned(), false);
});

test("a dimension change clears a pinned bot", () => {
  const { watch, clock, body } = watchWith();
  for (let n = 0; n < 3; n++) watch.recordFailure("no path");
  clock.advance(10 * MINUTE);
  body.moveTo(0, 0, "the_nether");
  clock.advance(10_000);
  assert.equal(watch.isPinned(), false);
});

test("close stops the sampler", () => {
  const clock = manualClock();
  const body = bodyAt();
  let reads = 0;
  const watch = new PinnedWatch({ position: () => (reads++, body.position()), clock });
  watch.close();
  const before = reads;
  clock.advance(MINUTE);
  assert.equal(reads, before);
});

/** A pinned bot whose first escape failed, ready for the refusal tests. */
function refusedWatch() {
  const made = watchWith();
  for (let n = 0; n < 3; n++) made.watch.recordFailure("dig into water 4, policy 2");
  made.clock.advance(10 * MINUTE);
  assert.equal(made.watch.isPinned(), true);
  made.watch.escapeFailed();
  assert.notEqual(made.watch.refusal(), null);
  return made;
}

test("a refused pinned bot may try its escape again once another full window has passed", () => {
  const { watch, clock } = refusedWatch();
  clock.advance(10 * MINUTE - 1);
  assert.notEqual(watch.refusal(), null, "one millisecond short of the window");
  clock.advance(1);
  assert.equal(watch.refusal(), null);
  assert.equal(watch.isPinned(), true, "still pinned, so the next movement action runs the escape");
});

test("a second failed escape restarts the window", () => {
  const { watch, clock } = refusedWatch();
  clock.advance(10 * MINUTE);
  assert.equal(watch.refusal(), null);
  watch.escapeFailed();
  assert.notEqual(watch.refusal(), null);
  clock.advance(10 * MINUTE - 1);
  assert.notEqual(watch.refusal(), null);
  clock.advance(1);
  assert.equal(watch.refusal(), null);
});

test("a success ends the refusal and the pinned state", () => {
  const { watch } = refusedWatch();
  watch.recordSuccess();
  assert.equal(watch.refusal(), null);
  assert.equal(watch.isPinned(), false);
});

test("the refusal says where, the last refusal counts, when the next try comes and what to do meanwhile", () => {
  const { watch, clock } = refusedWatch();
  clock.advance(4 * MINUTE);
  const text = watch.refusal() ?? "";
  assert.match(text, /^\[PINNED\]/u);
  assert.match(text, /0\.0, 64\.0, 0\.0/u);
  assert.match(text, /dig into water 4, policy 2/u);
  assert.match(text, /again in about 6 min/u);
  assert.match(text, /needs no walking/u);
});

test("a short window is told in seconds", () => {
  const clock = manualClock();
  const body = bodyAt();
  const watch = new PinnedWatch({ position: body.position, clock, windowMs: 2_000 });
  for (let n = 0; n < 3; n++) watch.recordFailure("no path");
  clock.advance(2_000);
  watch.escapeFailed();
  assert.match(watch.refusal() ?? "", /again in about 2 s/u);
});
