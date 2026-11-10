// Measure the first seated hostile response and verify the next navigate from its retained boat.
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { arenaCell } from "../arena/params.ts";
import type { ScenarioContext } from "../scenario.ts";
import { boatNamed, carriedBoats } from "./boat-state.ts";

/** Watch the actual hostile takeover, including every sampled seat, rather than just a successful route. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { approach, target, atSea, responseWithinMs, offWithinMs } = z.object({
    approach: arenaCell(context.arena), target: arenaCell(context.arena), atSea: z.boolean(),
    responseWithinMs: z.number().positive(),
    offWithinMs: z.number().positive().optional(),
  }).parse(context.scenario.params);
  const { bot } = context;
  let hurtAt = 0, effectAt = 0, offAt = 0, attacker: number | undefined;
  let boatId: number | undefined;
  let atHurt = bot.entity.position.clone();
  let broken: string | null = null;
  let attackerDied = false;
  let sawSeat = false;
  let stopOnDeath: ReturnType<ScenarioContext["call"]> | undefined;
  const onMount = () => { sawSeat = true; boatId ??= bot.entity.vehicle?.id; };
  const onDead = (entity: typeof bot.entity) => {
    if (entity.id !== attacker) return;
    attackerDied = true;
    // The suspended approach can resume and dismount before the next sample (T17e t00044, 2026-11-10).
    if (atSea) stopOnDeath = context.call("cancel_foreground_action", { reason: "scenario observed the hostile response" });
  };
  const onHurt = (entity: typeof bot.entity, source?: typeof bot.entity) => {
    if (entity.id === bot.entity.id && !hurtAt) {
      hurtAt = performance.now();
      attacker = source?.id;
      boatId = bot.entity.vehicle?.id;
      sawSeat ||= boatNamed(bot.entity.vehicle?.name);
      atHurt = bot.entity.position.clone();
      if (atSea && (!boatNamed(bot.entity.vehicle?.name) || boatId === undefined)) broken = "the first hurt was not seated";
    } else if (hurtAt && entity.id === attacker) effectAt ||= performance.now();
  };
  // Capture the seat before the reflex's hurt listener can synchronously start its near-shore get-off.
  bot.prependListener("entityHurt", onHurt);
  bot.on("entityDead", onDead);
  bot.on("mount", onMount);
  const first = context.call("navigate", { ...approach, range: 1 });
  try {
    const started = performance.now();
    while (performance.now() - started < 60_000) {
      if (hurtAt) {
        const seat = bot.entity.vehicle;
        if (!seat) offAt ||= performance.now();
        if (atSea && (!boatNamed(seat?.name) || boatId === undefined || seat?.id !== boatId))
          broken ||= "the boat was lost during the seated response";
        if (atSea && bot.entity.position.distanceTo(atHurt) > 2) effectAt ||= performance.now();
        if (effectAt && attackerDied && (atSea || (offAt && carriedBoats(bot) > 0))) break;
        if ((!effectAt || (!atSea && !offAt)) && performance.now() - hurtAt > responseWithinMs) break;
      }
      await delay(20);
    }
    const elapsed = effectAt ? Math.round(effectAt - hurtAt) : null;
    const offMs = offAt ? Math.round(offAt - hurtAt) : null;
    if (!hurtAt || !effectAt || !attackerDied || !sawSeat || broken || elapsed! > responseWithinMs ||
      (!atSea && (!offAt || offMs! > (offWithinMs ?? responseWithinMs) || !carriedBoats(bot))))
      return { status: "failed", detail: JSON.stringify({ hurtAt, elapsed, offMs, broken, seated: bot.entity.vehicle?.id, carried: carriedBoats(bot) }) };
    await (stopOnDeath ?? context.call("cancel_foreground_action", { reason: "scenario observed the hostile response" }));
    await first;
    const next = await context.call("navigate", { ...target, range: 2 });
    return { status: next.result.status === "succeeded" ? "succeeded" : "failed",
      detail: `hurt-to-effect ${elapsed} ms; hurt-to-off ${offMs} ms; next: ${next.summary}` };
  } finally {
    bot.off("entityHurt", onHurt);
    bot.off("entityDead", onDead);
    bot.off("mount", onMount);
    await context.call("cancel_foreground_action", { reason: "scenario cleanup" });
    await first;
  }
}
