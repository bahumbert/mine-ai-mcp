import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import type { ScenarioContext } from "../scenario.ts";
import { observeDeaths } from "./deaths.ts";

const paramsSchema = z.strictObject({ withinSeconds: z.number().positive() });
const POLL_MS = 250;
/** Instant damage at amplifier 5 kills at full health (shown by this scenario's live passes; the damage formula is not cited). */
const KILLING_EFFECT = "/effect give @s minecraft:instant_damage 1 5";

/** The server kills the actor; the death reader sees exactly one death and the respawn after it, in the bound. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { withinSeconds } = paramsSchema.parse(context.scenario.params);
  const seen = observeDeaths(context.bot);
  try {
    await context.waitForTicks(10);
    const sentAt = monotonicNow();
    context.bot.chat(KILLING_EFFECT);
    while (monotonicNow() - sentAt < withinSeconds * 1000 && seen.respawns.length === 0) await sleep(POLL_MS);
    const read = `${seen.deaths.length} death(s) ${JSON.stringify(seen.deaths)}, ${seen.respawns.length} respawn(s) ${JSON.stringify(seen.respawns)}`;
    if (seen.deaths.length !== 1 || seen.respawns.length !== 1) return { status: "failed", detail: `wanted one death and one respawn within ${withinSeconds} s, read ${read} (none read: check that the actor is op and the effect command was not refused)` };
    const respawnMs = Math.round(seen.respawns[0]!.atMs - sentAt);
    return { status: "succeeded", detail: `${read}; respawned ${respawnMs} ms after the effect was sent` };
  } finally {
    seen.dispose();
  }
}
