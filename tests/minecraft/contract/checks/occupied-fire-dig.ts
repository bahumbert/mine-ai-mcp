// Measure native digging at the occupied feet and head, independently of client prediction.
import assert from "node:assert/strict";
import type { Vec3 } from "vec3";
import { changeCovers, subscribeServerBlockChanges } from "../../../../src/navigation/mineflayer/server-block-changes.ts";
import type { ContractCheck } from "../checks.ts";
import { ANSWER_WALL_MS } from "../server-answer.ts";
import { type ContractSubject, settleWithin } from "../subject.ts";
import { markNow, READING_TICKS, tickOf } from "./server-tick-marks.ts";

/** Twice the measured 1-tick maximum at both rates, plus the common reading uncertainty (2026-11-17). */
const MAX_OCCUPIED_DIG_TICKS = 2 + READING_TICKS;

/** Record both directions before the dig can synchronously send or hear its first packet. */
function watchDig(subject: ContractSubject, cell: Vec3) {
  const { bot } = subject;
  const packets: { status: number; face: number; location: string }[] = [];
  const updates: { kind: string; name: string | undefined }[] = [];
  const incoming: string[] = [];
  const onSingle = (packet: { location: { x: number; y: number; z: number } }) => {
    if (changeCovers({ kind: "cell", ...packet.location }, cell)) incoming.push("block_change");
  };
  const onMulti = () => { incoming.push("multi_block_change"); };
  bot._client.on("block_change", onSingle);
  bot._client.on("multi_block_change", onMulti);
  const write = bot._client.write;
  bot._client.write = (name: string, data: unknown) => {
    if (name === "block_dig") {
      const packet = data as { status: number; face: number; location: Vec3 };
      packets.push({ status: packet.status, face: packet.face, location: packet.location.toString() });
    }
    return write.call(bot._client, name, data);
  };
  const unsubscribe = subscribeServerBlockChanges(bot, change => {
    if (changeCovers(change, cell)) updates.push({ kind: change.kind, name: bot.blockAt(cell)?.name });
  });
  return { packets, updates, incoming, dispose: () => {
    bot._client.write = write;
    unsubscribe();
    bot._client.off("block_change", onSingle);
    bot._client.off("multi_block_change", onMulti);
  } };
}

/** Query both sides of a known cell before any fake implementation is allowed to copy this answer. */
async function verifyBlockQuery(subject: ContractSubject, cell: Vec3, block: "air" | "fire"): Promise<void> {
  assert.equal(await subject.blockIs(cell, "air"), block === "air", `${block}: authoritative air query`);
  assert.equal(await subject.blockIs(cell, "fire"), block === "fire", `${block}: authoritative fire query`);
}

/** One occupied cell, supported by the inert fixture; the next iteration digs from the state it leaves. */
async function measureOccupiedDig(subject: ContractSubject, head: boolean): Promise<string> {
  const { bot } = subject;
  const feet = subject.world([0, -60, 0]);
  assert.ok(bot.entity.position.floored().equals(feet), `bot left fixture: ${bot.entity.position}`);
  const cell = subject.world([0, head ? -59 : -60, 0]);
  await verifyBlockQuery(subject, cell, "air");
  await subject.setBlock(cell, "fire");
  await verifyBlockQuery(subject, cell, "fire");
  const watch = watchDig(subject, cell);
  const started = markNow(subject);
  try {
    const digging = bot.dig(bot.blockAt(cell)!, true).then(() => {
      assert.ok(watch.updates.some(update => update.name === "air"), "native dig returned before an authoritative air packet");
    });
    const result = await settleWithin(subject, digging, ANSWER_WALL_MS);
    const ended = markNow(subject);
    const air = await subject.blockIs(cell, "air").catch(() => null);
    const endTick = await tickOf(subject, ended).catch(() => null);
    const startTick = await tickOf(subject, started).catch(() => null);
    const ticks = endTick === null || startTick === null ? null : endTick - startTick;
    const row = JSON.stringify({ cell: head ? "head" : "feet", packets: watch.packets, updates: watch.updates, incoming: watch.incoming,
      outcome: result === null ? "unsettled" : result.error?.message ?? "completed", air, ticks });
    console.info(`MEASURED occupied-fire-dig ${row}`);
    assert.ok(result !== null, "occupied fire dig did not settle within the existing answer backstop");
    assert.equal(result.error, undefined, "occupied fire dig failed");
    assert.equal(air, true, "occupied fire dig predicted air but the server kept the block");
    assert.deepEqual(watch.packets, [0, 2].map(status => ({ status, face: 1, location: cell.toString() })));
    assert.ok(watch.incoming.length > 0, "occupied fire dig received no block-state packet");
    assert.ok(ticks !== null && ticks >= 0 && ticks <= MAX_OCCUPIED_DIG_TICKS,
      `occupied fire dig took ${ticks} server ticks, expected 0..${MAX_OCCUPIED_DIG_TICKS}`);
    return row;
  } finally {
    try {
      bot.stopDigging();
    } finally {
      watch.dispose();
    }
  }
}

export const occupiedFireDig: ContractCheck = {
  name: "occupied-fire-dig",
  withoutRuntime: true,
  fixture: { cells: { "-1,-59,0": "oak_planks" }, carried: {}, position: [0.5, -60, 0.5] },
  async run(subject) {
    const feet = await measureOccupiedDig(subject, false);
    const head = await measureOccupiedDig(subject, true);
    return `MEASURED ${feet}; ${head}`;
  },
};
