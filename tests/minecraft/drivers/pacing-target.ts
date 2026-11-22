// Measure the no-damage fight and its target-specific answer against a re-offered invulnerable attacker.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { readRecentEventsResultSchema } from "../../../src/actions/read-recent-events/contract.ts";
import { observeExecution } from "../../../src/execution/execution-scope.ts";
import { STALE_AGE_TICKS } from "../../../src/world/world-age.ts";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import type { ScenarioContext } from "../scenario.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "./server-ticks.ts";

// T28, 2026-11-18, n=3/rate: spans 1220 ticks at 20 tps, 1212-1217 at 10; 1.5 x 1220, rounded up to 20.
export const MAX_FIGHT_TICKS = 1840;
const NO_DAMAGE_TICKS = 600;
const ANSWER_TICKS = 600;

interface AgedFight {
  readonly target: number | null;
  readonly startAge: number;
  endAge: number | null;
}

interface PacingOutcome {
  readonly targets: readonly number[];
  readonly outcome: string;
  readonly error?: string;
}

interface PacingEvidence {
  readonly fights: readonly AgedFight[];
  readonly outcomes: readonly PacingOutcome[];
  readonly contacts: readonly { readonly target: number; readonly age: number }[];
  readonly healthChanged: boolean;
}

/** Judge the fight's observed close and same-target claims during the time-only answer, allowing one stale age packet. */
export function judgePacing({ fights, outcomes, contacts, healthChanged }: PacingEvidence): string[] {
  const problems: string[] = [];
  if (healthChanged) problems.push("health changed: neither side deals damage in this fixture");
  const first = fights[0];
  if (!first || first.endAge === null) return [...problems, "fight 0 has no end"];
  const span = first.endAge - first.startAge;
  if (span < NO_DAMAGE_TICKS - STALE_AGE_TICKS) problems.push(`fight 0 spans ${span} ticks, need ${NO_DAMAGE_TICKS - STALE_AGE_TICKS}`);
  if (!outcomes.some(outcome => first.target !== null && outcome.targets.includes(first.target)
    && outcome.outcome === "target_unreachable" && outcome.error?.startsWith("No confirmed damage to ")))
    problems.push("no target_unreachable / No confirmed damage to outcome for the first target");
  const until = first.endAge + ANSWER_TICKS - STALE_AGE_TICKS;
  if (!contacts.some(contact => contact.target === first.target && contact.age >= first.endAge! && contact.age < until))
    problems.push("no re-offer witnessed during the answer window");
  for (const fight of fights.slice(1)) {
    if (fight.target === first.target && fight.startAge < until)
      problems.push(`target ${fight.target} claimed again at +${fight.startAge - first.endAge} ticks, before +${ANSWER_TICKS - STALE_AGE_TICKS}`);
  }
  return problems;
}

/** Subscribe before the first claim and latch damage, including a health dip restored between polls. */
function observePacing(context: ScenarioContext) {
  const fights: (AgedFight & { scope: string })[] = [];
  const outcomes: PacingOutcome[] = [];
  const contacts: { target: number; age: number }[] = [];
  const health = context.bot.health;
  let healthChanged = false;
  let reoffered = false;
  const onHealth = () => { healthChanged ||= context.bot.health !== health; };
  const onChat = (line: string) => {
    const target = fights[0]?.target;
    if (reoffered && target != null && (line === "pacing_contact" || line.endsWith("] pacing_contact")))
      contacts.push({ target, age: context.bot.time.age });
  };
  const stop = observeExecution(event => {
    if (event.owner.bot !== context.bot.username || event.owner.operation !== "combat") return;
    const fight = fights.find(fight => fight.scope === event.scopeId);
    if (event.kind === "closed") { if (fight) fight.endAge = context.bot.time.age; return; }
    if (!fight) fights.push({ scope: event.scopeId, target: event.owner.targetId, startAge: context.bot.time.age, endAge: null });
  });
  context.bot.on("health", onHealth);
  context.bot.on("messagestr", onChat);
  return {
    fights, outcomes, contacts,
    evidence: (): PacingEvidence => ({ fights, outcomes, contacts, healthChanged: healthChanged || context.bot.health !== health }),
    reoffer: () => { reoffered = true; reofferTarget(context); },
    close: () => { stop(); context.bot.off("health", onHealth); context.bot.off("messagestr", onChat); },
  };
}

/** NoAI in both YAMLs prevents melee damage; stop the pacing teleports before placing that same zombie beside the moving bot. */
function reofferTarget(context: ScenarioContext): void {
  context.bot.chat("/tag @e[type=zombie,limit=1] add pacing_reoffered");
  const { x, y, z: positionZ } = context.bot.entity.position;
  context.bot.chat(`/tp @e[type=zombie,limit=1] ${x + 1} ${y} ${positionZ}`);
  context.bot.chat("/execute at @s if entity @e[type=zombie,distance=..2] run say pacing_contact");
}

const pacingReceipt = z.object({ outcome: z.object({
  response: z.enum(["fight", "evade"]), threats: z.array(z.object({ id: z.number() })), outcome: z.string(), error: z.string().nullish(),
}) });

/** The cursor advances on every read, so each durable outcome is collected once. */
async function readPacingOutcomes(context: ScenarioContext, outcomes: PacingOutcome[]): Promise<boolean> {
  let separated = false;
  const page = readRecentEventsResultSchema.parse((await context.call("read_recent_events", { limit: 100 })).result);
  for (const event of page.events) {
    if (event.type !== "survival_outcome" || event.payload.source !== "hostile_reflex") continue;
    const receipt = pacingReceipt.safeParse(event.payload.evidence);
    if (!receipt.success) continue;
    const { response, outcome, error, threats } = receipt.data.outcome;
    if (response === "fight") outcomes.push({ outcome, ...(typeof error === "string" ? { error } : {}), targets: threats.map(threat => threat.id) });
    else separated ||= outcome === "safe_separation";
  }
  return separated;
}

/** Observe one no-damage limit and the complete answer window; the stopped-clock backstop remains independent. */
export async function run(context: ScenarioContext, sleep: (ms: number) => Promise<void> = delay) {
  const observed = observePacing(context);
  const began = monotonicNow();
  const startAge = context.bot.time.age;
  let lastAge = startAge;
  let lastAdvance = began;
  let reoffered = false;
  try {
    // The runtime is already live during preparation; activate contact only after subscribing (10 tps startup red, T28).
    context.bot.chat("/tag @e[type=zombie,limit=1] add pacing_active");
    while (true) {
      const age = context.bot.time.age;
      if (age !== lastAge) { lastAge = age; lastAdvance = monotonicNow(); }
      // wall bound: count from the last world-age advance, so a moving slow clock has no wall cap.
      assert.ok(monotonicNow() - lastAdvance < DRIVER_CLOCK_STOPPED_MS,
        `server clock stopped: world age ${age} has not moved for ${DRIVER_CLOCK_STOPPED_MS} ms, ${age - startAge} ticks after the start; ${JSON.stringify(observed.evidence())}`);
      const separated = await readPacingOutcomes(context, observed.outcomes);
      const first = observed.fights[0];
      // An offer during an ongoing evade is not a fresh decision; offer again after its confirmed separation (T28 zero-lifetime trace).
      if (first?.endAge != null && (!reoffered || separated)) { reoffered = true; observed.reoffer(); }
      assert.equal(observed.evidence().healthChanged, false, "health changed: neither side deals damage in this fixture");
      if (age - startAge > MAX_FIGHT_TICKS || first?.endAge != null && age - first.endAge >= ANSWER_TICKS - STALE_AGE_TICKS) break;
      await sleep(100);
    }
    const evidence = observed.evidence();
    const problems = judgePacing(evidence);
    const closedAge = evidence.fights[0]?.endAge;
    if (closedAge != null && context.bot.time.age - closedAge < ANSWER_TICKS - STALE_AGE_TICKS)
      problems.push("answer window not fully observed before the world-age budget");
    assert.deepEqual(problems, [], `${problems.join("; ")}: ${JSON.stringify(evidence)}`);
    return { status: "succeeded" as const, detail: JSON.stringify({ ...evidence, elapsedMs: monotonicNow() - began, ageTicks: context.bot.time.age - startAge }) };
  } finally {
    observed.close();
    await context.call("cancel_foreground_action", {});
  }
}
