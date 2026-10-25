import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import type { ArenaFrame } from "../arena/frame.ts";
import { arenaPoint } from "../arena/params.ts";
import type { ScenarioContext } from "../scenario.ts";

const requestSchemaIn = (arena: ArenaFrame) => z.strictObject({
  /** A target far enough that the first navigate is still walking when physics stops. */
  far: arenaPoint(arena),
  /** A target at least five blocks from anywhere the first navigate can have walked to. */
  near: arenaPoint(arena),
  /** Wall-clock time the first navigate walks before physics stops. */
  walkMs: z.number().int().positive(),
  /** Wall-clock time the bot then stands with physics stopped before the cancel. */
  silentMs: z.number().int().nonnegative(),
  /** How long after the cancel the first navigate may take to settle. */
  settleWithinMs: z.number().int().positive(),
});

/** Cancel a walking navigate while no physics tick comes: it must settle within seconds, and the body must walk again after. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { far, near, walkMs, silentMs, settleWithinMs } = requestSchemaIn(context.arena).parse(context.scenario.params);
  const walk = ([x, y, z]: readonly [number, number, number]) => context.call("navigate", { x, y, z, range: 1, dig: false });
  const first = walk(far);
  await delay(walkMs);
  context.physics.pause();
  await delay(silentMs);
  const cancelledAt = performance.now();
  const cancel = await context.call("cancel_foreground_action", { reason: "scenario cancel with physics stopped" });
  const settled = await first;
  const waited = Math.round(performance.now() - cancelledAt);
  context.physics.resume();
  if (settled.result.status !== "cancelled")
    return { status: "failed", detail: `the cancelled navigate read ${settled.result.status}, not cancelled: ${settled.summary}; cancel: ${cancel.summary}` };
  if (waited > settleWithinMs) return { status: "failed", detail: `the navigate settled ${waited} ms after the cancel, over ${settleWithinMs} ms: ${settled.summary}` };
  const next = await walk(near);
  return next.result.status === "succeeded"
    ? { status: "succeeded", detail: `cancelled ${waited} ms after the cancel with physics stopped; then ${next.summary}` }
    : { status: "failed", detail: `the navigate after the cancel read ${next.result.status}: ${next.summary}` };
}
