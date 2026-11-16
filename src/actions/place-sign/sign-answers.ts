// Request-owned sign packets, retained across the placement's inventory settle.
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import type { WorldBlock } from "../../world/placement.js";
import { SERVER_CLOCK_STOPPED_MS, waitForServerAnswer } from "../../world/world-age.js";
import { normalizeLines, type SignLines } from "./contract.js";
import { readSignAt } from "../read-signs/read-signs.js";

export interface SignAnswers {
  editor(signal?: AbortSignal): Promise<boolean>;
  text(lines: SignLines, from: number | undefined, signal?: AbortSignal): Promise<boolean>;
  textConfirmed(lines: SignLines): boolean;
  dispose(): void;
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
    editor: (attempt) => wait(bot.time?.age, () => opened, attempt),
    text(lines, from, attempt) {
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
