import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { type BotFixtureOptions, botFixture, registry } from "../test-support/bot.js";
import { createPinnedEscape } from "./pinned-escape.js";

type Stance = "supported" | "swimming" | "airborne" | "climbing";

interface Written {
  readonly name: string;
  readonly packet: Record<string, unknown>;
}

/**
 * The bot at (3.5, y, 4.5) in each stance a pinned watch can find it in, with the protocol client recording what the
 * escape writes. `answer` makes the "server" resend the clicked cell, as run 10 and 16 showed it does.
 */
function pinnedFixture(stance: Stance, options: { y?: number; blocks?: BotFixtureOptions["blocks"]; offHand?: { name: string }; answer?: boolean } = {}) {
  const written: Written[] = [];
  const client = new EventEmitter();
  const controls = new Map<string, boolean>();
  const bot = botFixture(
    {
      position: { x: 3.5, y: options.y ?? 64, z: 4.5 },
      blocks: options.blocks ?? (stance === "climbing" ? { "3,64,4": "ladder" } : {}),
      slots: { 45: options.offHand ?? null },
    },
    {
      version: "1.21.4",
      supportFeature: (feature: string) => registry.supportFeature(feature as never),
      setControlState: (control: string, value: boolean) => controls.set(control, value),
      _client: Object.assign(client, {
        write: (name: string, packet: Record<string, unknown>) => {
          written.push({ name, packet });
          if (name === "block_place" && options.answer !== false) setImmediate(() => client.emit("block_change", { location: packet.location, type: 1 }));
        },
      }),
    },
  );
  Object.assign(bot.entity, { onGround: stance === "supported", isInWater: stance === "swimming" });
  return { bot, written, controls, uses: () => written.filter((entry) => entry.name === "block_place") };
}

const escapeOf = (bot: ReturnType<typeof pinnedFixture>["bot"]) => createPinnedEscape(bot, () => ({ [Symbol.dispose]: () => undefined }));

test("the escape's first move runs from a supported stance: nothing to leave, nothing sent", async () => {
  const { bot, written } = pinnedFixture("supported");
  await escapeOf(bot).leave(new AbortController().signal);
  assert.deepEqual(written, []);
});

test("the escape's first move runs from a swimming stance: the swim, and no resend of a cell", async () => {
  const { bot, written, controls } = pinnedFixture("swimming");
  await escapeOf(bot).leave(new AbortController().signal);
  assert.equal(written.filter((entry) => entry.name === "block_place").length, 0);
  assert.ok([...controls.values()].every((held) => !held), "the swim returned with every control released");
});

test("the escape's first move runs from an airborne stance held by the server: it asks for the cell under the feet once", async () => {
  const { bot, uses, written } = pinnedFixture("airborne");
  await escapeOf(bot).leave(new AbortController().signal);
  assert.equal(uses().length, 1);
  const packet = uses()[0]!.packet;
  assert.deepEqual({ ...(packet.location as object) }, { x: 3, y: 63, z: 4 }, "the cell under the feet");
  assert.equal(packet.direction, 1);
  assert.equal(packet.hand, 1, "the empty off hand: no item of the bot's is used");
  assert.deepEqual(written.map((entry) => entry.name), ["entity_action", "block_place", "entity_action"], "crouched for the use, standing after");
});

test("the same cell is asked for when the body sits 0.08 into it, as the ghost-air cycle does", async () => {
  const { bot, uses } = pinnedFixture("airborne", { y: 63.92 });
  await escapeOf(bot).leave(new AbortController().signal);
  assert.deepEqual({ ...(uses()[0]!.packet.location as object) }, { x: 3, y: 63, z: 4 });
});

test("an airborne stance over a cell the client sees solid asks for nothing: the server holds nothing the client lacks", async () => {
  const { bot, written } = pinnedFixture("airborne", { blocks: { "3,63,4": "stone" } });
  await escapeOf(bot).leave(new AbortController().signal);
  assert.deepEqual(written, []);
});

test("the escape's first move runs from a climbing stance: the ladder is the support, nothing is asked", async () => {
  const { bot, written } = pinnedFixture("climbing");
  await escapeOf(bot).leave(new AbortController().signal);
  assert.deepEqual(written, []);
});

test("a held off-hand item ends the airborne escape without a throw and without a packet", async () => {
  const { bot, written } = pinnedFixture("airborne", { offHand: { name: "shield" } });
  await escapeOf(bot).leave(new AbortController().signal);
  assert.deepEqual(written, []);
});

test("a server that never answers lets the escape go on: leave resolves, the routes start as escapes", { timeout: 5_000 }, async () => {
  const { bot, uses } = pinnedFixture("airborne", { answer: false });
  await escapeOf(bot).leave(new AbortController().signal);
  assert.equal(uses().length, 1, "asked once, not retried in a loop");
});
