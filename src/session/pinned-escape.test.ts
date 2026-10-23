import assert from "node:assert/strict";
import test from "node:test";
import { type FakeBotOptions, type FakeHarness, createFakeBot, createFakeClock } from "../test-support/fake-bot/index.js";
import { createPinnedEscape } from "./pinned-escape.js";

type Stance = "supported" | "swimming" | "airborne" | "climbing";

/**
 * The bot at (3.5, y, 4.5) over open air in each stance a pinned watch can find it in; the harness's server records
 * what the escape writes. `answer` makes the server resend the clicked cell, as run 10 and 16 showed it does
 * (`cell-resync.ts`); the clock is mocked, so the answer's wait runs on it.
 */
function pinnedFixture(stance: Stance, options: { y?: number; cells?: FakeBotOptions["cells"]; offHand?: { name: string }; answer?: boolean; server?: FakeBotOptions["server"] } = {}) {
  const harness = createFakeBot({
    clock: createFakeClock({ mode: "mocked" }),
    position: { x: 3.5, y: options.y ?? 64, z: 4.5 },
    groundY: null,
    cells: options.cells ?? (stance === "climbing" ? { "3,64,4": "ladder" } : {}),
    slots: { 45: options.offHand ?? null },
    server: options.server,
  });
  const { bot, server } = harness;
  if (options.answer !== false) {
    server.onPacket("block_place", (packet) => {
      const { location } = packet as { location: unknown };
      server.answer(() => bot._client.emit("block_change", { location, type: 1 }));
    });
  }
  Object.assign(bot.entity, { onGround: stance === "supported", isInWater: stance === "swimming" });
  const written = () => server.packets.map(({ name, data }) => ({ name, packet: data as Record<string, unknown> }));
  return { harness, bot, written, uses: () => written().filter((entry) => entry.name === "block_place") };
}

/** The escape's `leave`, run while `ms` of clock pass: long enough for the server's answer, or its 40 ticks without one. */
async function leave({ bot, clock }: FakeHarness, ms = 200): Promise<void> {
  using _timers = clock.install();
  const leaving = createPinnedEscape(bot, () => ({ [Symbol.dispose]: () => undefined })).leave(new AbortController().signal);
  await clock.advance(ms);
  await leaving;
}

test("the escape's first move runs from a supported stance: nothing to leave, nothing sent", async () => {
  const { harness, written } = pinnedFixture("supported");
  await leave(harness);
  assert.deepEqual(written(), []);
});

test("the escape's first move runs from a swimming stance: the swim, and no resend of a cell", async () => {
  const { harness, bot, written } = pinnedFixture("swimming");
  await leave(harness);
  assert.equal(written().filter((entry) => entry.name === "block_place").length, 0);
  assert.ok(Object.values(bot.controlState).every((held) => !held), "the swim returned with every control released");
});

test("the escape's first move runs from an airborne stance held by the server: it asks for the cell under the feet once", async () => {
  const { harness, uses, written } = pinnedFixture("airborne");
  await leave(harness);
  assert.equal(uses().length, 1);
  const packet = uses()[0]!.packet;
  assert.deepEqual({ ...(packet.location as object) }, { x: 3, y: 63, z: 4 }, "the cell under the feet");
  assert.equal(packet.direction, 1);
  assert.equal(packet.hand, 1, "the empty off hand: no item of the bot's is used");
  // Mineflayer's sneak control sends its own `player_input` on a 1.21.4 server (`physics.js:245-275`), beside our shift.
  assert.deepEqual(
    written().map((entry) => entry.name),
    ["player_input", "entity_action", "block_place", "player_input", "entity_action"],
    "crouched for the use, standing after",
  );
});

test("the same cell is asked for when the body sits 0.08 into it, as the ghost-air cycle does", async () => {
  const { harness, uses } = pinnedFixture("airborne", { y: 63.92 });
  await leave(harness);
  assert.deepEqual({ ...(uses()[0]!.packet.location as object) }, { x: 3, y: 63, z: 4 });
});

test("an airborne stance over a cell the client sees solid asks for nothing: the server holds nothing the client lacks", async () => {
  const { harness, written } = pinnedFixture("airborne", { cells: { "3,63,4": "stone" } });
  await leave(harness);
  assert.deepEqual(written(), []);
});

test("the escape's first move runs from a climbing stance: the ladder is the support, nothing is asked", async () => {
  const { harness, written } = pinnedFixture("climbing");
  await leave(harness);
  assert.deepEqual(written(), []);
});

test("a held off-hand item ends the airborne escape without a throw and without a packet", async () => {
  const { harness, written } = pinnedFixture("airborne", { offHand: { name: "shield" } });
  await leave(harness);
  assert.deepEqual(written(), []);
});

test("a server that never answers lets the escape go on: leave resolves, the routes start as escapes", { timeout: 5_000 }, async () => {
  // Its first time packet half a second in: 40 ticks of world age pass at 1.5 s, before the 2 s wall bound.
  const { harness, uses } = pinnedFixture("airborne", { answer: false, server: { phaseMs: 500 } });
  // The server runs on (its world age moves) but never sends the cell: the wait ends on its 40 ticks.
  await leave(harness, 1_600);
  assert.equal(uses().length, 1, "asked once, not retried in a loop");
});
