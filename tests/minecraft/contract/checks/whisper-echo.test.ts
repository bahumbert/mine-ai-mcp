import assert from "node:assert/strict";
import test from "node:test";
import { whisperEcho } from "./whisper-echo.ts";
import { runOnFake } from "./run-on-fake.ts";

test("whisper-echo fails, saying no answer came, when a server echoes only the first of two whispers", async () => {
  let whispers = 0;
  await assert.rejects(
    runOnFake(whisperEcho, {}, (subject) => {
      const whisper = subject.bot.whisper.bind(subject.bot);
      subject.bot.whisper = (username, message) => (whispers += 1) === 1 && whisper(username, message);
      return subject;
    }),
    /the echo of two whispers: no answer within 10000 ms/,
  );
});

test("whisper-echo ignores the system lines other lanes of a shared server cause (a player left the game)", async () => {
  await runOnFake(whisperEcho, {}, (subject, harness) => {
    const leftTheGame = { translate: "multiplayer.player.left", with: [{ toString: () => "ActorL4003" }], toString: () => "ActorL4003 left the game" } as never;
    harness.clock.after(0, () => subject.bot.emit("message", leftTheGame, "system"));
    harness.clock.after(10, () => subject.bot.emit("message", leftTheGame, "system"));
    return subject;
  });
});

test("whisper-echo fails, showing both lists, when a line the check did not ask for arrives in the window", async () => {
  await assert.rejects(
    runOnFake(whisperEcho, {}, (subject, harness) => {
      harness.clock.after(10, () => subject.bot.emit("message", { translate: "chat.type.system", with: [], toString: () => "a stray line" } as never, "chat"));
      return subject;
    }),
    /each whisper is echoed as sent, then heard as received, in the order sent, and nothing else/,
  );
});
