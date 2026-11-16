/**
 * What the combat-data checks share (`combat-data-mobs`, `combat-data-items-*`): reading numbers the server keeps through
 * commands. Mine Labs runs with `sendCommandFeedback false` (measured 2026-10-24, `subject.ts` `createGameTimeQueries`), so a
 * command's answer is never sent: each read stores its success and its result in command storage (`execute store`) and
 * one `tellraw` prints the whole batch, which is not command feedback. The server runs the commands in the order sent.
 * A missing attribute or NBT key is a stored success of 0 (`present: false`), never English text read from a reply
 * (measured 2026-11-07, 1.21.4: `attribute @s flying_speed base get` on a zombie and `data get entity ... ExplosionRadius` on a zombie).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { CombatDataFile, MeasuredPart } from "../../../../src/world/combat-data-file.ts";
import type { ContractSubject } from "../subject.ts";
import { SERVER_ANSWER_TICKS, SERVER_CLOCK_STOPPED_MS, STALE_AGE_TICKS, waitForWorldAge } from "../../../../src/world/world-age.ts";

/** The command storage the reads go through; a key per bot and per read, so lanes never read each other's. */
const STORAGE = "mine_ai:cm";
/** The line a batch prints: this text, a batch number, then `<present> <value>` for each read. */
const LINE = "combat-measure ";
/**
 * An attribute is read multiplied by this (`attribute ... get <scale>`) and divided back: the command returns an integer
 * and cuts the rest (measured 2026-11-07: `attack_speed` 1.6 read at scale 1000 came back 1599, at 100000 it keeps 1.599999...).
 * The largest attribute (a mob's 500 health) times this stays inside the integer the command returns.
 */
export const ATTRIBUTE_SCALE = 100_000;
const ATTRIBUTE_DIGITS = 4;

/** What one read found. `raw` is the integer the command returned (0 when not present). */
export interface Reading {
  readonly present: boolean;
  readonly raw: number;
}

/** A command that answers a number: its text after `execute store ... ` (`run attribute ...`, `run data get entity ...`, or `if entity ...`). */
export type ReadCommand = string;

/** The attribute a reading returned at `ATTRIBUTE_SCALE`, to four decimals (the game's numbers have at most that many); null when the attribute is missing. */
export function attributeOf(reading: Reading): number | null {
  return reading.present ? Number((reading.raw / ATTRIBUTE_SCALE).toFixed(ATTRIBUTE_DIGITS)) : null;
}

/** The text of `attribute <target> <id> base get` or `get`, scaled; `base` leaves out equipment and effects. */
export function attributeCommand(target: string, attribute: string, which: "base" | "total"): ReadCommand {
  return `run attribute ${target} ${attribute} ${which === "base" ? "base " : ""}get ${ATTRIBUTE_SCALE}`;
}

/** The shipped file of the server's version, or null when none is written yet (the first measurement). */
export function shippedCombatData(version: string): CombatDataFile | null {
  const file = new URL(`../../../../src/world/data/combat-data/${version}.json`, import.meta.url);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as CombatDataFile) : null;
}

/**
 * Fails the check with what was measured, on one `MEASURED <json>` line: `src/world/combat-data-write.ts` reads that line from the
 * run's log, so the shipped file is rewritten from a failing run (a new server version, a changed number) with no other tool.
 */
export function failWithMeasured(measured: MeasuredPart, differences: readonly string[]): never {
  assert.fail(`${differences.length === 0 ? "no shipped file" : `shipped file differs: ${differences.join("; ")}`}. MEASURED ${JSON.stringify(measured)}`);
}

/** Reads batches of commands on a real server; one batch at a time. */
export interface MeasureReader {
  /** Runs every command in order; waits on server age and fails on a missing reply or a stopped clock. */
  read(commands: readonly ReadCommand[]): Promise<Reading[]>;
  /** Sends a command that answers nothing we read (a summon, an item replace); it keeps its order with the reads. */
  send(command: string): void;
}

/** Await an answer for the stated observed-age budget, with an independent stopped-clock bound. */
export async function waitForCommandReply(bot: Pick<ContractSubject["bot"], "time">, arrived: () => boolean,
  options: { observedTicks: number; stallMs: number; now?: () => number; sleep?: (ms: number) => Promise<void> }): Promise<void> {
  const result = await waitForWorldAge(bot, options.observedTicks, { wallMs: Infinity, stallMs: options.stallMs,
    until: arrived, now: options.now, sleep: options.sleep });
  if (result !== "until") throw new Error(result === "stalled" ? "server stalled" : "reply missing");
}

export function createMeasureReader(subject: Pick<ContractSubject, "bot">, timing?: { responseWithinTicks: number; stallMs: number }): MeasureReader {
  const { bot } = subject;
  let batch = 0;
  const readBatch = async (number: number, commands: readonly ReadCommand[]): Promise<Reading[]> => {
    const prefix = `${LINE}${number} `;
    let answer: string | undefined;
    const onMessage = (text: string) => {
      if (text.startsWith(prefix)) answer = text.slice(prefix.length);
    };
    bot.on("messagestr", onMessage as never);
    try {
      // Keys carry the bot's name: lanes share the server, and their commands interleave between a store and its tellraw.
      const key = (kind: "p" | "v", index: number) => `${kind}${index}_${bot.username}`;
      const extra = commands.flatMap((_, index) => [{ nbt: key("p", index), storage: STORAGE }, { text: " " }, { nbt: key("v", index), storage: STORAGE }, { text: " " }]);
      commands.forEach((command, index) => {
        bot.chat(`/execute store success storage ${STORAGE} ${key("p", index)} int 1 store result storage ${STORAGE} ${key("v", index)} int 1 ${command}`);
      });
      bot.chat(`/tellraw @s ${JSON.stringify({ text: prefix, extra })}`);
      await waitForCommandReply(bot, () => answer !== undefined, {
        observedTicks: timing ? timing.responseWithinTicks + STALE_AGE_TICKS : SERVER_ANSWER_TICKS,
        stallMs: timing?.stallMs ?? SERVER_CLOCK_STOPPED_MS,
      });
      const numbers = answer!.trim().split(/\s+/).map(Number);
      if (numbers.length !== commands.length * 2 || numbers.some((value) => !Number.isFinite(value))) throw new Error(`measure batch ${number}: malformed reply ${answer}`);
      return commands.map((_, index) => ({ present: numbers[2 * index] === 1, raw: numbers[2 * index + 1]! }));
    } finally {
      bot.off("messagestr", onMessage as never);
    }
  };
  return {
    send: (command) => void bot.chat(`/${command}`),
    read: (commands) => readBatch((batch += 1), commands),
  };
}

/** The ticks the server has run: `subject.serverGameTime()` until it moved `ticks` past `since` (each ask is a round trip, a fraction of a tick). */
export async function afterGameTicks(subject: ContractSubject, since: number, ticks: number): Promise<void> {
  while ((await subject.serverGameTime()) < since + ticks) {
    /* each ask is a round trip to the server: the loop ends when the server's own clock moved */
  }
}
