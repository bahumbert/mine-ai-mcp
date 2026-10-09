import assert from "node:assert/strict";
import test from "node:test";
import { Inbox } from "./inbox.ts";
import type { PlayerMessage } from "./runtime-client.ts";

const line = (username: string, message: string, extra: Partial<PlayerMessage> = {}): PlayerMessage => ({ username, channel: "chat", message, addressed: false, ...extra });

/** An inbox over a clock the test moves. */
function inboxAt(burstMs = 1_500) {
  const clock = { now: 1_000 };
  return { clock, inbox: new Inbox(burstMs, () => clock.now) };
}

test("lines from one speaker within the burst window are read together as one message", () => {
  const { clock, inbox } = inboxAt();
  inbox.push(line("Tom", "Ayla"));
  clock.now += 600;
  inbox.push(line("Tom", "build me a house", { addressed: true }));
  clock.now += 600;
  inbox.push(line("Tom", "a small one"));
  // The window runs from the last line: nothing is ready while Tom is still typing.
  assert.equal(inbox.next(), null);
  clock.now += 1_500;
  const heard = inbox.next();
  assert.deepEqual(heard?.message, { username: "Tom", channel: "chat", message: "Ayla build me a house a small one", addressed: true });
  assert.equal(heard?.lines, 3);
  assert.equal(inbox.next(), null);
});

test("a line after the window is a message of its own, and two speakers never mix", () => {
  const { clock, inbox } = inboxAt();
  inbox.push(line("Tom", "first"));
  inbox.push(line("Bob", "hello"));
  clock.now += 2_000;
  inbox.push(line("Tom", "second"));
  clock.now += 2_000;
  assert.deepEqual([inbox.next()?.message.message, inbox.next()?.message.message, inbox.next()?.message.message, inbox.next()], ["first", "hello", "second", null]);
});

test("one whisper makes the joined message a whisper; a window of 0 reads every line alone", () => {
  const { clock, inbox } = inboxAt();
  inbox.push(line("Tom", "psst"));
  inbox.push(line("Tom", "come here", { channel: "whisper" }));
  clock.now += 1_500;
  assert.equal(inbox.next()?.message.channel, "whisper");

  const alone = inboxAt(0);
  alone.inbox.push(line("Tom", "one"));
  alone.inbox.push(line("Tom", "two"));
  assert.deepEqual([alone.inbox.next()?.message.message, alone.inbox.next()?.message.message], ["one", "two"]);
});

test("a message is superseded when its speaker spoke after it was taken, nobody else", () => {
  const { clock, inbox } = inboxAt();
  inbox.push(line("Tom", "build a house"));
  clock.now += 1_500;
  const heard = inbox.next();
  assert.ok(heard !== null);
  assert.equal(inbox.superseded("Tom", heard.seq), false);
  inbox.push(line("Bob", "hi"));
  assert.equal(inbox.superseded("Tom", heard.seq), false);
  inbox.push(line("tom", "no wait"));
  assert.equal(inbox.superseded("Tom", heard.seq), true);
  // The newer line is read next, on its own.
  clock.now += 1_500;
  assert.deepEqual([inbox.next()?.message.message, inbox.next()?.message.message], ["hi", "no wait"]);
});

test("it says how long until the next message is ready", () => {
  const { clock, inbox } = inboxAt();
  assert.equal(inbox.readyIn(), null);
  inbox.push(line("Tom", "hi"));
  clock.now += 400;
  assert.equal(inbox.readyIn(), 1_100);
  clock.now += 2_000;
  assert.equal(inbox.readyIn(), 0);
});
