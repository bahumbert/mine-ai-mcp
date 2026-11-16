// Exercise the patched native plugin, including every exit and a later dig on the same bot.
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../test-support/fake-bot/index.js";
import { useNativeDigging } from "../../test-support/fake-bot/native-digging.js";
import { watch } from "../../test-support/pending.js";
import { SERVER_CLOCK_STOPPED_MS } from "../../world/world-age.js";
import { installNativeDigClock } from "./native-dig-clock.js";

const TARGET = new Vec3(1, 64, 0);
const NEXT = new Vec3(-1, 64, 0);

/** The same 300-tick hand dig as the real-server contract, then a short next action. */
function harnessAt(ticksPerSecond = 20) {
  const harness = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }),
    server: { ticksPerSecond }, cells: { "1,64,0": "deepslate", "-1,64,0": "dirt" },
  });
  useNativeDigging(harness);
  installNativeDigClock(harness.bot);
  return harness;
}

for (const ticksPerSecond of [20, 10, 5]) {
  test(`native digging counts server ticks at ${ticksPerSecond} tps and ignores prediction and sequence ack`, async () => {
    const { bot, clock, world, server } = harnessAt(ticksPerSecond);
    using _timers = clock.install();
    const added = listenersAddedSince(bot._client);
    const digging = bot.dig(bot.blockAt(TARGET)!, "ignore");
    const pending = watch(digging);
    world.setCell(TARGET, "air");
    bot._client.emit("acknowledge_player_digging", { sequenceId: 1 });
    await clock.advance(14_000);
    assert.equal(pending.over, false, `at ${clock.now()} ms, age ${bot.time.age}, prediction is not removal`);
    assert.equal(server.packets.filter(packet => packet.name === "block_dig" && (packet.data as { status: number }).status === 2).length, 0);
    await clock.settle(digging, 65_000);
    assert.ok(server.gameTime - 24_000 >= 300);
    for (const event of ["block_change", "multi_block_change", "map_chunk", "end"]) assert.equal(added(event), 0, event);
    const packets = server.packets.length;
    await clock.advance(SERVER_CLOCK_STOPPED_MS + 1);
    assert.equal(server.packets.length, packets, "no finish or swing survives completion");
  });
}

for (const exit of ["cancel", "death", "stopped clock", "stopped after finish", "disconnect", "unconfirmed", "cleanup throws", "stopped clock cleanup throws", "disconnect cleanup throws"] as const) {
  test(`native dig settles once on ${exit} and removes listeners${exit.startsWith("disconnect") ? "" : ", permitting the next action"}`, async () => {
    const { bot, clock, server } = harnessAt(10);
    using _timers = clock.install();
    const added = listenersAddedSince(bot._client);
    let settled = 0;
    const digging = bot.dig(bot.blockAt(TARGET)!, "ignore");
    const outcome = digging.then(() => { settled++; return null; }, error => { settled++; return error; });
    let unsubscribe = () => {};
    if (exit === "unconfirmed" || exit === "stopped after finish") {
      unsubscribe = server.onPacket("block_dig", data => {
        if ((data as { status: number }).status !== 2) return;
        if (exit === "stopped after finish") server.stop();
        else server.receive("block_dig", { status: 1 });
      });
    } else if (exit.includes("cleanup throws")) {
      unsubscribe = server.onPacket("block_dig", data => {
        if ((data as { status: number }).status === 1) throw new Error("cancel transport failed");
      });
      if (exit === "cleanup throws") assert.throws(() => bot.stopDigging(), /cancel transport failed/);
      else if (exit.startsWith("disconnect")) assert.doesNotThrow(() => bot.end("test connection ended"));
      else server.stop();
    } else if (exit === "cancel") bot.stopDigging();
    else if (exit === "death") bot.emit("death");
    else if (exit === "disconnect") bot.end("test connection ended");
    else server.stop();
    const error = await clock.settle(outcome, exit === "stopped after finish" ? 55_000 : 45_000);
    unsubscribe();
    assert.ok(error instanceof Error);
    assert.match(error.message, exit.startsWith("stopped") ? /DIG_SERVER_CLOCK_STOPPED/ : exit.startsWith("disconnect") ? /DIG_DISCONNECTED/ : exit === "unconfirmed" ? /DIG_NOT_CONFIRMED/ : /Digging aborted/);
    for (const event of ["block_change", "multi_block_change", "map_chunk", "end"]) assert.equal(added(event), 0, event);
    const packets = server.packets.length;
    await clock.advance(SERVER_CLOCK_STOPPED_MS + 1);
    assert.equal(settled, 1);
    assert.equal(server.packets.length, packets);
    if (exit.startsWith("disconnect")) return;
    server.resume();
    await clock.settle(bot.dig(bot.blockAt(NEXT)!, "ignore"), 8_000);
    assert.equal(bot.blockAt(NEXT)?.type, 0);
  });
}

test("native digging tolerates a delayed time packet without crediting stopped time", async () => {
  const { bot, clock, server } = harnessAt(10);
  using _timers = clock.install();
  const digging = bot.dig(bot.blockAt(TARGET)!, "ignore");
  const pending = watch(digging);
  await clock.advance(1_900);
  server.stop();
  await clock.advance(10_500);
  assert.equal(pending.over, false);
  assert.equal(bot.time.age, 24_000);
  server.resume();
  await clock.settle(digging, 35_000);
  assert.ok(server.gameTime >= 24_300);
});

test("a native dig follows a rate change during mining", async () => {
  const { bot, clock, server } = harnessAt(20);
  using _timers = clock.install();
  const digging = bot.dig(bot.blockAt(TARGET)!, "ignore");
  const pending = watch(digging);
  await clock.advance(5_000);
  assert.equal(server.gameTime, 24_100);
  server.setTickRate(10);
  await clock.advance(10_000);
  assert.equal(server.gameTime, 24_200);
  assert.equal(pending.over, false, "15 s of wall time is only 200 server ticks across the rate change");
  await clock.settle(digging, 15_000);
  assert.ok(server.gameTime >= 24_300);
});
