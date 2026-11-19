import assert from "node:assert/strict";
import test from "node:test";
import { Inbox, type BurstLimits } from "./inbox.ts";
import { steppedClocks } from "./testing.ts";
import type { PlayerMessage } from "./runtime-client.ts";

const line = (username: string, message: string, extra: Partial<PlayerMessage> = {}): PlayerMessage => ({ username, channel: "chat", message, addressed: false, ...extra });

const DEFAULT_LIMITS: BurstLimits = { maxLines: 8, maxChars: 1_000, maxMs: 8_000 };

/** An inbox over a clock the test moves. */
function inboxAt(burstMs = 1_500, limits: Partial<BurstLimits> = {}) {
  const clock = { now: 1_000 };
  return { clock, inbox: new Inbox(burstMs, { ...DEFAULT_LIMITS, ...limits }, () => clock.now) };
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

test("a line after the window is a message of its own once the first was read, and two speakers never mix; a waiting speaker's next line joins it", () => {
  const { clock, inbox } = inboxAt();
  inbox.push(line("Tom", "first"));
  inbox.push(line("Bob", "hello"));
  clock.now += 2_000;
  assert.equal(inbox.next()?.message.message, "first");
  inbox.push(line("Tom", "second"));
  clock.now += 2_000;
  assert.deepEqual([inbox.next()?.message.message, inbox.next()?.message.message, inbox.next()], ["hello", "second", null]);

  const waiting = inboxAt();
  waiting.inbox.push(line("Tom", "first"));
  waiting.inbox.push(line("Bob", "hello"));
  waiting.clock.now += 2_000;
  waiting.inbox.push(line("Tom", "second"));
  waiting.clock.now += 2_000;
  const joined = waiting.inbox.next();
  assert.deepEqual([joined?.message.message, joined?.lines, waiting.inbox.next()?.message.message, waiting.inbox.next()], ["first second", 2, "hello", null]);
});

test("one whisper makes the joined message a whisper; a window of 0 reads every line alone", () => {
  const { clock, inbox } = inboxAt();
  inbox.push(line("Tom", "psst"));
  inbox.push(line("Tom", "come here", { channel: "whisper" }));
  clock.now += 1_500;
  assert.equal(inbox.next()?.message.channel, "whisper");

  const alone = inboxAt(0);
  alone.inbox.push(line("Tom", "one"));
  assert.equal(alone.inbox.next()?.message.message, "one");
  alone.inbox.push(line("Tom", "two"));
  assert.equal(alone.inbox.next()?.message.message, "two");
});

test("a burst is ready when full, without waiting for the pause", () => {
  const { clock, inbox } = inboxAt(1_500, { maxLines: 3 });
  inbox.push(line("Tom", "a"));
  clock.now += 100;
  inbox.push(line("Tom", "b"));
  assert.equal(inbox.next(), null);
  clock.now += 100;
  inbox.push(line("Tom", "c"));
  const heard = inbox.next();
  assert.equal(heard?.lines, 3);
  assert.equal(heard?.dropped, 0);
  assert.equal(heard?.message.message, "a b c");
});

test("a full waiting burst keeps its newest lines and counts the others", () => {
  const { clock, inbox } = inboxAt(1_500, { maxLines: 3 });
  for (const text of ["a", "b", "c", "d", "e"]) {
    inbox.push(line("Tom", text));
    clock.now += 100;
  }
  clock.now += 2_000;
  const heard = inbox.next();
  assert.equal(heard?.message.message, "c d e");
  assert.equal(heard?.lines, 3);
  assert.equal(heard?.dropped, 2);
  assert.equal(heard?.lastLine, "e");
});

test("the character cap keeps the newest lines; a newest line alone over it is cut to its first characters", () => {
  const { clock, inbox } = inboxAt(1_500, { maxChars: 10 });
  for (const text of ["aaaa", "bbbb", "cccc"]) inbox.push(line("Tom", text));
  clock.now += 2_000;
  const heard = inbox.next();
  assert.equal(heard?.message.message, "bbbb cccc");
  assert.equal(heard?.dropped, 1);

  const long = inboxAt(1_500, { maxChars: 10 });
  long.inbox.push(line("Tom", "x".repeat(25)));
  long.clock.now += 2_000;
  const cut = long.inbox.next();
  assert.equal(cut?.message.message, "x".repeat(10));
  assert.equal(cut?.dropped, 0);
  assert.equal(cut?.lastLine, "x".repeat(25), "the raw line, so every bot claims the same everyone line");
});

test("a burst is ready burstMaxSeconds after its first line however fast lines come", () => {
  const { clock, inbox } = inboxAt(1_500, { maxLines: 100, maxMs: 8_000 });
  for (let at = 0; at < 8; at += 1) {
    inbox.push(line("Tom", `l${at}`));
    assert.equal(inbox.next(), null, `line ${at}: still inside the age cap`);
    clock.now += 1_000;
  }
  inbox.push(line("Tom", "l8"));
  assert.equal(inbox.next()?.lines, 9);
});

test("speakers are served in the order of their first waiting line", () => {
  const { clock, inbox } = inboxAt();
  for (const text of ["1", "2", "3", "4", "5"]) inbox.push(line("Tom", text));
  inbox.push(line("Ann", "hi"));
  inbox.push(line("Tom", "6"));
  clock.now += 2_000;
  const first = inbox.next();
  assert.equal(first?.message.username, "Tom");
  assert.equal(first?.lines, 6);
  assert.equal(inbox.next()?.message.username, "Ann");
});

test("a speaker without a token is skipped, the token is asked once per ready burst, and heldMs counts the skip", () => {
  const { clock, inbox } = inboxAt();
  inbox.push(line("Tom", "hello"));
  inbox.push(line("Ann", "hi"));
  clock.now += 2_000;
  const asked: string[] = [];
  const first = inbox.next((speaker) => {
    asked.push(speaker);
    return speaker !== "tom";
  });
  assert.equal(first?.message.username, "Ann");
  assert.deepEqual(asked, ["tom", "ann"]);
  assert.equal(inbox.readyIn((speaker) => (speaker === "tom" ? 4_000 : 0)), 4_000);
  clock.now += 4_000;
  const second = inbox.next(() => true);
  assert.equal(second?.message.username, "Tom");
  assert.equal(second?.heldMs, 4_000);
});

test("a held burst stays within its caps over 500 lines", () => {
  const { clock, inbox } = inboxAt();
  for (let at = 0; at < 500; at += 1) {
    inbox.push(line("Tom", `${at}`.padEnd(20, "x")));
    clock.now += 10;
    assert.equal(inbox.next(() => false), null);
  }
  const heard = inbox.next(() => true);
  assert.ok(heard !== null);
  assert.ok(heard.lines <= 8);
  assert.ok(heard.message.message.length <= 1_000);
  assert.equal(heard.dropped, 500 - heard.lines);
});

test("channel and addressed come from the kept lines only", () => {
  const { clock, inbox } = inboxAt(1_500, { maxLines: 2 });
  inbox.push(line("Tom", "stop", { channel: "whisper", addressed: true }));
  inbox.push(line("Tom", "b"));
  inbox.push(line("Tom", "c"));
  clock.now += 2_000;
  const heard = inbox.next();
  assert.equal(heard?.message.channel, "chat");
  assert.equal(heard?.message.addressed, false);

  const kept = inboxAt(1_500, { maxLines: 2 });
  kept.inbox.push(line("Tom", "a"));
  kept.inbox.push(line("Tom", "psst", { channel: "whisper" }));
  assert.equal(kept.inbox.next()?.message.channel, "whisper");
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

test("spokeSince sees any of the speakers after seq", () => {
  const { clock, inbox } = inboxAt();
  inbox.push(line("Tom", "Ayla"));
  clock.now += 2_000;
  const heard = inbox.next()!;
  assert.equal(inbox.spokeSince(["theo", "bruno"], heard.seq), false);
  inbox.push(line("Theo", "hello"));
  assert.equal(inbox.spokeSince(["THEO", "Bruno"], heard.seq), true);
  assert.equal(inbox.spokeSince(["Bruno"], heard.seq), false);
  assert.equal(inbox.spokeSince([], heard.seq), false);
});

test("hasFrom sees a line that waits, whatever the case, until it is taken", () => {
  const { clock, inbox } = inboxAt();
  assert.equal(inbox.hasFrom("Theo"), false);
  inbox.push(line("Theo", "hello"));
  assert.equal(inbox.hasFrom("THEO"), true);
  assert.equal(inbox.hasFrom("Bruno"), false);
  clock.now += 2_000;
  inbox.next();
  assert.equal(inbox.hasFrom("Theo"), false);
  const release = inbox.hold("Theo");
  const again = inbox.hold("theo");
  release();
  assert.equal(inbox.hasFrom("Theo"), true, "a line is still being decided");
  again();
  assert.equal(inbox.hasFrom("Theo"), false);
});

test("a heard burst carries the read time of its newest line", () => {
  const { clock, inbox } = inboxAt();
  inbox.push(line("Tom", "Ayla"));
  clock.now += 1_000;
  inbox.push(line("Tom", "hello"));
  const lastRead = clock.now;
  clock.now += 5_000;
  assert.equal(inbox.next()?.readAt, lastRead);
});

test("the burst window runs on the monotonic clock: a wall clock step between two lines does not split them", (t) => {
  const clocks = steppedClocks(t);
  const inbox = new Inbox(1_500, DEFAULT_LIMITS);
  inbox.push(line("Tom", "Ayla"));
  clocks.wall(60_000);
  inbox.push(line("Tom", "build me a house", { addressed: true }));
  clocks.monotonic(2_000);
  assert.equal(inbox.next()?.lines, 2);
});

test("dropWaitingFrom removes only that speaker's untaken lines and counts them", () => {
  const { clock, inbox } = inboxAt();
  inbox.push(line("Tom", "one"));
  inbox.push(line("Tom", "two"));
  inbox.push(line("Bob", "hello"));
  assert.equal(inbox.dropWaitingFrom("TOM"), 2, "the speaker's name is matched without case");
  assert.equal(inbox.dropWaitingFrom("Tom"), 0, "nothing is left to drop");
  assert.equal(inbox.hasFrom("Tom"), false);
  clock.now += 2_000;
  assert.equal(inbox.next()?.message.message, "hello", "Bob's waiting message is untouched");
  assert.equal(inbox.next(), null);
});

test("waitingLines gives the speaker's untaken lines, oldest first, and nothing once taken", () => {
  const { clock, inbox } = inboxAt();
  inbox.push(line("Tom", "one"));
  inbox.push(line("Bob", "hello"));
  inbox.push(line("Tom", "two"));
  assert.deepEqual(inbox.waitingLines("TOM").map((waiting) => waiting.message), ["one", "two"]);
  clock.now += 2_000;
  inbox.next();
  assert.deepEqual(inbox.waitingLines("Tom"), []);
});

test("a line pushed after dropWaitingFrom starts a message of its own", () => {
  const { clock, inbox } = inboxAt();
  inbox.push(line("Tom", "get logs"));
  inbox.dropWaitingFrom("Tom");
  inbox.push(line("Tom", "stop"));
  clock.now += 2_000;
  const heard = inbox.next();
  assert.equal(heard?.message.message, "stop");
  assert.equal(heard?.lines, 1);
});
