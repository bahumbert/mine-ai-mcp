import assert from "node:assert/strict";
import test from "node:test";
import { EVENT_PAGE, readEventPages } from "./runtime-events.ts";

const said = (username: string, message: string, direction = "incoming") => ({ type: "player_message", payload: { username, channel: "chat", direction, message, addressed: false } });
const page = (events: readonly unknown[], remainingEventCount: number) => ({ result: { events, remainingEventCount } });

test("readEventPages reads every page until none remains, asking for the largest page each time", async () => {
  const pages = [page([said("Theo", "one"), { type: "hurt_by", payload: { attacker: "Zed", direct: null, at: 5 } }], 1), page([said("Theo", "two")], 0)];
  const limits: number[] = [];
  const events = await readEventPages(async (limit) => {
    limits.push(limit);
    return pages.shift();
  });
  assert.deepEqual(limits, [EVENT_PAGE, EVENT_PAGE]);
  assert.deepEqual(events.messages.map((m) => m.message), ["one", "two"]);
  assert.deepEqual(events.hurts, [{ attacker: "Zed", direct: null, at: 5 }]);
});

test("readEventPages drops the bot's own lines and events it does not read", async () => {
  const events = await readEventPages(async () => page([said("Ayla", "my own line", "outgoing"), { type: "block_broken", payload: {} }, said("Theo", "hi")], 0));
  assert.deepEqual(events.messages.map((m) => m.message), ["hi"]);
});

test("readEventPages keeps the distance a localized-chat server reports, and only that", async () => {
  const withDistance = { type: "player_message", payload: { username: "Theo", channel: "whisper", direction: "incoming", message: "psst", addressed: true, distance: 7 } };
  const events = await readEventPages(async () => page([withDistance, said("Vex", "far")], 0));
  assert.deepEqual(events.messages, [
    { username: "Theo", channel: "whisper", message: "psst", addressed: true, distance: 7 },
    { username: "Vex", channel: "chat", message: "far", addressed: false },
  ]);
});

test("readEventPages fails on a reply that is not the events shape, so the poll logs it and tries again", async () => {
  await assert.rejects(readEventPages(async () => ({ result: "nope" })));
});
