import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import type { FakeServerOptions } from "../../../src/test-support/fake-bot/fake-server.ts";
import { ZERO_ARENA, arenaFrame } from "../arena/frame.ts";
import { fakeContractSubject, serverContractSubject } from "./subject.ts";

const chatMessagesOf = createRequire(import.meta.url)("prismarine-chat") as (registry: unknown) => { fromNotch(notch: unknown): { toString(): string } };

function subjectOn(server: FakeServerOptions = {}) {
  const harness = createFakeBot({ clock: createFakeClock({ mode: "mocked" }), server });
  const subject = fakeContractSubject(harness, arenaFrame(ZERO_ARENA));
  return { harness, subject };
}

test("serverTicks resolves true once the age moved by the ticks asked since the call", async () => {
  const { harness, subject } = subjectOn({ startAge: 1_000 });
  using _installed = harness.clock.install();
  const age = harness.bot.time.age;
  assert.equal(await subject.serverTicks(40, 5_000), true);
  assert.ok(harness.bot.time.age - age >= 40, `age moved ${harness.bot.time.age - age}`);
});

test("serverTicks counts from the call, not from the server's start", async () => {
  const { harness, subject } = subjectOn({ startAge: 1_000 });
  using _installed = harness.clock.install();
  await subject.wait(2_500);
  const calledAt = subject.now();
  const age = harness.bot.time.age;
  assert.equal(await subject.serverTicks(40, 5_000), true);
  assert.ok(harness.bot.time.age - age >= 40, "the packets before the call do not count");
  assert.ok(subject.now() - calledAt >= 1_000, "40 ticks at 20 a packet need at least two packets after the call");
});

test("serverTicks gives up at the wall bound on a frozen server, whatever the ticks asked", async () => {
  const { harness, subject } = subjectOn();
  using _installed = harness.clock.install();
  await subject.wait(1_500);
  harness.server.stop();
  const calledAt = subject.now();
  assert.equal(await subject.serverTicks(20, 2_000), false);
  const waited = subject.now() - calledAt;
  assert.ok(waited >= 2_000 && waited < 2_100, `waited ${waited} ms for a 2000 ms bound`);
});

test("serverTicks on a server behind its schedule is bound by the wall: 5 ticks a second never reach 40 in 3 s", async () => {
  const { harness, subject } = subjectOn({ ticksPerSecond: 5 });
  using _installed = harness.clock.install();
  assert.equal(await subject.serverTicks(40, 3_000), false);
  assert.equal(await subject.serverTicks(40, 10_000), true);
});

test("serverTicks before the first time packet counts from the first age the client holds", async () => {
  const { harness, subject } = subjectOn({ timePacketYet: false });
  using _installed = harness.clock.install();
  assert.equal(harness.bot.time.age, null);
  assert.equal(await subject.serverTicks(40, 5_000), true);
});

test("serverTicks of zero ticks resolves true at once", async () => {
  const { harness, subject } = subjectOn();
  using _installed = harness.clock.install();
  const calledAt = subject.now();
  assert.equal(await subject.serverTicks(0, 1_000), true);
  assert.equal(subject.now(), calledAt);
});

test("serverGameTime on the fake leaves the clock to the caller: two calls 50 ms of the caller's wait apart read 1 tick apart", async () => {
  const { harness, subject } = subjectOn({ startAge: 1_000 });
  using _installed = harness.clock.install();
  const calledAt = subject.now();
  const before = subject.serverGameTime();
  assert.equal(subject.now(), calledAt, "the call itself moves no time");
  await subject.wait(50);
  const after = subject.serverGameTime();
  await subject.wait(50);
  assert.equal((await after) - (await before), 1);
  assert.ok((await after) > harness.bot.time.age!, `the client's age ${harness.bot.time.age} is the older reading`);
});

/** A chat line as the 1.21.4 server sends a `tellraw` text with a resolved `nbt` part (an NBT compound with an `extra` list), heard as `chat.js:141` files it. */
function hear(harness: ReturnType<typeof createFakeBot>, text: string, extra: string): void {
  const part = { text: { type: "string", value: extra } };
  const notch = { type: "compound", name: "", value: { text: { type: "string", value: text }, extra: { type: "list", value: { type: "compound", value: [part] } } } };
  const message = chatMessagesOf(harness.bot.registry).fromNotch(notch);
  harness.bot.emit("messagestr", message.toString(), "system", message as never);
}

/**
 * A real-server subject whose `chat` records what it sends. `answers` are the counts the server tells back: the n-th `tellraw` is
 * answered 80 ms later with the line "<prefix><n-th count>" (a server with `sendCommandFeedback false` answers a `tellraw` and nothing else).
 */
function chatAnswering(answers: { prefix: string; counts: readonly number[] }) {
  const sent: string[] = [];
  let tellraws = 0;
  const harness = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }),
    overrides: {
      chat(message: string) {
        sent.push(message);
        if (!message.startsWith("/tellraw")) return;
        const count = answers.counts[tellraws++]!;
        setTimeout(() => hear(harness, answers.prefix, String(count)), 80);
      },
    },
  });
  return { harness, sent, subject: serverContractSubject(harness.bot, arenaFrame(ZERO_ARENA)) };
}

const ANSWER = { prefix: "contract-gametime ", counts: [24_012, 24_013] };

test("serverGameTime on a real server stores `time query gametime` under the bot's own key, tells it back with tellraw and reads the count", async () => {
  const { harness, sent, subject } = chatAnswering(ANSWER);
  using _installed = harness.clock.install();
  const listening = harness.bot.listenerCount("messagestr");
  const answered = subject.serverGameTime();
  const key = `gametime_${harness.bot.username}`;
  assert.deepEqual(sent, [
    `/execute store result storage mine_ai:contract ${key} int 1 run time query gametime`,
    `/tellraw @s {"text":"contract-gametime ","extra":[{"nbt":"${key}","storage":"mine_ai:contract"}]}`,
  ], "both commands are sent before the call returns");
  await harness.clock.advance(200);
  await answered;
  assert.equal(harness.bot.listenerCount("messagestr"), listening, "the listener is gone with the last answer");
});

test("serverGameTime on a real server gives each of two questions in flight the answer to its own, in the order asked", async () => {
  const { harness, subject } = chatAnswering(ANSWER);
  using _installed = harness.clock.install();
  const listening = harness.bot.listenerCount("messagestr");
  const first = subject.serverGameTime();
  await harness.clock.advance(50);
  const second = subject.serverGameTime();
  await harness.clock.advance(200);
  assert.deepEqual([await first, await second], [24_012, 24_013]);
  assert.equal(harness.bot.listenerCount("messagestr"), listening, "the listener is gone with the last answer");
});

test("serverGameTime on a real server ignores other chat lines and rejects at the wall bound when the answer never comes", async () => {
  const { harness, subject } = chatAnswering({ prefix: "Set the time to ", counts: [6_000] });
  using _installed = harness.clock.install();
  const listening = harness.bot.listenerCount("messagestr");
  const answered = assert.rejects(subject.serverGameTime(), /gametime: no answer after 3000 ms/);
  await harness.clock.advance(3_100);
  await answered;
  assert.equal(harness.bot.listenerCount("messagestr"), listening);
});
