// Pool cleanup and air confirmations allow slow server ticks, with a bound when its clock stops.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { scenarioDefinitionSchema } from "mine-labs";
import { createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import { watch } from "../../../src/test-support/pending.ts";
import { recordLifeSavingPlacement, removeLifeSavingPlacements } from "../../../src/world/life-saving-placements.ts";
import { setProtectedRegionsProvider } from "../../../src/world/protected-regions.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import { serverRemoved, waitForPoolCleanup } from "./lava-pool-region.ts";

for (const answer of ["late", "missing", "stopped"] as const) {
  test(`air confirmation ${answer} follows server age and removes its listener`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { bot, server } = createFakeBot({ clock, server: { ticksPerSecond: 5 } });
    bot.chat = () => {};
    const context = scenarioTestContext({
      bot, scenario: scenarioDefinitionSchema.parse({ goal: { kind: "completion" } }),
      call: async () => assert.fail("air confirmation runs no action"),
    });
    await clock.advance(3_800);
    const startTick = server.gameTime;
    // tellraw emits messagestr: chat.js:131-143; the real pool scenario proves the conditional air answer.
    const ChatMessage = (require("prismarine-chat") as typeof import("prismarine-chat").default)(bot.version);
    if (answer === "late") clock.after(7_500, () => bot.emit("messagestr", "pool-air-0", "system", new ChatMessage("pool-air-0")));
    if (answer === "stopped") server.stop();
    const before = bot.listenerCount("messagestr");
    const pending = serverRemoved(context, [new Vec3(1, 64, 0)], clock.sleep);
    const state = watch(pending);
    await clock.advance(2_500);
    assert.equal(state.over, false, "two wall seconds cannot decide a slow-server answer");
    const result = await clock.settle(pending, 30_000);
    assert.equal(result, answer === "late");
    if (answer === "missing") assert.ok(server.gameTime - startTick >= 40, "a stale entry packet cannot shorten the answer window");
    if (answer === "stopped") assert.equal(clock.now(), 33_800);
    assert.equal(bot.listenerCount("messagestr"), before);
  });
}

for (const outcome of ["removed", "pending", "stopped"] as const) {
  test(`pool placement ${outcome} waits up to 600 server ticks`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const { bot, server, world } = createFakeBot({ clock, server: { ticksPerSecond: 5 }, cells: { "1,64,0": "cobblestone" } });
    const cell = new Vec3(1, 64, 0);
    setProtectedRegionsProvider(bot, () => [{
      regionId: 1, owner: "Builder", label: "pool", dimension: "overworld", min: cell, max: cell,
    }]);
    recordLifeSavingPlacement(bot, cell, "block");
    await clock.advance(3_800);
    const startTick = server.gameTime;
    if (outcome === "stopped") server.stop();
    const pending = waitForPoolCleanup(bot, clock.sleep);
    const state = watch(pending);
    await clock.advance(30_000, 1_000);
    if (outcome === "stopped") {
      await pending;
      return;
    }
    assert.equal(state.over, false, "a moving slow server keeps its cleanup window past 30 wall seconds");
    await clock.advance(87_500, 1_000);
    assert.equal(state.over, false, "a stale entry packet cannot shorten the cleanup window");
    const changedAt = clock.now();
    if (outcome === "removed") {
      world.setCell(cell, "air");
      await removeLifeSavingPlacements(bot, new AbortController().signal);
    }
    await clock.settle(pending, 10_000);
    if (outcome === "removed") assert.ok(clock.now() - changedAt <= 50, "clearing the ledger ends the wait promptly");
    else assert.ok(server.gameTime - startTick >= 600, "the pending ledger gets at least 600 actual server ticks");
  });
}
