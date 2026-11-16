// The held-shooter handshake waits for the measured server reply and cleans up on every exit.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { holdShooter, waitForNavigationStart } from "./evade-flight.ts";

function fixture(ticksPerSecond: number) {
  const clock = createFakeClock({ mode: "mocked" });
  const harness = createFakeBot({ clock, server: { ticksPerSecond }, entities: { 2: { name: "skeleton", position: new Vec3(0, 64, 3) } } });
  return harness;
}

for (const rate of [20, 10]) {
  test(`navigation starts before summoning at ${rate} tps`, async () => {
    const h = fixture(rate);
    using _timers = h.clock.install();
    const start = h.bot.entity.position.clone();
    const off = h.server.onTick(() => { off(); h.bot.entity.position.x += 0.25; });
    await h.clock.settle(waitForNavigationStart(h.bot, start, () => false), 2_000);
    assert.ok(h.server.gameTime > 0);
    assert.ok(h.bot.entity.position.distanceTo(start) > 0);
  });
}

test("navigation-start barrier fails when the server stops", async () => {
  const h = fixture(20);
  using _timers = h.clock.install();
  const start = h.bot.entity.position.clone();
  h.server.stop();
  const tick = h.server.gameTime;
  await assert.rejects(h.clock.settle(waitForNavigationStart(h.bot, start, () => false), 31_000), /stalled/);
  assert.equal(h.server.gameTime, tick);
});

for (const rate of [20, 10]) {
  test(`held shooter waits for the server at ${rate} tps`, async () => {
    const h = fixture(rate);
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    const before = h.server.gameTime;
    await h.clock.settle(holdShooter(h.bot, "skeleton"), 2_000);
    assert.ok(h.server.gameTime > before);
    assert.equal(added("messagestr"), 0);
    await h.clock.advance(31_000);
    assert.equal(added("messagestr"), 0);
  });
}

test("held shooter fails on a stopped server and removes its listener", async () => {
  const h = fixture(20);
  using _timers = h.clock.install();
  const added = listenersAddedSince(h.bot);
  h.server.stop();
  const age = h.server.gameTime;
  await assert.rejects(h.clock.settle(holdShooter(h.bot, "skeleton"), 31_000), /stalled/);
  assert.equal(h.server.gameTime, age);
  assert.equal(added("messagestr"), 0);
  await h.clock.advance(31_000);
  assert.equal(added("messagestr"), 0);
});

test("held shooter reports a missing reply after the measured tick budget", async () => {
  const h = fixture(10);
  using _timers = h.clock.install();
  const added = listenersAddedSince(h.bot);
  const startAge = h.bot.time.age;
  h.bot.chat = () => {};
  await assert.rejects(h.clock.settle(holdShooter(h.bot, "skeleton"), 4_500), /reply missing/);
  assert.equal(h.bot.time.age - startAge, 40);
  assert.equal(added("messagestr"), 0);
  await h.clock.advance(31_000);
  assert.equal(added("messagestr"), 0);
});

test("a late held reply after expiry leaves no listener and the next read succeeds", async () => {
  const h = fixture(20);
  using _timers = h.clock.install();
  const added = listenersAddedSince(h.bot);
  const chat = h.bot.chat.bind(h.bot);
  const pending: string[] = [];
  h.bot.chat = (command) => { pending.push(command); };
  await assert.rejects(h.clock.settle(holdShooter(h.bot, "skeleton"), 3_000), /reply missing/);
  assert.equal(added("messagestr"), 0);
  h.bot.chat = chat;
  for (const command of pending) chat(command);
  await h.clock.advance(1_000);
  assert.equal(added("messagestr"), 0);
  await h.clock.settle(holdShooter(h.bot, "skeleton"), 2_000);
  assert.equal(added("messagestr"), 0);
});

for (const failureAt of [1, 2, 3]) {
  test(`held shooter removes its listener when command ${failureAt} throws`, async () => {
    const h = fixture(20);
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    let sent = 0;
    h.bot.chat = () => { if (++sent === failureAt) throw new Error("command failed"); };
    await assert.rejects(holdShooter(h.bot, "skeleton"), /command failed/);
    assert.equal(added("messagestr"), 0);
    await h.clock.advance(31_000);
    assert.equal(added("messagestr"), 0);
  });
}

for (const [reply, pattern] of [["1 nope", /malformed reply/], ["1", /malformed reply/], ["1 0 0", /malformed reply/], ["0 0", /movement speed must be zero/], ["1 1", /movement speed must be zero/]] as const) {
  test(`held shooter rejects a ${reply} readback and cleans up`, async () => {
    const h = fixture(20);
    using _timers = h.clock.install();
    const added = listenersAddedSince(h.bot);
    h.bot.chat = (command) => {
      if (!command.startsWith("/tellraw @s ")) return;
      const { text } = JSON.parse(command.slice("/tellraw @s ".length)) as { text: string };
      const off = h.server.onTick(() => {
        off();
        const line = `${text}${reply}`;
        const chat = createRequire(import.meta.url)("prismarine-chat")(h.bot.registry).fromNotch(JSON.stringify({ text: line }));
        h.bot.emit("messagestr", line, "system", chat);
      });
    };
    await assert.rejects(h.clock.settle(holdShooter(h.bot, "skeleton"), 2_000), pattern);
    assert.ok(h.server.gameTime > 0);
    assert.equal(added("messagestr"), 0);
    await h.clock.advance(31_000);
    assert.equal(added("messagestr"), 0);
  });
}
