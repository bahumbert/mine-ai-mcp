// Request-owned sign packets, retained across the placement's inventory settle.
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import type { WorldBlock } from "../../world/placement.js";
import { SERVER_CLOCK_STOPPED_MS, waitForServerAnswer } from "../../world/world-age.js";
import { normalizeLines, type SignLines } from "./contract.js";
import { readSignAt } from "../read-signs/read-signs.js";

export interface SignAnswers {
  editor(signal?: AbortSignal, from?: number): Promise<boolean>;
  text(lines: SignLines, from: number | undefined, signal?: AbortSignal): Promise<boolean>;
  textConfirmed(lines: SignLines): boolean;
  dispose(): void;
}

/** Mineflayer owns the prediction sequence shared by all use-on-block packets. */
const { nextInteractionSequence } = require("mineflayer/lib/interaction_sequence.js") as {
  nextInteractionSequence(bot: object): number | undefined;
};

/**
 * Send in this turn: generic_place.js skips its awaited look with forceLook ignore (T1, 2026-11-15).
 * A held-item click that rejects (a throwing packet write, after `onSent`) reaches `onFailed`; the empty-hand click throws to the caller.
 */
export function clickSignNow(bot: Bot, block: WorldBlock, face: Vec3, onSent: () => void, onFailed: (error: unknown) => void): void {
  if (bot.heldItem) {
    const placing = bot as Bot & { _genericPlace(block: WorldBlock, face: Vec3, options: object): Promise<unknown> };
    placing._genericPlace(block, face, { forceLook: "ignore", swingArm: "right", onSent }).catch(onFailed);
    return;
  }
  const direction = face.y < 0 ? 0 : face.y > 0 ? 1 : face.z < 0 ? 2 : face.z > 0 ? 3 : face.x < 0 ? 4 : 5;
  const packet = { location: block.position, direction, cursorX: 0.5, cursorY: 0.5, cursorZ: 0.5 };
  // The empty-hand shapes mirror activateBlock without its awaited look (inventory.js:215-254).
  if (bot.supportFeature("blockPlaceHasHeldItem")) {
    bot._client.write("block_place", { ...packet, heldItem: { blockId: -1 }, cursorX: 8, cursorY: 8, cursorZ: 8 });
  } else if (bot.supportFeature("blockPlaceHasHandAndIntCursor")) {
    bot._client.write("block_place", { ...packet, hand: 0, cursorX: 8, cursorY: 8, cursorZ: 8 });
  } else if (bot.supportFeature("blockPlaceHasHandAndFloatCursor")) {
    bot._client.write("block_place", { ...packet, hand: 0 });
  } else if (bot.supportFeature("blockPlaceHasInsideBlock")) {
    bot._client.write("block_place", { ...packet, hand: 0, insideBlock: false, sequence: nextInteractionSequence(bot), worldBorderHit: false });
  }
  onSent();
  bot.swingArm("right");
}

/** Keep early editor packets, but require a new entity answer for each write. */
export function watchSignAnswers(bot: Bot, target: Vec3, signal?: AbortSignal): SignAnswers {
  const stop = new AbortController();
  const combined = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  let opened = false;
  let version = 0;
  let editVersion: number | null = null;
  let front: SignLines | null = null;
  const onOpen = (block: WorldBlock | null) => { if (block?.position.equals(target)) opened = true; };
  const onText = (block: WorldBlock | null) => {
    if (!block?.position.equals(target)) return;
    const reading = readSignAt(bot, target);
    if (!reading?.known) return;
    version++;
    front = normalizeLines(reading.front);
  };
  bot.on("signOpen", onOpen);
  bot.on("blockEntityData", onText);
  const wait = async (from: number | undefined, until: () => boolean, attempt?: AbortSignal) => {
    const answer = await waitForServerAnswer(bot, from, { until, wallMs: Infinity, stallMs: SERVER_CLOCK_STOPPED_MS,
      signal: attempt ? AbortSignal.any([combined, attempt]) : combined });
    return answer === "until";
  };
  const textConfirmed = (lines: SignLines) => editVersion !== null && version > editVersion && front !== null && front.every((line, index) => line === lines[index]);
  return {
    editor: (attempt, from = bot.time?.age) => wait(from, () => opened, attempt),
    text(lines, from, attempt) {
      opened = false;
      editVersion = version;
      return wait(from, () => textConfirmed(lines), attempt);
    },
    textConfirmed,
    dispose() {
      bot.removeListener("signOpen", onOpen);
      bot.removeListener("blockEntityData", onText);
      stop.abort(new Error("Sign observers disposed"));
    },
  };
}
