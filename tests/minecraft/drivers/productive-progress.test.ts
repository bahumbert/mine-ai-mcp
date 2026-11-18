// Productive evidence and observation windows reach Mine Labs without surviving their owner.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtempDisposable } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { declareProductiveProgress } from "./productive-progress.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "./server-ticks.ts";

/** Packet behavior comes from fake-bot-combat's attack-hurts-and-kills and damage-event-to-bot contracts. */
function fixture(rate = 20, timePacketYet = true) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, health: 14, server: { ticksPerSecond: rate, timePacketYet }, entities: {
    61: { name: "zombie", position: { x: 1, y: 64, z: 0 } },
    62: { name: "player", position: { x: 2, y: 64, z: 0 } },
  } });
  const reasons: string[] = [];
  const added = listenersAddedSince(harness.bot);
  const packetsAdded = listenersAddedSince(harness.bot._client);
  const record = (reason: string) => { reasons.push(reason); };
  return { ...harness, clock, reasons, record, added, packetsAdded };
}

test("only the bot's server-confirmed damage to another entity declares a hit", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  using _progress = declareProductiveProgress(f.bot, f.record);
  f.bot.attack(f.bot.entities[61]!);
  assert.deepEqual(f.reasons, [], "an attack request alone is not evidence");
  await f.clock.advance(50);
  assert.deepEqual(f.reasons, ["hit"]);
  f.combat.hurtBot(1, 61);
  await f.clock.advance(1_000);
  f.combat.hurt(61, 62, 1);
  // A projectile's direct source alone is not the bot's causal damage (entities.js:398-402).
  f.bot._client.emit("damage_event", { entityId: 61, sourceCauseId: 63, sourceDirectId: f.bot.entity.id + 1 });
  f.bot._client.emit("damage_event", { entityId: f.bot.entity.id, sourceCauseId: f.bot.entity.id + 1 });
  assert.deepEqual(f.reasons, ["hit"]);
});

test("health increases count once, damage and unchanged health do not", () => {
  const f = fixture();
  using _progress = declareProductiveProgress(f.bot, f.record);
  f.combat.setHealth(15);
  f.combat.setHealth(15);
  f.combat.setHealth(14);
  assert.deepEqual(f.reasons, ["healed"]);
  f.combat.setHealth(15);
  assert.deepEqual(f.reasons, ["healed", "healed"], "the comparison follows the last health, not its maximum");
});

for (const rate of [20, 10]) {
  test(`observation lifecycle counts world-age ticks, separates windows and expires stopped clocks at ${rate} tps`, async () => {
    const f = fixture(rate);
    using _timers = f.clock.install();
    using progress = declareProductiveProgress(f.bot, f.record);
    const startAge = f.bot.time.age;
    progress.observing(true);
    await f.clock.advance(20_000 / rate - 1);
    assert.deepEqual(f.reasons, []);
    await f.clock.advance(1);
    assert.deepEqual(f.reasons, ["observing"]);
    progress.observing(true); // Repeated phase samples do not restart the window.
    await f.clock.advance(80_000 / rate);
    assert.equal(f.bot.time.age - startAge, 100);
    assert.deepEqual(f.reasons, Array(5).fill("observing"));
    progress.observing(false);
    await f.clock.advance(200_000 / rate);
    assert.equal(f.reasons.length, 5);
    progress.observing(true);
    await f.clock.advance(50_000 / rate);
    progress.observing(false);
    assert.deepEqual(f.reasons, Array(7).fill("observing"));
    await f.clock.advance(100_000 / rate);
    assert.equal(f.reasons.length, 7, "no declaration after phase exit at +50 ticks");
    await f.clock.advance(10_000 / rate);
    progress.observing(true);
    await f.clock.advance(40_000 / rate);
    assert.deepEqual(f.reasons, Array(9).fill("observing"));
    f.server.stop();
    const stoppedAge = f.bot.time.age;
    await f.clock.advance(DRIVER_CLOCK_STOPPED_MS - 1);
    progress.observing(true);
    assert.equal(f.clock.pendingGlobalTimers(), 1, "the last packet renewed the existing stall bound");
    await f.clock.advance(1);
    assert.equal(f.clock.pendingGlobalTimers(), 0, "the stopped observation no longer owns a timer");
    assert.equal(f.bot.time.age, stoppedAge);
    f.server.resume();
    await f.clock.advance(40_000 / rate);
    assert.deepEqual(f.reasons, Array(9).fill("observing"), "a resumed clock cannot revive the old phase");
    progress.observing(true);
    await f.clock.advance(20_000 / rate);
    assert.deepEqual(f.reasons, Array(10).fill("observing"));
  });
}

test("an observation before the first time packet starts counting from the first known age", async () => {
  const f = fixture(10, false);
  using _timers = f.clock.install();
  using progress = declareProductiveProgress(f.bot, f.record);
  progress.observing(true);
  await f.clock.advance(2_000);
  assert.deepEqual(f.reasons, []);
  await f.clock.advance(2_000);
  assert.deepEqual(f.reasons, ["observing"]);
});

for (const exit of ["dispose", "death", "end", "abort", "already aborted", "already dead"] as const) {
  test(`${exit} removes listeners and timers and prevents later evidence or observation`, async () => {
    const f = fixture();
    using _timers = f.clock.install();
    const controller = new AbortController();
    if (exit === "already aborted") controller.abort();
    if (exit === "already dead") f.combat.setHealth(0);
    using progress = declareProductiveProgress(f.bot, f.record, controller.signal);
    progress.observing(true);
    if (exit === "dispose") progress[Symbol.dispose]();
    if (exit === "death") f.combat.setHealth(0);
    if (exit === "end") f.bot.emit("end", "disconnected");
    if (exit === "abort") controller.abort();
    for (const event of ["time", "health", "death", "end"]) assert.equal(f.added(event), 0, event);
    assert.equal(f.packetsAdded("damage_event"), 0);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    progress.observing(true);
    f.combat.setHealth(15);
    f.bot._client.emit("damage_event", { entityId: 61, sourceCauseId: f.bot.entity.id + 1 });
    await f.clock.advance(DRIVER_CLOCK_STOPPED_MS + 2_000);
    assert.deepEqual(f.reasons, []);
    progress[Symbol.dispose]();
    for (const event of ["time", "health", "death", "end"]) assert.equal(f.added(event), 0, event);
    assert.equal(f.packetsAdded("damage_event"), 0);
    assert.equal(f.clock.pendingGlobalTimers(), 0);
  });
}

/** Isolate module mocks from other tests while exercising each complete host's driver boundary. */
function hostProbe(host: string, withRuntime: boolean): string {
  return `
    import assert from "node:assert/strict";
    import { mock } from "bun:test";
    import { createFakeBot } from "./src/test-support/fake-bot/index.ts";
    const { bot } = createFakeBot();
    const reasons = [];
    const completions = [];
    const session = {
      env: {}, scenario: { name: "progress-host", params: {} }, username: "Actor",
      signal: new AbortController().signal, start: Promise.resolve(), arranged: Promise.resolve(),
      log() {}, chat() {}, prepared() {}, progress(reason) { reasons.push(reason); },
      finish(result) { completions.push(result); }
    };
    const client = await import("mine-labs/client");
    mock.module("mine-labs/client", () => ({ ...client, runNodeClient: async run => run(session) }));
    mock.module("@aibengineering/mine-ai-mcp", () => ({
      BOT_PHYSICS_OPTIONS: {}, assertBotPluginsLoaded() {}, loadBotPlugins() {},
      createNavigationRuntime: () => ({ async [Symbol.asyncDispose]() {} }),
      createMinecraftRuntime: async () => ({ async [Symbol.asyncDispose]() {} })
    }));
    mock.module("./tests/minecraft/scenario-bot.ts", () => ({
      createScenarioBot: () => bot, prepareScenarioBot: async () => {}, closeScenarioBot() {}
    }));
    mock.module("./tests/minecraft/scenario-highlighter.ts", () => ({ openScenarioHighlighter: async () => undefined }));
    mock.module("mineflayer", () => ({ default: { createBot() { queueMicrotask(() => bot.emit("spawn")); return bot; } } }));
    mock.module("./scenarios/src/player-preparation.ts", () => ({ prepareScenarioPlayer: async () => {} }));
    mock.module("./scenarios/src/pathfinder-implementation.ts", () => ({
      installScenarioPathfinder: () => ({ summary: () => "", close() {} })
    }));
    const driver = new URL("./tests/minecraft/drivers/single-action.ts", import.meta.url).pathname;
    mock.module(driver, () => ({ run: async context => {
      context.progress("x");
      return { status: "succeeded" };
    } }));
    process.argv = [process.execPath, ${JSON.stringify(host)}, driver, ...${JSON.stringify(withRuntime ? [] : ["--without-runtime"])}];
    await import(${JSON.stringify(host)});
    assert.deepEqual(completions.map(result => result.status), ["succeeded"], JSON.stringify(completions));
    console.log(JSON.stringify(reasons));
  `;
}

for (const { host, withRuntime } of [
  { host: "./tests/minecraft/client-host.ts", withRuntime: false },
  { host: "./tests/minecraft/client-host.ts", withRuntime: true },
  { host: "./scenarios/src/client-host.ts", withRuntime: true },
]) {
  test(`${host} forwards driver progress to its session (runtime ${withRuntime})`, async (t) => {
    await using scratch = await mkdtempDisposable("/dev/shm/productive-progress-host-");
    const { stdout } = await promisify(execFile)(process.execPath, ["--eval", hostProbe(host, withRuntime)], {
      cwd: join(import.meta.dirname, "../../.."), signal: t.signal,
      env: { ...process.env, TMPDIR: scratch.path, MINE_AI_SCENARIO_EVIDENCE: "0", MINE_LABS_ARTIFACTS_DIR: "" },
    });
    assert.deepEqual(JSON.parse(stdout.trim().split("\n").at(-1)!), ["x"]);
  });
}
