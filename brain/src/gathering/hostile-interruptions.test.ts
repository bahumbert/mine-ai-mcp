// Tests of the runtime hostile-contact format and interruption memory across gatherings.
import assert from "node:assert/strict";
import test from "node:test";
import { HostileInterruptions, parseHostileContact } from "./hostile-interruptions.ts";

test("parses the runtime's exact fight/evade contacts and negative cells with nested reasons", () => {
  for (const [detail, response, name, id, cell] of [
    ["[HOSTILE_CONTACT] evade response for skeleton#24617 at 6,64,0 (6 blocks) (withdraw: no permitted attack, or defend_only engagement out of reach).", "evade", "skeleton", 24617, "6,64,0"],
    ["[HOSTILE_CONTACT] fight response for skeleton#24617 at 6,64,0 (6 blocks).", "fight", "skeleton", 24617, "6,64,0"],
    ["[HOSTILE_CONTACT] evade response for zombie#84159 at -553,59,-48 (3.2 blocks) (withdraw: ...).", "evade", "zombie", 84159, "-553,59,-48"],
    ["[HOSTILE_CONTACT] evade response for zombie#84159 at -553,59,-48 (3.2 blocks) (outmatched: killing 2 zombie with bare hands would cost ~99 of your 20 health (margin 0.2, fight_margin 1.5)).", "evade", "zombie", 84159, "-553,59,-48"],
    ["[HOSTILE_CONTACT] evade response for zombie#84159 at -553,59,-48 (3.2 blocks) (explosive: no safe weapon answer (blast margin 0.2)).", "evade", "zombie", 84159, "-553,59,-48"],
  ] as const) {
    assert.deepEqual(parseHostileContact(detail), { response, mobs: [{ name, id, cell }] }, detail);
  }
});

test("non-hostile and malformed details do not invent a contact", () => {
  for (const detail of ["[TOOL_TIER_LOST] lost a shovel", "[HOSTILE_CONTACT] evade", "ordinary response for zombie#1 at 0,64,0 (2 blocks)"]) {
    assert.equal(parseHostileContact(detail), null);
  }
});

for (const [cell, distance, count, moved] of [
  ["-552,59,-48", 4, 1, false],
  ["-552,59,-48", 3.2, 3, true],
  ["-552,59,-48", 2, 3, true],
  ["-553,59,-48", 4, 3, false],
] as const) {
  test(`another contact at ${cell}, ${distance} blocks counts ${count} (${moved ? "chaser" : "unmoved or walked off"})`, () => {
    let now = 0;
    const tracker = new HostileInterruptions(() => now);
    tracker.note("[HOSTILE_CONTACT] evade response for zombie#84159 at -553,59,-48 (3.2 blocks).");
    tracker.note("[HOSTILE_CONTACT] evade response for zombie#84159 at -553,59,-48 (3.2 blocks).");
    now = 60_000;
    assert.deepEqual(tracker.note(`[HOSTILE_CONTACT] evade response for zombie#84159 at ${cell} (${distance} blocks).`), {
      name: "zombie", id: 84159, cell, count, firstAt: count === 1 ? 60_000 : 0, moved,
    });
  });
}

test("ten minutes after its last interruption the count clears, including firstAt", () => {
  let now = 0;
  const tracker = new HostileInterruptions(() => now);
  const detail = "[HOSTILE_CONTACT] fight response for skeleton#24617 at 6,64,0 (6 blocks).";
  tracker.note(detail);
  now = 599_999;
  assert.equal(tracker.note(detail)?.count, 2);
  now += 600_000;
  assert.equal(tracker.note(detail)?.count, 1);
  now += 1;
  assert.equal(tracker.note(detail)?.firstAt, 1_199_999);
});

test("a reason listing two threats counts each once and returns the highest count", () => {
  const tracker = new HostileInterruptions(() => 0);
  tracker.note("[HOSTILE_CONTACT] evade response for zombie#2 at 2,64,0 (2 blocks).");
  const both = "[HOSTILE_CONTACT] evade response for zombie#1 at 1,64,0 (1 blocks), zombie#2 at 2,64,0 (2 blocks) (outmatched: killing 2 zombie (margin 0.2)).";
  assert.equal(parseHostileContact(both)?.mobs.length, 2);
  assert.equal(tracker.note(both)?.id, 2);
  assert.equal(tracker.note("[HOSTILE_CONTACT] evade response for zombie#1 at 1,64,0 (1 blocks).")?.count, 2);
  assert.equal(tracker.note("[TOOL_TIER_LOST] shovel lost"), null);
});
