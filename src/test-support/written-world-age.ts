/**
 * A world age that tests can write, for the domain builders whose importers move it themselves (`startServerClock`,
 * `bot.time.age += 20`): the shared fake's `time` is rebuilt from its server at each read, so such a write would be
 * lost and every "40 ticks or the wall bound" wait would end on the wall. Kept for unmigrated importers (crafting:
 * craft-item, craft-item-resume, crafting-station, temporary-workstation; the furnace's own `startServerClock`); a
 * test on the harness moves `clock` instead, and then `server.age` and `bot.time.age` agree (plan T4, batches M1-M8).
 */
import type { FakeHarness } from "./fake-bot/index.js";

/** Give the harness bot a `time` whose fields are the harness's own, its `age` the server's plus what a test wrote. */
export function letTestsWriteWorldAge(harness: FakeHarness): void {
  const { bot, server } = harness;
  const serverTime = Object.getOwnPropertyDescriptor(bot, "time")?.get;
  if (serverTime === undefined) throw new Error("the harness bot has no time getter");
  const own = () => serverTime.call(bot) as Record<string, unknown>;
  let written = 0;
  const time = {};
  for (const key of Object.keys(own()).filter((field) => field !== "age")) {
    Object.defineProperty(time, key, { get: () => own()[key], enumerable: true });
  }
  Object.defineProperty(time, "age", {
    get: () => server.age + written,
    set: (value: number) => {
      written = value - server.age;
    },
    enumerable: true,
  });
  Object.defineProperty(bot, "time", { value: time, configurable: true, writable: true });
}
