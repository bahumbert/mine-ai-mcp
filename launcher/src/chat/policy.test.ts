import assert from "node:assert/strict";
import test from "node:test";
import { CommandGate, type CommandLine, type GateRules } from "./policy.ts";

const COOLDOWN_MS = 2_000;
const REFUSAL_EVERY_MS = 600_000;

function gateAt(clock: { now: number }): CommandGate {
  return new CommandGate({ now: () => clock.now, cooldownMs: COOLDOWN_MS, refusalEveryMs: REFUSAL_EVERY_MS });
}

const line = (username: string, channel: "chat" | "whisper" = "chat"): CommandLine => ({ username, channel, message: "!bots" });
const open: GateRules = { anyoneMay: true, players: [], ourNames: ["Ayla", "Brea", "MineAI"] };
const closed: GateRules = { anyoneMay: false, players: ["Tom"], ourNames: ["Ayla", "Brea", "MineAI"] };

test("a sender that is no player name is ignored", () => {
  const gate = gateAt({ now: 0 });
  for (const username of ["", "To>m", "Seventeen_chars_x", "Tom Smith", "Tom\n"]) assert.equal(gate.check(line(username), open), "ignore", JSON.stringify(username));
});

test("one of our own names is ignored, without case: a bot's model typing a command runs nothing", () => {
  const gate = gateAt({ now: 0 });
  assert.equal(gate.check(line("ayla"), open), "ignore");
  assert.equal(gate.check(line("MINEAI"), closed), "ignore");
});

test("anyoneMay runs the command", () => {
  assert.equal(gateAt({ now: 0 }).check(line("Stranger"), open), "run");
});

test("a sender not in players is refused once, ignored within refusalEveryMs, refused again after it", () => {
  const clock = { now: 1_000 };
  const gate = gateAt(clock);
  assert.equal(gate.check(line("Mallory"), closed), "refuse");
  clock.now += REFUSAL_EVERY_MS - 1;
  assert.equal(gate.check(line("Mallory"), closed), "ignore");
  clock.now += 1;
  assert.equal(gate.check(line("Mallory"), closed), "refuse");
});

test("refusals are counted per sender, without case", () => {
  const gate = gateAt({ now: 0 });
  assert.equal(gate.check(line("Mallory"), closed), "refuse");
  assert.equal(gate.check(line("Eve"), closed), "refuse");
  assert.equal(gate.check(line("MALLORY"), closed), "ignore");
});

test("players match without case", () => {
  assert.equal(gateAt({ now: 0 }).check(line("tOM"), closed), "run");
});

test("a second command within cooldownMs is ignored, one after it runs", () => {
  const clock = { now: 10_000 };
  const gate = gateAt(clock);
  assert.equal(gate.check(line("Tom"), closed), "run");
  clock.now += COOLDOWN_MS - 1;
  assert.equal(gate.check(line("Tom"), closed), "ignore");
  clock.now += 1;
  assert.equal(gate.check(line("Tom"), closed), "run");
});

test("the cooldown is per sender and the channel does not matter", () => {
  const gate = gateAt({ now: 0 });
  assert.equal(gate.check(line("Tom", "chat"), open), "run");
  assert.equal(gate.check(line("Dara", "chat"), open), "run");
  assert.equal(gate.check(line("Tom", "whisper"), open), "ignore");
});

test("a refused line does not start a cooldown for a later allowed sender", () => {
  const gate = gateAt({ now: 0 });
  assert.equal(gate.check(line("Mallory"), closed), "refuse");
  assert.equal(gate.check(line("Tom"), closed), "run");
});

test("old refusal and cooldown records are dropped so a flood of names does not grow memory", () => {
  const clock = { now: 0 };
  const gate = gateAt(clock);
  for (let index = 0; index < 5_000; index += 1) gate.check(line(`P${index}`), closed);
  clock.now += REFUSAL_EVERY_MS;
  gate.check(line("Late"), closed);
  assert.ok(gate.trackedSenders() <= 2, `${gate.trackedSenders()} senders still tracked`);
});
