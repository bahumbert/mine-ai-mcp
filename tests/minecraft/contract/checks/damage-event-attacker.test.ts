import assert from "node:assert/strict";
import test from "node:test";
import { damageEventAttacker } from "./damage-event-attacker.ts";
import { runOnFake } from "./run-on-fake.ts";

test("damage-event-attacker fails when a server names the shooter and not the arrow of an arrow's hit", async () => {
  // A server that hurts by the shooter alone: the arrow the check names is dropped, so the direct entity is the shooter.
  await assert.rejects(
    runOnFake(damageEventAttacker, {}, (subject) => ({ ...subject, hurtBot: (amount, sourceId) => subject.hurtBot(amount, sourceId) })),
    /sourceDirectId/,
  );
});
