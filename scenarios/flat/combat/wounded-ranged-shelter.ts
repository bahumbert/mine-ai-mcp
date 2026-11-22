import type { Bot } from "mineflayer";
import { z } from "zod";
import { isBurning, isInLava } from "../../../src/survival/perception/body.ts";
import { recoveryHealth } from "../../../src/survival/policy/combat/health.ts";
import { DEFAULT_SURVIVAL_POLICY } from "../../../src/survival/policy/contract.ts";
import { serverTickPace } from "../../../src/world/server-tick-pace.ts";
import { AGE_PACKET_TICKS, SERVER_ANSWER_TICKS, waitForWorldAge } from "../../../src/world/world-age.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "../../../tests/minecraft/drivers/server-ticks.ts";
import { DEFAULT_GOAL_TIMEOUT_SECONDS } from "../../../tests/minecraft/shared/trial.ts";
import { openRuntime, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario, MineAiScenarioContext } from "../../src/scenario-client.ts";
import { pollServerWindow } from "./idle-reflex-window.ts";
import { readOrderedReflexOutcomes, type ReflexOutcome } from "./reflex.ts";

/** Every reflex outcome stream read since the wound, one entry per read, oldest first. */
export type ShelterRead = Awaited<ReturnType<typeof readOrderedReflexOutcomes>>;

export interface ShelterEvidence {
  protection: "buildable" | "unbuildable";
  shots: number;
  health: number;
  minimumHealth: number;
  reads: readonly ShelterRead[];
}

/** A goal timeout counts game seconds: this many server ticks each. */
const TICKS_PER_GAME_SECOND = 20;

/** The health the driver waits for, and the line a hide receipt must reach to count as a recovered shelter: where the hold ends. */
const HEALTHY = recoveryHealth(DEFAULT_SURVIVAL_POLICY.combat);

/** Every outcome of the reads in the order the events were recorded. */
const inOrder = (reads: readonly ShelterRead[]): ReflexOutcome[] => reads.flatMap((read) => read.ordered);

/** Where the first hide that ended `hidden` at full recovery sits in the ordered outcomes, or -1. */
function recoveredShelter(outcomes: readonly ReflexOutcome[]): number {
  return outcomes.findIndex((o) => o.kind === "encounter" && o.response === "hide" && o.outcome === "hidden" && o.healthAfter >= HEALTHY);
}

/**
 * D35: a shelter proof needs the shelter. A buildable trial succeeds only when a hide receipt ended `hidden` at the
 * healthy line (`settlement.ts` publishes `hidden` for a recovered hold and for a held one; the held one's health is
 * below the line) and nothing failed or hit a limit after it. The shared encounter reader drops the receipt's `error`
 * text, so the health at the receipt stands for it.
 */
export function judgeShelter(evidence: ShelterEvidence): { status: "succeeded" | "failed"; why: string } {
  const fail = (why: string) => ({ status: "failed" as const, why });
  if (evidence.minimumHealth <= 0) return fail("the bot died");
  if (evidence.shots === 0) return fail("no projectile was shot");
  if (evidence.health < HEALTHY) return fail(`health ${evidence.health} never reached ${HEALTHY}`);
  if (evidence.protection === "unbuildable") return { status: "succeeded", why: "recovered without a shelter, as declared" };
  const outcomes = inOrder(evidence.reads);
  const found = recoveredShelter(outcomes);
  if (found < 0) return fail("healed with no recovered shelter: no hide receipt ended hidden at full health");
  const later = outcomes.slice(found + 1).flatMap((o) => {
    if (o.kind === "limit") return [`${o.response} limit ${o.limit}`];
    if (o.kind === "failed") return [`${o.response} ${o.failure}`];
    return o.outcome === "capability_limit" || o.outcome === "failed" ? [`${o.response} ${o.outcome}`] : [];
  });
  return later.length > 0 ? fail(`a failure came after the shelter: ${later.join(", ")}`) : { status: "succeeded", why: "hidden and recovered" };
}

/**
 * Server ticks a hurt keeps the bot's invulnerability window open: a second hurt inside it costs only the excess over the
 * first (a 6-point wound sent 2.1 ticks after a 4-point lava touch took 2, t00631 and the step 1 trace at 20 and 10 tps),
 * and one sent 10 ticks or more after it takes its whole amount (trace: 16 -> 10 in every trial).
 */
const HURT_WINDOW_OPEN_TICKS = 10;

/** The stated gap around the starting health, `[target - 2, target + 2]`, in which the response must be admitted. */
const HEALTH_BAND = 2;

/** A health loss within this of the amount sent is the whole amount (health travels as a 32-bit float). */
const WHOLE_AMOUNT_TOLERANCE = 0.01;

/** When the bot was last hurt, as the server's own damage packets tell it. */
export interface DamageLatch extends Disposable {
  /** Server ticks credited since the bot's last damage event, or null when it has had none. */
  creditedTicks(): number | null;
}

/**
 * Arm before the first hurt of the arrangement (the lava): the pace needs three time packets to measure its tick length,
 * and the packet of a damage event is the only proof that a window opened. The pace observer is the bot's one shared
 * observer (`serverTickPace`): a runtime opened meanwhile reuses it and disposes it on close, so the latch reads no
 * pace after the wound.
 */
export function watchDamage(bot: Bot): DamageLatch {
  const pace = serverTickPace(bot);
  let mark: ReturnType<typeof pace.mark> | null = null;
  const onDamage = (packet: { entityId: number }) => {
    if (packet.entityId === bot.entity.id) mark = pace.mark();
  };
  bot._client.on("damage_event", onDamage);
  return {
    creditedTicks: () => (mark === null ? null : pace.creditedSince(mark)),
    [Symbol.dispose]() {
      bot._client.off("damage_event", onDamage);
      pace[Symbol.dispose]();
    },
  };
}

export interface WoundStaging {
  /** `wounded`: the whole amount landed and the health is in the band; `partial`: less landed; `off_band`: it landed but the band is missed; `no_window`: the hurt window never closed; `unanswered`: no health packet answered; `died`. */
  status: "wounded" | "partial" | "off_band" | "no_window" | "unanswered" | "died";
  sent: number;
  healthBefore: number;
  healthAfter: number;
}

/**
 * Bring the bot to `target` health with one `/damage` command that lands whole: it waits for the last hurt's window to
 * close (a wound inside it lands only the excess, t00631: 16 -> 14 with 6 sent, the rest of the way carried by residual
 * fire), sends the amount computed from the health read at the send, and reads the first health packet that answers it.
 * Every wait is world age with the stopped-clock bound. The pace observer of `latch` is the caller's.
 */
export async function stageWound(
  context: Pick<MineAiScenarioContext, "bot" | "signal">,
  target: number,
  latch: DamageLatch,
): Promise<WoundStaging> {
  const { bot, signal } = context;
  const outcome = (status: WoundStaging["status"], sent: number, healthBefore: number, healthAfter: number): WoundStaging =>
    ({ status, sent, healthBefore, healthAfter });
  const closed = await waitForWorldAge(bot, HURT_WINDOW_OPEN_TICKS + 2 * AGE_PACKET_TICKS, {
    wallMs: Number.POSITIVE_INFINITY, stallMs: DRIVER_CLOCK_STOPPED_MS, signal,
    until: () => (latch.creditedTicks() ?? HURT_WINDOW_OPEN_TICKS) >= HURT_WINDOW_OPEN_TICKS,
  });
  const healthBefore = bot.health;
  if (closed !== "until") return outcome("no_window", 0, healthBefore, healthBefore);
  if (healthBefore <= 0) return outcome("died", 0, healthBefore, healthBefore);
  const inBand = (health: number) => Math.abs(health - target) <= HEALTH_BAND;
  const amount = Math.round(healthBefore - target);
  if (amount < 1) return outcome(inBand(healthBefore) ? "wounded" : "off_band", 0, healthBefore, healthBefore);
  let after: number | null = null;
  const onHealth = () => {
    if (after === null && bot.health < healthBefore) after = bot.health;
  };
  bot.on("health", onHealth);
  try {
    bot.chat(`/damage @s ${amount} minecraft:magic`);
    await waitForWorldAge(bot, SERVER_ANSWER_TICKS, {
      wallMs: Number.POSITIVE_INFINITY, stallMs: DRIVER_CLOCK_STOPPED_MS, signal, until: () => after !== null,
    });
  } finally {
    bot.off("health", onHealth);
  }
  if (after === null) return outcome("unanswered", amount, healthBefore, bot.health);
  if (after <= 0) return outcome("died", amount, healthBefore, 0);
  if (healthBefore - after < amount - WHOLE_AMOUNT_TOLERANCE) return outcome("partial", amount, healthBefore, after);
  return outcome(inBand(after) ? "wounded" : "off_band", amount, healthBefore, after);
}

/**
 * Report to the still watchdog each new health high of the recovery, and only while the world age moves: a regeneration
 * that oscillates, or a health packet on a stopped server, is no progress (`productive-progress.ts` reports every rise).
 */
export function declareRecoveryHighs(bot: Bot, progress: (reason: string) => void): Disposable {
  let high = bot.health;
  let reportedAge = bot.time.age ?? null;
  const onHealth = () => {
    if (bot.health <= high) return;
    high = bot.health;
    const age = bot.time.age ?? null;
    if (age === null || (reportedAge !== null && age <= reportedAge)) return;
    reportedAge = age;
    progress(`health high ${Number(bot.health.toFixed(1))}`);
  };
  bot.on("health", onHealth);
  return { [Symbol.dispose]: () => void bot.off("health", onHealth) };
}

/** The first health drop after the wound, whatever caused it (a hit, a fire's damage). */
export interface HurtWatch extends Disposable {
  hurt(): boolean;
  /** The health the first drop left, or null before one. */
  healthAtHurt(): number | null;
  /** The world age of the first drop, or null before one (or before the first time packet): a time packet's age, so exact to about 19 server ticks. */
  ageAtHurt(): number | null;
}

/**
 * Arm after the wound: a health strictly below the last health heard is the first hurt, recorded once. A health equal or
 * above (regeneration, a heal) only updates the last heard; a hit the armour fully absorbs sends no drop and is no hurt.
 */
export function watchFirstHurt(bot: Bot): HurtWatch {
  let last = bot.health;
  let healthAtHurt: number | null = null;
  let ageAtHurt: number | null = null;
  const onHealth = () => {
    if (healthAtHurt === null && bot.health < last) [healthAtHurt, ageAtHurt] = [bot.health, bot.time.age ?? null];
    last = bot.health;
  };
  bot.on("health", onHealth);
  return {
    hurt: () => healthAtHurt !== null,
    healthAtHurt: () => healthAtHurt,
    ageAtHurt: () => ageAtHurt,
    [Symbol.dispose]: () => void bot.off("health", onHealth),
  };
}

/** The report's record of the first health drop after the wound (not a blaze hit: any damage), or null when none came. */
function firstHealthDrop(watch: HurtWatch, woundAge: number | null): { health: number; ticks: number | null } | null {
  const health = watch.healthAtHurt();
  const age = watch.ageAtHurt();
  return health === null ? null : { health, ticks: age === null || woundAge === null ? null : age - woundAge };
}

/**
 * Turn natural regeneration on at the first attack on the wounded bot, so the response the trial judges is admitted below
 * `engage_min_health` and not after the health has regenerated past it before the first hit (analysis 2026-11-22 section 2).
 * The first attack is the first health drop (`watch`) or the reflex taking the body (`responding`): a blaze hit the reflex
 * answers sends no health or damage packet: the hide began at health 10 with no drop, and its shell blocked every later
 * shot, so a gate on the drop alone never opened (facts `scenario-fixture-pitfalls.md`, plan part2-a8 T13v).
 * Regeneration freezes the bot's health, so nothing else would tell Mine Labs' still guard the trial lives: each new shot
 * is reported as progress, and only while the world age has moved since the last report. A death aborts `waitPhase`'s
 * signal (`run`'s `died` controller); a budget that runs out or a stopped world age throws from it, naming the phase.
 * Returns what opened the gate.
 */
export async function enableRegenerationOnFirstAttack(
  bot: Bot,
  watch: HurtWatch,
  responding: () => boolean,
  waitPhase: (phase: string, until: () => boolean) => Promise<void>,
  shots: () => number,
  progress: (reason: string) => void,
): Promise<"hurt" | "responding"> {
  let reportedShots = shots();
  let reportedAge = bot.time.age ?? null;
  const onTick = () => {
    const count = shots();
    const age = bot.time.age ?? null;
    if (count <= reportedShots || age === null || (reportedAge !== null && age <= reportedAge)) return;
    [reportedShots, reportedAge] = [count, age];
    progress(`shot ${count}`);
  };
  bot.on("physicsTick", onTick);
  try {
    await waitPhase("first attack", () => watch.hurt() || responding());
  } finally {
    bot.off("physicsTick", onTick);
  }
  bot.chat("/gamerule naturalRegeneration true");
  return watch.hurt() ? "hurt" : "responding";
}

/**
 * A wait inside the driver's shared goal budget (the goal's timeout in game seconds, counted from the driver's first age),
 * leaving the terminal read its server ticks. It ends when `until` holds and throws, naming the phase, when the budget
 * runs out or the world age stands still.
 */
export function phaseWaiter(context: Pick<MineAiScenarioContext, "bot" | "scenario">, signal: AbortSignal) {
  const { bot } = context;
  // The first age heard counts from zero: a null age before the first time packet is no age (`idle-reflex-window.ts` `windowAge`).
  let firstAge: number | undefined = bot.time.age ?? undefined;
  const budgetTicks = (context.scenario.goal.timeout ?? DEFAULT_GOAL_TIMEOUT_SECONDS) * TICKS_PER_GAME_SECOND;
  /** Server ticks left for waits: the budget minus what the driver spent, minus the terminal read's own ticks. */
  const remaining = (): number => {
    firstAge ??= bot.time.age ?? undefined;
    const spent = firstAge === undefined ? 0 : (bot.time.age ?? firstAge) - firstAge;
    return Math.max(0, budgetTicks - spent - SERVER_ANSWER_TICKS);
  };
  const wait = async (phase: string, until: () => boolean): Promise<void> => {
    const end = await waitForWorldAge(bot, remaining(), { wallMs: Number.POSITIVE_INFINITY, stallMs: DRIVER_CLOCK_STOPPED_MS, signal, until });
    if (end !== "until") throw new Error(`${phase}: ${end === "moved" ? "the goal budget ran out" : "the server's world age stood still"}`);
  };
  return Object.assign(wait, { remaining });
}

/**
 * Read every reflex outcome stream once the bot is healthy, then, while a buildable shelter is still unproven, again
 * until a qualifying hide shows, the body has been idle for `SERVER_ANSWER_TICKS`, or `windowTicks` of world age pass:
 * a receipt arrives after the health does.
 */
export async function readShelterReads(
  context: Pick<MineAiScenarioContext, "bot" | "signal">,
  runtime: Parameters<typeof readOrderedReflexOutcomes>[1],
  needsShelter: boolean,
  windowTicks: number,
): Promise<ShelterRead[]> {
  const reads: ShelterRead[] = [await readOrderedReflexOutcomes(context, runtime)];
  if (needsShelter && recoveredShelter(inOrder(reads)) < 0) {
    // A hide still running when the health is back (natural regeneration is faster than a shell) publishes its receipt
    // when it ends: the read goes on while the body is busy, to the goal budget (`windowTicks`), and stops
    // `SERVER_ANSWER_TICKS` after the body was first seen idle (t00769, t00838: the runtime was closed under the hold).
    let idleSince: number | null = null;
    const { ended } = await pollServerWindow(context.bot, Math.max(SERVER_ANSWER_TICKS, windowTicks), async () => {
      reads.push(await readOrderedReflexOutcomes(context, runtime));
      if (recoveredShelter(inOrder(reads)) >= 0) return true;
      const age = context.bot.time.age ?? 0;
      if (runtime.status().busy) idleSince = null;
      else idleSince ??= age;
      return idleSince !== null && age - idleSince >= SERVER_ANSWER_TICKS;
    }, context.signal);
    // The wait between polls is longer than the window (a time packet's margin), so the receipt of the last stretch is
    // only read here (t00657, 2026-11-21: the receipt came 1.2 s after the first read and was never seen).
    if (ended === "ticks") reads.push(await readOrderedReflexOutcomes(context, runtime));
  }
  return reads;
}

/**
 * A native lava touch leaves a long burn after escape. The shield cannot block these residual ticks, which killed the
 * equipped eyes trial (the burning YAML carries none since T13i).
 */
async function burnInLava(bot: Bot, waitPhase: (phase: string, until: () => boolean) => Promise<void>): Promise<void> {
  bot.chat("/setblock 0 -60 0 lava");
  await waitPhase("lava", () => isInLava(bot) && isBurning(bot));
  bot.chat("/setblock 0 -60 0 air");
  await waitPhase("out of the lava", () => !isInLava(bot));
}

/** Two shooters of `mob` on opposite sides of the bot (a skeleton holds a bow and stands closer). */
function summonShooters(bot: Bot, mob: "blaze" | "skeleton"): void {
  const range = mob === "skeleton" ? 12 : 18;
  const equipment = mob === "skeleton" ? ',HandItems:[{id:"minecraft:bow",count:1},{}]' : "";
  for (const [x, z] of [
    [range + 0.5, 0.5],
    [-range + 0.5, 0.5],
  ])
    bot.chat(`/summon ${mob} ${x} -60 ${z} {PersistenceRequired:1b${equipment}}`);
}

export const run: MineAiScenario = async (context) => {
  const { bot } = context;
  const died = new AbortController();
  const onDeath = () => died.abort(new Error("Wounded bot died"));
  const signal = AbortSignal.any([context.signal, died.signal]);
  const { mob, protection, burning, startingHealth } = z
    .object({
      mob: z.enum(["blaze", "skeleton"]),
      burning: z.boolean().default(false),
      protection: z.enum(["buildable", "unbuildable"]).default("buildable"),
      startingHealth: z.number().min(1).max(19).default(10),
    })
    .parse(context.scenario.params);
  const waitPhase = phaseWaiter(context, signal);
  // Armed before the first hurt: the wound waits for the lava's hurt window by the damage packets it heard.
  using latch = watchDamage(bot);
  await wearArmor(context);
  // Freeze recovery during the arrangement and until the first attack (`enableRegenerationOnFirstAttack`: a health drop or
  // the reflex taking the body), so the admitted response starts below `engage_min_health`, not after regeneration has
  // carried the health past it before the first hit (analysis 2026-11-22 section 2). No teleport or healing in combat.
  bot.chat("/gamerule naturalRegeneration false");
  if (burning) await burnInLava(bot, waitPhase);
  // A burning bot is wounded once the first shot is in the air (the 100 ticks of fire before it would otherwise carry
  // the health past the band); an unburning one is wounded first, nothing hurts it meanwhile.
  const woundNow = async () => {
    const staged = await stageWound(context, startingHealth, latch);
    if (staged.status !== "wounded") throw new Error(`Could not arrange ${startingHealth} health: ${JSON.stringify(staged)}`);
    return { ...staged, age: bot.time.age ?? null };
  };
  let wound = burning ? null : await woundNow();
  // Armed as soon as the wound is staged, so a hit that lands before the runtime opens is still the first hurt.
  let hurt: HurtWatch | null = wound === null ? null : watchFirstHurt(bot);
  const start = bot.entity.position.clone();
  let shots = 0;
  let minimumHealth = bot.health;
  let maximumDistance = 0;
  const spawn = (entity: typeof bot.entity) => {
    if (["small_fireball", "arrow"].includes(entity.name ?? "")) shots++;
  };
  const tick = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
    maximumDistance = Math.max(maximumDistance, bot.entity.position.distanceTo(start));
  };
  bot.once("death", onDeath);
  bot.on("entitySpawn", spawn);
  bot.on("physicsTick", tick);
  summonShooters(bot, mob);
  try {
    // Admit the policy with an actual projectile already in flight, not merely
    // with a passive shooter in sight that an early sprint can leave behind.
    await waitPhase("first shot", () => shots > 0 || bot.health <= 0);
    wound ??= await woundNow();
    hurt ??= watchFirstHurt(bot);
    const runtime = await openRuntime(context, `wounded-${mob}-shelter`);
    try {
      using _highs = declareRecoveryHighs(bot, context.progress);
      const regenerationOpenedBy = await enableRegenerationOnFirstAttack(
        bot, hurt, () => runtime.status().busy, waitPhase, () => shots, context.progress,
      );
      await waitPhase("recovery", () => bot.health >= HEALTHY || bot.health <= 0);
      const reads = await readShelterReads(context, runtime, protection === "buildable", waitPhase.remaining());
      const verdict = judgeShelter({ protection, shots, health: bot.health, minimumHealth, reads });
      return {
        status: verdict.status,
        detail: JSON.stringify({
          protection, verdict: verdict.why, wound, firstHealthDrop: firstHealthDrop(hurt, wound.age), regenerationOpenedBy, encounters: reads.flatMap((read) => read.encounters),
          limits: reads.flatMap((read) => read.limits), failures: reads.flatMap((read) => read.failures),
          shots, health: bot.health, minimumHealth, maximumDistance,
        }),
      };
    } finally {
      await runtime.close();
    }
  } finally {
    hurt?.[Symbol.dispose]();
    bot.off("death", onDeath);
    bot.off("entitySpawn", spawn);
    bot.off("physicsTick", tick);
  }
};
