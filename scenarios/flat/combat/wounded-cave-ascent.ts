/** Reach the surface alive from a wounded, foodless start with mid-route hostile contact. */
import { CANCEL_FOREGROUND_ACTION, NAVIGATE } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import type { Bot } from "mineflayer";
import { z } from "zod";
import { waitServerTicks } from "../../../tests/minecraft/drivers/server-ticks.ts";
import { SERVER_ANSWER_TICKS } from "../../../src/world/world-age.ts";
import { openRuntime, standStill, type Runtime } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { awaitEncounters, describe, hurt, type Encounter } from "./reflex.ts";

const paramsSchema = z.strictObject({
  /** Health to bring the bot down to before the route is asked for; below the hide bar. */
  hurtTo: z.number().int().positive(),
  /** Food the YAML declares for the player (Mine Labs drains to at most this value); below the regeneration bar. */
  maxFood: z.number().int().min(0).max(20),
  /** Feet cell on the plateau the withdraw navigate is asked to reach. */
  target: z.tuple([z.number().int(), z.number().int(), z.number().int()]),
  /** Where the zombie is put once the route is under way: on its ledge, in sight, out of contact range. */
  zombie: z.tuple([z.number(), z.number(), z.number()]),
});

type Declared = Pick<z.infer<typeof paramsSchema>, "hurtTo" | "maxFood">;
type DriverContext = Pick<MineAiScenarioContext, "bot" | "signal">;

/** Blocks from the captured origin that count as "the route got the bot moving". */
const ROUTE_MOVED_BLOCKS = 1;
/** Server ticks the route gets to move the bot off its start cell. */
const ROUTE_UNDER_WAY_TICKS = 200;
/** Server ticks the zombie gets to be seen after it is summoned. */
const ZOMBIE_ARRIVAL_TICKS = 40;
/** The bot has to end within this many blocks of the target. */
const ARRIVED_BLOCKS = 2;
const STALLED_SERVER = "the server's world age stood still";

function where(context: Pick<MineAiScenarioContext, "bot">): string {
  const feet = context.bot.entity.position;
  return `${feet.x.toFixed(1)},${feet.y.toFixed(1)},${feet.z.toFixed(1)}`;
}

function carriedFood(bot: Bot): string[] {
  return bot.inventory
    .items()
    .filter((item) => bot.registry.foodsByName[item.name] !== undefined)
    .map((item) => item.name);
}

/**
 * Confirm the vitals the YAML declared, from the server's own answers.
 *
 * Mine Labs sets the declared food and drains saturation when the player joins; this reads what the bot was told:
 * health above 0 and at most `hurtTo`, food at most `maxFood`, saturation 0 and no food item. The packets may be late,
 * so it waits one answer window of server ticks, then reads once more. Returns null, or the refusal with the values.
 */
// @function-metrics size=14 branches=3 fan-out=6 depth=2 interface=3 fan-in=1
export async function confirmVitals(context: DriverContext, declared: Declared): Promise<string | null> {
  const { bot } = context;
  const holds = () =>
    bot.health > 0 && bot.health <= declared.hurtTo && bot.food <= declared.maxFood && bot.foodSaturation === 0 && carriedFood(bot).length === 0;
  const outcome = await waitServerTicks(bot, SERVER_ANSWER_TICKS, { signal: context.signal, until: holds });
  if (holds()) return null;
  const carried = carriedFood(bot);
  const carrying = carried.length > 0 ? `, carrying ${carried.join(", ")}` : "";
  const stalled = outcome === "stalled" ? `; ${STALLED_SERVER}` : "";
  return `Declared vitals not seen: health ${bot.health}, food ${bot.food}, saturation ${bot.foodSaturation}${carrying}${stalled}`;
}

/** A latch a client event sets and a later read sees; `close` removes its listener. */
interface RouteWatch {
  latched(): boolean;
  close(): void;
}

/** Latch once the bot is `ROUTE_MOVED_BLOCKS` from `origin` while navigate owns the body; a read looks again at the position now. */
// @function-metrics size=11 branches=2 fan-out=4 depth=2 interface=3 fan-in=1
export function watchRoute(
  bot: Pick<Bot, "entity" | "on" | "off">,
  activeAction: () => string | undefined,
  origin: { distanceTo(other: { x: number; y: number; z: number }): number },
): RouteWatch {
  let held = false;
  const look = () => {
    held ||= activeAction() === NAVIGATE && origin.distanceTo(bot.entity.position) >= ROUTE_MOVED_BLOCKS;
    return held;
  };
  const onMove = () => void look();
  bot.on("move", onMove);
  return { latched: look, close: () => void bot.off("move", onMove) };
}

interface ZombieWatch {
  seen(): boolean;
  id(): number | undefined;
  close(): void;
}

/** Latch on the id of the first zombie the client sees spawn. */
// @function-metrics size=9 branches=2 fan-out=3 depth=2 interface=1 fan-in=1
export function watchZombie(bot: Pick<Bot, "on" | "off">): ZombieWatch {
  let zombieId: number | undefined;
  const spawned = (entity: { id: number; name?: string }) => {
    if (entity.name === "zombie") zombieId ??= entity.id;
  };
  bot.on("entitySpawn", spawned);
  return { seen: () => zombieId !== undefined, id: () => zombieId, close: () => void bot.off("entitySpawn", spawned) };
}

type LatchWait = "latched" | "never" | "abandoned" | "stalled";

/**
 * Wait `ticks` server ticks for a latch, with one read at the end; `ended` abandons the wait early (the route returned).
 * A stopped server ends the wait as "stalled". An abort rejects with its reason.
 */
// @function-metrics size=8 branches=4 fan-out=3 depth=2 interface=4 fan-in=2
export async function awaitLatch(context: DriverContext, ticks: number, latched: () => boolean, ended: () => boolean = () => false): Promise<LatchWait> {
  const outcome = await waitServerTicks(context.bot, ticks, { signal: context.signal, until: () => latched() || ended() });
  if (latched()) return "latched";
  if (ended()) return "abandoned";
  return outcome === "stalled" ? "stalled" : "never";
}

interface AscentFacts {
  health: number;
  remaining: number;
  zombieId: number | undefined;
  output: { result: { status: string; error?: string } };
  encounters: readonly Encounter[];
}

/** The pass: alive, within `ARRIVED_BLOCKS` of the target, navigate succeeded, and the zombie's evade interrupted it. */
// @function-metrics size=18 branches=7 fan-out=4 depth=2 interface=1 fan-in=2
export function judgeAscent(facts: AscentFacts): { status: "succeeded" | "failed"; detail: string } {
  const problems: string[] = [];
  if (facts.health <= 0) problems.push("The bot died on the way up");
  if (facts.remaining > ARRIVED_BLOCKS) problems.push(`The bot did not arrive: ${facts.remaining.toFixed(1)} blocks from the plateau`);
  const { status, error } = facts.output.result;
  if (status !== "succeeded") problems.push(`The navigate returned ${status}: ${error ?? "no reason given"}`);
  const interrupting = facts.encounters.filter((encounter) => encounter.interrupted?.action === NAVIGATE);
  if (interrupting.length === 0) {
    problems.push("No encounter interrupted the navigate");
  } else if (facts.zombieId === undefined || !interrupting.some((encounter) => encounter.finalDistances.some((entry) => entry.id === facts.zombieId))) {
    problems.push(`No encounter that interrupted the navigate saw zombie ${facts.zombieId ?? "(never seen)"}`);
  }
  return problems.length === 0
    ? { status: "succeeded", detail: "Arrived alive after the zombie's evade interrupted the navigate" }
    : { status: "failed", detail: problems.join("; ") };
}

/** The navigate the driver started: its return, and a way to cancel it as the model's cancel would. */
interface RouteRun {
  pending: Promise<{ result: unknown }>;
  cancel(reason: string): Promise<void>;
}

/**
 * What a latch wait that did not latch means for the route: null when it latched, else the failure's text.
 * A route that returned first reports its own result; one that never reached the latch is cancelled, then awaited.
 */
// @function-metrics size=9 branches=3 fan-out=3 depth=2 interface=3 fan-in=1
export async function routeFailure(wait: LatchWait, what: string, route: RouteRun): Promise<string | null> {
  if (wait === "latched") return null;
  if (wait === "abandoned") return `The withdraw navigate returned before ${what}: ${JSON.stringify((await route.pending).result)}`;
  await route.cancel(`The route never reached: ${what}.`);
  await route.pending;
  return `Not seen: ${what}${wait === "stalled" ? `; ${STALLED_SERVER}` : ""}`;
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const { bot } = context;
  const runtime = await openRuntime(context, "combat-wounded-cave-ascent");
  try {
    if (!(await standStill(context))) {
      return { status: "failed", detail: `The bot never came to rest with vitals known; at ${where(context)}` };
    }
    // Hurt while nothing is watching: the hide bar is what the fixture is
    // about, and a hide before the route starts would only add ninety seconds.
    if (!(await hurt(context, params.hurtTo))) {
      return {
        status: "failed",
        detail: `The bot could not be brought to ${params.hurtTo} health; it is at ${bot.health}`,
      };
    }
    const refused = await confirmVitals(context, params);
    if (refused) return { status: "failed", detail: refused };
    context.log(`bot at ${bot.health} health and ${bot.food} hunger with nothing to eat`);
    return await ascend(context, runtime, params);
  } finally {
    await runtime.close();
  }
}

/** Ask for the withdraw navigate, put the zombie on its ledge once the route moves, and judge the arrival. */
// @function-metrics size=30 branches=3 fan-out=9 depth=2 interface=3 fan-in=1
async function ascend(context: MineAiScenarioContext, runtime: Runtime, params: z.infer<typeof paramsSchema>): Promise<ClientCompletion> {
  const { bot } = context;
  const navigate = runtime.actions.find((action) => action.name === NAVIGATE);
  const cancel = runtime.actions.find((action) => action.name === CANCEL_FOREGROUND_ACTION);
  if (!navigate || !cancel) throw new Error("The ascent scenario requires the navigate and cancel actions.");
  const [x, y, z] = params.target;
  const request = { x, y, z, range: 1, dig: true, scaffold: true };

  const route = watchRoute(bot, () => runtime.status().activeAction?.action, bot.entity.position.clone());
  const zombie = watchZombie(bot);
  try {
    const pending = runtime.run(navigate, request, context.signal);
    let returned = false;
    void pending.then(() => (returned = true), () => (returned = true));
    const routeRun: RouteRun = { pending, cancel: async (reason) => void (await runtime.run(cancel, { reason }, context.signal)) };

    const moving = await routeFailure(await awaitLatch(context, ROUTE_UNDER_WAY_TICKS, route.latched, () => returned), "the bot moving under navigate", routeRun);
    if (moving) return { status: "failed", detail: moving };
    bot.chat(`/summon minecraft:zombie ${params.zombie.join(" ")} {PersistenceRequired:1b,NoAI:1b}`);
    const watched = await routeFailure(await awaitLatch(context, ZOMBIE_ARRIVAL_TICKS, zombie.seen, () => returned), `a zombie within sight of ${params.zombie.join(",")}`, routeRun);
    if (watched) return { status: "failed", detail: watched };
    context.log(`zombie on its ledge; bot at ${where(context)} with ${bot.health} health`);

    const output = await pending;
    const encounters = await awaitEncounters(context, runtime, 1, SERVER_ANSWER_TICKS);
    const remaining = Math.hypot(bot.entity.position.x - (x + 0.5), bot.entity.position.y - y, bot.entity.position.z - (z + 0.5));
    const verdict = judgeAscent({ health: bot.health, remaining, zombieId: zombie.id(), output, encounters });
    const evidence = { health: bot.health, hunger: bot.food, position: where(context), remaining, encounters: encounters.map(describe), output };
    return { status: verdict.status, detail: `${verdict.detail}; ${JSON.stringify(evidence)}` };
  } finally {
    route.close();
    zombie.close();
  }
}
