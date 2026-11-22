// A blaze held above melee reach by its NoGravity flag: the hunt must wait under its shield and finish once it comes down.
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { huntMobResultSchema } from "../../../src/actions/hunt-mob/contract.ts";
import { arenaActionInput } from "../arena/frame.ts";
import { arenaPoint } from "../arena/params.ts";
import type { ScenarioContext } from "../scenario.ts";
import { waitServerTicks } from "./server-ticks.ts";

/** Server ticks the probe blaze may take to appear after its summon (a time packet's margin and the spawn packet). */
const APPEAR_TICKS = 200;
/** The probe is found at its summon within this many blocks: the bot stands beside it when it is summoned. */
const SUMMON_NEAR_BLOCKS = 8;
/** The hunt walks the bot off during its hold (up to 13 blocks in a trial): the probe is tracked to the hunt's own 32-block search radius. */
const TRACK_BLOCKS = 32;
/** Server ticks asked for each one-block descent step after the release (waitServerTicks pads it to 40). */
const DESCENT_STEP_TICKS = 5;
/** A probe above the bot's feet by more than this is held above the bot, not on its level (the fixture's blaze hovers 5 above). */
const ABOVE_BLOCKS = 3;

/** Start the real hunt, hold the blaze above reach for `heldTicks`, release it and read the hunt's own result. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const { blaze, mob_name, drop_name, count, heldTicks, settleTicks } = z.strictObject({
    blaze: arenaPoint(context.arena),
    mob_name: z.string().min(1),
    drop_name: z.string().min(1),
    count: z.number().int().positive(),
    heldTicks: z.number().int().positive(),
    settleTicks: z.number().int().positive(),
  }).parse(context.scenario.params);

  const probeAbove = (withinBlocks: number) => Object.values(bot.entities).some((entity) =>
    entity.name === "blaze" &&
    entity.position.y > bot.entity.position.y + ABOVE_BLOCKS &&
    entity.position.distanceTo(bot.entity.position) < withinBlocks);

  bot.chat(`/summon minecraft:blaze ${blaze.join(" ")} {NoAI:1b,NoGravity:1b,PersistenceRequired:1b,Tags:["hovering_probe"]}`);
  const appeared = await waitServerTicks(bot, APPEAR_TICKS, { until: () => probeAbove(SUMMON_NEAR_BLOCKS) });
  if (appeared !== "until") return { status: "failed", detail: JSON.stringify({ status: "no_probe", clock: appeared }) };

  const startAge = bot.time.age;
  const outcome = context.call("collect_mob_drop", arenaActionInput({ mob_name, drop_name, count }, context.arena));
  let settled = false;
  // The result is read below; this handler keeps a failed call from reaching the runtime as an unhandled rejection meanwhile.
  outcome.then(() => { settled = true; }, () => { settled = true; });

  const held = await waitServerTicks(bot, heldTicks);
  const heldFor = bot.time.age - startAge;
  const settledBeforeRelease = settled;
  if (!settledBeforeRelease) {
    if (held !== "moved") return failure({ heldTicks: heldFor, settledBeforeRelease, status: "held", clock: held });
    if (!probeAbove(TRACK_BLOCKS)) {
      const blazes = Object.values(bot.entities).filter((entity) => entity.name === "blaze").map((entity) => entity.position.toArray());
      return failure({ heldTicks: heldFor, settledBeforeRelease, status: "probe_left", clock: held, bot: bot.entity.position.toArray(), blazes });
    }
    bot.chat('/data merge entity @e[tag=hovering_probe,limit=1,sort=nearest] {NoGravity:0b}');
    // The release alone left the NoAI blaze at its summon height in the green runs (5.1 blocks at the trial's end): the
    // driver lowers it one block per step to the bot's feet. A step is one waitServerTicks of 5 (40 ticks with its margin).
    const feetY = Math.floor(bot.entity.position.y);
    for (let y = blaze[1] - 1; y >= feetY && !settled; y -= 1) {
      bot.chat(`/tp @e[tag=hovering_probe,limit=1,sort=nearest] ${blaze[0]} ${y} ${blaze[2]}`);
      await waitServerTicks(bot, DESCENT_STEP_TICKS, { until: () => settled });
    }
    const released = await waitServerTicks(bot, settleTicks, { until: () => settled });
    if (released !== "until") return failure({ heldTicks: heldFor, settledBeforeRelease, status: "pending", clock: released });
  }

  const output = await outcome;
  const hunted = huntMobResultSchema.safeParse(output.result);
  const gained = hunted.success ? hunted.data.hunt.gained : 0;
  const deaths = hunted.success ? hunted.data.hunt.targetDeathsObserved : 0;
  const handoff = hunted.success ? hunted.data.handoff.kind : "none";
  const termination = hunted.success ? hunted.data.termination : "none";
  const error = output.result.status === "succeeded" ? undefined : output.result.error;
  // The rod count is reported, not asserted: one kill's drop is random (master 2026-11-22; six kills gave none).
  const detail = { heldTicks: heldFor, settledBeforeRelease, status: output.result.status, gained, deaths, handoff, termination, error };
  // Success: the blaze came down and the hunt killed it under a safe handoff, without an approach stop. A call that settled
  // while the blaze hovered is no wait under the shield: it fails here, with its error in the detail.
  const approachStopped = termination === "targets_unreachable" || (error ?? "").includes("HUNT_APPROACH_STOPPED");
  return !settledBeforeRelease && deaths >= 1 && handoff === "safe" && !approachStopped
    ? { status: "succeeded", detail: JSON.stringify(detail) }
    : failure(detail);
}

function failure(detail: Record<string, unknown>): ClientCompletion {
  return { status: "failed", detail: JSON.stringify(detail) };
}
