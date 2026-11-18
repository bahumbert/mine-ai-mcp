// The brain's command line and the set of agents it must not answer; apart from `main.ts` so a test can import them
// (`main.ts` runs the brain on import, and `.agent/scripts/ops/brain-mem.ts` loads it that way).
import { parseArgs } from "node:util";
import { chatSlotsRefusal } from "./model-lanes.ts";

/** A `--chat-slots` or `MODEL_CHAT_SLOTS` text as a number, or the reason it cannot be kept for chat. */
function chatSlotsOf(text: string, slots: number | null): { readonly value: number } | { readonly refusal: string } {
  if (!/^\d+$/u.test(text.trim())) return { refusal: `"${text}" is not a whole number from 0` };
  const value = Number(text);
  const refusal = chatSlotsRefusal(slots, value);
  return refusal === null ? { value } : { refusal };
}

/**
 * How many model slots are kept for replies to a person's line (spec 2026-11-18 D1): 1 when the slots are known and at
 * least 2 (one slot cannot be kept back), else 0. The flag out of range refuses to start (`[BAD_CHAT_SLOTS]`); the env
 * value out of range is logged and the default used, so one global `.env.defaults` line never stops a one-slot or a
 * remote-provider run.
 */
export function chatSlotsFor(slots: number | null, flag: string | undefined, envValue: string | undefined, log: (line: string) => void): number {
  const fallback = slots !== null && slots >= 2 ? 1 : 0;
  if (flag !== undefined) {
    const read = chatSlotsOf(flag, slots);
    if ("refusal" in read) throw new Error(`[BAD_CHAT_SLOTS] --chat-slots ${flag}: ${read.refusal}`);
    return read.value;
  }
  if (envValue === undefined || envValue === "") return fallback;
  const read = chatSlotsOf(envValue, slots);
  if ("refusal" in read) {
    log(`MODEL_CHAT_SLOTS=${envValue} ignored: ${read.refusal}; ${fallback} kept for chat`);
    return fallback;
  }
  return read.value;
}

/** Defaults of the per-speaker chat budget (spec 2026-11-18-chat-flood-bounds, open choice 3). */
const DEFAULT_SPEAKER_CHAT_PER_MINUTE = 6;
const DEFAULT_SPEAKER_CHAT_BURST = 15;

/** A whole-number option text (or its default) read against a minimum; a bad value refuses to start. */
function wholeOption(name: string, text: string | undefined, fallback: number, min: number): number {
  if (text === undefined || text === "") return fallback;
  if (!/^\d+$/u.test(text.trim()) || Number(text) < min) throw new Error(`[BAD_START_ARG] --${name} expects a whole number (${min} or more), got ${text}`);
  return Number(text);
}

/** The per-speaker chat budget from `--speaker-chat-per-minute` and `--speaker-chat-burst` (each already falling back to its env value). */
export function speakerBudgetLimits(perMinute: string | undefined, burst: string | undefined): { perMinute: number; burst: number } {
  return {
    perMinute: wholeOption("speaker-chat-per-minute", perMinute, DEFAULT_SPEAKER_CHAT_PER_MINUTE, 0),
    burst: wholeOption("speaker-chat-burst", burst, DEFAULT_SPEAKER_CHAT_BURST, 1),
  };
}

/** The brain's command line options: `bun brain/src/main.ts --help` lists them. */
export function parseBrainArgs(args: string[] = process.argv.slice(2)) {
  return parseArgs({
    args,
    options: {
      agent: { type: "string", multiple: true },
      "other-agent": { type: "string", multiple: true },
      "other-agents-file": { type: "string" },
      "chat-model": { type: "string" },
      "action-model": { type: "string" },
      "planner-model": { type: "string" },
      "known-names": { type: "string" },
      "model-slots": { type: "string" },
      "chat-slots": { type: "string" },
      "speaker-chat-per-minute": { type: "string" },
      "speaker-chat-burst": { type: "string" },
      "start-gap": { type: "string" },
      "start-when-free": { type: "boolean" },
      "max-conversations": { type: "string" },
      help: { type: "boolean" },
    },
  });
}

/**
 * The usernames an agent must not answer: the other agents of this process and the `--other-agent` ones, never itself.
 * Names match without case, as the Agent compares them (`agent.ts` `listensTo`); the first spelling given is kept.
 */
export function otherAgentsFor(username: string, inProcess: readonly string[], extra: readonly string[]): string[] {
  const own = username.toLowerCase();
  const seen = new Set<string>([own]);
  return [...inProcess, ...extra].filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
