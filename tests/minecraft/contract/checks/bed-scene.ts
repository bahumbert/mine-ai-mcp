/** The bed checks' shared scene and steps: a red bed beside the feet, what the client hears when it is slept in, and a sleep that is tried. */
import assert from "node:assert/strict";
import type { Block } from "prismarine-block";
import type { ContractFixture } from "../checks.ts";
import { type ContractBot, type ContractSubject, holdsWithin, settleWithin } from "../subject.ts";

/** A red bed one block east of the feet, its head further east (`bed.js:parseBedMetadata`: facing east puts the head at +x). */
export const BED_FOOT = [1, -60, 0] as const;
export const BED_HEAD = [2, -60, 0] as const;
export const BED_FIXTURE: ContractFixture = {
  cells: {
    [BED_FOOT.join(",")]: { name: "red_bed", properties: { facing: "east", occupied: "false", part: "foot" } },
    [BED_HEAD.join(",")]: { name: "red_bed", properties: { facing: "east", occupied: "false", part: "head" } },
  },
  carried: {},
  position: [0.5, -60, 0.5],
};

/** The sleep Mineflayer waits for (`bed.js:waitUntilSleep`) is 3 s; one more second for a server behind. */
export const SLEEP_WALL_MS = 4_000;
/** One server answer to a bed use (a round trip, a server a little behind). */
export const BED_ANSWER_WALL_MS = 3_000;
/** How long a refusal is watched for a sleep that does not come. */
export const REFUSAL_WATCH_MS = 2_000;

/** The bed's foot block as the client has it. */
export function bedFoot(subject: ContractSubject): Block {
  const { bot } = subject;
  const at = subject.world(BED_FOOT);
  const block = bot.blockAt(at);
  assert.ok(block !== null && bot.isABed(block), `no bed at ${at}: ${String(block?.name)}`);
  return block;
}

/** Whether the client's world shows the bed taken (`occupied=true`), which `sleep.ts` reads to skip a bed. */
export function bedOccupied(subject: ContractSubject): boolean {
  return String(bedFoot(subject).getProperties().occupied) === "true";
}

/** The player's `pose` and `sleeping_pos` as the client filed them from the metadata (`entities.js:481-484`), by the version's keys. */
export function sleepMetadataOf(bot: ContractBot): { pose: unknown; sleepingPos: unknown } {
  const keys = bot.registry.entitiesByName.player!.metadataKeys!;
  return { pose: Reflect.get(bot.entity.metadata, keys.indexOf("pose")), sleepingPos: Reflect.get(bot.entity.metadata, keys.indexOf("sleeping_pos")) };
}

/** Counts the packets of one name the client writes while a step runs (`bot._client.write`), to show a refusal sent none. */
export function countWrites(bot: ContractBot, name: string): { readonly count: () => number; readonly stop: () => void } {
  const client = bot._client as unknown as { write: (packet: string, data: unknown) => void };
  const write = client.write;
  let written = 0;
  client.write = function (this: unknown, packet: string, data: unknown) {
    if (packet === name) written += 1;
    return write.call(this, packet, data);
  };
  return { count: () => written, stop: () => void (client.write = write) };
}

/** Sleep in the bed, resolved once the client heard `sleep`; the error Mineflayer or the server gave otherwise. */
export async function trySleep(subject: ContractSubject): Promise<{ readonly slept: boolean; readonly error?: string; readonly atMs: number }> {
  const settled = await settleWithin(subject, subject.bot.sleep(bedFoot(subject)), SLEEP_WALL_MS);
  assert.ok(settled !== null, "bot.sleep never settled");
  return { slept: settled.error === undefined, error: settled.error?.message, atMs: settled.atMs };
}

/** Wait until the client's world shows the bed's occupied state as `occupied`. */
export async function untilBedOccupied(subject: ContractSubject, occupied: boolean): Promise<void> {
  assert.ok(await holdsWithin(subject, () => bedOccupied(subject) === occupied, BED_ANSWER_WALL_MS), `the bed never showed occupied=${occupied}`);
}

/** Use the bed without Mineflayer's sleep checks (`activateBlock`: the look, the packet, the swing), so the server's own answer is the one heard. */
export async function useBed(subject: ContractSubject): Promise<void> {
  const settled = await settleWithin(subject, subject.bot.activateBlock(bedFoot(subject)), BED_ANSWER_WALL_MS);
  assert.ok(settled !== null && settled.error === undefined, `activateBlock: ${settled?.error?.message ?? "never settled"}`);
}
