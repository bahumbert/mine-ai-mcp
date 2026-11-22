// Combat observation follows server time and still fails promptly on death or a stopped server.
import assert from "node:assert/strict";
import test from "node:test";
import { scenarioDefinitionSchema } from "mine-labs";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { watch } from "../../../src/test-support/pending.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import { run } from "./combat-margin.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "./server-ticks.ts";

type CommandStage = "summon" | "bag";
type CommandAnswer = "late" | "missing" | "stopped";

/** Commands have no fake interpreter: this stopgap scripts their answers, not general summon/item semantics (T2e). */
function commandRun(rate: number, stage: CommandStage, answer: CommandAnswer) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, server: { ticksPerSecond: rate },
    carried: stage === "bag" ? { stone_sword: 1 } : {} });
  const { bot, server, inventory, entities } = harness;
  let sentAge = -1;
  let sentTick = -1;
  let sentMs = -1;
  let answeredTick = -1;
  let answeredMs = -1;
  let summons = 0;
  let receipts = 0;
  const stopAnswer = server.onTick(() => {
    if (answer !== "late" || sentTick < 0 || answeredTick >= 0 || server.gameTime - sentTick < 30) return;
    answeredTick = server.gameTime;
    answeredMs = clock.now();
    if (stage === "summon") entities.spawn({ id: 7, name: "zombie", position: new Vec3(3, 64, 0) });
    else {
      inventory.updateSlot(9, inventory.slots[36]!);
      inventory.updateSlot(36, null as never);
    }
  });
  bot.chat = (command) => {
    if (command.includes("run summon")) {
      summons += 1;
      if (stage === "bag") throw new Error("bag complete: summoning");
    }
    if (!(stage === "summon" ? command.includes("run summon") : command.includes("weapon.mainhand with"))) return;
    [sentAge, sentTick, sentMs] = [bot.time.age, server.gameTime, clock.now()];
    if (answer === "stopped") server.stop();
  };
  const context = scenarioTestContext({ bot,
    scenario: scenarioDefinitionSchema.parse({ params: { mob: "zombie", response: "fight", observeSeconds: 1,
      ...(stage === "bag" ? { bagItem: "stone_sword" } : {}) }, goal: { kind: "completion" } }),
    call: async () => { receipts += 1; throw new Error("observation complete: reading receipts"); },
  });
  return { clock, bot, server, stopAnswer, pending: () => run(context, clock.sleep),
    readings: () => ({ sentAge, sentTick, sentMs, answeredTick, answeredMs, summons, receipts }) };
}

/** The command stages install the same death listeners as observation; every exit releases all of them. */
function commandListeners(bot: ReturnType<typeof createFakeBot>["bot"]) {
  const added = listenersAddedSince(bot);
  const clientAdded = listenersAddedSince(bot._client);
  return () => {
    for (const event of ["death", "spawn", "entityDead"]) assert.equal(added(event), 0, event);
    assert.equal(clientAdded("death_combat_event"), 0);
  };
}

for (const stage of ["summon", "bag"] as const) {
  for (const rate of [20, 10, 5]) {
    test(`${stage} answered after 30 server ticks at ${rate} tps${rate === 5 ? " (stress, S2)" : ""} proceeds`, async () => {
      const fixture = commandRun(rate, stage, "late");
      const { clock, bot } = fixture;
      using _timers = clock.install();
      const assertListeners = commandListeners(bot);
      const pending = fixture.pending();
      const observation = watch(pending);
      const rejected = assert.rejects(pending, stage === "bag" ? /bag complete: summoning/ : /observation complete: reading receipts/);
      await clock.advance(20 * 1_000 / rate);
      assert.equal(observation.over, false, "the unanswered command cannot proceed");
      await clock.settle(rejected, 100 * 1_000 / rate);
      const seen = fixture.readings();
      assert.equal(seen.answeredTick - seen.sentTick, 30);
      assert.equal(seen.answeredMs - seen.sentMs, 30 * 1_000 / rate);
      assert.equal(seen.summons, 1);
      assert.equal(seen.receipts, stage === "bag" ? 0 : 1);
      assertListeners();
      fixture.stopAnswer();
      await clock.advance(DRIVER_CLOCK_STOPPED_MS + 1_000);
      assert.deepEqual(fixture.readings(), seen, "no command or receipt after settlement");
      assert.equal(clock.pendingTimers(), 0);
      assertListeners();
    });
  }

  for (const rate of [20, 10]) {
    for (const answer of ["missing", "stopped"] as const) {
      test(`${stage} ${answer} at ${rate} tps fails before receipts and releases listeners`, async () => {
        const fixture = commandRun(rate, stage, answer);
        const { clock, bot } = fixture;
        using _timers = clock.install();
        const assertListeners = commandListeners(bot);
        const pending = fixture.pending();
        const observation = watch(pending);
        const rejected = assert.rejects(pending, answer === "stopped" ? /stood still/
          : stage === "summon" ? /never seen/ : /hand was not emptied/);
        await clock.settle(rejected, DRIVER_CLOCK_STOPPED_MS + 1_000);
        const seen = fixture.readings();
        assert.equal(observation.over, true);
        assert.equal(seen.receipts, 0);
        assert.equal(seen.summons, stage === "bag" ? 0 : 1);
        if (answer === "missing") assert.ok(bot.time.age - seen.sentAge >= 40);
        else {
          assert.equal(bot.time.age, seen.sentAge);
          assert.equal(clock.now() - seen.sentMs, DRIVER_CLOCK_STOPPED_MS);
        }
        assertListeners();
        fixture.stopAnswer();
        await clock.advance(DRIVER_CLOCK_STOPPED_MS + 1_000);
        assert.deepEqual(fixture.readings(), seen, "a settled command does nothing at its old deadline");
        assert.equal(clock.pendingTimers(), 0);
        assertListeners();
      });
    }
  }
}

// Time packets: contract/checks/world-age-at-slow-tick.ts. A visible entity is arranged directly;
// chat is inert because this test exercises observation, not the server's summon command.
for (const rate of [20, 10, 5]) {
  test(`combat observes twenty game seconds at ${rate} tps before reading receipts`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    const { bot } = createFakeBot({ clock, server: { ticksPerSecond: rate }, overrides: { chat: () => {} },
      entities: { 7: { name: "zombie", position: new Vec3(3, 64, 0) } } });
    const context = scenarioTestContext({ bot,
      scenario: scenarioDefinitionSchema.parse({ params: { mob: "zombie", response: "fight", observeSeconds: 20 },
        goal: { kind: "completion" } }),
      call: async () => { throw new Error("observation complete: reading receipts"); },
    });
    const startAge = bot.time.age;
    const pending = run(context, clock.sleep);
    const observation = watch(pending);
    const rejected = assert.rejects(pending, /observation complete: reading receipts/);
    await clock.advance(20_000);
    if (rate < 20) assert.equal(observation.over, false, "wall seconds cannot finish the game observation");
    await clock.settle(rejected, 70_000);
    assert.ok(bot.time.age - startAge >= 420, "a packet of margin keeps a stale age from ending observation early");
  });
}

for (const end of ["death", "stopped clock"] as const) {
  test(`combat observation rejects on ${end} and releases its listeners`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _installed = clock.install();
    const { bot, combat, server } = createFakeBot({ clock, overrides: { chat: () => {} },
      entities: { 7: { name: "zombie", position: new Vec3(3, 64, 0) } } });
    const before = [bot.listenerCount("death"), bot.listenerCount("spawn"), bot.listenerCount("entityDead"),
      bot._client.listenerCount("death_combat_event")];
    server.stop();
    const context = scenarioTestContext({ bot,
      scenario: scenarioDefinitionSchema.parse({ params: { mob: "zombie", response: "fight", observeSeconds: 20 },
        goal: { kind: "completion" } }),
      call: async () => { throw new Error("receipts must not be read"); },
    });
    const pending = run(context, clock.sleep);
    const rejected = assert.rejects(pending, end === "death" ? /actor died/ : /server's clock stood still/);
    if (end === "death") clock.after(500, () => combat.hurtBot(25, null));
    await clock.settle(rejected, end === "death" ? 1_000 : 30_100);
    assert.deepEqual([bot.listenerCount("death"), bot.listenerCount("spawn"), bot.listenerCount("entityDead"),
      bot._client.listenerCount("death_combat_event")], before);
  });
}
