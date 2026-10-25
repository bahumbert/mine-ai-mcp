import assert from "node:assert/strict";
import test from "node:test";
import { FakeNavigationBot, flatWorld, movementStep, observation } from "../../test-support/navigation.js";
import { createRunScopedBot } from "./run-scoped-bot.js";

/** The shared bot, counting what reaches it. */
class CountingBot extends FakeNavigationBot {
  writes: string[] = [];
  holds = 0;
  released = 0;
  override clearOwnedControls() {
    this.writes.push("clear");
  }
  override applyMovementControls() {
    this.writes.push("controls");
  }
  override applyMovementSteering() {
    this.writes.push("steering");
  }
  override holdPosition() {
    this.holds += 1;
    return () => {
      this.released += 1;
    };
  }
}

test("writes after revoke do nothing", () => {
  const shared = new CountingBot();
  const scoped = createRunScopedBot(shared);
  scoped.bot.applyMovementControls({ forward: true } as never);
  assert.deepEqual(shared.writes, ["controls"], "a live run writes through");
  scoped.revoke();
  shared.writes = [];
  scoped.bot.applyMovementControls({ forward: true } as never);
  scoped.bot.applyMovementSteering({ x: 1, y: 63, z: 0 });
  scoped.bot.clearOwnedControls();
  const release = scoped.bot.holdPosition(flatWorld());
  release();
  assert.deepEqual(shared.writes, [], "nothing reaches the shared bot");
  assert.equal(shared.holds, 0);
  assert.equal(scoped.revoked, true);
});

test("revoke releases the holds it handed out once, and clears the controls", () => {
  const shared = new CountingBot();
  const scoped = createRunScopedBot(shared);
  const first = scoped.bot.holdPosition(flatWorld());
  scoped.bot.holdPosition(flatWorld());
  first();
  assert.equal(shared.released, 1);
  shared.writes = [];
  scoped.revoke();
  assert.equal(shared.released, 2, "only the hold still open is released");
  assert.deepEqual(shared.writes, ["clear"]);
  scoped.revoke();
  assert.equal(shared.released, 2);
  first();
  assert.equal(shared.released, 2, "a release called twice releases once");
});

test("reads still answer after revoke, and new movement is refused", async () => {
  const shared = new CountingBot();
  shared.current = observation(3);
  const scoped = createRunScopedBot(shared);
  scoped.revoke();
  assert.equal(scoped.bot.observe().position.x, 3.5);
  assert.equal(scoped.bot.movementSnapshot().position.x, 3.5);
  assert.equal(scoped.bot.ownedControlCount, 0);
  const step = movementStep("walk", { x: 3, y: 63, z: 0 }, { x: 4, y: 63, z: 0 });
  const preparation = await scoped.bot.prepareMovement(step, {} as never, new AbortController().signal, { end: "settled" }, () =>
    shared.movementSnapshot(),
  );
  assert.equal(preparation.kind, "failed");
  assert.equal(shared.current.position.x, 3.5, "the abandoned run moved nothing");
  assert.equal(await scoped.bot.centerOnCell({ x: 3, y: 63, z: 0 }, new AbortController().signal), false);
  const effect = scoped.bot.startEffect({ kind: "break" } as never, {} as never, new AbortController().signal);
  assert.equal(effect.issued, false);
  assert.equal((await effect.completion).kind, "failed");
});

test("a release that throws still leaves the view withdrawn", () => {
  class ThrowingBot extends CountingBot {
    override holdPosition() {
      return () => {
        throw new Error("release failed");
      };
    }
  }
  const scoped = createRunScopedBot(new ThrowingBot());
  scoped.bot.holdPosition(flatWorld());
  assert.throws(() => scoped.revoke(), /release failed/);
  assert.equal(scoped.revoked, true);
});

test("a run asks the server for a cell through its view, and an abandoned run asks nothing", async () => {
  const shared = new CountingBot();
  const asked: unknown[] = [];
  shared.requestCellResync = async (cell) => {
    asked.push(cell);
    return "resent";
  };
  const scoped = createRunScopedBot(shared);
  const cell = { x: 1, y: 62, z: 0 };
  assert.equal(await scoped.bot.requestCellResync?.(cell, new AbortController().signal), "resent");
  scoped.revoke();
  assert.equal(await scoped.bot.requestCellResync?.(cell, new AbortController().signal), "unavailable");
  assert.deepEqual(asked, [cell]);
});

test("a shared bot without the resync gives the run none", () => {
  assert.equal(createRunScopedBot(new CountingBot()).bot.requestCellResync, undefined);
});
