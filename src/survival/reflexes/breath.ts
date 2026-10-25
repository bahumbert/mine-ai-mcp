import type { Bot } from "mineflayer";
import { LETHAL_REFLEX_RETRY_MS, type ReflexLimits } from "../control/contract.js";
import { climbsBy, risesOver, watchBodyTicks } from "../control/reflex-progress.js";
import type { ReflexDriver } from "../control/driver.js";
import { airSupplyPoints, isInWater } from "../perception/body.js";
import { decideBreathResponse, needsBreathResponse } from "../policy/environment.js";
import { swimmingRoof } from "../positioning/swim-escape.js";
import { surface } from "../responses/breath.js";
import { airSupplyTicks } from "../../world/air-supply.js";

/** What the runner reports as the body's owner while the bot surfaces for air. */
export const BREATH_REFLEX = "breath_reflex" as const;
/**
 * A surfacing may hold the body 40 s (the 600-tick budget is 30 s at full speed, plus 10 s for a server 30 % behind) and
 * 5 s without the air rising, the body climbing a block or a block dug; then the reflex pauses 2 s (owner 2026-10-19).
 */
const BREATH_LIMITS: ReflexLimits = { ceilingMs: 40_000, noProgressMs: 5_000, standDownMs: 2_000 };
/** The body rising this far (in water too) toward air is progress. */
const CLIMB_BLOCKS = 1;
/** Check air every quarter second while another action or idle buoyancy owns movement. */
const CHECK_INTERVAL_TICKS = 5;
/** Air ticks on the server's meter while the bot breathes. */
const FULL_AIR_TICKS = 300;
/** Surfacing this many times within the window and radius means the action keeps diving to a place it cannot reach on one breath. */
const REPEAT_FIRINGS = 3;
const REPEAT_WINDOW_MS = 3 * 60_000;
const REPEAT_RADIUS = 4;

/** What counts as getting somewhere while surfacing: the air rose, the body climbed a block (in water too), a block was dug. */
function surfacingProgress(bot: Bot, mark: (reason: string) => void): () => void {
  const dug = () => mark("dug");
  bot.on("diggingCompleted", dug);
  const stopTicks = watchBodyTicks(bot, mark, {
    air_rose: risesOver(() => airSupplyPoints(bot)),
    climbed: climbsBy(() => bot.entity.position.y, CLIMB_BLOCKS),
  });
  return () => {
    stopTicks();
    bot.off("diggingCompleted", dug);
  };
}

/** The breathing response owns only its registration; runtime attaches idle buoyancy separately. */
export function attachBreathReflex(bot: Bot, driver: ReflexDriver, diveBackstop: () => number | null = () => null, now: () => number = Date.now): AsyncDisposable {
  // Where and when the reflex recently finished a surfacing that resumed the action (live 2026-10-10 run 7: one navigate
  // dived again from the same x/z for 40 minutes, 120 times).
  let firings: { x: number; z: number; at: number }[] = [];
  return driver.register({
    name: BREATH_REFLEX,
    // Still water never changes the cells the answer reads, while the air runs out: try the surfacing again.
    retryAfterFailureMs: LETHAL_REFLEX_RETRY_MS,
    intervalTicks: CHECK_INTERVAL_TICKS,
    sense: () => {
      const air = airSupplyPoints(bot);
      if (air === null) return { kind: "unknown", missing: "own_air_metadata" };
      if (!isInWater(bot)) return null;
      const roof = swimmingRoof(bot)?.name ?? null;
      const floor = diveBackstop();
      // Full air on the server's meter is a bot that breathes (water breathing, respiration, eyes the server puts out of
      // the water): the dive's own model of the cells never rescues it (run 15: 20 cancels at air 20).
      if (floor !== null && airSupplyTicks(bot) === FULL_AIR_TICKS) return null;
      if (floor === null ? !needsBreathResponse(air, roof) : (airSupplyTicks(bot) ?? 0) > floor) return null;
      return { kind: "observed", danger: { air, ownedDive: floor !== null }, evidence: { air, roof } };
    },
    decide: ({ air, ownedDive }) => {
      const decision = decideBreathResponse(air);
      return decision.kind === "respond" ? { ...decision, response: { ...decision.response, ownedDive } } : decision;
    },
    facts: () => {
      const origin = bot.entity.position.floored();
      return {
        capability: "breath",
        response: "surface",
        scope: `cell:${origin}`,
        facts: () => {
          const cells: (number | null)[] = [];
          // The physical method checks a two-block lateral corridor and the next swim stroke.
          for (let x = -2; x <= 2; x++)
            for (let z = -2; z <= 2; z++)
              for (let y = -1; y <= 2; y++) cells.push(bot.blockAt(origin.offset(x, y, z))?.stateId ?? null);
          return { cells, tools: bot.inventory.items().map((item) => ({ name: item.name, count: item.count })) };
        },
        permissions: () => null,
      };
    },
    limits: () => BREATH_LIMITS,
    progress: (_response, mark) => surfacingProgress(bot, mark),
    act: async ({ airBefore, maximumTicks, ownedDive }, signal) => {
      const healthBefore = bot.health;
      return {
        ...(await surface(bot, signal, driver.budgets, maximumTicks)),
        airBefore,
        ownedDive,
        healthBefore,
        healthAfter: bot.health,
      };
    },
    continuation: (outcome) => {
      // A rescue from a dive navigation owned resumes like any other (navigation plans again from the surface) and counts
      // in the same guard, so a dive that keeps failing at one place still ends. `ownedDive` stays in the receipts.
      if (outcome.kind === "air_full") {
        const { x, z } = bot.entity.position;
        const at = now();
        firings = firings.filter((earlier) => at - earlier.at <= REPEAT_WINDOW_MS && Math.hypot(x - earlier.x, z - earlier.z) <= REPEAT_RADIUS);
        firings.push({ x, z, at });
        if (firings.length < REPEAT_FIRINGS) return { kind: "resume" };
        firings = [];
        return { kind: "return", reason: "[BREATH] Out of air three times here: the target is too deep under water to reach holding breath." };
      }
      return {
        kind: "return",
        reason: outcome.kind === "air_unknown" ? "Own air metadata is unavailable." : "Full air was not observed.",
      };
    },
    failure: (outcome) =>
      outcome.kind === "stuck"
        ? { kind: "stuck", why: "The surface attempt ended before full air was observed." }
        : null,
    describe: (outcome) => outcome,
  });
}
