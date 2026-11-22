// Observe target-scoped fight retries while an unreachable skeleton keeps shooting.
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import type { ClientCompletion } from "mine-labs/client";
import type { Entity } from "prismarine-entity";
import { readRecentEventsResultSchema } from "../../../src/actions/read-recent-events/contract.ts";
import { observeExecution } from "../../../src/execution/execution-scope.ts";
import { arenaPoint } from "../arena/params.ts";
import { monotonicNow } from "../../../src/utils/monotonic-clock.ts";
import type { ScenarioContext } from "../scenario.ts";

const POLL_MS = 100;
interface Claim { readonly from: number }
interface Outcome { readonly id: number; readonly kind: "fight" | "evade" }

/** The fixed shooter's physical fight has one execution scope per claim; observe even claims shorter than a status poll. */
function observeFightStarts(context: ScenarioContext, claims: Claim[], began: number): () => void {
  const seen = new Set<string>();
  return observeExecution((event) => {
    if (event.owner.bot !== context.bot.username || event.owner.operation !== "combat" || seen.has(event.scopeId)) return;
    seen.add(event.scopeId);
    claims.push({ from: monotonicNow() - began });
  });
}

/** Check the frozen trace, including starts during the final polling wait (task review, 2026-11-09). */
function checkFightRetries(claims: readonly Claim[], outcomes: readonly Outcome[], minimumRetryMs: number): void {
  for (let index = 1; index < claims.length; index++)
    assert.ok(claims[index]!.from - claims[index - 1]!.from >= minimumRetryMs, JSON.stringify({ claims, index }));
  assert.ok(outcomes.filter((entry) => entry.kind === "fight").length >= claims.length, "every observed fight must settle");
  let fought = false;
  let evaded = false;
  for (const outcome of outcomes) {
    if (outcome.kind === "evade") { evaded = true; continue; }
    // Claims own the body serially: an evade outcome between fight outcomes proves it ran before the next fight.
    assert.ok(!fought || evaded, `an evade must separate fight claims: ${JSON.stringify(outcomes)}`);
    fought = true;
    evaded = false;
  }
}

/** Preserve the durable claim order; a later evade cannot answer an earlier pair (task review, 2026-11-09). */
async function readOutcomes(context: ScenarioContext, outcomes: Outcome[]): Promise<void> {
  for (let remaining = 1; remaining > 0;) {
    const page = readRecentEventsResultSchema.parse((await context.call("read_recent_events", { limit: 100 })).result);
    assert.equal(page.status, "succeeded");
    for (const event of page.events) {
      if (event.type !== "survival_outcome" || event.payload.source !== "hostile_reflex") continue;
      const evidence = z.object({ outcome: z.object({ response: z.enum(["fight", "evade"]) }) }).safeParse(event.payload.evidence);
      if (evidence.success) outcomes.push({ id: event.eventId, kind: evidence.data.outcome.response });
    }
    remaining = page.events.length ? page.remainingEventCount : 0;
  }
}

/** Keep the fixture on fight/evade so a failed enclosure cannot end the shooting experiment. */
async function setLedgePolicy(context: ScenarioContext): Promise<void> {
  const status = await context.call("view_status", {});
  const revision = status.survivalPolicy?.revision;
  assert.ok(revision, "status must expose the policy revision");
  const set = await context.call("set_survival_policy", {
    operation: "set", expected_revision: revision,
    changes: { combat: { hide: "never", terrain: { dig: false, place: false } } },
    lifetime: { kind: "session" }, reason: "Measure unreachable fight retention without terrain changes.",
  });
  assert.equal(set.result.status, "succeeded", set.summary);
}

/** Measure physical fight starts monotonically and the intervening evades in durable claim order. */
export async function run(context: ScenarioContext, sleep: (ms: number) => Promise<void> = delay): Promise<ClientCompletion> {
  const { observeMs, minimumRetryMs, steps, shooter } = z.strictObject({ observeMs: z.number().positive(), minimumRetryMs: z.number().positive(),
    shooter: arenaPoint(context.arena),
    steps: z.array(arenaPoint(context.arena)).min(2) })
    .parse(context.scenario.params);
  await setLedgePolicy(context);
  const claims: Claim[] = [];
  const outcomes: Outcome[] = [];
  let shots = 0;
  let retained = false;
  let targetId: number | undefined;
  const shot = (entity: Entity) => { if (entity.name === "arrow") shots++; };
  context.bot.on("entitySpawn", shot);
  const began = monotonicNow();
  const stopWatchingFights = observeFightStarts(context, claims, began);
  let nextStep = began + 5_000;
  let step = 0;
  try {
    // Spawn after policy setup and listeners: preparation must not contribute a cancelled fight (review trial 4, 2026-11-09).
    context.bot.chat(`/summon minecraft:skeleton ${shooter.join(" ")} {PersistenceRequired:1b,Invulnerable:1b,HandItems:[{id:"minecraft:bow",count:1},{}]}`);
    while (monotonicNow() - began < observeMs) {
      const status = await context.call("view_status", {});
      const skeleton = Object.values(context.bot.entities).find((entity) => entity.name === "skeleton");
      if (skeleton) {
        targetId ??= skeleton.id;
        assert.equal(skeleton.id, targetId, "the shooter must keep its target id throughout the trial");
      }
      const survival = status.survival;
      assert.ok(survival, "status must expose survival observations");
      if (survival.owner.current === null && monotonicNow() >= nextStep) {
        context.bot.chat(`/tp @s ${steps[Math.min(step++, steps.length - 1)]!.join(" ")}`);
        nextStep = monotonicNow() + 5_000;
      }
      retained ||= survival.answered.some((entry) => entry.scope === `target:${targetId}` &&
        entry.failure.kind === "unreachable" && entry.temporal?.premise === "unreachable");
      await readOutcomes(context, outcomes);
      await sleep(POLL_MS);
    }
    stopWatchingFights();
    await readOutcomes(context, outcomes);
    const final = await context.call("view_status", {});
    assert.notEqual(final.survival?.response?.kind, "fight", "the final fight must settle before its evade order is known");
    checkFightRetries(claims, outcomes, minimumRetryMs);
    const detail = JSON.stringify({ claims, outcomes, shots, retained, targetId, observedMs: monotonicNow() - began });
    assert.ok(claims.length >= 2, `at least two actual fight claims are required: ${detail}`);
    assert.ok(retained && shots > 0, `an unreachable answer and real shots are required: ${detail}`);
    return { status: "succeeded", detail };
  } finally {
    stopWatchingFights();
    context.bot.off("entitySpawn", shot);
  }
}
