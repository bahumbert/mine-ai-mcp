// Measure the first seated hostile response and verify the next navigate from its retained boat.
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import { arenaCell } from "../arena/params.ts";
import type { ScenarioContext } from "../scenario.ts";
import { boatNamed, carriedBoats } from "./boat-state.ts";
import { waitForWorldAge } from "../../../src/world/world-age.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "./server-ticks.ts";

interface HostileResponse {
  hurtAt: number | null;
  effectAt: number | null;
  offAt: number | null;
  attacker?: number;
  boatId?: number;
  atHurt: ScenarioContext["bot"]["entity"]["position"];
  broken: string | null;
  attackerDied: boolean;
  sawSeat: boolean;
}

/** Sample every seat as before, while budgets and the outer observation window follow the server's clock. */
async function sampleResponse(context: ScenarioContext, response: HostileResponse, atSea: boolean, responseWithinTicks: number) {
  const { bot } = context;
  // The former 60 s observation window is 1200 ticks; add one packet as waitServerTicks does for a stale starting age.
  return waitForWorldAge(bot, 1_220, {
    wallMs: Number.POSITIVE_INFINITY, stallMs: DRIVER_CLOCK_STOPPED_MS, pollMs: 20,
    until: () => {
      if (response.hurtAt === null) return false;
      const seat = bot.entity.vehicle;
      if (!seat) response.offAt ??= bot.time.age;
      if (atSea && (!boatNamed(seat?.name) || response.boatId === undefined || seat?.id !== response.boatId))
        response.broken ??= "the boat was lost during the seated response";
      if (atSea && bot.entity.position.distanceTo(response.atHurt) > 2) response.effectAt ??= bot.time.age;
      return (response.effectAt !== null && response.attackerDied && (atSea || (response.offAt !== null && carriedBoats(bot) > 0))) ||
        ((response.effectAt === null || (!atSea && response.offAt === null)) && bot.time.age - response.hurtAt > responseWithinTicks);
    },
  });
}

/** Watch the actual hostile takeover, including every sampled seat, rather than just a successful route. */
export async function run(context: ScenarioContext): Promise<ClientCompletion> {
  const { approach, target, atSea, responseWithinTicks, offWithinTicks } = z.strictObject({
    approach: arenaCell(context.arena), target: arenaCell(context.arena), atSea: z.boolean(),
    responseWithinTicks: z.number().int().positive(),
    offWithinTicks: z.number().int().positive().optional(),
  }).parse(context.scenario.params);
  const { bot } = context;
  const response: HostileResponse = { hurtAt: null, effectAt: null, offAt: null,
    atHurt: bot.entity.position.clone(), broken: null, attackerDied: false, sawSeat: false };
  let stopOnDeath: ReturnType<ScenarioContext["call"]> | undefined;
  const onMount = () => { response.sawSeat = true; response.boatId ??= bot.entity.vehicle?.id; };
  const onDead = (entity: typeof bot.entity) => {
    if (entity.id !== response.attacker) return;
    response.attackerDied = true;
    // The suspended approach can resume and dismount before the next sample (T17e t00044, 2026-11-10).
    if (atSea) stopOnDeath = context.call("cancel_foreground_action", { reason: "scenario observed the hostile response" });
  };
  const onHurt = (entity: typeof bot.entity, source?: typeof bot.entity) => {
    if (entity.id === bot.entity.id && response.hurtAt === null) {
      response.hurtAt = bot.time.age;
      response.attacker = source?.id;
      response.boatId = bot.entity.vehicle?.id;
      response.sawSeat ||= boatNamed(bot.entity.vehicle?.name);
      response.atHurt = bot.entity.position.clone();
      if (atSea && (!boatNamed(bot.entity.vehicle?.name) || response.boatId === undefined)) response.broken = "the first hurt was not seated";
    } else if (response.hurtAt !== null && entity.id === response.attacker) response.effectAt ??= bot.time.age;
  };
  // Capture the seat before the reflex's hurt listener can synchronously start its near-shore get-off.
  bot.prependListener("entityHurt", onHurt);
  bot.on("entityDead", onDead);
  bot.on("mount", onMount);
  const first = context.call("navigate", { ...approach, range: 1 });
  try {
    const waited = await sampleResponse(context, response, atSea, responseWithinTicks);
    if (waited === "stalled") return { status: "failed", detail: "the server's clock stood still during the hostile response" };
    const { hurtAt, effectAt, offAt, attackerDied, sawSeat, broken } = response;
    const elapsedTicks = effectAt !== null && hurtAt !== null ? effectAt - hurtAt : null;
    const offTicks = offAt !== null && hurtAt !== null ? offAt - hurtAt : null;
    if (hurtAt === null || elapsedTicks === null || !attackerDied || !sawSeat || broken || elapsedTicks > responseWithinTicks ||
      (!atSea && (offTicks === null || offTicks > (offWithinTicks ?? responseWithinTicks) || !carriedBoats(bot))))
      return { status: "failed", detail: JSON.stringify({ hurtAt, elapsedTicks, offTicks, broken, seated: bot.entity.vehicle?.id, carried: carriedBoats(bot) }) };
    await (stopOnDeath ?? context.call("cancel_foreground_action", { reason: "scenario observed the hostile response" }));
    await first;
    const next = await context.call("navigate", { ...target, range: 2 });
    return { status: next.result.status === "succeeded" ? "succeeded" : "failed",
      detail: `hurt-to-effect ${elapsedTicks} ticks; hurt-to-off ${offTicks} ticks; next: ${next.summary}` };
  } finally {
    bot.off("entityHurt", onHurt);
    bot.off("entityDead", onDead);
    bot.off("mount", onMount);
    await context.call("cancel_foreground_action", { reason: "scenario cleanup" });
    await first;
  }
}
