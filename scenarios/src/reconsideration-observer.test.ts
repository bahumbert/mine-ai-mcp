import test from "node:test";
import assert from "node:assert/strict";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../src/test-support/fake-bot/index.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "../../tests/minecraft/drivers/server-ticks.ts";
import { getEventListeners } from "node:events";
import { closeTrial, nextActionFromPursuitEnd, removeOnceOnAbort } from "../default/nether/enderman-reconsideration.ts";
import { hitsPerGameMinute, judgePursuit, observeReconsideration } from "../default/nether/reconsideration-observer.ts";
import type { MineAiScenarioContext } from "./scenario-client.ts";
import type { Runtime } from "./runtime.ts";

/** One arranged-move fixture on the shared fake; `rate` is the server's ticks a second. */
function fixture(rate = 20) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, server: { ticksPerSecond: rate }, entities: {
    2: { name: "enderman", position: { x: 0, y: 64, z: 0 } },
    3: { name: "enderman", position: { x: 4, y: 64, z: 0 } },
  }, overrides: { chat: () => {} } });
  const { bot } = harness;
  let selected = 2;
  const runtime = { status: () => ({ survival: { request: { evidence: { checkpoint: { selectedTargetId: selected } } } } }) } as unknown as Runtime;
  const context = { bot, log: () => {} } as unknown as MineAiScenarioContext;
  const child = new AbortController();
  const observer = observeReconsideration(context, runtime, { primary: 2, alternative: 3 }, { mode: "failed_approach", teleportTo: [10, 64, 0], returnTo: [1, 64, 0] }, child);
  return { ...harness, clock, child, observer, select: (id: number) => { selected = id; } };
}

// Mineflayer entities.js:354-375 emits entityMoved after applying the server position;
// entities.js:398-400 defines damage_event source ids. These emissions stand in for those packets.
test("proof requires server-observed moves and a hit, and death remains observable until cleanup", () => {
  const { bot, child, observer, select, clock } = fixture();
  using _timers = clock.install();
  bot.emit("physicsTick");
  assert.equal(observer.snapshot().primaryMoved, false);
  bot._client.emit("damage_event", { entityId: 2, sourceCauseId: bot.entity.id + 1, sourceDirectId: 0 });
  assert.equal(child.signal.aborted, false);
  bot.entities[2]!.position.set(10, 64, 0);
  bot.emit("entityMoved", bot.entities[2]);
  select(3);
  bot.emit("physicsTick");
  bot.entities[2]!.position.set(1, 64, 0);
  bot.emit("entityMoved", bot.entities[2]);
  assert.equal(child.signal.aborted, true);
  bot.emit("death");
  assert.equal(observer.snapshot().deaths, 1);
  observer.close();
  bot.emit("death");
  assert.equal(observer.snapshot().deaths, 1);
  assert.equal(bot._client.listenerCount("damage_event"), 0);
  assert.equal(clock.pendingGlobalTimers(), 0, "the budget of each observed move is released");
});

for (const rate of [20, 10]) {
  test(`an arranged move not seen within 100 server ticks fails, and releases observers, at ${rate} tps`, async () => {
    const f = fixture(rate);
    using _timers = f.clock.install();
    let failed = false;
    f.observer.failure.catch(() => { failed = true; });
    const sentAt = f.server.gameTime;
    f.bot.emit("physicsTick");
    while (!failed && f.server.gameTime - sentAt < 300) await f.clock.advance(20_000 / rate);
    assert.equal(failed, true);
    assert.ok(f.server.gameTime - sentAt >= 100, "never before its 100 server ticks");
    assert.ok(f.server.gameTime - sentAt <= 140, "and soon after, the packet margin allowed");
    f.observer.close();
    assert.equal(f.bot.listenerCount("entityMoved"), 0);
    assert.equal(f.bot._client.listenerCount("damage_event"), 0);
    assert.equal(f.clock.pendingGlobalTimers(), 0);
  });
}

// The shared server-paced budget looks every 50 ms and backs a 100-tick limit with 3 x (100 + 20) ticks of wall time
// (`serverPacedWallMs`, 18 s), under the 30 s stopped-clock bound: a stopped server ends it there, one look late at most.
test("a stopped server fails an arranged move at the budget's wall backstop, not before", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  let failed = false;
  f.observer.failure.catch(() => { failed = true; });
  f.bot.emit("physicsTick");
  f.server.stop();
  await f.clock.advance(17_900);
  assert.equal(failed, false, "100 ms inside the backstop");
  await f.clock.advance(200);
  assert.equal(failed, true, "past it");
  f.observer.close();
});

test("a move seen within its budget is accepted and nothing fails after it", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  let failed = false;
  f.observer.failure.catch(() => { failed = true; });
  f.bot.emit("physicsTick");
  await f.clock.advance(2_000); // 40 server ticks
  f.bot.entities[2]!.position.set(10, 64, 0);
  f.bot.emit("entityMoved", f.bot.entities[2]);
  assert.equal(f.observer.snapshot().primaryMoved, true);
  await f.clock.advance(DRIVER_CLOCK_STOPPED_MS + 5_000);
  assert.equal(failed, false);
  assert.equal(f.clock.pendingGlobalTimers(), 0);
  f.observer.close();
});

// Pursuit mode: the hunt goes on after the first hit; the window, the stop and the measures count server ticks.
const PURSUIT = { windowTicks: 1_200, minDisplacement: 8, terrain: { from: [-5, 63, -5], to: [5, 80, 5] }, provoke: { everyTicks: 100, command: "/damage @e[tag=t] 1 minecraft:on_fire" } } as const;
const EVENTS = ["time", "physicsTick", "entityMoved", "entityDead", "entityGone", "death"];

function pursuitFixture(options: { rate?: number; observing?: (active: boolean) => void } = {}) {
  const rate = options.rate ?? 20;
  const clock = createFakeClock({ mode: "mocked" });
  const chats: string[] = [];
  const harness = createFakeBot({ clock, server: { ticksPerSecond: rate }, entities: {
    2: { name: "enderman", position: { x: 0, y: 64, z: 0 } },
    4: { name: "zombie", position: { x: 3, y: 64, z: 3 } },
  }, overrides: { chat: (message: string) => { chats.push(message); } } });
  const { bot } = harness;
  bot.entity.position.set(0.5, 64, 0.5);
  const added = listenersAddedSince(bot);
  const packetsAdded = listenersAddedSince(bot._client);
  const observing: boolean[] = [];
  const context = { bot, log: () => {} } as unknown as MineAiScenarioContext;
  const runtime = { status: () => ({ survival: { request: undefined } }) } as unknown as Runtime;
  const child = new AbortController();
  const progress = { observing: (active: boolean) => { observing.push(active); options.observing?.(active); } };
  const observer = observeReconsideration(context, runtime, { primary: 2 }, { mode: "pursuit", pursuit: PURSUIT }, child, progress);
  const hit = () => bot._client.emit("damage_event", { entityId: 2, sourceCauseId: bot.entity.id + 1, sourceDirectId: 0 });
  /** One server tick, then one time packet (20 ticks) later. */
  const tick = () => clock.advance(1_000 / rate);
  const packet = () => clock.advance(20_000 / rate);
  /** The server ticks since `since` (the fake server's own game time, not the client's last packet). */
  const elapsed = (since: number) => harness.server.gameTime - since;
  return { ...harness, clock, child, chats, observer, observing, added, packetsAdded, hit, tick, packet, elapsed };
}

test("pursuit mode does not abort at the first hit, and time packets before any hit start nothing", async () => {
  const f = pursuitFixture();
  using _timers = f.clock.install();
  for (let step = 0; step < 5; step++) await f.packet();
  assert.equal(f.observer.snapshot().pursuit, null);
  assert.deepEqual(f.observing, []);
  assert.deepEqual(f.chats, [], "nothing is provoked before the first hit");
  f.hit();
  assert.equal(f.observer.snapshot().firstNativeHit, 2);
  assert.equal(f.child.signal.aborted, false);
  f.observer.close();
});

for (const rate of [20, 10]) {
  for (const phase of [0, 19]) {
    test(`the pursuit window is 1200 server ticks from the first hit, the last packet ${phase} ticks stale, at ${rate} tps`, async () => {
      const f = pursuitFixture({ rate });
      using _timers = f.clock.install();
      for (let step = 0; step < phase; step++) await f.tick();
      const hitAt = f.server.gameTime;
      f.hit();
      while (!f.child.signal.aborted && f.elapsed(hitAt) < 1_300) await f.tick();
      assert.equal(f.child.signal.aborted, true);
      assert.ok(f.elapsed(hitAt) >= 1_200, `ended after ${f.elapsed(hitAt)} server ticks`);
      assert.ok(f.elapsed(hitAt) <= 1_240, `ended after ${f.elapsed(hitAt)} server ticks`);
      const { pursuit } = f.observer.snapshot();
      assert.equal(pursuit?.ended, "window");
      assert.deepEqual(f.observing, [true, false], "progress is declared only while the pursuit window is open");
      assert.equal(f.chats.length, 1 + Math.floor((pursuit?.ticks ?? 0) / 100), "provoked at the first hit and each 100 ticks, never after the end");
      await f.packet();
      assert.equal(f.chats.length, 1 + Math.floor((pursuit?.ticks ?? 0) / 100), "nothing more once ended");
      f.observer.close();
    });
  }

  test(`a stopped server fails the pursuit at the stopped-clock bound, not before, at ${rate} tps`, async () => {
    const f = pursuitFixture({ rate });
    using _timers = f.clock.install();
    const seen: { failure?: Error } = {};
    f.observer.failure.catch((error: Error) => { seen.failure = error; });
    f.hit();
    await f.packet();
    f.server.stop();
    await f.clock.advance(DRIVER_CLOCK_STOPPED_MS - 100);
    const message = () => seen.failure?.message;
    assert.equal(message(), undefined, "100 ms inside the bound (the budget looks every 50 ms)");
    await f.clock.advance(200);
    assert.match(String(message()), /server clock stopped during pursuit/);
    assert.equal(f.child.signal.aborted, false, "the failure, not the window, ends it");
    assert.equal(f.observing.at(-1), false);
    f.observer.close();
  });
}

test("a hit starts the provocation, a later hit does not repeat it, and each 100 server ticks sends it again", async () => {
  const f = pursuitFixture();
  using _timers = f.clock.install();
  f.hit();
  assert.equal(f.chats.length, 1);
  f.hit();
  assert.equal(f.chats.length, 1);
  for (let step = 0; step < 4; step++) await f.packet();
  assert.equal(f.chats.length, 1, "80 ticks in");
  await f.packet();
  assert.equal(f.chats.length, 2, "100 ticks in");
  assert.deepEqual([...new Set(f.chats)], ["/damage @e[tag=t] 1 minecraft:on_fire"]);
  f.observer.close();
});

test("pursuit records both positions at the first hit and at each packet, and measures displacements, lowest y and terrain cells", async () => {
  const f = pursuitFixture();
  using _timers = f.clock.install();
  f.hit();
  f.hit();
  f.bot.entities[2]!.position.set(3, 64, 4);
  f.bot.entity.position.set(0.5, 62, 0.5);
  f.bot.emit("physicsTick");
  await f.packet();
  f.bot.entities[2]!.position.set(9, 64, 0); // 9 blocks from where it stood at the first hit
  f.bot.entity.position.set(8.5, 64, 0.5); // x 8 is outside the box (-5..5)
  f.bot.emit("physicsTick");
  f.bot.emit("physicsTick"); // the same cell twice counts once
  await f.packet();
  const { pursuit } = f.observer.snapshot();
  assert.equal(pursuit?.hits, 2);
  assert.equal(pursuit?.targetDisplacement, 9);
  assert.ok(Math.abs((pursuit?.botDisplacement ?? 0) - 8) < 0.01);
  assert.equal(pursuit?.minimumY, 62);
  assert.equal(pursuit?.offTerrainCells, 2, "the dip to y 62 (box floor 63) and x 8 are two cells");
  assert.equal(pursuit?.onTerrain, false);
  // The box is [-5, 6) x [63, 81) x [-5, 6) in blocks: x 8.5 stands 2.5 outside it, y 62 stands 1 below it.
  assert.equal(pursuit?.maxDistanceOffTerrain, 2.5);
  assert.equal(pursuit?.endDistanceOffTerrain, 2.5);
  assert.deepEqual(pursuit?.samples.map(({ target, bot }) => [target, bot]), [
    [[0, 64, 0], [0.5, 64, 0.5]], // the first hit
    [[3, 64, 4], [0.5, 62, 0.5]],
    [[9, 64, 0], [8.5, 64, 0.5]],
  ]);
  f.observer.close();
});

test("the distance off the terrain is the straight distance to the box, its maximum kept after the bot comes back", () => {
  const f = pursuitFixture();
  using _timers = f.clock.install();
  f.hit();
  f.bot.entity.position.set(9, 64, 10); // 3 blocks east of x 6 and 4 south of z 6: 5 blocks away
  f.bot.emit("physicsTick");
  assert.equal(f.observer.snapshot().pursuit?.endDistanceOffTerrain, 5);
  f.bot.entity.position.set(0.5, 64, 0.5);
  f.bot.emit("physicsTick");
  const { pursuit } = f.observer.snapshot();
  assert.equal(pursuit?.endDistanceOffTerrain, 0);
  assert.equal(pursuit?.maxDistanceOffTerrain, 5);
  assert.equal(pursuit?.onTerrain, true);
  f.observer.close();
});

for (const [name, x, y, z, inside] of [
  ["the low corner", -5, 63, -5, true],
  ["the high corner", 5.99, 80.99, 5.99, true],
  ["one cell below the floor", 0, 62.99, 0, false],
  ["one cell above the roof", 0, 81, 0, false],
  ["one cell west of the box", -5.01, 64, 0, false],
  ["one cell east of the box", 6, 64, 0, false],
  ["one cell north of the box", 0, 64, -5.01, false],
  ["one cell south of the box", 0, 64, 6, false],
] as const) {
  test(`terrain box faces are inclusive: ${name}`, () => {
    const f = pursuitFixture();
    using _timers = f.clock.install();
    f.hit();
    f.bot.entity.position.set(x, y, z);
    f.bot.emit("physicsTick");
    assert.equal(f.observer.snapshot().pursuit?.onTerrain, inside);
    f.observer.close();
  });
}

test("the server's death status ends the pursuit and keeps what was measured; another entity's does not", async () => {
  const f = pursuitFixture();
  using _timers = f.clock.install();
  f.hit();
  f.bot.entities[2]!.position.set(10, 64, 0);
  await f.packet();
  f.bot.emit("entityDead", f.bot.entities[4]);
  assert.equal(f.child.signal.aborted, false, "a zombie's death is not the target's");
  f.bot.emit("entityDead", f.bot.entities[2]);
  assert.equal(f.child.signal.aborted, true);
  const { pursuit } = f.observer.snapshot();
  assert.equal(pursuit?.ended, "target died");
  assert.equal(pursuit?.targetDisplacement, 10);
  assert.deepEqual(f.observing, [true, false]);
  const chatsAtEnd = f.chats.length;
  f.hit();
  await f.packet();
  assert.equal(f.observer.snapshot().pursuit?.hits, 1, "a hit after the end is not counted");
  assert.equal(f.chats.length, chatsAtEnd, "nothing is provoked after the end");
  f.observer.close();
});

test("a target unloaded while alive does not end the pursuit: it is a missing sample", async () => {
  const f = pursuitFixture();
  using _timers = f.clock.install();
  f.hit();
  f.entities.remove(2);
  await f.packet();
  assert.equal(f.child.signal.aborted, false);
  const { pursuit } = f.observer.snapshot();
  assert.equal(pursuit?.ended, null);
  assert.equal(pursuit?.samples.at(-1)?.target, null);
  f.observer.close();
});

test("settling the pursuit stops its tracking at once, so a cleanup kill is not its endpoint", async () => {
  const f = pursuitFixture();
  using _timers = f.clock.install();
  f.hit();
  await f.packet();
  f.observer.settlePursuit();
  f.bot.emit("entityDead", f.bot.entities[2]);
  assert.equal(f.child.signal.aborted, false);
  assert.equal(f.observer.snapshot().pursuit?.ended, null, "the hunt ended with the target alive: the judge says so");
  assert.deepEqual(f.observing, [true, false]);
  f.observer.close();
});

for (const exit of ["window", "closed before any hit", "closed during the pursuit", "target died", "stopped clock", "progress callback throws"] as const) {
  test(`${exit}: no listener, timer or later provocation is left`, async () => {
    const f = pursuitFixture({ observing: (active) => { if (!active && exit === "progress callback throws") throw new Error("boom"); } });
    using _timers = f.clock.install();
    const seen: { failure?: Error } = {};
    f.observer.failure.catch((error: Error) => { seen.failure = error; });
    if (exit !== "closed before any hit") f.hit();
    if (exit === "window") while (!f.child.signal.aborted) await f.tick();
    if (exit === "target died") f.bot.emit("entityDead", f.bot.entities[2]);
    if (exit === "stopped clock") { f.server.stop(); await f.clock.advance(DRIVER_CLOCK_STOPPED_MS); }
    if (exit === "progress callback throws") assert.throws(() => f.observer.close(), /boom/);
    else f.observer.close();
    if (exit === "stopped clock") assert.ok(seen.failure, "the stall was reported");
    for (const event of EVENTS) assert.equal(f.added(event), 0, event);
    for (const event of ["damage_event", "entity_teleport"]) assert.equal(f.packetsAdded(event), 0, event);
    const chatsAtEnd = f.chats.length;
    f.server.resume();
    await f.clock.advance(DRIVER_CLOCK_STOPPED_MS + 2_000);
    assert.equal(f.chats.length, chatsAtEnd, "nothing provoked after the exit");
    assert.equal(f.clock.pendingGlobalTimers(), 0);
    if (exit !== "closed before any hit") assert.equal(f.observing.at(-1), false, "the progress window is closed too");
  });
}

const stimulus = { firstHit: true, ended: "window", targetDisplacement: 8, botDisplacement: 8, deaths: 0, health: 20, next: "home" } as const;

// Spec D17 (owner 2026-11-18): the terrain distances, the off-terrain cells and the home rate are recorded, not judged;
// the judge has no terrain input, so a bot that ended far off the box passes on its next action alone.
test("judgePursuit passes an alive bot whose stimulus happened and whose next action ended, home or in a bounded failure, at each bound", () => {
  assert.deepEqual(judgePursuit(stimulus, 8), []);
  assert.deepEqual(judgePursuit({ ...stimulus, next: "bounded failure" }, 8), [], "alive, off the terrain, not home: passes");
  assert.match(judgePursuit({ ...stimulus, next: null }, 8).join(), /^the next action did not end within its budget$/);
  assert.deepEqual(judgePursuit({ ...stimulus, ended: "target died" }, 8), []);
  assert.match(judgePursuit({ ...stimulus, targetDisplacement: 7.9 }, 8).join(), /^no pursuit: the target moved 7\.9 blocks/);
  assert.match(judgePursuit({ ...stimulus, targetDisplacement: 0, botDisplacement: 0 }, 8).join(), /^no pursuit: the target moved 0 blocks/);
  assert.match(judgePursuit({ ...stimulus, firstHit: false, ended: null, targetDisplacement: 0, botDisplacement: 0 }, 8).join(), /^no pursuit: the hunt ended before the first hit$/);
  assert.match(judgePursuit({ ...stimulus, botDisplacement: 7.9 }, 8).join(), /^the bot did not follow: it moved 7\.9 blocks/);
  assert.match(judgePursuit({ ...stimulus, ended: null }, 8).join(), /^no pursuit: the hunt ended before the window passed or the target died$/);
  assert.match(judgePursuit({ ...stimulus, deaths: 1 }, 8).join(), /^the bot died$/);
  assert.match(judgePursuit({ ...stimulus, health: 0 }, 8).join(), /^the bot died$/);
  assert.match(judgePursuit({ ...stimulus, deaths: 1, next: "bounded failure" }, 8).join(), /^the bot died$/, "a death fails whatever the next action did");
});

/** A runtime whose `navigate` ends with the scripted answer, throws the given error, or waits for its signal. */
function navigateRuntime(behaviour: { status: string } | Error | "waits" = "waits") {
  const runtime = {
    actions: [{ name: "navigate" }],
    run: (_action: unknown, _input: unknown, signal: AbortSignal) => {
      if (behaviour instanceof Error) return Promise.reject(behaviour);
      if (behaviour !== "waits") return Promise.resolve({ result: behaviour });
      return new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
    status: () => ({ survival: { request: undefined } }),
  };
  return runtime as unknown as Runtime;
}
const home = { x: 100, y: 100, z: 0 };

/** A bare fake bot on a mocked clock, with no observer listening to it. */
function bareFixture(rate = 20) {
  const clock = createFakeClock({ mode: "mocked" });
  return { ...createFakeBot({ clock, server: { ticksPerSecond: rate } }), clock };
}

/** Start the next action from a pursuit's end and record how it settled (once), with the resources it must retire. */
function startNextAction(f: ReturnType<typeof bareFixture>, behaviour: Parameters<typeof navigateRuntime>[0], failure: Promise<never> = new Promise<never>(() => {})) {
  const trial = new AbortController();
  const context = { bot: f.bot, signal: trial.signal, log: () => {} } as unknown as MineAiScenarioContext;
  const seen: { outcome?: string; error?: unknown; settled: number } = { settled: 0 };
  nextActionFromPursuitEnd(context, navigateRuntime(behaviour), home, failure, 600)
    .then((next) => { seen.outcome = next.outcome; }, (error: unknown) => { seen.error = error; })
    .finally(() => { seen.settled++; });
  return { trial, seen };
}
/** After an exit: advance past every old deadline and prove nothing is left (T6). */
async function assertRetired(f: ReturnType<typeof bareFixture>, trial: AbortController, seen: { settled: number }) {
  await f.clock.advance(DRIVER_CLOCK_STOPPED_MS + 5_000);
  assert.equal(seen.settled, 1, "settled once");
  assert.equal(f.clock.pendingGlobalTimers(), 0, "the budget's timer is released");
  assert.equal(getEventListeners(trial.signal, "abort").length, 0, "no abort listener is left on the trial's signal");
}

const nextActionFailure = new Error("arranged move not observed");
const navigateCrash = new Error("navigate crashed");
for (const [name, behaviour, expected] of [
  ["home on a navigate that succeeded", { status: "succeeded" }, { outcome: "home" }],
  ["a bounded failure on a navigate that ended failed", { status: "failed" }, { outcome: "bounded failure" }],
  ["the error itself on an ordinary navigate error, never a bounded failure", navigateCrash, { error: navigateCrash }],
] as const) {
  test(`the next action from a pursuit's end gives ${name}, and retires its budget and listeners`, async () => {
    const f = bareFixture();
    using _timers = f.clock.install();
    const { trial, seen } = startNextAction(f, behaviour);
    await f.clock.advance(1);
    assert.equal(seen.outcome, "outcome" in expected ? expected.outcome : undefined);
    assert.equal(seen.error, "error" in expected ? expected.error : undefined);
    await assertRetired(f, trial, seen);
  });
}

test("an observation failure during the next action is thrown as it is, and retires its budget and listeners", async () => {
  const f = bareFixture();
  using _timers = f.clock.install();
  const { trial, seen } = startNextAction(f, "waits", Promise.reject(nextActionFailure));
  await f.clock.advance(1);
  assert.equal(seen.error, nextActionFailure);
  assert.equal(seen.outcome, undefined);
  await assertRetired(f, trial, seen);
});

test("a cancelled trial is thrown, never a bounded failure of the next action, and retires its budget and listeners", async () => {
  const f = bareFixture();
  using _timers = f.clock.install();
  const { trial, seen } = startNextAction(f, "waits");
  const reason = new Error("cancel trial");
  trial.abort(reason);
  await f.clock.advance(1);
  assert.equal(seen.error, reason);
  assert.equal(seen.outcome, undefined);
  await assertRetired(f, trial, seen);
});

for (const rate of [20, 10]) {
  test(`a next action that never ends is a bounded failure after its 600 server ticks, not before, at ${rate} tps`, async () => {
    const f = bareFixture(rate);
    using _timers = f.clock.install();
    const startedAt = f.server.gameTime;
    const { trial, seen } = startNextAction(f, "waits");
    while (seen.outcome === undefined && f.server.gameTime - startedAt < 900) await f.clock.advance(20_000 / rate);
    assert.equal(seen.outcome, "bounded failure");
    assert.ok(f.server.gameTime - startedAt >= 600, `ended after ${f.server.gameTime - startedAt} server ticks`);
    assert.ok(f.server.gameTime - startedAt <= 640, `ended after ${f.server.gameTime - startedAt} server ticks`);
    await assertRetired(f, trial, seen);
  });
}

test("a stopped server ends a next action that never ends at the stopped-clock bound, as a bounded failure", async () => {
  const f = bareFixture();
  using _timers = f.clock.install();
  const { trial, seen } = startNextAction(f, "waits");
  f.server.stop();
  await f.clock.advance(DRIVER_CLOCK_STOPPED_MS - 100);
  assert.equal(seen.outcome, undefined, "100 ms inside the bound (the budget looks every 50 ms)");
  await f.clock.advance(200);
  assert.equal(seen.outcome, "bounded failure");
  await assertRetired(f, trial, seen);
});

// A fight response keeps the body (and the cancelled hunt unsettled) while the arranged Enderman, 1000 health, still stands:
// the scenario removes the threat the moment the hunt is cancelled, then waits for the hunt to settle.
test("the arranged threat is removed once, as soon as the hunt is cancelled, and the caller awaits that one removal", async () => {
  const hunt = new AbortController();
  let removals = 0;
  const deferred = Promise.withResolvers<void>();
  const removal = removeOnceOnAbort(hunt.signal, () => { removals++; return deferred.promise; });
  assert.equal(removals, 0, "nothing before the cancel");
  hunt.abort("pursuit window passed");
  assert.equal(removals, 1, "the cancel starts it");
  let awaited = false;
  const finished = removal.run().then(() => { awaited = true; });
  await Promise.resolve();
  assert.equal(awaited, false, "the caller waits for the removal");
  deferred.resolve();
  await finished;
  await removal.run();
  assert.equal(removals, 1, "later calls share the one removal");
});

test("with no cancel, the caller's call starts the removal, once; before it, nothing is pending", async () => {
  const hunt = new AbortController();
  let removals = 0;
  const removal = removeOnceOnAbort(hunt.signal, async () => { removals++; });
  await removal.settled();
  assert.equal(removals, 0, "waiting for a removal that never started starts none");
  await removal.run();
  await removal.run();
  hunt.abort("late");
  assert.equal(removals, 1, "a cancel after the removal started starts no second one");
});

test("a failed removal reaches the caller that awaits it and is never an unhandled rejection", async () => {
  const hunt = new AbortController();
  const removal = removeOnceOnAbort(hunt.signal, async () => { throw new Error("arranged Endermen not removed"); });
  hunt.abort("cancelled");
  await assert.rejects(removal.run(), /not removed/);
});

/** The finalizer's parts, recording the order they run in. */
function closing(options: { observerThrows?: Error; progressThrows?: Error; removal?: () => Promise<void> } = {}) {
  const events: string[] = [];
  const logs: string[] = [];
  const child = new AbortController();
  const removal = removeOnceOnAbort(child.signal, options.removal ?? (async () => { events.push("removed"); }));
  const parts = {
    observer: { close() { events.push("observer"); if (options.observerThrows) throw options.observerThrows; } },
    progress: { [Symbol.dispose]() { events.push("progress"); if (options.progressThrows) throw options.progressThrows; } },
    child,
    runtime: { close: async () => { events.push("runtime"); } } as unknown as Runtime,
    removal,
    log: (message: string) => { logs.push(message); },
  };
  return { events, logs, child, parts };
}

test("the finalizer's cancel starts the pursuit's removal and the runtime closes only after it", async () => {
  const deferred = Promise.withResolvers<void>();
  const c = closing({ removal: async () => { c.events.push("removal started"); await deferred.promise; c.events.push("removed"); } });
  const closed = closeTrial(c.parts);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(c.events, ["observer", "progress", "removal started"], "the runtime waits for the removal");
  deferred.resolve();
  await closed;
  assert.deepEqual(c.events, ["observer", "progress", "removal started", "removed", "runtime"]);
});

test("a removal that failed is logged by the finalizer, never thrown over the trial's own error, and the runtime still closes", async () => {
  const c = closing({ removal: async () => { throw new Error("arranged Endermen not removed"); } });
  await closeTrial(c.parts);
  assert.deepEqual(c.events, ["observer", "progress", "runtime"]);
  assert.match(c.logs.join(), /removal failed during cleanup.*not removed/);
});

test("a removal that is not started (the other modes) is not started by the finalizer's wait", async () => {
  const c = closing();
  const lazy = removeOnceOnAbort(AbortSignal.any([]), async () => { c.events.push("removed"); });
  await closeTrial({ ...c.parts, child: new AbortController(), removal: lazy }); // a child the helper in `c` is not bound to
  assert.deepEqual(c.events, ["observer", "progress", "runtime"]);
});

test("every finalizer step runs when an earlier one throws, and the first error is the one thrown", async () => {
  const c = closing({ observerThrows: new Error("observer close"), progressThrows: new Error("progress dispose") });
  await assert.rejects(closeTrial(c.parts), /observer close/);
  assert.deepEqual(c.events, ["observer", "progress", "removed", "runtime"]);
  assert.equal(c.child.signal.aborted, true);
});

test("hits per game minute count 1200 server ticks to the minute", () => {
  assert.equal(hitsPerGameMinute({ hits: 6, ticks: 600 }), 12);
  assert.equal(hitsPerGameMinute({ hits: 6, ticks: 1_200 }), 6);
  assert.equal(hitsPerGameMinute({ hits: 3, ticks: 0 }), null);
});
