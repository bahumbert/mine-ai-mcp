import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Bot } from "mineflayer";
import { z } from "zod";
import { huntCheckpointSchema } from "../../../src/actions/checkpoint-schemas.ts";
import { declareProductiveProgress } from "../../../tests/minecraft/drivers/productive-progress.ts";
import { waitServerTicks } from "../../../tests/minecraft/drivers/server-ticks.ts";
import { declareFortressProgress, runFortressHunt } from "../../default/nether/fortress-twelve-rods.ts";
import { openRuntime, type Runtime } from "../../src/runtime.ts";
import { recordSourceIdentity } from "../../src/source-identity.ts";
import type { MineAiScenario, MineAiScenarioContext } from "../../src/scenario-client.ts";
import { hurt, readEncounters } from "./reflex.ts";

/** The day time at which the sky turns dark and, a night later, the first time packet below it is dawn. */
const NIGHTFALL_TIME = 13_000;
/** `/time set 13000` is read back within this many ticks of day time: later packets are the night itself running. */
const NIGHTFALL_WINDOW = 100;
const NIGHTFALL_WAIT_TICKS = 400;
/** The native night is 11,000 ticks (13,000 to 24,000); client physics may skip, the world age is the count. */
export const MINIMUM_NIGHT_TICKS = 10_800;
/** One look of the night watch, and the log line it writes. */
const LOOK_TICKS = 1_200;

const settlementSchema = z.object({
  status: z.string(),
  termination: z.string().optional(),
  handoff: z.object({ kind: z.string() }).optional(),
});

/** What the night showed, in server ticks after the request was armed (`null`: it never happened). */
export interface NightSample {
  readonly died: boolean;
  /** How many times the request returned to the caller. */
  readonly handoffs: number;
  readonly dawnTicks: number | null;
  readonly settledTicks: number | null;
  readonly worldTicks: number;
  readonly settled: { readonly status: string; readonly termination?: string | undefined; readonly handoffKind?: string | undefined } | null;
  /** The request's whole returned output, kept as evidence (`undefined`: it never returned). */
  readonly output?: unknown;
}

export interface NightWatchInput {
  readonly runtime: Pick<Runtime, "status" | "actions" | "asyncActions">;
  readonly bot: Bot;
  readonly context: Pick<MineAiScenarioContext, "signal" | "progress" | "log">;
  readonly request: Parameters<typeof runFortressHunt>[2];
  /** Frees the mob ring; called once the request is submitted and every latch is armed. */
  readonly release: () => void;
}

/** How the night request ended for its caller: the returned output, or the error it threw. */
type Returned = { readonly output: Awaited<ReturnType<typeof runFortressHunt>> } | { readonly error: unknown };

/** The sample's request fields: one handoff and its readable result when the request returned, none otherwise. */
function readReturn(final: Returned | null): Pick<NightSample, "handoffs" | "settled" | "output"> {
  if (!final || !("output" in final)) return { handoffs: 0, settled: null };
  const answer = settlementSchema.safeParse(final.output.result);
  return {
    handoffs: 1,
    output: final.output,
    settled: answer.success
      ? { status: answer.data.status, termination: answer.data.termination, handoffKind: answer.data.handoff?.kind }
      : null,
  };
}

/** A reflex owns the body for the request this driver submitted, which is still admitted (D34). */
function reflexHoldsRequest(runtime: Pick<Runtime, "status">): boolean {
  const { busy, owner, foreground } = runtime.status();
  return busy && foreground.active !== null && (owner === "takeover" || owner === "yielding");
}

function huntPhase(runtime: Pick<Runtime, "status">): string | null {
  const checkpoint = huntCheckpointSchema.safeParse(runtime.status().foreground.active?.request?.evidence?.checkpoint);
  return checkpoint.success ? checkpoint.data.phase : null;
}

/** Send the dusk command and see its time packet: a packet newer than the send with the dusk day time. */
export async function awaitNightfall(bot: Bot, send: () => void, signal: AbortSignal): Promise<void> {
  const sentAge = bot.time.age;
  send();
  const dusk = () => {
    const { age, timeOfDay } = bot.time;
    return age > sentAge && timeOfDay >= NIGHTFALL_TIME && timeOfDay < NIGHTFALL_TIME + NIGHTFALL_WINDOW;
  };
  const ended = await waitServerTicks(bot, NIGHTFALL_WAIT_TICKS, { signal, until: dusk });
  if (ended === "stalled") throw new Error("The server clock stood still before nightfall was observed.");
  if (!dusk()) throw new Error(`Did not observe nightfall within ${NIGHTFALL_WAIT_TICKS} server ticks`);
}

/** Wait in looks of `LOOK_TICKS` server ticks until `done()` holds (at once when it does), calling `look` after each. */
async function lookEvery(bot: Bot, signal: AbortSignal, done: () => boolean, when: string, look: () => void = () => {}) {
  while (!done()) {
    if ((await waitServerTicks(bot, LOOK_TICKS, { signal, until: done })) === "stalled")
      throw new Error(`The server clock stood still ${when} (stalled).`);
    look();
  }
}

/**
 * Hold the night request from its release to dawn and its settlement, declaring the night's protected stillness.
 *
 * The request goes through the async-action path so its checkpoint is readable. Progress is declared (D10, D34) only
 * while the hunt's own observation phase runs, or while a reflex owns the body for the admitted request, and stops at
 * dawn, settlement or death. The loop ends at dawn, a settlement or a death; after dawn the settlement is awaited.
 */
export async function watchNight({ runtime, bot, context, request, release }: NightWatchInput): Promise<NightSample> {
  const { signal, progress: publish, log } = context;
  const stop = new AbortController();
  let open = true;
  let died = false;
  let dawnAge: number | null = null;
  let settledAge: number | null = null;
  const returned: { outcome: Returned | null } = { outcome: null };
  const declare = (reason: string) => {
    if (open) publish(reason);
  };
  const startingAge = bot.time.age;
  const sinceStart = (age: number | null) => (age === null ? null : age - startingAge);
  // First listener on the bot: dawn closes the declarations before any window hears the same packet.
  const onTime = () => {
    if (dawnAge !== null || bot.time.timeOfDay >= NIGHTFALL_TIME) return;
    dawnAge = bot.time.age;
    open = false;
  };
  const onDeath = () => {
    died = true;
    open = false;
  };
  bot.on("time", onTime);
  bot.on("death", onDeath);
  using hunt = declareFortressProgress(runtime.asyncActions, bot, declare, signal);
  using reflex = declareProductiveProgress(bot, (reason) => {
    if (reason === "observing" && reflexHoldsRequest(runtime)) declare(reason);
  }, signal);
  const settle = (outcome: Returned) => {
    settledAge = bot.time.age;
    open = false;
    returned.outcome = outcome;
  };
  const settlement = runFortressHunt(runtime, bot, request, hunt, AbortSignal.any([signal, stop.signal])).then(
    (output) => settle({ output }),
    (error: unknown) => settle({ error }),
  );
  try {
    reflex.observing(true);
    release();
    await lookEvery(bot, signal, () => dawnAge !== null || settledAge !== null || died, "during the night", () => log(JSON.stringify({
      worldTicks: bot.time.age - startingAge, time: bot.time.timeOfDay, health: bot.health,
      handoffs: returned.outcome && "output" in returned.outcome ? 1 : 0, owner: runtime.status().owner, phase: huntPhase(runtime),
    })));
    await lookEvery(bot, signal, () => settledAge !== null || died, "after dawn");
    const final = returned.outcome;
    if (final && "error" in final && !died) throw final.error;
    return {
      died,
      dawnTicks: sinceStart(dawnAge),
      settledTicks: sinceStart(settledAge),
      worldTicks: bot.time.age - startingAge,
      ...readReturn(final),
    };
  } finally {
    open = false;
    bot.off("time", onTime);
    bot.off("death", onDeath);
    stop.abort(new Error("The night watch ended."));
    await settlement;
  }
}

/** The verdict of one night: `null` when it passes, else why it does not. */
export function judgeNight(sample: NightSample): string | null {
  const { died, handoffs, dawnTicks, settledTicks, worldTicks, settled } = sample;
  if (died) return "The bot died during the night.";
  if (handoffs !== 1) return `Exactly one request must return to the caller; ${handoffs} did.`;
  if (settledTicks !== null && dawnTicks === null)
    return `The collection returned before dawn: dawn was never observed (settled +${settledTicks} ticks).`;
  if (dawnTicks === null) return "Dawn was never observed.";
  if (settledTicks !== null && settledTicks < dawnTicks)
    return `The collection returned before dawn (settled +${settledTicks} ticks, dawn +${dawnTicks}).`;
  if (settled === null) return "The collection returned a result the night driver could not read.";
  if (settled.termination !== "observation_exhausted")
    return `The collection ended ${settled.status}/${settled.termination}, not observation_exhausted.`;
  if (settled.handoffKind !== "safe") return `The collection did not end with a safe handoff (${settled.handoffKind}).`;
  if (worldTicks < MINIMUM_NIGHT_TICKS)
    return `Only ${worldTicks} server ticks passed; the night needs ${MINIMUM_NIGHT_TICKS.toLocaleString("en-US")}.`;
  return null;
}

/** One real request remains subject to normal survival policy for an entire native night. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  await recordSourceIdentity();
  assert.ok(await hurt(context, 7), "The night starts at seven observed health.");
  await awaitNightfall(bot, () => bot.chat("/time set 13000"), signal);
  await using runtime = await openRuntime(context, "full-night-request");
  let minimumHealth = bot.health;
  const health = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
  };
  bot.on("health", health);
  try {
    // There are no cows. The declared 550-second observation covers 11,000 night ticks, read as game time at 20
    // ticks a second (D32): the request must still be pending at the dawn packet.
    const sample = await watchNight({
      runtime, bot, context,
      request: { mob_name: "cow", drop_name: "leather", count: 1, observe_for_ms: 550_000 },
      release: () => bot.chat("/execute as @e[tag=night_ring] run data merge entity @s {NoAI:0b}"),
    });
    const encounters = await readEncounters(context, runtime);
    const evidence = { ...sample, minimumHealth, dawn: bot.time.timeOfDay, encounters };
    await writeFile(path.join(process.env.MINE_LABS_ARTIFACTS_DIR!, "full-night-request.json"), JSON.stringify(evidence, null, 2));
    context.log(`NIGHT ${JSON.stringify({ settledAfterStart: sample.settledTicks, dawnAfterStart: sample.dawnTicks })}`);
    const failure = judgeNight(sample);
    if (failure !== null) assert.fail(failure);
    return { status: "succeeded", detail: JSON.stringify(evidence) };
  } finally {
    bot.off("health", health);
  }
};
