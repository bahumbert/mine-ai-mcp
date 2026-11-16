// Request-owned sign packets, retained across the placement's inventory settle.
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import type { WorldBlock } from "../../world/placement.js";
import { SERVER_CLOCK_STOPPED_MS, waitForServerAnswer } from "../../world/world-age.js";
import { normalizeLines, type SignLines } from "./contract.js";
import { readSignAt } from "../read-signs/read-signs.js";

export interface SignAnswers {
  editor(): Promise<boolean>;
  text(lines: SignLines, from: number | undefined): Promise<boolean>;
  dispose(): void;
}

/** Keep early editor packets, but require a new entity answer for each write. */
export function watchSignAnswers(bot: Bot, target: Vec3, signal?: AbortSignal): SignAnswers {
  const stop = new AbortController();
  const combined = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal;
  let opened = false;
  let version = 0;
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
  const wait = async (from: number | undefined, until: () => boolean) => {
    const answer = await waitForServerAnswer(bot, from, { until, wallMs: Infinity, stallMs: SERVER_CLOCK_STOPPED_MS, signal: combined });
    return answer === "until";
  };
  return {
    editor: () => wait(bot.time?.age, () => opened),
    text(lines, from) {
      const before = version;
      return wait(from, () => version > before && front !== null && front.every((line, index) => line === lines[index]));
    },
    dispose() {
      bot.removeListener("signOpen", onOpen);
      bot.removeListener("blockEntityData", onText);
      stop.abort(new Error("Sign observers disposed"));
    },
  };
}
