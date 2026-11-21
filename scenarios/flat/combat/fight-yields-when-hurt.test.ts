/** Fight-yields counts server ticks, needs a post-wound safe withdrawal and declares the watch after it (plan 2026-11-18-scenario-reds-part2-a3 T13k, D34). */
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { spyOn } from "bun:test";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { observeDamageRegistry } from "../../../src/world/damage-registry.ts";
import { declareProductiveProgress } from "../../../tests/minecraft/drivers/productive-progress.ts";
import * as scenarioRuntime from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { judgeYield, run, watchNativeContact, watchYield, type YieldRead } from "./fight-yields-when-hurt.ts";
import * as reflex from "./reflex.ts";
import type { Encounter } from "./reflex.ts";

const START_AGE = 1_000;
/** The watch is 60 s of server time (1,200 ticks); the receipts are read every 40 ticks (waitServerTicks of 20 adds a packet). */
const WATCH_TICKS = 1_200;
const PACKET_TICKS = 20;
/** Zombie id: spawned by the fixture, the cause of every native hit. */
const ZOMBIE = 61;

type Outcome = Encounter["outcome"];
type Batch = { encounters?: Encounter[]; limits?: Awaited<ReturnType<YieldRead>>["limits"]; failures?: Awaited<ReturnType<YieldRead>>["failures"] };

/** The damage types the fake's own login packet lists: the host's registry observer fills its table from them. */
function damageTypeEntries(bot: ReturnType<typeof createFakeBot>["bot"]): { key: string }[] {
  const { loginPacket } = bot.registry as unknown as { loginPacket: { dimensionCodec: Record<string, { entries: { key: string }[] }> } };
  return loginPacket.dimensionCodec["minecraft:damage_type"]!.entries;
}

/** One published encounter; only response and outcome matter to the judge. */
function encounter(response: Encounter["response"], outcome: Outcome): Encounter {
  return { response, outcome, reason: "wounded", interrupted: null, healthBefore: 9, healthAfter: 9, attacks: 0, combatStyles: [],
    weaponsUsed: [], shieldRaisedSwings: 0, projectileGuards: 0, explosions: 0, finalPosition: { x: 0, y: -60, z: 0 }, finalDistances: [] };
}
const separation = () => encounter("evade", "safe_separation");

/** Build a shared-clock trial; `publish(atTicks, batch)` is what the runtime's event log holds from that world age on. */
function fixture(rate = 20, timePacketYet = true, health = 9) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, health, server: { startAge: START_AGE, ticksPerSecond: rate, timePacketYet },
    entities: { [ZOMBIE]: { name: "zombie", position: { x: 1, y: 64, z: 0 } } } });
  const { bot, server } = harness;
  // The host installs the damage registry before login and the login packet fills it: its listeners belong to the host, not to the code under test.
  observeDamageRegistry(bot);
  bot._client.emit("registry_data", { id: "minecraft:damage_type", entries: damageTypeEntries(bot) });
  const controller = new AbortController();
  const context = { bot, signal: controller.signal, log: () => {}, progress: () => {}, scenario: {
    entities: [{ type: "minecraft:zombie" }, { type: "minecraft:zombie" }],
    goal: { kind: "all", goals: [] },
  } } as unknown as MineAiScenarioContext;
  const published: { at: number; batch: Batch }[] = [];
  const reads: number[] = [];
  const read: YieldRead = async () => {
    const ticks = server.age - START_AGE;
    reads.push(ticks);
    const due = published.filter((entry) => entry.at <= ticks);
    for (const entry of due) published.splice(published.indexOf(entry), 1);
    return { encounters: due.flatMap((entry) => entry.batch.encounters ?? []), limits: due.flatMap((entry) => entry.batch.limits ?? []),
      failures: due.flatMap((entry) => entry.batch.failures ?? []) };
  };
  const reasons: { reason: string; ticks: number }[] = [];
  const added = listenersAddedSince(bot);
  const clientAdded = listenersAddedSince(bot._client);
  /** The progress reasons the declared observer published, with the world age they came at. */
  const progress = declareProductiveProgress(bot, (reason) => { reasons.push({ reason, ticks: server.age - START_AGE }); }, controller.signal);
  const observed = () => reasons.filter(({ reason }) => reason === "observing").map(({ ticks }) => ticks);
  const maxMs = ((WATCH_TICKS + 200) / rate) * 1_000;
  return { ...harness, clock, controller, context, publish: (at: number, batch: Batch) => void published.push({ at, batch }), read, reads,
    progress, reasons, observed, maxMs, assertClean: async () => {
      // Before the observer is disposed: only the watch's own exit can have ended its window (T6).
      assert.equal(added("time"), 0, "the watch left its observing window on");
      const declared = reasons.length;
      await clock.advance(100_000);
      assert.equal(reasons.length, declared, "an observing call came after the watch returned");
      progress[Symbol.dispose]();
      const check = () => {
        for (const event of bot.eventNames()) assert.equal(added(String(event)), 0, String(event));
        for (const event of bot._client.eventNames()) assert.equal(clientAdded(String(event)), 0, String(event));
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
        assert.equal(clock.pendingTimers(), 0);
        assert.equal(clock.pendingGlobalTimers(), 0);
      };
      check();
      await clock.advance(100_000);
      check();
    } };
}

/** Consecutive progress calls come on each time packet. */
function gaps(ticks: readonly number[]): number[] {
  return ticks.slice(1).map((tick, index) => tick - ticks[index]!);
}

for (const rate of [20, 10]) {
  test(`a safe separation at +150 declares the rest of the watch each 20 ticks at ${rate} tps`, async () => {
    const f = fixture(rate);
    using _timers = f.clock.install();
    f.publish(150, { encounters: [separation()] });
    const watched = await f.clock.settle(watchYield(f.context, f.read, f.progress), f.maxMs);
    assert.equal(watched.survival, "survived");
    assert.deepEqual(watched.encounters.map(({ outcome }) => outcome), ["safe_separation"]);
    const seen = f.observed();
    assert.ok(seen[0]! >= 150, `no observing progress before the separation was read (first ${seen[0]})`);
    assert.ok(seen[0]! <= 150 + 40 + PACKET_TICKS, `declared from the read after it (first ${seen[0]})`);
    assert.deepEqual([...new Set(gaps(seen))], [PACKET_TICKS], "one call per 20-tick time packet");
    assert.ok(seen.at(-1)! >= WATCH_TICKS - 2 * PACKET_TICKS, `declared to the end (last ${seen.at(-1)})`);
    assert.ok(seen.length >= 40, `${seen.length} calls`);
    assert.equal(f.reasons.filter(({ ticks }) => ticks < 150).length, 0, "nothing before the separation");
    assert.equal(judgeYield(watched, 1).status, "succeeded");
    await f.assertClean();
  });
}

test("a separation read only at +1000 declares from there, not before", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  f.publish(1_000, { encounters: [separation()] });
  const watched = await f.clock.settle(watchYield(f.context, f.read, f.progress), f.maxMs);
  const seen = f.observed();
  assert.ok(seen[0]! >= 1_000 && seen[0]! <= 1_000 + 40 + PACKET_TICKS, `first ${seen[0]}`);
  assert.deepEqual(judgeYield(watched, 1).status, "succeeded");
  await f.assertClean();
});

test("a recontact after the separation turns the declaration off until the next separation", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  f.publish(100, { encounters: [separation()] });
  f.publish(400, { encounters: [encounter("fight", "target_died")] });
  f.publish(700, { encounters: [separation()] });
  const watched = await f.clock.settle(watchYield(f.context, f.read, f.progress), f.maxMs);
  const seen = f.observed();
  const during = seen.filter((tick) => tick > 100 && tick <= 420);
  const off = seen.filter((tick) => tick > 440 && tick < 700);
  const again = seen.filter((tick) => tick >= 700);
  assert.ok(during.length >= 10, `on after the first separation (${during.length})`);
  assert.equal(off.length, 0, `off while the later response stood (${off})`);
  assert.ok(again.length >= 20, `on again after the next separation (${again.length})`);
  assert.equal(judgeYield(watched, 1).status, "succeeded");
  await f.assertClean();
});

test("a failure after the separation turns the declaration off and fails the judge", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  f.publish(100, { encounters: [separation()] });
  f.publish(500, { failures: [{ kind: "failed", response: "evade", failure: "execution_failed", why: "path lost" }] });
  const watched = await f.clock.settle(watchYield(f.context, f.read, f.progress), f.maxMs);
  assert.equal(f.observed().filter((tick) => tick > 540).length, 0);
  const verdict = judgeYield(watched, 1);
  assert.equal(verdict.status, "failed");
  assert.match(verdict.detail, /path lost/);
  await f.assertClean();
});

for (const [name, published] of [
  // The first read is the wound's own: everything published up to it is the old life of the fixture.
  ["a separation published before the wound is no withdrawal after it", [separation()]],
  ["no encounter at all fails although the bot lives", []],
] as const) {
  test(name, async () => {
    const f = fixture();
    using _timers = f.clock.install();
    f.publish(0, { encounters: [...published] });
    const watched = await f.clock.settle(watchYield(f.context, f.read, f.progress), f.maxMs);
    assert.equal(watched.survival, "survived");
    assert.equal(watched.encounters.length, 0);
    assert.equal(f.observed().length, 0, "no declaration without a post-wound separation");
    const verdict = judgeYield(watched, 1);
    assert.equal(verdict.status, "failed");
    assert.match(verdict.detail, /safe separation/);
    await f.assertClean();
  });
}

test("a receipt published after the last periodic read is taken by the terminal read, without a declaration", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  // The periodic reads come each 40 ticks (1,200 is the last one); the watch ends at +1,220.
  f.publish(1_210, { encounters: [separation()] });
  const watched = await f.clock.settle(watchYield(f.context, f.read, f.progress), f.maxMs);
  assert.equal(f.reads.filter((ticks) => ticks < 1_210).length, f.reads.length - 1, "only the last read comes after the receipt");
  assert.deepEqual(watched.encounters.map(({ outcome }) => outcome), ["safe_separation"]);
  assert.equal(f.observed().length, 0, "the terminal read declares nothing");
  assert.equal(judgeYield(watched, 1).status, "succeeded");
  await f.assertClean();
});

for (const rate of [20, 10]) {
  test(`death then respawn at +300 ends the watch, the declaration and the verdict at ${rate} tps`, async () => {
    const f = fixture(rate);
    using _timers = f.clock.install();
    f.publish(100, { encounters: [separation()] });
    const pending = watchYield(f.context, f.read, f.progress);
    await f.clock.advance((300 / rate) * 1_000);
    f.combat.setHealth(0);
    const watched = await f.clock.settle(pending, f.maxMs);
    assert.equal(watched.survival, "died");
    assert.equal(f.observed().filter((tick) => tick > 340).length, 0, "no declaration after the death");
    await f.clock.advance(3_000);
    assert.equal(f.bot.health, 20, "the respawn is full health");
    assert.equal(judgeYield(watched, 1).status, "failed", "a respawned bot is not a survivor");
    await f.assertClean();
  });
}

test("a stopped server ends the watch stalled and fails", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  f.publish(100, { encounters: [separation()] });
  const pending = watchYield(f.context, f.read, f.progress);
  await f.clock.advance(6_000);
  f.server.stop();
  const watched = await f.clock.settle(pending, 60_000);
  assert.equal(watched.survival, "stalled");
  const verdict = judgeYield(watched, 1);
  assert.equal(verdict.status, "failed");
  assert.match(verdict.detail, /stalled/);
  await f.assertClean();
});

test("a server that never told its age ends the watch unobserved and fails", async () => {
  const f = fixture(20, false);
  using _timers = f.clock.install();
  f.server.stop();
  const watched = await f.clock.settle(watchYield(f.context, f.read, f.progress), 60_000);
  assert.equal(watched.survival, "unobserved");
  assert.equal(judgeYield(watched, 1).status, "failed");
  await f.assertClean();
});

test("a cancellation ends the watch cancelled, reads nothing more and leaves no listener", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  f.publish(100, { encounters: [separation()] });
  const pending = watchYield(f.context, f.read, f.progress);
  await f.clock.advance(3_000);
  const readsBefore = f.reads.length;
  f.controller.abort(new Error("trial stopped"));
  const watched = await f.clock.settle(pending, 0);
  assert.equal(watched.survival, "cancelled");
  assert.equal(f.reads.length, readsBefore, "no terminal read for a cancelled trial");
  assert.equal(judgeYield(watched, 1).status, "failed");
  await f.assertClean();
});

test("a receipt read that throws while the window is on ends the watch with its error, the window and every listener", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  f.publish(100, { encounters: [separation()] });
  const read: YieldRead = async () => {
    if (f.server.age - START_AGE >= 300) throw new Error("recent events unreadable");
    return f.read();
  };
  const rejected = assert.rejects(watchYield(f.context, read, f.progress), /recent events unreadable/);
  await f.clock.settle(rejected, f.maxMs);
  await f.assertClean();
});

test("only a declared mob's mob attack on the bot is a native contact", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  const { entities, combat } = f;
  entities.spawn({ name: "skeleton", id: 70, position: { x: 3, y: 64, z: 0 } });
  const contact = watchNativeContact(f.context);
  combat.hurtBot(1, null);
  assert.equal(contact.hits(), 0, "the arranged damage has no source");
  await f.clock.advance(1_000);
  combat.hurtBot(1, 70);
  assert.equal(contact.hits(), 0, "a mob that is not a declared fixture");
  f.bot._client.emit("damage_event", { entityId: 1000, sourceTypeId: 0, sourceCauseId: ZOMBIE + 1, sourceDirectId: ZOMBIE + 1 });
  assert.equal(contact.hits(), 0, "damage to another entity");
  await f.clock.advance(1_000);
  combat.hurtBot(1, ZOMBIE);
  assert.equal(contact.hits(), 1);
  await f.clock.advance(1_000);
  combat.hurtBot(1, ZOMBIE);
  assert.equal(contact.hits(), 2);
  const magic = damageTypeEntries(f.bot).findIndex(({ key }) => key === "minecraft:magic");
  f.bot._client.emit("damage_event", { entityId: f.bot.entity.id, sourceTypeId: magic, sourceCauseId: ZOMBIE + 1, sourceDirectId: ZOMBIE + 1 });
  assert.equal(contact.hits(), 2, "a zombie hit not announced as a mob attack");
  contact.close();
  await f.clock.advance(1_000);
  combat.hurtBot(1, ZOMBIE);
  assert.equal(contact.hits(), 2, "closed");
  await f.assertClean();
});

const watch = (survival: Parameters<typeof judgeYield>[0]["survival"], encounters: Encounter[] = [separation()], extra: Partial<Parameters<typeof judgeYield>[0]> = {}) =>
  ({ survival, encounters, limits: [], failures: [], ...extra });

test("judgeYield: each condition alone decides, the full set passes", () => {
  assert.equal(judgeYield(watch("survived"), 1).status, "succeeded");
  for (const survival of ["died", "cancelled", "stalled", "wall", "unobserved"] as const)
    assert.equal(judgeYield(watch(survival), 1).status, "failed", survival);
  assert.equal(judgeYield(watch("survived"), 0).status, "succeeded", "no native contact is reported, not judged");
  assert.match(judgeYield(watch("survived"), 0).detail, /"contact":0/);
  assert.equal(judgeYield(watch("survived", []), 1).status, "failed", "no encounter");
  assert.equal(judgeYield(watch("survived", [encounter("fight", "target_lost")]), 1).status, "failed");
  assert.equal(judgeYield(watch("survived", [encounter("hide", "hidden")]), 1).status, "failed", "another response is no evade");
  assert.equal(judgeYield(watch("survived", [encounter("evade", "contact_ended")]), 1).status, "failed");
  assert.equal(judgeYield(watch("survived", [separation()], { limits: [{ response: "evade", kind: "limit", limit: "no_progress", elapsedMs: 1, lastProgress: null }] }), 1).status, "failed");
  assert.equal(judgeYield(watch("survived", [separation()], { failures: [{ kind: "failed", response: "evade", failure: "cancelled", why: "x" }] }), 1).status, "failed");
  assert.equal(judgeYield(watch("survived", [separation(), encounter("fight", "target_died")]), 1).status, "succeeded", "a later ordinary response is not a failure");
  for (const outcome of ["failed", "capability_limit"] as const)
    assert.equal(judgeYield(watch("survived", [encounter("evade", outcome)]), 1).status, "failed", `evade -> ${outcome}`);
  assert.equal(judgeYield(watch("survived", [encounter("fight", "bot_died")]), 1).status, "failed", "fight -> bot_died");
  for (const later of ["failed", "capability_limit", "bot_died"] as const)
    assert.equal(judgeYield(watch("survived", [separation(), encounter("fight", later)]), 1).status, "failed", `separation, then ${later}`);
  const { detail } = judgeYield(watch("survived", [separation()]), 3);
  assert.match(detail, /survived/);
  assert.match(detail, /safe_separation/);
  assert.match(detail, /"contact":3/);
});

for (const rate of [20, 10]) {
  test(`run releases the zombies, wounds the bot 40 server ticks later, then judges the watch at ${rate} tps`, async () => {
    const f = fixture(rate);
    using _timers = f.clock.install();
    const chats: { ticks: number; text: string }[] = [];
    f.bot.chat = ((text: string) => { chats.push({ ticks: f.server.age - START_AGE, text }); }) as typeof f.bot.chat;
    const closed: number[] = [];
    const open = spyOn(scenarioRuntime, "openRuntime").mockResolvedValue({ close: async () => { closed.push(1); } } as unknown as scenarioRuntime.Runtime);
    const published: Batch[] = [{ encounters: [separation()] }];
    const firstRead: number[] = [];
    const read = spyOn(reflex, "readReflexOutcomes").mockImplementation(async () => {
      firstRead.push(f.server.age - START_AGE);
      return { encounters: [], limits: [], failures: [], ...published.shift() };
    });
    try {
      const pending = run(f.context);
      await f.clock.advance((10 / rate) * 1_000);
      f.combat.hurtBot(1, ZOMBIE);
      const result = await f.clock.settle(pending, ((WATCH_TICKS + 400) / rate) * 1_000);
      assert.deepEqual(chats.map(({ text }) => text), ["/execute as @e[type=zombie] run data merge entity @s {NoAI:0b}"]);
      assert.equal(chats[0]!.ticks, 0);
      assert.ok(firstRead[0]! >= 2 * PACKET_TICKS, `the wound's boundary read came ${firstRead[0]} ticks after the release, 40 are waited`);
      assert.equal(result.status, "failed", "the first read is the wound's boundary: the only separation was before it");
      assert.match(result.detail!, /safe separation/);
      assert.equal(closed.length, 1);
      await f.assertClean();
    } finally {
      open.mockRestore();
      read.mockRestore();
    }
  });
}

test("run fails with its own words, reads no receipt and closes the runtime when the bot cannot be wounded", async () => {
  const f = fixture(20, true, 20);
  using _timers = f.clock.install();
  f.bot.chat = (() => {}) as typeof f.bot.chat;
  const closed: number[] = [];
  const open = spyOn(scenarioRuntime, "openRuntime").mockResolvedValue({ close: async () => { closed.push(1); } } as unknown as scenarioRuntime.Runtime);
  const targets: number[] = [];
  const wound = spyOn(reflex, "hurt").mockImplementation(async (_context, target) => { targets.push(target); return false; });
  const read = spyOn(reflex, "readReflexOutcomes");
  try {
    const result = await f.clock.settle(run(f.context), f.maxMs);
    assert.deepEqual(targets, [11], "the bot is wounded down to 11");
    assert.equal(result.status, "failed");
    assert.match(result.detail!, /Could not arrange the health loss/);
    assert.equal(read.mock.calls.length, 0, "no watch after a failed wound");
    assert.equal(closed.length, 1);
    await f.assertClean();
  } finally {
    open.mockRestore();
    wound.mockRestore();
    read.mockRestore();
  }
});

test("run succeeds on a native contact, the wound and a post-wound separation", async () => {
  const f = fixture();
  using _timers = f.clock.install();
  f.bot.chat = (() => {}) as typeof f.bot.chat;
  const open = spyOn(scenarioRuntime, "openRuntime").mockResolvedValue({ close: async () => {} } as unknown as scenarioRuntime.Runtime);
  let calls = 0;
  const read = spyOn(reflex, "readReflexOutcomes").mockImplementation(async () => ({ encounters: ++calls === 4 ? [separation()] : [], limits: [], failures: [] }));
  try {
    const pending = run(f.context);
    await f.clock.advance(500);
    f.combat.hurtBot(1, ZOMBIE);
    const result = await f.clock.settle(pending, f.maxMs);
    assert.equal(result.status, "succeeded", result.detail ?? "");
    assert.match(result.detail!, /"contact":1/);
    await f.assertClean();
  } finally {
    open.mockRestore();
    read.mockRestore();
  }
});
