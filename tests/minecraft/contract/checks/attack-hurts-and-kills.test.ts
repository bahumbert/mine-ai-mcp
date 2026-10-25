import assert from "node:assert/strict";
import test from "node:test";
import { ZERO_ARENA, arenaFrame } from "../../arena/frame.ts";
import { fakeHarnessFor } from "../fake-harness.ts";
import { fakeContractSubject } from "../subject.ts";
import { attackHurtsAndKills } from "./attack-hurts-and-kills.ts";
import { finishWithin } from "./combat-scene.ts";

/** A server thread stalled this long after each hit (another lane's clone: 0.16 to 0.9 s, plan 2026-10-23-shared-scenario-server E4). */
const STALL_MS = 400;

test("attack-hurts-and-kills reads each hit's health from the answer, not after a fixed gap, when the server stalls after every hit", async () => {
  const harness = fakeHarnessFor(attackHurtsAndKills.fixture, arenaFrame(ZERO_ARENA));
  using _installed = harness.clock.install();
  const { bot, server } = harness;
  const attack = bot.attack.bind(bot);
  bot.attack = (target) => {
    server.stop();
    harness.clock.after(STALL_MS, () => server.resume());
    attack(target);
  };
  await attackHurtsAndKills.run(fakeContractSubject(harness, arenaFrame(ZERO_ARENA)));
});

test("attack-hurts-and-kills lets the sword's swing recharge in server ticks before its first hit, when the sword was only just taken in hand", async () => {
  const frame = arenaFrame(ZERO_ARENA);
  const harness = fakeHarnessFor(attackHurtsAndKills.fixture, frame);
  using _installed = harness.clock.install();
  const subject = fakeContractSubject(harness, frame);
  const { bot } = harness;
  const sword = bot.heldItem!;
  // A body that just joined, or just took the sword: the swing starts over (`Player.tick`), a hit in the first 12 ticks is weak (a lane batch: 1.2 of 6 for hit 1).
  await finishWithin(subject, bot.unequip("hand"), "unequip");
  await finishWithin(subject, bot.equip(sword, "hand"), "equip");
  await attackHurtsAndKills.run(subject);
});

test("attack-hurts-and-kills names the hit whose answer never came when the server answers nothing", async () => {
  const harness = fakeHarnessFor(attackHurtsAndKills.fixture, arenaFrame(ZERO_ARENA));
  using _installed = harness.clock.install();
  harness.bot.attack = () => undefined;
  await assert.rejects(attackHurtsAndKills.run(fakeContractSubject(harness, arenaFrame(ZERO_ARENA))), /hit 1.*not answered/);
});
