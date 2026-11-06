import { setTimeout as delay } from "node:timers/promises";
import { Vec3 } from "vec3";
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { arenaActionInput, type ArenaFrame } from "../arena/frame.ts";
import { arenaPoint } from "../arena/params.ts";
import type { ScenarioContext } from "../scenario.ts";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import { observeDeaths } from "./deaths.ts";

const paramsIn = (arena: ArenaFrame) => z.strictObject({
  action: z.string().trim().min(1),
  input: z.record(z.string(), z.unknown()),
  /** The kill comes this many wall-clock ms after the action starts (a long walk is still walking) ... */
  killAfterMs: z.number().int().positive().optional(),
  /** ... or as soon as this cell first reads empty (a dig has just broken it: the miner is waiting for its drops or the sand above). */
  killWhenCellEmpty: arenaPoint(arena).optional(),
  /** How long after the kill the action may take to settle. */
  settleWithinMs: z.number().int().positive(),
  /** How long after the kill the actor may take to respawn. */
  respawnWithinMs: z.number().int().positive(),
  /** How far east of its respawn point the next navigate walks. */
  nextStepBlocks: z.number().int().positive(),
}).refine((params) => (params.killAfterMs === undefined) !== (params.killWhenCellEmpty === undefined), "give exactly one of killAfterMs and killWhenCellEmpty");

const KILL = "/kill";
const POLL_MS = 20;
const KILL_TRIGGER_WITHIN_MS = 20_000;
/** Mineflayer's own message when a tick wait gets no tick for `ticks * 50 + 5000` ms (`physics.js:462`): a cancel must not end with it. */
const TICK_TIMEOUT = /Timeout waiting for \d+ ticks/u;

/** Kill the actor in the middle of an action: it settles cancelled within its bound (not with a tick timeout), and the next navigate after the respawn arrives. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const params = paramsIn(context.arena).parse(context.scenario.params);
  const { settleWithinMs, respawnWithinMs, nextStepBlocks } = params;
  const seen = observeDeaths(context.bot);
  try {
    const first = context.call(params.action, arenaActionInput(params.input, context.arena));
    if (params.killAfterMs !== undefined) await delay(params.killAfterMs);
    else if (!(await cellEmptied(context, params.killWhenCellEmpty!)))
      return { status: "failed", detail: `the cell ${params.killWhenCellEmpty!.join(",")} was not emptied within ${KILL_TRIGGER_WITHIN_MS} ms, so the kill never came` };
    const killedAt = monotonicNow();
    context.bot.chat(KILL);
    const settled = await first;
    const waited = Math.round(monotonicNow() - killedAt);
    if (settled.result.status !== "cancelled")
      return { status: "failed", detail: `${params.action} killed mid-way read ${settled.result.status}, not cancelled: ${settled.summary}` };
    if (TICK_TIMEOUT.test(settled.summary)) return { status: "failed", detail: `the cancel ended with Mineflayer's tick timeout, not the death: ${settled.summary}` };
    if (waited > settleWithinMs) return { status: "failed", detail: `${params.action} settled ${waited} ms after the kill, over ${settleWithinMs} ms: ${settled.summary}` };

    while (monotonicNow() - killedAt < respawnWithinMs && seen.respawns.length === 0) await delay(POLL_MS);
    if (seen.deaths.length !== 1 || seen.respawns.length !== 1)
      return { status: "failed", detail: `wanted one death and one respawn within ${respawnWithinMs} ms of the kill, read ${seen.deaths.length} and ${seen.respawns.length} (is the actor op?)` };

    const { x, y, z } = context.bot.entity.position;
    const next = await context.call("navigate", { x: Math.floor(x) + nextStepBlocks, y: Math.floor(y), z: Math.floor(z), range: 1, dig: false });
    return next.result.status === "succeeded"
      ? { status: "succeeded", detail: `cancelled ${waited} ms after the kill (${settled.summary}); then ${next.summary}` }
      : { status: "failed", detail: `the navigate after the respawn read ${next.result.status}: ${next.summary}` };
  } finally {
    seen.dispose();
  }
}

/** True once the block at `point` first reads empty (no collision box), polled on the wall clock. */
async function cellEmptied(context: ScenarioContext, point: readonly [number, number, number]): Promise<boolean> {
  const cell = new Vec3(point[0], point[1], point[2]);
  const startedAt = monotonicNow();
  while (monotonicNow() - startedAt < KILL_TRIGGER_WITHIN_MS) {
    if (context.bot.blockAt(cell)?.boundingBox === "empty") return true;
    await delay(POLL_MS);
  }
  return false;
}
