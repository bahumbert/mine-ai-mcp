import assert from "node:assert/strict";
import test from "node:test";
import { WhoWasNamed } from "./who-was-named.ts";

const line = (username: string, message: string) => ({ username, message }) as Parameters<WhoWasNamed["note"]>[0];

// What a line naming nobody follows is also held through `Agent` in agent.test.ts (the live 2026-10-11 case); these hold the window's edge and the live list.
test("a line naming nobody follows the speaker's last line naming another character for exactly 60 s, per speaker", () => {
  const who = new WhoWasNamed("Ayla", () => ["Vex"]);
  assert.equal(who.note(line("Tester", "Vex, mine some stone"), 1_000), undefined, "a line naming a character is the conversation itself");
  assert.deepEqual(who.note(line("Tester", "thanks, no rush"), 24_000), { name: "Vex", secondsAgo: 23 });
  assert.equal(who.note(line("Other", "thanks"), 24_000), undefined, "kept per speaker");
  assert.deepEqual(who.note(line("Tester", "thanks again"), 61_000), { name: "Vex", secondsAgo: 60 }, "exactly 60 s is still within the window");
  assert.equal(who.note(line("Tester", "and again"), 61_001), undefined, "past 60 s the line stands alone");
});

test("a name added to the live list of other agents is known on the next line", () => {
  const names = ["Vex"];
  const who = new WhoWasNamed("Ayla", () => names);
  names.push("Brea");
  who.note(line("Tester", "Brea, dig"), 1_000);
  assert.deepEqual(who.note(line("Tester", "thanks"), 2_000), { name: "Brea", secondsAgo: 1 });
});
