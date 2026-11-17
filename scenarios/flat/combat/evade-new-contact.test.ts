// The native-contact observation lasts 400 server ticks and releases every exit's resources.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { observeNewContact } from "./evade-new-contact.ts";

for (const ticksPerSecond of [20, 10]) {
  for (const exit of ["complete", "death", "abort", "stopped"] as const) {
    test(`new contact ${exit} observes server time and cleans up (${ticksPerSecond} tps)`, async () => {
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const { bot, server } = createFakeBot({ clock, server: { ticksPerSecond } });
      const controller = new AbortController();
      const added = listenersAddedSince(bot);
      const origin = bot.time.age!;
      if (exit === "stopped") server.stop();
      const window = observeNewContact(bot, controller.signal);
      let settlements = 0;
      window.then(() => settlements++, () => settlements++);
      const rejected = exit === "abort" ? assert.rejects(window, /cancel contact/)
        : exit === "stopped" ? assert.rejects(window, /world age stood still for 30 s/) : null;
      if (exit === "death" || exit === "abort") {
        await clock.advance(1_000);
        if (exit === "death") bot.emit("death");
        else controller.abort(new Error("cancel contact"));
      }
      if (rejected) await clock.settle(rejected, 60_000);
      else {
        const observed = await clock.settle(window, 60_000);
        assert.equal(observed.died, exit === "death");
        if (exit === "complete") {
          assert.ok(observed.observedTicks >= 400 && observed.observedTicks <= 440,
            `400 server ticks required, observed ${observed.observedTicks}`);
          assert.equal(bot.time.age! - origin, observed.observedTicks);
          assert.ok(clock.now() >= 400_000 / ticksPerSecond);
        }
      }
      await clock.advance(60_000);
      assert.equal(settlements, 1);
      for (const event of ["physicsTick", "time", "death"]) assert.equal(added(event), 0, event);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      assert.equal(clock.pendingTimers(), 0);
    });
  }
}
