import type { ClientCompletion } from "mine-labs/client";
import { declareProductiveProgress, type ProductiveProgress } from "../../../tests/minecraft/drivers/productive-progress.ts";
import { waitServerTicks } from "../../../tests/minecraft/drivers/server-ticks.ts";
import { damageSourceName } from "../../../src/world/damage-registry.ts";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { type Encounter, hurt, readReflexOutcomes } from "./reflex.ts";
import { observeSurvival } from "./low-health-night-survival.ts";

/** The server's name for a creature's melee hit on the bot (Mineflayer's `damage_event` names the type by registry id). */
const MOB_ATTACK = "minecraft:mob_attack";
/** The post-wound watch: 60 s of server time, 1,200 ticks. */
const WATCH_SECONDS = 60;
/** The receipts are read after each wait of this many server ticks (`waitServerTicks` adds the packet margin). */
const READ_TICKS = 20;
/** Outcomes of a response that did not withdraw the bot safely. */
const FAILED_OUTCOMES: readonly string[] = ["failed", "capability_limit", "bot_died"];

type Receipts = Awaited<ReturnType<typeof readReflexOutcomes>>;
/** One read of the runtime's new hostile-reflex receipts: the event log's own cursor makes each read new. */
export type YieldRead = () => Promise<Receipts>;
/** What the watch after the wound saw: how it ended and every receipt published after the wound. */
export interface YieldWatch extends Receipts {
  survival: Awaited<ReturnType<typeof observeSurvival>>;
}

const isSeparation = (encounter: Encounter) => encounter.response === "evade" && encounter.outcome === "safe_separation";

/**
 * Whether a completed separation is still the latest response after this batch (D34). Ordering between a batch's
 * encounters and its failures is not recorded, so any failure or limit in the batch counts as later.
 */
function holdsAfter(holding: boolean, batch: Receipts): boolean {
  if (batch.failures.length + batch.limits.length > 0) return false;
  const latest = batch.encounters.at(-1);
  return latest === undefined ? holding : isSeparation(latest);
}

/**
 * Count the hits the declared fixture creatures land on the bot themselves: the server's `damage_event` naming a
 * mob attack whose cause is one of the entities the scenario declares. The arranged wound has no such source.
 */
export function watchNativeContact(context: Pick<MineAiScenarioContext, "bot" | "scenario">): { hits(): number; close(): void } {
  const { bot } = context;
  const declared = new Set(context.scenario.entities.map((entity) => entity.type.replace(/^minecraft:/, "")));
  let hits = 0;
  const onDamage = (packet: { entityId: number; sourceTypeId: number; sourceCauseId: number }) => {
    if (packet.entityId !== bot.entity.id || packet.sourceCauseId === 0) return;
    if (damageSourceName(bot, packet.sourceTypeId) !== MOB_ATTACK) return;
    const cause = bot.entities[packet.sourceCauseId - 1];
    if (cause?.name !== undefined && declared.has(cause.name)) hits += 1;
  };
  bot._client.on("damage_event", onDamage);
  return { hits: () => hits, close: () => bot._client.off("damage_event", onDamage) };
}

/**
 * Watch the wounded bot for 60 server seconds beside one receipt reader. The first read is the wound's boundary:
 * what the log held until then is before the wound. D34: while a post-wound safe separation is the latest response,
 * the driver's `observing` window is on (progress at each time packet); a later response, failure or limit turns it
 * off until the next separation; it is off at the end, at a death and at a stopped world age.
 */
export async function watchYield(
  context: Pick<MineAiScenarioContext, "bot" | "signal">,
  read: YieldRead,
  progress: Pick<ProductiveProgress, "observing">,
): Promise<YieldWatch> {
  const { bot, signal } = context;
  const taken: Receipts = { encounters: [], limits: [], failures: [] };
  let holding = false;
  const take = async (declare: boolean) => {
    const batch = await read();
    taken.encounters.push(...batch.encounters);
    taken.limits.push(...batch.limits);
    taken.failures.push(...batch.failures);
    holding = holdsAfter(holding, batch);
    if (declare) progress.observing(holding);
  };
  await read();
  const stop = new AbortController();
  const readFailed = new AbortController();
  const failure: { error?: unknown } = {};
  const readerSignal = AbortSignal.any([signal, stop.signal]);
  const reading = (async () => {
    for (;;) {
      if (await waitServerTicks(bot, READ_TICKS, { signal: readerSignal }) === "stalled") return;
      await take(true);
    }
  })().catch((error: unknown) => {
    if (readerSignal.aborted) return;
    failure.error = error;
    readFailed.abort(error);
  });
  try {
    const survival = await observeSurvival({ bot, signal: AbortSignal.any([signal, readFailed.signal]) } as MineAiScenarioContext, WATCH_SECONDS);
    stop.abort();
    await reading;
    if (readFailed.signal.aborted) throw failure.error;
    if (survival !== "cancelled") await take(false);
    return { survival, ...taken };
  } finally {
    stop.abort();
    progress.observing(false);
  }
}

/**
 * Pure verdict: the bot lived the whole watch and withdrew safely after the wound with no failed response. The native
 * contact count is evidence in the detail, not a condition: the released zombies start 4.5 blocks away and the
 * wounded bot evades before they land a hit (0 hits in 4 gate runs and in the base analysis: zero attacks).
 */
export function judgeYield(watch: YieldWatch, contactHits: number): ClientCompletion & { detail: string } {
  const failedOutcomes = watch.encounters.filter((encounter) => FAILED_OUTCOMES.includes(encounter.outcome));
  const problems = [
    watch.survival === "survived" ? null : `the 60 s watch ended ${watch.survival}, not survived`,
    watch.encounters.some(isSeparation) ? null : "no safe separation (evade -> safe_separation) was published after the wound",
    failedOutcomes.length === 0 ? null : `a response failed after the wound (${failedOutcomes.map((e) => `${e.response} -> ${e.outcome}`).join(", ")})`,
    watch.failures.length === 0 ? null : `a reflex failed after the wound (${watch.failures.map((f) => `${f.response}: ${f.why}`).join("; ")})`,
    watch.limits.length === 0 ? null : `a reflex limit ended a response after the wound (${watch.limits.map((l) => `${l.response}: ${l.limit}`).join(", ")})`,
  ].filter((problem) => problem !== null);
  const evidence = JSON.stringify({
    survival: watch.survival, contact: contactHits,
    encounters: watch.encounters.map((e) => `${e.response} -> ${e.outcome} (${e.reason})`),
    failures: watch.failures, limits: watch.limits,
  });
  return { status: problems.length === 0 ? "succeeded" : "failed", detail: `${problems.join("; ") || "Withdrew safely and survived"}; ${evidence}` };
}

/** A wounded bot beside released zombies withdraws safely and survives 60 server seconds, and the receipts say so. */
export const run = async (context: MineAiScenarioContext): Promise<ClientCompletion> => {
  const { bot, signal } = context;
  const runtime = await openRuntime(context, "fight-health-boundary");
  let contact: ReturnType<typeof watchNativeContact> | undefined;
  try {
    contact = watchNativeContact(context);
    using progress = declareProductiveProgress(bot, context.progress, signal);
    bot.chat("/execute as @e[type=zombie] run data merge entity @s {NoAI:0b}");
    await waitServerTicks(bot, 20, { signal });
    if (bot.health > 11 && !(await hurt(context, 11)))
      return { status: "failed", detail: "Could not arrange the health loss that wounds the bot beside the released zombies." };
    const watched = await watchYield(context, () => readReflexOutcomes(context, runtime), progress);
    const verdict = judgeYield(watched, contact.hits());
    return { ...verdict, detail: `${verdict.detail}; final health ${bot.health}` };
  } finally {
    contact?.close();
    await runtime.close();
  }
};
