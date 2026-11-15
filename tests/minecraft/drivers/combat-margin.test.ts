// Combat observation follows server time and still fails promptly on death or a stopped server.
import assert from "node:assert/strict";
import test from "node:test";
import { scenarioDefinitionSchema } from "mine-labs";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import { watch } from "../../../src/test-support/pending.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import { run } from "./combat-margin.ts";

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
