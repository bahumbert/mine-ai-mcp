// The stall tracker counts a request's evades against its objective evidence, in world ticks with a wall backstop.
import assert from "node:assert/strict";
import test from "node:test";
import type { RequestEvidence, RequestSnapshot } from "../../session/request.js";
import { createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { serverPacedWallMs } from "../../world/world-age.js";
import { RequestStalls, STALLED_CODE, STALL_EVADES, STALL_TICKS, stallReason, type StallFacts } from "./request-stall.js";

type Objective = RequestEvidence["objective"];

/** A running request whose evidence carries `objective` (`undefined`: the action publishes none). */
function requestOf(objective: Objective, options: { id?: string; observed?: boolean; action?: string } = {}): RequestSnapshot {
  return {
    id: options.id ?? "request-1", requestId: 1, action: options.action ?? "navigate", admittedAt: 0,
    state: { kind: "running" }, objective: null,
    evidence: {
      baseline: {}, checkpoint: {}, objective,
      completion: { kind: "current", observed: options.observed ?? false, owes: "" },
    },
  };
}

/** The same request when its evidence observer threw (`ActionRunner.#requestSnapshot`). */
const unreadable = (request: RequestSnapshot): RequestSnapshot => ({ ...request, evidence: null, observationError: "observer threw" });

const far = (remaining: number, tolerance = 1): Objective => ({ remaining, tolerance });
const threats = [{ id: 7, name: "skeleton" }];
const WALL_MS = serverPacedWallMs(STALL_TICKS);
const RATES = [20, 10] as const;

/** A tracker beside a fake server at `ticksPerSecond`, its time packets 20 ticks apart (20 tps: 1 s; 10 tps: 2 s). */
function sceneAt(ticksPerSecond: number, options: { timePacketYet?: boolean } = {}) {
  const clock = createFakeClock({ mode: "manual" });
  const harness = createFakeBot({ clock, server: { ticksPerSecond, startAge: 0, timePacketYet: options.timePacketYet ?? true } });
  const stalls = new RequestStalls();
  const age = (): number | null => harness.bot.time.age ?? null;
  return {
    stalls, harness, clock, age,
    /** Run the server until its world age reads `target`, which a packet lands on exactly (ages move in jumps of 20). */
    async toAge(target: number) {
      for (let guard = 0; (age() ?? -1) < target && guard < 10_000; guard++) await clock.advance(500);
      assert.equal(age(), target);
    },
    /** Pass `ms` of clock; a stopped server's age stands still. */
    async pass(ms: number) { await clock.advance(ms); },
    evade(request: RequestSnapshot | null, generation = 0, who = threats) {
      return stalls.recordResponse(request, generation, "evade", who, age(), clock.now());
    },
    fight(request: RequestSnapshot | null, generation = 0, who = threats) {
      return stalls.recordResponse(request, generation, "fight", who, age(), clock.now());
    },
    observe(request: RequestSnapshot | null, generation = 0) { stalls.observe(request, generation, age(), clock.now()); },
    check(request: RequestSnapshot | null, generation = 0) { return stalls.check(request, generation, age(), clock.now()); },
  };
}

type Scene = ReturnType<typeof sceneAt>;

/** One test per rate: the answer is in world ticks, the same at 20 and 10 tps. */
function atRates(name: string, body: (scene: Scene, ticksPerSecond: number) => Promise<void> | void): void {
  for (const ticksPerSecond of RATES) test(`${name} (${ticksPerSecond} tps)`, () => body(sceneAt(ticksPerSecond), ticksPerSecond));
}

atRates("seven evades resume and the eighth returns", (s) => {
  const request = requestOf(far(20));
  s.observe(request);
  for (let evade = 1; evade < STALL_EVADES; evade++) assert.equal(s.evade(request)?.limit, null, `evade ${evade}`);
  const eighth = s.evade(request);
  assert.deepEqual([eighth?.limit, eighth?.evades], ["evades", STALL_EVADES]);
});

atRates("1660 ticks resume and 1680 return with two evades", async (s) => {
  const request = requestOf(far(20));
  s.observe(request);
  s.evade(request);
  s.evade(request);
  await s.toAge(1_660);
  assert.equal(s.check(request)?.limit, null);
  await s.toAge(1_680);
  const facts = s.check(request);
  assert.deepEqual([facts?.limit, facts?.ticks], ["ticks", 1_680]);
});

atRates("1680 ticks with one evade is no limit", async (s) => {
  const request = requestOf(far(20));
  s.observe(request);
  await s.toAge(STALL_TICKS);
  assert.equal(s.evade(request)?.limit, null);
});

atRates("a stopped server returns on the wall backstop and only with two evades", async (s) => {
  const request = requestOf(far(20));
  const start = s.clock.now();
  s.observe(request);
  s.evade(request);
  s.harness.server.stop();
  await s.pass(WALL_MS);
  assert.equal(s.check(request)?.limit, null, "one evade is no chain");
  s.evade(request);
  assert.equal(WALL_MS, 255_000);
  assert.equal(s.clock.now() - start, WALL_MS);
  assert.deepEqual([s.check(request)?.limit, s.check(request)?.ticks, s.age()], ["wall", 0, 0]);
});

atRates("a stopped server holds one millisecond before the wall backstop", async (s) => {
  const request = requestOf(far(20));
  s.observe(request);
  s.evade(request);
  s.evade(request);
  s.harness.server.stop();
  await s.pass(WALL_MS - 1);
  assert.equal(s.check(request)?.limit, null);
  await s.pass(1);
  assert.equal(s.check(request)?.limit, "wall");
});

atRates("the limits order: evades over ticks over wall", async (s) => {
  const request = requestOf(far(20));
  s.observe(request);
  for (let evade = 0; evade < 2; evade++) s.evade(request);
  await s.toAge(STALL_TICKS);
  s.harness.server.stop();
  await s.pass(WALL_MS); // the server ran 1680 ticks and the clock passed the wall: ticks and wall hold together
  assert.equal(s.check(request)?.limit, "ticks");
  for (let evade = 2; evade < STALL_EVADES; evade++) s.evade(request);
  assert.equal(s.check(request)?.limit, "evades", "all three hold: the evade count names it");
});

// D28: a completed fight is a response of the request like an evade (plan 2026-11-18-scenario-reds-part3-a2 T18d).
atRates("two fights and no evade return at 1680 ticks and not at 1660", async (s) => {
  const request = requestOf(far(20));
  s.observe(request);
  s.fight(request);
  s.fight(request);
  await s.toAge(1_660);
  assert.equal(s.check(request)?.limit, null);
  await s.toAge(STALL_TICKS);
  const facts = s.check(request);
  assert.deepEqual([facts?.limit, facts?.ticks, facts?.responses, facts?.evades], ["ticks", STALL_TICKS, 2, 0]);
});

atRates("one fight is no chain, and a fight with an evade is", async (s) => {
  const single = requestOf(far(20), { id: "single" });
  s.observe(single);
  await s.toAge(STALL_TICKS);
  assert.equal(s.fight(single)?.limit, null, "one response in 1680 ticks");
  const mixed = requestOf(far(20), { id: "mixed" });
  s.observe(mixed);
  s.fight(mixed);
  const facts = s.evade(mixed);
  assert.deepEqual([facts?.responses, facts?.evades, facts?.limit], [2, 1, null]);
  await s.toAge(2 * STALL_TICKS);
  assert.deepEqual([s.check(mixed)?.limit, s.check(mixed)?.evades], ["ticks", 1]);
});

atRates("progress at 1000 ticks restarts the fight count: null at 1680, ticks at 2680", async (s) => {
  const request = requestOf(far(20));
  s.observe(request);
  s.fight(request);
  s.fight(request);
  await s.toAge(1_000);
  const closer = requestOf(far(19));
  s.observe(closer);
  assert.deepEqual([s.check(closer)?.responses, s.check(closer)?.evades], [0, 0]);
  s.fight(closer);
  s.fight(closer);
  await s.toAge(STALL_TICKS);
  assert.equal(s.check(closer)?.limit, null, "680 ticks since the progress");
  await s.toAge(1_000 + STALL_TICKS);
  assert.deepEqual([s.check(closer)?.limit, s.check(closer)?.ticks], ["ticks", STALL_TICKS]);
});

atRates("eight fights are no evades limit, and eight evades still are", async (s) => {
  const request = requestOf(far(20));
  s.observe(request);
  for (let fight = 0; fight < STALL_EVADES; fight++) s.fight(request);
  assert.deepEqual([s.check(request)?.limit, s.check(request)?.responses, s.check(request)?.evades], [null, STALL_EVADES, 0]);
  await s.toAge(STALL_TICKS);
  assert.equal(s.check(request)?.limit, "ticks", "named by the ticks, not by an evade count");
  const evading = requestOf(far(20), { id: "evading" });
  s.observe(evading);
  for (let evade = 1; evade < STALL_EVADES; evade++) s.evade(evading);
  assert.equal(s.evade(evading)?.limit, "evades");
});

atRates("fights alone return on the wall backstop of a stopped server", async (s) => {
  const request = requestOf(far(20));
  s.observe(request);
  s.fight(request);
  s.harness.server.stop();
  await s.pass(WALL_MS);
  assert.equal(s.check(request)?.limit, null, "one response is no chain");
  s.fight(request);
  assert.deepEqual([s.check(request)?.limit, s.age()], ["wall", 0]);
});

test("a new generation drops the fight count", () => {
  const s = sceneAt(20);
  const request = requestOf(far(20));
  s.observe(request, 1);
  s.fight(request, 1);
  s.fight(request, 1);
  assert.equal(s.check(request, 1)?.responses, 2);
  assert.equal(s.fight(request, 2)?.responses, 1);
  assert.equal(s.fight(request, 1), null, "a late fight of the old life");
});

atRates("real progress resets the count, the age and the wall origin", async (s) => {
  const request = requestOf(far(20));
  s.observe(request);
  for (let evade = 0; evade < 7; evade++) s.evade(request);
  await s.toAge(1_600);
  const progressed = requestOf(far(17));
  s.observe(progressed);
  assert.equal(s.check(progressed)?.evades, 0);
  const next = s.evade(progressed);
  assert.deepEqual([next?.evades, next?.limit, next?.best, next?.current, next?.ticks], [1, null, 17, 17, 0]);
  s.evade(progressed);
  await s.toAge(1_600 + STALL_TICKS - 20);
  assert.equal(s.check(progressed)?.limit, null);
  await s.toAge(1_600 + STALL_TICKS);
  assert.equal(s.check(progressed)?.limit, "ticks");
});

atRates("progress renews the wall backstop from the progress", async (s) => {
  s.observe(requestOf(far(20)));
  s.harness.server.stop();
  await s.pass(200_000);
  const progressed = requestOf(far(10));
  s.observe(progressed);
  s.evade(progressed);
  s.evade(progressed);
  await s.pass(WALL_MS - 1);
  assert.equal(s.check(progressed)?.limit, null, "255 s after the first reading, 255 s minus 1 ms after the progress");
  await s.pass(1);
  assert.equal(s.check(progressed)?.limit, "wall");
});

atRates("a completion observed is progress", (s) => {
  s.observe(requestOf(far(20)));
  for (let evade = 0; evade < 5; evade++) s.evade(requestOf(far(20)));
  const done = requestOf(far(20), { observed: true });
  s.observe(done);
  assert.equal(s.check(done)?.evades, 0);
});

atRates("jitter under tolerance is not progress, and a full tolerance is", (s) => {
  s.observe(requestOf(far(20)));
  s.evade(requestOf(far(20)));
  const jitter = s.check(requestOf(far(19.4)));
  assert.deepEqual([jitter?.evades, jitter?.best, jitter?.current], [1, 20, 19.4]);
  assert.equal(s.check(requestOf(far(19)))?.evades, 0);
});

atRates("out and back is not progress", (s) => {
  s.observe(requestOf(far(20)));
  s.evade(requestOf(far(20)));
  s.observe(requestOf(far(25)));
  s.evade(requestOf(far(25)));
  const back = s.check(requestOf(far(20)));
  assert.deepEqual([back?.evades, back?.best], [2, 20]);
});

atRates("a missing objective keeps no state", async (s) => {
  const request = requestOf(far(20));
  const untracked = requestOf(undefined, { action: "hunt_mob" });
  s.observe(untracked);
  for (let evade = 0; evade < STALL_EVADES + 2; evade++) assert.equal(s.evade(untracked), null);
  assert.equal(s.check(untracked), null);
  s.harness.server.stop();
  await s.pass(WALL_MS * 2);
  assert.equal(s.check(untracked), null);
  assert.equal(s.check(null), null);
  assert.equal(s.evade(null), null);
  // A request that stops publishing, or no request at all, drops what was counted: the same id starts again.
  for (const gone of [requestOf(undefined), null]) {
    s.observe(request);
    s.evade(request);
    s.evade(request);
    assert.equal(s.check(gone), null);
    assert.equal(s.check(request)?.evades, 0);
  }
});

atRates("a null objective neither resets nor limits early", (s) => {
  s.observe(requestOf(far(20)));
  for (let evade = 0; evade < 3; evade++) s.evade(requestOf(far(20)));
  const lost = requestOf(null); // a dimension change: no remaining distance
  s.observe(lost);
  const facts = s.check(lost);
  assert.deepEqual([facts?.evades, facts?.best, facts?.current, facts?.limit], [3, 20, null, null]);
  for (let evade = 0; evade < STALL_EVADES - 4; evade++) assert.equal(s.evade(lost)?.limit, null);
  assert.equal(s.evade(lost)?.limit, "evades");
});

atRates("a null objective from the first reading keeps counting; the first distance sets best and is no progress", (s) => {
  const lost = requestOf(null);
  s.observe(lost);
  assert.deepEqual([s.evade(lost)?.best, s.evade(lost)?.evades], [null, 2]);
  s.observe(requestOf(far(30)));
  assert.equal(s.check(requestOf(far(30)))?.evades, 2);
  assert.equal(s.check(requestOf(far(28)))?.evades, 0);
});

atRates("a request whose evidence failed to read keeps its count and never starts one", (s) => {
  const request = requestOf(far(20));
  assert.equal(s.evade(unreadable(request)), null, "nothing tracked before a first reading");
  s.observe(request);
  s.evade(request);
  assert.equal(s.evade(unreadable(request))?.evades, 2);
  assert.equal(s.evade(request)?.evades, 3);
});

for (const ticksPerSecond of RATES) {
  test(`the first world age heard anchors the tick count, whether or not the evidence reads (${ticksPerSecond} tps)`, async () => {
    for (const readable of [true, false]) {
      const s = sceneAt(ticksPerSecond, { timePacketYet: false });
      const request = requestOf(far(20));
      const duringFirstPacket = readable ? request : unreadable(request);
      s.observe(request); // no time packet yet: no age
      assert.equal(s.age(), null);
      await s.pass(1_000 * 20 / ticksPerSecond); // the first packet comes
      assert.equal(s.age(), 20);
      s.evade(duringFirstPacket);
      s.evade(duringFirstPacket);
      assert.equal(s.check(duringFirstPacket)?.limit, null);
      await s.toAge(20 + STALL_TICKS - 20);
      assert.equal(s.check(request)?.limit, null, `readable ${readable}`);
      await s.toAge(20 + STALL_TICKS);
      const facts = s.check(request);
      assert.deepEqual([facts?.limit, facts?.ticks], ["ticks", STALL_TICKS], `readable ${readable}`);
    }
  });

  test(`with no world age the ticks limit waits and the wall backstop still ends it (${ticksPerSecond} tps)`, async () => {
    const s = sceneAt(ticksPerSecond, { timePacketYet: false });
    const request = requestOf(far(20));
    s.observe(request);
    s.evade(request);
    const facts = s.evade(request);
    assert.deepEqual([facts?.ticks, facts?.limit], [null, null]);
    s.harness.server.stop(); // no packet ever comes
    await s.pass(WALL_MS - 1);
    assert.deepEqual([s.age(), s.check(request)?.ticks, s.check(request)?.limit], [null, null, null]);
    await s.pass(1);
    assert.equal(s.check(request)?.limit, "wall");
  });
}

test("a new request id starts a new count", () => {
  const s = sceneAt(20);
  const first = requestOf(far(20));
  s.observe(first);
  for (let evade = 0; evade < 5; evade++) s.evade(first);
  const second = requestOf(far(20), { id: "request-2" });
  assert.equal(s.evade(second)?.evades, 1);
  assert.equal(s.check(first)?.evades, 0, "the first request's tracker is gone: its next reading starts again");
});

test("a new request id with no objective drops the old tracker", () => {
  const s = sceneAt(20);
  const first = requestOf(far(20));
  s.observe(first);
  s.evade(first);
  s.observe(requestOf(undefined, { id: "request-2", action: "hunt_mob" }));
  assert.equal(s.check(first)?.evades, 0);
});

test("an older generation is ignored whatever the newer reading was, and a newer one starts again", () => {
  const tracked = requestOf(far(20));
  const other = requestOf(undefined, { id: "request-2", action: "hunt_mob" });
  const newerReadings: [string, RequestSnapshot | null][] = [
    ["a tracked request", requestOf(far(20), { id: "request-3" })], ["an unbounded request", other], ["no request", null],
  ];
  for (const [reading, newer] of newerReadings) {
    const s = sceneAt(20);
    s.observe(tracked, 2);
    for (let evade = 0; evade < 3; evade++) s.evade(tracked, 2);
    assert.equal(s.check(tracked, 2)?.evades, 3);
    s.observe(newer, 3);
    assert.equal(s.evade(tracked, 2), null, `a late finalize of an old life after ${reading}`);
    assert.equal(s.check(tracked, 2), null);
    assert.equal(s.evade(tracked, 3)?.evades, 1, "the newer life starts again");
  }
});

test("clear() forgets the count and keeps the newest generation heard", () => {
  const s = sceneAt(20);
  const request = requestOf(far(20));
  s.observe(request, 3);
  for (let evade = 0; evade < 5; evade++) s.evade(request, 3);
  s.stalls.clear();
  assert.equal(s.evade(request, 2), null, "an old life's finalize after the clear");
  assert.equal(s.evade(request, 3)?.evades, 1);
});

test("the facts name the threats once each and the reason says what the model can do", () => {
  const s = sceneAt(20);
  const request = requestOf(far(20));
  s.observe(request);
  s.evade(request, 0, [{ id: 7, name: "skeleton" }]);
  s.evade(request, 0, [{ id: 7, name: "skeleton" }, { id: 9, name: "zombie" }]);
  const facts = s.check(request)!;
  assert.deepEqual(facts.threats, [{ id: 7, name: "skeleton" }, { id: 9, name: "zombie" }]);
  const unmeasured: StallFacts = {
    requestId: "r", action: "navigate", responses: 8, evades: 8, ticks: null, threats: [{ id: 3, name: "zombie" }],
    best: null, current: null, limit: "evades",
  };
  assert.equal(
    stallReason({ ...facts, limit: "evades" }),
    "[HOSTILE_STALLED] 2 hostile responses (2 evades) from skeleton#7, zombie#9 over 0 server ticks without progress on navigate (best remaining 20.0, now 20.0); the reflex still protects the body; choose the next action.",
  );
  assert.equal(
    stallReason(unmeasured),
    "[HOSTILE_STALLED] 8 hostile responses (8 evades) from zombie#3 over an unknown number of server ticks without progress on navigate (best remaining unknown, now unknown); the reflex still protects the body; choose the next action.",
  );
  assert.equal(
    stallReason({ ...unmeasured, responses: 5, evades: 1, limit: "ticks" }),
    "[HOSTILE_STALLED] 5 hostile responses (1 evades) from zombie#3 over an unknown number of server ticks without progress on navigate (best remaining unknown, now unknown); the reflex still protects the body; choose the next action.",
  );
  assert.equal(STALLED_CODE, "[HOSTILE_STALLED]");
});
