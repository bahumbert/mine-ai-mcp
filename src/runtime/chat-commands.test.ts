import assert from "node:assert/strict";
import test from "node:test";
import { ChatCommandRing, isChatCommandLine } from "./chat-commands.js";

const line = (message: string, username = "Tom") => ({ username, channel: "chat" as const, message });

test("lines get a seq from 1 and after(n) returns the ones past n, with the ring's epoch", () => {
  const ring = new ChatCommandRing(50, () => new Date("2026-10-30T10:00:00.000Z"));
  assert.deepEqual(ring.after(undefined), { epoch: ring.epoch, lastSeq: 0, commands: [] });
  for (const text of ["!bots", "!bot start a", "!bot stop a"]) ring.push(line(text));

  assert.deepEqual(
    ring.after(undefined).commands.map(({ seq, message }) => [seq, message]),
    [[1, "!bots"], [2, "!bot start a"], [3, "!bot stop a"]],
  );
  const past2 = ring.after(2);
  assert.equal(past2.lastSeq, 3);
  assert.deepEqual(past2.commands, [
    { seq: 3, username: "Tom", channel: "chat", message: "!bot stop a", at: "2026-10-30T10:00:00.000Z" },
  ]);
  assert.deepEqual(ring.after(3).commands, []);
  assert.deepEqual(ring.after(99).commands, []);
});

test("past its capacity the ring keeps the newest lines and seq goes on counting", () => {
  const ring = new ChatCommandRing(50);
  for (let n = 1; n <= 60; n += 1) ring.push(line(`!bot start p${n}`));

  const { commands, lastSeq } = ring.after(0);
  assert.equal(lastSeq, 60);
  assert.equal(commands.length, 50);
  assert.equal(commands[0]?.seq, 11);
  assert.equal(commands.at(-1)?.seq, 60);
});

test("two rings have different epochs, so a restarted runtime is told apart", () => {
  assert.notEqual(new ChatCommandRing().epoch, new ChatCommandRing().epoch);
});

test("a command line is the prefix then bot or bots, in any case, as a whole word", () => {
  for (const yes of ["!bots", "!bot", " !Bot start x", "  !BOT stop x", "!bots\tnow", "!BOTS"]) {
    assert.equal(isChatCommandLine(yes, "!"), true, yes);
  }
  for (const no of ["!discord", "!botany", "!! creeper", "hi !bots", "bots", "", "!", "!bots!"]) {
    assert.equal(isChatCommandLine(no, "!"), false, no);
  }
});

test("the prefix is matched as text, not as a pattern", () => {
  assert.equal(isChatCommandLine(".bots", "."), true);
  assert.equal(isChatCommandLine("xbots", "."), false);
  assert.equal(isChatCommandLine("$bot go", "$"), true);
  assert.equal(isChatCommandLine("!bots", "$"), false);
});
