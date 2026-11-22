import { Vec3 } from "vec3";
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import type { Block } from "prismarine-block";
import type { ArenaFrame } from "../arena/frame.ts";
import { arenaCell, arenaPoint } from "../arena/params.ts";
import type { ScenarioContext } from "../scenario.ts";
import { waitServerTicks } from "./server-ticks.ts";

/**
 * `pocket` is the stalk's feet cell (its head cell is the one above), `target` where `navigate` is asked to go, `dig` whether
 * the request may break blocks. A run that may not dig must fail with the partial-cell sentence and leave the stalk standing.
 */
const paramsIn = (arena: ArenaFrame) => z.strictObject({
  pocket: arenaCell(arena),
  target: arenaPoint(arena),
  dig: z.boolean(),
});

/** Server ticks to stand still before asking: the body settles in the pocket, the chunk and the stalk are in. `waitServerTicks` rounds up to whole 20-tick time packets plus one (`server-ticks.ts`): 20 becomes 40. */
const SETTLE_TICKS = 20;
/** How far from the target the body may end and still have arrived. */
const ARRIVAL_RADIUS = 2.5;
/** The sentence `#leavePartialCell` fails with, whatever follows it. */
const STUCK_SENTENCE = "Standing inside the partial block";

/**
 * A bot inside a bamboo stalk's cell with a stalk or leaves on every side (live 2026-11-10, Ayla, 90 minutes at
 * 344,83,298). With digging allowed `navigate` breaks the stalk cells that hold the body and goes on; without it the call
 * fails at once with the sentence log readers grep. The driver also records when each stalk cell turned to air, in
 * physics ticks since the call: the head cell turning to air within a few ticks of the feet cell is the server breaking
 * the stalk above (bamboo above a broken stalk cannot survive), a gap of 40 ticks or more is the run's own second break.
 */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { pocket, target, dig } = paramsIn(context.arena).parse(context.scenario.params);
  const { bot } = context;
  const cells = [pocket, { ...pocket, y: pocket.y + 1 }] as const;
  // Counted physics ticks, not `bot.time.age`: the world age arrives once a second, too coarse to time a one-tick break.
  let ticks = 0;
  const airTick: (number | null)[] = [null, null];
  const onTick = () => void (ticks += 1);
  const onUpdate = (_old: Block | null, block: Block) => {
    if (block.name !== "air") return;
    cells.forEach((cell, index) => {
      if (airTick[index] === null && block.position.x === cell.x && block.position.y === cell.y && block.position.z === cell.z)
        airTick[index] = ticks;
    });
  };
  if ((await waitServerTicks(bot, SETTLE_TICKS)) === "stalled") return { status: "failed", detail: "[FIXTURE] the world age stood still while the bot settled in the pocket" };
  const start = bot.entity.position;
  if (Math.floor(start.x) !== pocket.x || Math.floor(start.y) !== pocket.y || Math.floor(start.z) !== pocket.z)
    return { status: "failed", detail: `the bot is not inside the pocket cell ${pocket.x},${pocket.y},${pocket.z}: at ${start.x},${start.y},${start.z}` };
  const nameAt = (cell: { x: number; y: number; z: number }) => bot.blockAt(new Vec3(cell.x, cell.y, cell.z))?.name;
  const standing = cells.map(nameAt);
  if (standing.some((name) => name !== "bamboo")) return { status: "failed", detail: `the pocket is not a two-high stalk: ${standing.join(",")}` };

  bot.on("physicsTick", onTick);
  bot.on("blockUpdate", onUpdate);
  const call = await context.call("navigate", { x: target[0], y: target[1], z: target[2], range: 1, dig });
  bot.off("blockUpdate", onUpdate);
  bot.off("physicsTick", onTick);
  const [feetAir, headAir] = airTick;
  const timeline = `feet cell air at physics tick ${feetAir}, head cell at ${headAir}${feetAir !== null && headAir !== null ? ` (+${headAir - feetAir} ticks)` : ""}`;
  const feet = { name: nameAt(pocket) };

  if (!dig) {
    const error = "error" in call.result ? call.result.error : "";
    if (call.result.status !== "failed" || !error.includes(STUCK_SENTENCE))
      return { status: "failed", detail: `a run that may not dig must fail with "${STUCK_SENTENCE}": ${call.summary}` };
    return feet.name === "bamboo"
      ? { status: "succeeded", detail: `${call.summary}; the stalk is still standing` }
      : { status: "failed", detail: `the run broke the stalk although it may not dig: ${timeline}` };
  }
  if (call.result.status !== "succeeded") return { status: "failed", detail: `navigate from the pocket: ${call.summary}; ${timeline}` };
  const end = bot.entity.position;
  const away = Math.hypot(end.x - (target[0] + 0.5), end.z - (target[2] + 0.5));
  if (away > ARRIVAL_RADIUS) return { status: "failed", detail: `ended ${away.toFixed(1)} blocks from the target: ${call.summary}` };
  if (feet.name === "bamboo")
    return { status: "failed", detail: `the stalk cell was not broken: ${timeline}` };
  return { status: "succeeded", detail: `${call.summary}; ${timeline}` };
}
