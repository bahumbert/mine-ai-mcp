/** Measure the packets and block entities of sign editing on a 1.21.4 server. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Vec3 } from "vec3";
import type { Block } from "prismarine-block";
import type { ContractCheck } from "../checks.ts";
import type { ContractSubject } from "../subject.ts";
import { afterClientTicks, afterServerTicks, answerArrives, serverQuiet } from "../server-answer.ts";
import { createMeasureReader } from "./combat-data-measure.ts";
import { markNow, restTicksSince, tickOf, READING_TICKS, type Mark } from "./server-tick-marks.ts";
import { logPackets, type PacketLog } from "./packet-log.ts";

const UP = new Vec3(0, 1, 0);
const WEST = new Vec3(-1, 0, 0);
const WINDOW = 100;
const { nextInteractionSequence } = createRequire(import.meta.url)("mineflayer/lib/interaction_sequence") as { nextInteractionSequence(bot: ContractSubject["bot"]): number };
type GenericPlace = (block: Block, face: Vec3, options: { forceLook: "ignore"; swingArm: "right" }) => Promise<unknown>;
const PACKETS = ["block_change", "open_sign_entity", "tile_entity_data", "set_slot", "acknowledge_player_digging"] as const;

/** Format the shared packet log with queried server ticks relative to the send. */
async function packetText(subject: ContractSubject, recorded: PacketLog, sent: Mark): Promise<string> {
  const start = await tickOf(subject, sent);
  return (await Promise.all(recorded.packets.map(async ({ name, packet, heardAt }) => {
    const ticks = (await tickOf(subject, heardAt!)) - start;
    assert.ok(ticks >= -READING_TICKS && ticks <= WINDOW, `${name} observed at ${ticks} ticks`);
    const detail = name === "open_sign_entity" ? ` front=${packet.isFrontText}` : name === "set_slot" ? ` slot=${packet.slot}` : "";
    return `${name}${detail}@${ticks}`;
  }))).join(", ");
}

/** Send one act, then wait long enough to observe an absent answer as well as a present one. */
async function measure(subject: ContractSubject, action: () => void | Promise<unknown>, sent?: Mark): Promise<string> {
  const recorded = logPackets(subject, PACKETS, PACKETS);
  const start = sent ?? markNow(subject);
  try {
    await action();
    await afterServerTicks(subject, WINDOW, "sign answer window");
    return await packetText(subject, recorded, start);
  } finally {
    recorded.stop();
  }
}

/** Write, then attempt a second write 40 server ticks after the first send. */
async function writeTwice(subject: ContractSubject, at: Vec3): Promise<readonly [string, string, number]> {
  const { bot } = subject;
  const recorded = logPackets(subject, PACKETS, PACKETS);
  const first = markNow(subject);
  try {
    bot.updateSign(bot.blockAt(at)!, "one\ntwo\nthree\nfour");
    await answerArrives(subject, () => recorded.packets.some(({ name }) => name === "tile_entity_data"), "first sign edit");
    await restTicksSince(subject, first, 40, "the second sign edit");
    recorded.stop();
    const second = markNow(subject);
    const rejected = await measure(subject, () => bot.updateSign(bot.blockAt(at)!, "changed"), second);
    const gap = (await tickOf(subject, second)) - (await tickOf(subject, first));
    assert.ok(gap >= 40 && gap <= 40 + 2 * READING_TICKS, `second edit gap: ${gap} ticks`);
    return [await packetText(subject, recorded, first), rejected, gap];
  } finally {
    recorded.stop();
  }
}

/** Send activateBlock's 1.21.4 packet after the caller's forced look, with an empty hand. */
function emptyClick(subject: ContractSubject, at: Vec3): void {
  subject.bot._client.write("block_place", { location: at, direction: 1, hand: 0, cursorX: 0.5, cursorY: 0.5, cursorZ: 0.5, insideBlock: false, sequence: nextInteractionSequence(subject.bot), worldBorderHit: false });
}

/** Assert packet order independently of the small uncertainty in the tick queries. */
function assertPackets(line: string, names: readonly string[]): void {
  const packets = line.slice(line.indexOf(": ") + 2).split("; ")[0]!;
  assert.deepEqual(packets === "" ? [] : packets.split(", ").map((packet) => packet.split("@")[0]), names, line);
}

/** Assert the observed block, properties and both text faces. */
function assertSign(line: string, name: string, properties: object, front: string): void {
  assert.ok(line.endsWith(JSON.stringify({ name, properties, entity: true, text: [front, "\n\n\n"] })), line);
}

/** Place or click by Mineflayer's packet path without an implicit second look. */
async function click(subject: ContractSubject, reference: Vec3, face: Vec3): Promise<void> {
  const block = subject.bot.blockAt(reference);
  assert.ok(block, `no loaded reference at ${reference}`);
  const place = Reflect.get(subject.bot, "_genericPlace") as GenericPlace;
  await place(block, face, { forceLook: "ignore", swingArm: "right" });
}

/** Read the actual block and both sign faces, including a missing entity. */
function signAt(subject: ContractSubject, at: Vec3): string {
  const block = subject.bot.blockAt(at);
  return JSON.stringify({ name: block?.name, properties: block?.getProperties(), entity: !!block?.entity, text: block?.getSignText() });
}

/** Place a standing sign while facing a chosen yaw. */
async function floorSign(subject: ContractSubject, at: Vec3, yaw: number): Promise<string> {
  await subject.bot.look(yaw, 0, true);
  await afterClientTicks(subject, 2, "the placement look");
  const packets = await measure(subject, () => click(subject, at.offset(0, -1, 0), UP));
  return `${packets}; ${signAt(subject, at)}`;
}

/** Reopen a sign with the same held-item click used by fill_blank. */
async function heldClick(subject: ContractSubject, at: Vec3): Promise<string> {
  await subject.bot.lookAt(at.offset(0.5, 0.5, 0.5), true);
  return measure(subject, () => click(subject, at, UP));
}

/** Reload the sign's chunk after travelling away and record its entity at first sight. */
async function reload(subject: ContractSubject, at: Vec3): Promise<string> {
  if (subject.chunkPackets !== "server") return "chunk reload: server only";
  const reader = createMeasureReader(subject);
  const away = subject.world([200, -60, 0]);
  await reader.read([`run teleport ${subject.bot.username} ${away.x} ${away.y} ${away.z}`]);
  await answerArrives(subject, () => subject.bot.blockAt(at) === null, "the sign chunk unloads");
  const home = subject.world([0.5, -60, 0.5]);
  let first: string | undefined;
  const onLoad = (corner: Vec3) => {
    if ((corner.x >> 4) === (at.x >> 4) && (corner.z >> 4) === (at.z >> 4)) first = signAt(subject, at);
  };
  subject.bot.on("chunkColumnLoad", onLoad);
  try {
    await reader.read([`run teleport ${subject.bot.username} ${home.x} ${home.y} ${home.z}`]);
    await answerArrives(subject, () => first !== undefined, "the sign chunk reloads");
    await answerArrives(subject, () => !!subject.bot.blockAt(at)?.entity, "the reloaded sign entity");
    return `first ${first}; entity ${signAt(subject, at)}`;
  } finally {
    subject.bot.off("chunkColumnLoad", onLoad);
  }
}

export const signEdit: ContractCheck = {
  name: "sign-edit",
  fixture: { cells: { "2,-60,0": "stone", "2,-59,0": "stone" }, carried: { oak_sign: 4 }, position: [0.5, -60, 0.5] },
  withoutRuntime: true,
  async run(subject) {
    const { bot } = subject;
    const north = subject.world([0, -60, -2]);
    const east = subject.world([0, -60, 2]);
    const raw = subject.world([-2, -60, 0]);
    const wall = subject.world([1, -60, 0]);
    const log: string[] = [];
    await serverQuiet(subject, "the join");
    log.push(`north: ${await floorSign(subject, north, 0)}`);
    const [firstWrite, secondWrite, gap] = await writeTwice(subject, north);
    log.push(`write: ${firstWrite}; ${signAt(subject, north)}`);
    log.push(`second write: ${secondWrite}; ${signAt(subject, north)}`);
    log.push(`east: ${await floorSign(subject, east, -Math.PI / 2)}`);
    log.push(`close blank: ${await measure(subject, () => bot.updateSign(bot.blockAt(east)!, ""))}; ${signAt(subject, east)}`);
    log.push(`blank held click: ${await heldClick(subject, east)}`);
    log.push(`blank write: ${await measure(subject, () => bot.updateSign(bot.blockAt(east)!, "filled"))}; ${signAt(subject, east)}`);
    log.push(`text held click: ${await heldClick(subject, east)}`);
    log.push(`text write: ${await measure(subject, () => bot.updateSign(bot.blockAt(east)!, "again"))}; ${signAt(subject, east)}`);
    bot.setQuickBarSlot(1);
    await bot.lookAt(east.offset(0.5, 0.5, 0.5), true);
    log.push(`text empty click: ${await measure(subject, () => emptyClick(subject, east))}`);
    log.push(`empty write: ${await measure(subject, () => bot.updateSign(bot.blockAt(east)!, "empty"))}; ${signAt(subject, east)}`);
    bot.setQuickBarSlot(0);
    log.push(`raw placement: ${await floorSign(subject, raw, 0)}`);
    log.push(`raw write: ${await measure(subject, () => bot._client.write("update_sign", { location: raw, isFrontText: true, text1: "a".repeat(45), text2: "b".repeat(46), text3: "", text4: "" }))}; ${signAt(subject, raw)}`);
    log.push(`wall: ${await measure(subject, () => click(subject, subject.world([2, -60, 0]), WEST))}; ${signAt(subject, wall)}`);
    log.push(`close wall blank: ${await measure(subject, () => bot.updateSign(bot.blockAt(wall)!, ""))}; ${signAt(subject, wall)}`);
    bot.setQuickBarSlot(1);
    await bot.lookAt(wall.offset(0.5, 0.5, 0.5), true);
    log.push(`blank empty click: ${await measure(subject, () => emptyClick(subject, wall))}`);
    log.push(`blank empty write: ${await measure(subject, () => bot.updateSign(bot.blockAt(wall)!, "empty blank"))}; ${signAt(subject, wall)}`);
    log.push(`reload: ${await reload(subject, north)}`);
    // Real 1.21.4 server, 2026-11-16: 3/3 at both 10 and 20 tps. Placement
    // opens the front editor before slot 36; clicks reopen it, writes update the
    // entity, and a second write without reopening is silent (40-tick gap at
    // 10 tps). Raw 45/46-character lines survived; reload first lacked the
    // entity, then delivered the saved front text. The server maximum is unknown.
    const placement = ["block_change", "open_sign_entity front=true", "block_change", "block_change", "block_change", "tile_entity_data", "set_slot slot=36", "acknowledge_player_digging"];
    const clickAnswer = ["block_change", "open_sign_entity front=true", "block_change", "block_change", "acknowledge_player_digging"];
    const editAnswer = ["block_change", "tile_entity_data"];
    for (const index of [0, 3, 11, 13]) assertPackets(log[index]!, placement);
    for (const index of [5, 7, 9, 15]) assertPackets(log[index]!, clickAnswer);
    for (const index of [1, 4, 6, 8, 10, 12, 14, 16]) assertPackets(log[index]!, editAnswer);
    assertPackets(log[2]!, []);
    const northProperties = { waterlogged: false, rotation: "0" };
    const eastProperties = { waterlogged: false, rotation: "4" };
    for (const index of [0, 11]) assertSign(log[index]!, "oak_sign", northProperties, "\n\n\n");
    for (const index of [1, 2]) assertSign(log[index]!, "oak_sign", northProperties, "one\ntwo\nthree\nfour");
    for (const index of [3, 4]) assertSign(log[index]!, "oak_sign", eastProperties, "\n\n\n");
    for (const [index, text] of [[6, "filled"], [8, "again"], [10, "empty"]] as const) assertSign(log[index]!, "oak_sign", eastProperties, `${text}\n\n\n`);
    assertSign(log[12]!, "oak_sign", northProperties, `${"a".repeat(45)}\n${"b".repeat(46)}\n\n`);
    for (const index of [13, 14]) assertSign(log[index]!, "oak_wall_sign", { waterlogged: false, facing: "west" }, "\n\n\n");
    assertSign(log[16]!, "oak_wall_sign", { waterlogged: false, facing: "west" }, "empty blank\n\n\n");
    if (subject.chunkPackets === "server") {
      assert.ok(log[17]!.includes(`first ${JSON.stringify({ name: "oak_sign", properties: northProperties, entity: false, text: ["", ""] })};`), log[17]);
      assertSign(log[17]!, "oak_sign", northProperties, "one\ntwo\nthree\nfour");
    }
    log.push(`second write gap: ${gap} ticks`);
    return log.join(" | ");
  },
};
