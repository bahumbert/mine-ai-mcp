// Snapshot-only situation triggers, their clocks and stale asynchronous reads.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { dayPhase } from "../../../src/world/daylight.ts";
import type { LastDeath } from "../last-death.ts";
import { personaSchema } from "../persona.ts";
import type { BotSnapshot, Position } from "../runtime-client.ts";
import { FakeRuntime, testPersona } from "../testing.ts";
import { SituationWatch, inOverworld, lowHealthAt, minutesToDay, nightFor, restsOnLand, type SituationHost, type SituationInfo, type SituationKind } from "./situations.ts";

const base = new FakeRuntime().snapshot;

/** Runtime-shaped clock facts; only the runtime's dayPhase computes the phase. */
function snapshot(time = 12_000, extra: Partial<BotSnapshot> = {}): BotSnapshot {
  return { ...base, position: { x: 0, y: 64, z: 0 }, health: 20, lastDeath: null,
    clock: { phase: dayPhase(time), timeOfDay: time, minutesUntilChange: null, sleeping: false }, ...extra };
}

/** Only I/O is replaced: the real watch consumes status and records its public events. */
function fixture(random = 0) {
  const raised: { info: SituationInfo; snapshot: BotSnapshot }[] = [];
  const ended: { kind: SituationKind; detail: string }[] = [];
  const reads: Position[] = [];
  const state = { covered: false, busy: [] as SituationKind[], answer: null as ReturnType<SituationHost["answeringNight"]>, draws: 0, statuses: 0, snapshot: snapshot() };
  const host: SituationHost = {
    persona: testPersona(), random: () => { state.draws++; return random; },
    status: async () => { state.statuses++; return state.snapshot; },
    underCover: async (at) => { reads.push(at); return state.covered; },
    busy: () => state.busy, answeringNight: () => state.answer,
    raise: (info, current) => { raised.push({ info, snapshot: current }); },
    end: (kind, detail) => { ended.push({ kind, detail }); },
  };
  const watch = new SituationWatch(host);
  return { host, watch, raised, ended, reads, state };
}

/** A held external answer with an explicit started signal, never a settle delay. */
function held<T>() {
  let release!: (value: T) => void;
  let start!: () => void;
  const promise = new Promise<T>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { start = resolve; });
  return { promise, release, started, read: () => { start(); return promise; } };
}

const death: LastDeath = { dimension: "overworld", position: { x: 10.7, y: 64, z: -3.2 }, observedAt: "death-1", minutesAgo: 1, cause: "Zombie" };

for (const [random, point] of [[0, 12_000], [0.9999, 13_188]] as const) {
  test(`the dusk point is drawn between 12000 and 13188: ${point}`, async () => {
    const f = fixture(random);
    await f.watch.observe(snapshot(Math.min(12_000, point - 1)));
    await f.watch.observe(snapshot(point - 1));
    assert.equal(f.raised.length, 0);
    await f.watch.observe(snapshot(point));
    assert.equal(f.raised.length, 1);
    assert.equal(f.state.draws, 1);
  });
}

test("twenty snapshots before the point draw once", async () => {
  const f = fixture(500 / 1189);
  for (let tick = 12_000; tick < 12_200; tick += 10) await f.watch.observe(snapshot(tick));
  assert.equal(f.state.draws, 1);
  assert.equal(f.raised.length, 0);
  await f.watch.observe(snapshot(12_500));
  assert.equal(f.raised.length, 1);
  assert.equal(f.state.draws, 1);
});

test("a dusk point at 12100", async () => {
  const f = fixture(100 / 1189);
  await f.watch.observe(snapshot());
  await f.watch.observe(snapshot(12_150));
  assert.equal(f.raised[0]?.info.cause, "Night has just fallen (day comes in 9.4 min)");
  f.state.busy = ["night"];
  await f.watch.observe(snapshot(12_300));
  assert.deepEqual(f.ended, []);
  assert.equal(f.watch.nightActive(), true);
  assert.equal(f.watch.timeOfDay(), 12_300);
  assert.equal(f.watch.minutesToDay(), 9.299166666666666);
});

test("under cover at dusk: no event, one cover read; a second observe without moving reads no cover", async () => {
  const f = fixture();
  f.state.covered = true;
  await f.watch.observe(snapshot());
  await f.watch.observe(snapshot(12_500));
  assert.equal(f.reads.length, 1);
  assert.equal(f.raised.length, 0);
  await f.watch.observe(snapshot(13_000, { position: { x: 1, y: 64, z: 0 } }));
  assert.equal(f.reads.length, 2, "moved one block: one more read");
  f.state.covered = false;
  await f.watch.observe(snapshot(13_100, { position: { x: 2, y: 64, z: 0 } }));
  assert.equal(f.raised.length, 1);
});

test("30 s still under the same block: one more read; a roof removed over a still bot raises within 30 s", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const f = fixture();
  f.state.covered = true;
  await f.watch.observe(snapshot());
  f.state.covered = false;
  await clock.advance(29_999, 29_999);
  await f.watch.observe(snapshot(12_500));
  assert.equal(f.reads.length, 1);
  assert.equal(f.raised.length, 0);
  await clock.advance(1);
  await f.watch.observe(snapshot(12_600));
  assert.equal(f.reads.length, 2);
  assert.equal(f.raised[0]?.info.raisedAt, 30_000);
});

test("a dimension change leaves the overworld clock; equivalent dimension names reuse the cache", async () => {
  const f = fixture();
  f.state.covered = true;
  await f.watch.observe(snapshot());
  await f.watch.observe(snapshot(12_500, { dimension: "minecraft:overworld" }));
  assert.equal(f.reads.length, 1);
  await f.watch.observe(snapshot(12_600, { dimension: "the_nether", clock: { phase: null, timeOfDay: 12_600, minutesUntilChange: null } }));
  assert.equal(f.reads.length, 1);
  assert.equal(f.watch.nightActive(), false);
  assert.equal(f.raised.length, 0);
});

test("movement while a cover read is held cannot cache the old roof at the new cell", async () => {
  const f = fixture();
  const cover = held<boolean>();
  f.host.underCover = (at) => { f.reads.push(at); return f.reads.length === 1 ? cover.read() : Promise.resolve(false); };
  const first = f.watch.observe(snapshot());
  await cover.started;
  const newest = snapshot(12_500, { position: { x: 2, y: 64, z: 0 } });
  const second = f.watch.observe(newest);
  cover.release(true);
  await Promise.all([first, second]);
  assert.equal(f.reads.length, 2);
  assert.equal(f.raised.length, 1);
  assert.equal(f.raised[0]?.snapshot, newest);
});

test("a dimension change while a cover read is held drops the old roof and raises nothing", async () => {
  const f = fixture();
  const cover = held<boolean>();
  f.host.underCover = () => cover.read();
  const first = f.watch.observe(snapshot());
  await cover.started;
  const second = f.watch.observe(snapshot(13_000, { dimension: "the_nether", clock: { phase: null, minutesUntilChange: null, timeOfDay: 13_000 } }));
  cover.release(false);
  await Promise.all([first, second]);
  assert.equal(f.raised.length, 0);
  assert.equal(f.watch.nightActive(), false);
  f.host.underCover = async () => true;
  await f.watch.observe(snapshot(13_100));
  assert.equal(f.raised.length, 0, "the stale exposed result was not cached");
});

test("a handled night fires nothing until a day is seen; time set 12500 later is the same night", async () => {
  const f = fixture();
  await f.watch.observe(snapshot());
  const key = f.watch.nightKey();
  for (const tick of [14_000, 20_000, 12_500]) await f.watch.observe(snapshot(tick));
  assert.equal(f.raised.length, 1);
  assert.equal(f.watch.nightHandled(), true);
  assert.equal(f.watch.nightKey(), key);
  await f.watch.observe(snapshot(1_000));
  assert.equal(f.watch.nightHandled(), false);
  await f.watch.observe(snapshot());
  assert.equal(f.raised.length, 2);
  assert.equal(f.watch.nightKey(), key + 1);
});

for (const [random, delay] of [[0.5, 29_700], [0, 0], [0.9999, 59_394.06]] as const) {
  test(`a late start waits a random spread: ${random}`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const f = fixture(random);
    await f.watch.observe(snapshot(15_000));
    if (delay > 0) {
      assert.equal(f.raised.length, 0);
      await clock.advance(delay - 1, delay - 1);
      await f.watch.observe(snapshot(15_100));
      assert.equal(f.raised.length, 0);
      await clock.advance(1);
      await f.watch.observe(snapshot(15_200));
    }
    assert.equal(f.raised.length, 1);
    assert.equal(f.raised[0]?.info.raisedAt, delay);
  });
}

test("a time jump from an observed day uses the late-start spread", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const f = fixture(0.5);
  await f.watch.observe(snapshot(1_000));
  await f.watch.observe(snapshot(13_000));
  assert.equal(f.raised.length, 0);
  await clock.advance(29_700, 29_700);
  await f.watch.observe(snapshot(13_500));
  assert.equal(f.raised.length, 1);
});

for (const [time, clock, detail] of [[0, undefined, "day came"], [23_459, undefined, "day came"], [14_000, { phase: null, minutesUntilChange: null }, "left the overworld"]] as const) {
  test(`dawn ends the night situation: ${time} ${detail}`, async () => {
    const f = fixture();
    await f.watch.observe(snapshot());
    f.state.busy = ["night"];
    await f.watch.observe(snapshot(time, clock === undefined ? {} : { clock }));
    assert.deepEqual(f.ended, [{ kind: "night", detail }]);
    f.state.busy = [];
    await f.watch.observe(snapshot(time, clock === undefined ? {} : { clock }));
    assert.equal(f.ended.length, 1);
  });
}

const exit = { at: { x: 10.9, y: 70.2, z: -3.1 }, plannedAt: "route-1", reached: false };
test("a cover report on an unhandled night raises; the same coverExit seen twice raises once", async () => {
  const f = fixture();
  f.state.covered = true;
  await f.watch.observe(snapshot(13_858, { position: { x: 3.1, y: 64, z: 2.5 }, coverExit: exit }));
  assert.equal(f.raised[0]?.info.cause, "Your route goes out under the open sky at 10 70 -4; you are at 3 64 2 (day comes in 8.0 min)");
  await f.watch.observe(snapshot(14_000, { coverExit: exit }));
  assert.equal(f.raised.length, 1);
});

test("a cover report after the night was handled raises nothing", async () => {
  const f = fixture();
  await f.watch.observe(snapshot());
  await f.watch.observe(snapshot(13_858, { coverExit: exit }));
  assert.equal(f.raised.length, 1);
});

test("a report observed by day cannot become a fresh night exit", async () => {
  const f = fixture();
  f.state.covered = true;
  await f.watch.observe(snapshot(6_000, { coverExit: exit }));
  assert.equal(f.raised.length, 0);
  await f.watch.observe(snapshot(13_000, { coverExit: exit }));
  assert.equal(f.raised.length, 0);
  await f.watch.observe(snapshot(13_100, { coverExit: { ...exit, plannedAt: "route-2" } }));
  assert.equal(f.raised.length, 1);
});

test("a reached coverExit raises nothing", async () => {
  const f = fixture();
  f.state.covered = true;
  await f.watch.observe(snapshot(13_000, { coverExit: { ...exit, reached: true } }));
  assert.equal(f.raised.length, 0);
  await f.watch.observe(snapshot(13_100, { coverExit: { ...exit, plannedAt: "route-2" } }));
  assert.equal(f.raised.length, 1);
});

for (const sleeping of [true, false]) {
  test(`a sleeping bot or a running dig_shelter marks the night handled: sleeping=${sleeping}`, async () => {
    const f = fixture();
    if (!sleeping) f.state.answer = "night";
    await f.watch.observe(snapshot(12_500, { clock: { phase: dayPhase(12_500), timeOfDay: 12_500, minutesUntilChange: null, sleeping } }));
    f.state.answer = null;
    await f.watch.observe(snapshot(14_000));
    assert.equal(f.watch.nightHandled(), true);
    assert.equal(f.raised.length, 0);
    await f.watch.observe(snapshot(1_000));
    await f.watch.observe(snapshot());
    assert.equal(f.raised.length, 1);
  });
}

test("finite daytime shelter ends after dusk: exposed bot still gets its one night event", async () => {
  const f = fixture();
  f.state.answer = "for now";
  await f.watch.observe(snapshot(12_500));
  await f.watch.observe(snapshot(12_700));
  assert.equal(f.watch.nightHandled(), false);
  assert.equal(f.raised.length, 0);
  f.state.answer = null;
  await f.watch.observe(snapshot(12_900));
  assert.equal(f.raised.length, 1);
});

for (const next of ["overlap", "dawn", "death", "stop/shutdown"] as const) {
  test(`${next} while a cover read is held processes the newest snapshot only`, async () => {
    const f = fixture();
    const cover = held<boolean>();
    f.host.underCover = () => cover.read();
    const first = f.watch.observe(snapshot());
    await cover.started;
    let second: Promise<void> = Promise.resolve();
    if (next === "stop/shutdown") f.watch.invalidate();
    else second = f.watch.observe(snapshot(next === "dawn" ? 23_459 : 13_000, next === "death" ? { lastDeath: death } : {}));
    cover.release(false);
    await Promise.all([first, second]);
    assert.equal(f.raised.filter(({ info }) => info.kind === "night").length, next === "overlap" || next === "death" ? 1 : 0);
    assert.equal(f.raised.filter(({ info }) => info.kind === "respawn").length, next === "death" ? 1 : 0);
    if (next === "stop/shutdown") {
      await f.watch.observe(snapshot(13_100));
      assert.equal(f.raised.length, 1, "observations after invalidation work as usual");
    }
  });
}

test("a death recorded before the start is the baseline and fires nothing", async () => {
  const f = fixture();
  await f.watch.observe(snapshot(6_000, { lastDeath: death }));
  assert.equal(f.raised.length, 0);
  await f.watch.observe(snapshot(6_000, { lastDeath: { ...death, observedAt: "death-2" } }));
  assert.equal(f.raised[0]?.info.kind, "respawn");
});

test("a first death after a null start raises respawn", async () => {
  const f = fixture();
  await f.watch.observe(snapshot(6_000));
  assert.equal(f.raised.length, 0);
  await f.watch.observe(snapshot(6_000, { lastDeath: death }));
  assert.equal(f.raised[0]?.info.cause, "You died 1 min ago at 10 64 -4 (Zombie) and respawned at 0 64 0");
  assert.equal(f.raised[0]?.info.death, death);
});

test("a night respawn starts with it is night; a night death counts at night", async () => {
  const f = fixture();
  f.state.covered = true;
  await f.watch.observe(snapshot(14_000));
  await f.watch.observe(snapshot(14_000, { lastDeath: death }));
  assert.equal(f.raised[0]?.info.cause, "It is night (day comes in 7.9 min). You died 1 min ago at 10 64 -4 (Zombie) and respawned at 0 64 0");
  assert.deepEqual(f.watch.deaths(), { total: 1, atNight: 1 });
});

test("health 0: not yet; a null lastDeath between two equal deaths fires nothing", async () => {
  const f = fixture();
  await f.watch.observe(snapshot(6_000));
  await f.watch.observe(snapshot(6_000, { health: 0, lastDeath: death }));
  assert.equal(f.raised.length, 0);
  await f.watch.observe(snapshot(6_000, { lastDeath: death }));
  assert.equal(f.raised.length, 1);
  await f.watch.observe(snapshot(6_000, { lastDeath: null }));
  await f.watch.observe(snapshot(6_000, { lastDeath: death }));
  assert.equal(f.raised.length, 1);
});

test("lastDeath absent: no respawn event", async () => {
  const f = fixture();
  await f.watch.observe(snapshot(6_000, { lastDeath: undefined }));
  await f.watch.observe(snapshot(6_000, { health: 7.5, lastDeath: undefined }));
  assert.deepEqual(f.raised.map(({ info }) => info.kind), ["low_health"]);
});

test("busy respawn: ended died again first; low health ends died", async () => {
  const f = fixture();
  await f.watch.observe(snapshot(6_000));
  f.state.busy = ["respawn", "low_health"];
  const order: string[] = [];
  f.host.end = (kind, detail) => { order.push(`${kind}: ${detail}`); };
  f.host.raise = (info) => { order.push(info.kind); };
  await f.watch.observe(snapshot(6_000, { lastDeath: death }));
  assert.deepEqual(order, ["respawn: died again", "low_health: died", "respawn"]);
});

test("a multiline 300-character death cause stays one bounded line; null cause is omitted", async () => {
  const f = fixture();
  await f.watch.observe(snapshot(6_000));
  await f.watch.observe(snapshot(6_000, { lastDeath: { ...death, cause: "Zombie\nhit".repeat(30) } }));
  const cause = f.raised[0]!.info.cause;
  assert.equal(cause.includes("\n"), false);
  assert.ok(cause.split("(")[1]!.split(")")[0]!.length <= 120);
  await f.watch.observe(snapshot(6_000, { lastDeath: { ...death, observedAt: "death-2", cause: null } }));
  assert.equal(f.raised[1]?.info.cause, "You died 1 min ago at 10 64 -4 and respawned at 0 64 0");
});

test("the Nether keeps respawn and low health", async () => {
  const f = fixture();
  const nether = { dimension: "the_nether", clock: { phase: null, timeOfDay: 14_000, minutesUntilChange: null } } as const;
  await f.watch.observe(snapshot(14_000, nether));
  await f.watch.observe(snapshot(14_000, { ...nether, lastDeath: death, health: 5 }));
  assert.deepEqual(f.raised.map(({ info }) => info.kind), ["respawn", "low_health"]);
  assert.equal(f.raised[0]!.info.cause.startsWith("It is night"), false);
  assert.equal(f.reads.length, 0);
});

test("the threshold follows the runtime; a persona overrides it", async () => {
  const f = fixture();
  const policy = { revision: "1", digStraightDown: false, criticalHealth: 12 };
  await f.watch.observe(snapshot(6_000, { health: 11.5, policy }));
  assert.equal(f.raised[0]?.info.kind, "low_health");
  const cautious = personaSchema.parse({ ...testPersona(), settings: { lowHealthAt: 6 } });
  assert.equal(lowHealthAt(snapshot(6_000, { policy }), cautious), 6);
  const other = fixture();
  Object.assign(other.host, { persona: cautious });
  await other.watch.observe(snapshot(6_000, { health: 11.5, policy }));
  assert.equal(other.raised.length, 0);
  await other.watch.observe(snapshot(6_000, { health: 5.5, policy }));
  assert.equal(other.raised.length, 1);
  assert.equal(lowHealthAt(snapshot(), testPersona()), 8);
});

for (const [healths, prefixes] of [
  [[9, 7.5], [[], [7.5]]], [[7.5, 8.5, 7.5], [[7.5], [7.5], [7.5]]],
  [[3.5, 6, 6, 5], [[3.5], [3.5], [3.5], [3.5, 5]]], [[7.5, 11, 7], [[7.5], [7.5], [7.5, 7]]],
  [[7.5, 9.5, 9], [[7.5], [7.5], [7.5]]], [[8, 7.9], [[], [7.9]]], [[7.5, 3.6, 3.5], [[7.5], [7.5], [7.5, 3.5]]],
  [[7.5, 9.4, 7], [[7.5], [7.5], [7.5]]], [[7.5, 9.5, 7], [[7.5], [7.5], [7.5, 7]]], [[7.5, 12, 7.5], [[7.5], [7.5], [7.5, 7.5]]],
] as const) {
  test(`low health ${healths.join(", ")} asks only on the expected falls`, async () => {
    const f = fixture();
    for (const [index, health] of healths.entries()) {
      await f.watch.observe(snapshot(6_000, { health }));
      assert.deepEqual(f.raised.map(({ info }) => info.health), prefixes[index], `after health ${health} at sample ${index}`);
    }
    assert.equal(f.raised[0]?.info.kind, "low_health");
    assert.equal(f.raised[0]?.info.cause, `Your health fell to ${healths.find((health) => health < 8)}/20`);
  });
}

test("health back to 12 ends the situation; no raise while low_health is busy", async () => {
  const f = fixture();
  await f.watch.observe(snapshot(6_000, { health: 7.5 }));
  f.state.busy = ["low_health"];
  await f.watch.observe(snapshot(6_000, { health: 3.5 }));
  await f.watch.observe(snapshot(6_000, { health: 11.9 }));
  assert.equal(f.raised.length, 1);
  assert.equal(f.ended.length, 0);
  await f.watch.observe(snapshot(6_000, { health: 12 }));
  assert.deepEqual(f.ended, [{ kind: "low_health", detail: "health back to 12" }]);
});

test("poll reads status only after 10 s without a snapshot; one read in flight", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const f = fixture();
  await f.watch.observe(snapshot(6_000));
  await clock.advance(9_999, 9_999);
  await f.watch.poll();
  assert.equal(f.state.statuses, 0);
  await clock.advance(1);
  const status = held<BotSnapshot>();
  f.host.status = () => { f.state.statuses++; return status.read(); };
  const first = f.watch.poll();
  await status.started;
  await f.watch.poll();
  assert.equal(f.state.statuses, 1);
  status.release(snapshot(6_000, { health: 5 }));
  await first;
  assert.equal(f.raised[0]?.info.kind, "low_health");
  await f.watch.poll();
  assert.equal(f.state.statuses, 1);
});

for (const change of ["invalidate alone", "fresh observe in the same generation"]) {
  test(`${change} drops a late poll status`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const f = fixture();
    const status = held<BotSnapshot>();
    f.host.status = () => status.read();
    const pending = f.watch.poll();
    await status.started;
    if (change === "invalidate alone") f.watch.invalidate();
    else await f.watch.observe(snapshot(6_000));
    status.release(snapshot(6_000, { health: 5 }));
    await pending;
    assert.equal(f.raised.length, 0);
    assert.equal(f.watch.timeOfDay(), change === "invalidate alone" ? null : 6_000);
    f.host.status = async () => snapshot(6_000, { health: 5 });
    await clock.advance(10_000, 10_000);
    await f.watch.poll();
    assert.equal(f.raised.length, 1);
  });
}

test("an observe arriving as the drain finishes is processed before it resolves", async () => {
  const f = fixture();
  const first = f.watch.observe(snapshot(6_000));
  const second = Promise.resolve().then(() => f.watch.observe(snapshot(6_000, { health: 5 })));
  await Promise.all([first, second]);
  assert.deepEqual(f.raised.map(({ info }) => info.kind), ["low_health"]);
});

test("an observe reentered by raise joins the same drain", async () => {
  const f = fixture();
  const firstSnapshot = snapshot(6_000, { health: 7 });
  let reentered: Promise<void> | undefined;
  f.host.raise = (info, current) => {
    f.raised.push({ info, snapshot: current });
    if (current === firstSnapshot) reentered = f.watch.observe(snapshot(6_000, { health: 3 }));
  };
  const first = f.watch.observe(firstSnapshot);
  await first;
  assert.equal(reentered, first);
  assert.deepEqual(f.raised.map(({ info }) => info.health), [7, 3]);
});

test("restsOnLand requires known dry footing and no vehicle", () => {
  const dry = { onGround: true, inWater: false, inLava: false };
  assert.equal(restsOnLand(snapshot(0, { footing: dry, vehicle: null })), true);
  for (const extra of [{ footing: { ...dry, inWater: true } }, { footing: { ...dry, inLava: true } }, { footing: { ...dry, onGround: false } }, { vehicle: { name: "boat" }, footing: dry }, {}, { vehicle: { name: "boat" } }]) {
    assert.equal(restsOnLand(snapshot(0, extra)), false);
  }
});

test("nightFor includes both boundaries; minutesToDay at 23458 is under one minute", () => {
  assert.deepEqual([12_099, 12_100, 23_458, 23_459].map((time) => nightFor(time, 12_100)), [false, true, true, false]);
  assert.equal(minutesToDay(23_458), 1 / 1200);
  assert.equal(inOverworld(snapshot(0)), true);
  assert.equal(inOverworld(snapshot(0, { clock: undefined })), false);
  assert.equal(inOverworld(snapshot(0, { clock: { phase: null, minutesUntilChange: null } })), false);
});

test("lowHealthAt schema accepts its boundaries and rejects values outside them", () => {
  for (const value of [1, 19, 7.5]) assert.equal(personaSchema.parse({ ...testPersona(), settings: { lowHealthAt: value } }).settings.lowHealthAt, value);
  for (const value of [0.9, 19.1]) assert.equal(personaSchema.safeParse({ ...testPersona(), settings: { lowHealthAt: value } }).success, false);
});
