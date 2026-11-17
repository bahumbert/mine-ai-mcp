import assert from "node:assert/strict";
import test from "node:test";
import { combatPolicySchema, DEFAULT_COMBAT_POLICY } from "./contract.js";
import type { ThreatAssessment } from "../../perception/combat/threat-assessment.js";
import { createFakeBot } from "../../../test-support/fake-bot/index.js";
import { ActionRunner } from "../../../session/action-runner.js";
import { ReflexDriver } from "../../control/driver.js";
import type { SurvivalTransition } from "../../control/contract.js";
import { combatDecisionFacts } from "../../../test-support/combat.js";
import {
  combatDecisionEvidence,
  combatResponseExclusions,
  decideCombatResponse,
  type CombatDecisionFacts,
  type CombatPurpose,
} from "./decision.js";
import { decideHostileReflex, describeDirectiveReason } from "./reflex-decision.js";

const scene = (): CombatDecisionFacts => combatDecisionFacts({
  policy: { ...DEFAULT_COMBAT_POLICY, engagement: "defend_only" },
  health: 20,
  burning: false,
  hideAllowed: false,
  recoveryAvailable: true,
  weapon: true,
  rangedWeapon: false,
  shield: true,
  fireball: null,
  answeredFights: new Map(),
  answered: new Set(),
  contacts: [
    {
      id: 7,
      name: "piglin",
      position: { x: 2, y: 64, z: 0 },
      distance: 2,
      relationship: { avoid: true, defend: false, attention: "unknown" },
      inContact: true,
      inReach: true,
      defendsOnContact: true,
      ranged: false,
      utility: { inReach: true, visible: true, hasHitUs: false, safeDropGround: true, distance: 2 },
    },
  ],
});

test("prohibiting retreat does not authorize an angry piglin whose victim is unknown", () => {
  const facts = scene();
  const response = decideCombatResponse(
    { ...facts, policy: { ...facts.policy, retreat: false } },
    { kind: "automatic" },
  );
  assert.equal(response.kind, "constrained");
  assert.equal(decideCombatResponse(facts, { kind: "automatic" }).kind, "evade");
});

test("defend_only keeps the explicit quarry while handoff never chooses fresh pursuit", () => {
  const facts = scene();
  const request = decideCombatResponse(facts, {
    kind: "pursuit",
    targetId: 42,
    minimumHealth: facts.policy.engage_min_health,
  });
  assert.equal(request.kind, "fight");
  if (request.kind === "fight") assert.equal(request.targetId, 42);
  assert.equal(decideCombatResponse(facts, { kind: "handoff" }).kind, "evade");
});

test("an exhausted recovery blocks reentry while a permitted enclosure can still secure handoff", () => {
  const facts = { ...scene(), health: 6, hideAllowed: true, answered: new Set(["recovery"]) };
  assert.equal(decideCombatResponse(facts, { kind: "recovery", targetId: 42 }).kind, "constrained");
  assert.equal(decideCombatResponse(facts, { kind: "automatic" }).kind, "evade");
  assert.equal(decideCombatResponse(facts, { kind: "handoff" }).kind, "hide");
});

test("serialized decision inputs retain every scope needed to replay the decision", () => {
  const facts = {
    ...scene(),
    answeredFights: new Map([[7, 28]]),
    answered: new Set(["fight", "hide", "recovery"]),
  };
  for (const purpose of [
    { kind: "automatic" },
    { kind: "pursuit", targetId: 42, minimumHealth: 12 },
    { kind: "recovery", targetId: 42 },
    { kind: "handoff" },
  ] satisfies CombatPurpose[]) {
    const decision = decideCombatResponse(facts, purpose);
    const receipt = JSON.parse(JSON.stringify(combatDecisionEvidence(facts, purpose, decision))) as {
      inputs: Omit<CombatDecisionFacts, "answered" | "answeredFights"> & {
        answered: string[];
        answeredFights: [number, number][];
      };
      purpose: CombatPurpose;
      decision: ReturnType<typeof decideCombatResponse>;
    };
    assert.deepEqual(receipt.inputs.answeredFights, [[7, 28]]);
    assert.deepEqual(receipt.inputs.answered, ["fight", "hide", "recovery"]);
    assert.deepEqual(
      decideCombatResponse(
        {
          ...receipt.inputs,
          answeredFights: new Map(receipt.inputs.answeredFights),
          answered: new Set(receipt.inputs.answered),
        },
        receipt.purpose,
      ),
      receipt.decision,
    );
  }
});

test("a wounded defender keeps a failed fight excluded without resolving its threat or excluding a new target id", () => {
  // EnderSeeker 2026-09-11: blocked retreat was forgotten by selection at full
  // health and melee reach, then vetoed by the driver while the creeper remained.
  const facts = scene();
  const creeper = {
    ...facts.contacts[0]!,
    name: "creeper",
    distance: 0.36,
    relationship: { avoid: true, defend: true, attention: "on_sight" as const },
  };
  const blocked = { ...facts, health: 11, contacts: [creeper], answeredFights: new Map([[7, 28]]) };
  for (const purpose of [
    { kind: "automatic" },
    { kind: "pursuit", targetId: 7, minimumHealth: 12 },
    { kind: "contact_defence", targetId: 7 },
  ] satisfies CombatPurpose[]) {
    const response = decideCombatResponse(blocked, purpose);
    assert.notEqual(response.kind, "none", "failed attempt is not resolved danger");
    assert.notEqual(response.kind, "constrained", "an unanswered withdrawal is still permitted");
    assert.ok(response.kind !== "fight" || response.targetId !== 7, "selection must honor admission's exclusion");
    assert.ok("threats" in response && response.threats.some(({ id }) => id === 7));
  }
  const another = { ...creeper, id: 8, name: "zombie" };
  const response = decideCombatResponse({ ...blocked, health: 20, contacts: [{ ...creeper, inReach: false }, another] }, { kind: "automatic" });
  assert.ok(response.kind === "fight" && response.targetId === 8, "failure is target-specific");
  assert.equal(decideCombatResponse({ ...blocked, contacts: [] }, { kind: "automatic" }).kind, "none");
});

test("standing-down evidence separates a retained failure from a prohibited response", () => {
  const facts = { ...scene(), policy: { ...DEFAULT_COMBAT_POLICY, retreat: false, hide: "never" as const } };
  assert.deepEqual(combatResponseExclusions(facts, "no route", new Map([["fight", 17]])), [
    { response: "fight", excluded: { kind: "answered", entry: 17 } },
    { response: "hide", excluded: { kind: "prohibited", field: "hide" } },
    { response: "evade", excluded: { kind: "prohibited", field: "retreat" } },
  ]);
});

const skeletonScene = (): CombatDecisionFacts => ({
  ...scene(),
  contacts: [
    {
      id: 24617,
      name: "skeleton",
      position: { x: 6, y: 64, z: 0 },
      distance: 6,
      relationship: { avoid: true, defend: true, attention: "on_sight" },
      inContact: true,
      inReach: false,
      defendsOnContact: false,
      ranged: true,
      utility: { inReach: false, visible: true, hasHitUs: false, safeDropGround: true, distance: 6 },
    },
  ],
});

test("a hunted species in contact is fought, not withdrawn from, until health rules say otherwise", () => {
  const facts = skeletonScene();
  assert.equal(decideCombatResponse(facts, { kind: "automatic" }).kind, "evade");
  const hunted = decideCombatResponse(facts, { kind: "automatic", quarry: ["skeleton"] });
  assert.equal(hunted.kind, "fight");
  if (hunted.kind === "fight") assert.equal(hunted.targetId, 24617);
  assert.equal(decideCombatResponse(facts, { kind: "automatic", quarry: ["zombie"] }).kind, "evade");
  const hurt = decideCombatResponse({ ...facts, health: 10 }, { kind: "automatic", quarry: ["skeleton"] });
  assert.equal(hurt.kind, "evade");
  if (hurt.kind === "evade") assert.equal(hurt.reason, "hurt");
});

test("a hunted contact whose fight is answered leaves the decision to the hunt", () => {
  const facts = skeletonScene();
  const answered = decideCombatResponse(
    { ...facts, answeredFights: new Map([[24617, 3]]) },
    { kind: "automatic", quarry: ["skeleton"] },
  );
  assert.equal(answered.kind, "none");
  const other = decideCombatResponse({ ...facts, answeredFights: new Map([[24617, 3]]) }, { kind: "automatic" });
  assert.equal(other.kind, "evade");
});

test("a hostile interruption names the decision's reason so the caller can act on it", () => {
  const facts = skeletonScene();
  const directive = decideCombatResponse(facts, { kind: "automatic" });
  const decision = decideHostileReflex({ facts, directive, settling: false, combatOwnsBody: false, entries: [] });
  assert.equal(decision.kind, "respond");
  if (decision.kind === "respond")
    assert.equal(
      decision.reason,
      "[HOSTILE_CONTACT] evade response for skeleton#24617 at 6,64,0 (6 blocks) (withdraw: no permitted attack, or defend_only engagement out of reach).",
    );
  const fight = decideCombatResponse(facts, { kind: "automatic", quarry: ["skeleton"] });
  const fighting = decideHostileReflex({ facts, directive: fight, settling: false, combatOwnsBody: false, entries: [] });
  if (fighting.kind === "respond") assert.equal(fighting.reason, "[HOSTILE_CONTACT] fight response for skeleton#24617 at 6,64,0 (6 blocks).");
});

/** Hand-priced inputs isolate policy from the separately tested damage formulas. */
function weighedScene(margin: number | null = 0.6) {
  const base = scene();
  const contact = { ...base.contacts[0]!, name: "zombie", defendsOnContact: false,
    relationship: { avoid: true, defend: true, attention: "on_sight" as const } };
  const assessment: ThreatAssessment = {
    bot: { effectiveHealth: 20, armor: 0, toughness: 0 },
    weapon: { item: null, damage: 1, intervalTicks: 10 },
    contacts: [{ id: 7, species: "zombie", damagePerHit: 3, damageSource: "attribute", unknownMelee: false,
      hitIntervalTicks: 20, health: 20, hitsToKill: 22, ticksToKill: 220, hitsToKillBot: 7,
      explosion: null, inContact: true }],
    ticksToDie: 133, ticksToClear: 220, healthLostToClear: 33, margin,
    source: { version: "1.21.4", measured: true },
  };
  return { ...base, policy: { ...DEFAULT_COMBAT_POLICY, fight_margin: 1.5 }, contacts: [contact], assessment };
}

test("automatic fighting respects the margin, quarry, defence, ranged and answered-evade boundaries", async (t) => {
  const base = weighedScene();
  const cases = [
    { name: "bare hands outmatched", facts: base, want: "outmatched" },
    { name: "margin passes", facts: { ...base, assessment: { ...base.assessment, margin: 2.1 } }, want: "fight" },
    { name: "margin equals threshold", facts: { ...base, assessment: { ...base.assessment, margin: 1.5 } }, want: "fight" },
    { name: "hunt owns giving up", facts: base, purpose: { kind: "automatic", quarry: ["zombie"] } as const, want: "fight" },
    { name: "contact defence", facts: weighedScene(0.3), purpose: { kind: "contact_defence", targetId: 7 } as const, want: "fight" },
    { name: "retreat prohibited defends in reach", facts: { ...weighedScene(0.3), policy: { ...base.policy, retreat: false } }, want: "fight" },
    { name: "can shoot outside reach", facts: { ...base, rangedWeapon: true, contacts: [{ ...base.contacts[0]!, inReach: false }] }, want: "fight" },
    { name: "can shoot but melee contact", facts: { ...base, rangedWeapon: true }, want: "outmatched" },
    { name: "bow prohibited", facts: { ...base, rangedWeapon: true, policy: { ...base.policy, bow: false } }, want: "outmatched" },
    { name: "no damage to weigh", facts: weighedScene(null), want: "fight" },
    { name: "unmeasured source", facts: { ...base, assessment: { ...base.assessment, source: { version: "1.21.4", measured: false } } }, want: "outmatched" },
    { name: "answered evade hides", facts: { ...base, answered: new Set(["evade"]), hideAllowed: true }, want: "hide" },
    { name: "answered evade defends", facts: { ...base, answered: new Set(["evade"]) }, want: "fight" },
  ];
  for (const entry of cases) await t.test(entry.name, () => {
    const result = decideCombatResponse(entry.facts, entry.purpose ?? { kind: "automatic" });
    assert.equal(result.kind === "evade" ? result.reason : result.kind, entry.want);
  });
});

test("explosive decisions use assessed explosions and damage, including a damage-one carried weapon", () => {
  const base = weighedScene(null);
  // A different name proves the branch reads explosion data, not a species spelling.
  const contacts = [{ ...base.contacts[0]!, name: "measured_explosive" }];
  const explosive = { ...base.assessment.contacts[0]!, species: "measured_explosive", damagePerHit: null,
    explosion: { radius: 3, fuseTicks: 30, fuseRemainingTicks: null, damageAtReach: 16.75 } };
  for (const damage of [1, 2]) {
    const facts = { ...base, weapon: true, contacts, assessment: { ...base.assessment,
      weapon: { ...base.assessment.weapon, damage }, contacts: [explosive] } };
    const result = decideCombatResponse(facts, { kind: "automatic" });
    assert.equal(result.kind === "evade" ? result.reason : result.kind, damage === 1 ? "explosive" : "fight");
    for (const [bow, rangedWeapon] of [[false, true], [true, false], [true, true]]) {
      const pair = decideCombatResponse({ ...facts, policy: { ...facts.policy, bow: bow! }, rangedWeapon: rangedWeapon!,
        contacts: [...contacts, { ...contacts[0]!, id: 8 }],
        assessment: { ...facts.assessment, contacts: [explosive, { ...explosive, id: 8 }] } }, { kind: "automatic" });
      assert.equal(pair.kind === "evade" ? pair.reason : pair.kind,
        damage === 1 || !bow || !rangedWeapon ? "explosive" : "fight");
    }
  }
  const order = decideCombatResponse({ ...base, contacts: [...contacts, { ...base.contacts[0]!, id: 8 }],
    assessment: { ...base.assessment, weapon: { ...base.assessment.weapon, damage: 2 },
      contacts: [explosive, { ...base.assessment.contacts[0]!, id: 8 }] } }, { kind: "automatic" });
  assert.ok(order.kind === "fight" && order.targetId === 8);
});

test("combat explanations give rounded costs without nested parentheses", () => {
  const base = weighedScene(0.202);
  const facts = { ...base, contacts: [...base.contacts, { ...base.contacts[0]!, id: 8 }],
    assessment: { ...base.assessment, healthLostToClear: 99,
      contacts: [...base.assessment.contacts, { ...base.assessment.contacts[0]!, id: 8 }] } };
  assert.equal(describeDirectiveReason("outmatched", facts),
    "outmatched: killing 2 zombie with bare hands would cost ~99 of your 20 health; margin 0.2 under fight_margin 1.5");
  assert.match(describeDirectiveReason("outmatched", { ...base,
    assessment: { ...base.assessment, contacts: [{ ...base.assessment.contacts[0]!, unknownMelee: true }] } }),
    /unknown melee damage.*keep away, or hunt_mob it to fight anyway/);
  assert.equal(describeDirectiveReason("explosive", { ...base,
    contacts: [{ ...base.contacts[0]!, name: "creeper", distance: 3 }],
    assessment: { ...base.assessment, contacts: [{ ...base.assessment.contacts[0]!, species: "creeper",
      explosion: { radius: 3, fuseTicks: 30, fuseRemainingTicks: null, damageAtReach: 16.75 } }] } }),
    "explosive: creeper at 3 blocks can deal ~17 of your 20 health at melee reach; you carry nothing stronger than a bare hand");
});

test("fight_margin rejects nonfinite and out-of-range policy edits", () => {
  assert.equal(DEFAULT_COMBAT_POLICY.fight_margin, 1.5);
  for (const fight_margin of [0, 1.5, 10]) assert.ok(combatPolicySchema.safeParse({ ...DEFAULT_COMBAT_POLICY, fight_margin }).success);
  for (const fight_margin of [-1, 11, NaN, Infinity]) assert.equal(combatPolicySchema.safeParse({ ...DEFAULT_COMBAT_POLICY, fight_margin }).success, false);
});

test("changing only assessment numbers or distances publishes one decision; target and reason changes publish", async (t) => {
  const { bot } = createFakeBot();
  await using driver = new ReflexDriver(bot, new ActionRunner());
  const events: SurvivalTransition[] = [];
  driver.onTransition((event) => events.push(event));
  let facts = weighedScene();
  driver.register({
    name: "hostile_reflex",
    sense: () => ({ kind: "observed", danger: facts, evidence: null }),
    decide: (observed) => decideHostileReflex({ facts: observed,
      directive: decideCombatResponse(observed, { kind: "automatic" }), settling: false, combatOwnsBody: false, entries: [] }),
    decisionFacts: (observed) => combatDecisionEvidence(observed, { kind: "automatic" }, decideCombatResponse(observed, { kind: "automatic" })),
    facts: () => ({ capability: "combat", response: "response", scope: "test", facts: () => null, permissions: () => null }),
    limits: () => ({ ceilingTicks: 12_000, noProgressTicks: 12_000, standDownTicks: 40 }),
    act: async () => true,
    continuation: () => ({ kind: "resume" }),
    failure: () => null,
    describe: () => null,
  });
  const tick = async () => { bot.emit("physicsTick"); await new Promise<void>((resolve) => setImmediate(resolve)); };
  await tick();
  const outcome = events.find((event) => event.kind === "outcome")!;
  const captured = outcome.evidence as { decision: { inputs: { assessment: { margin: number } } } };
  assert.equal(captured.decision.inputs.assessment.margin, 0.6, "outcomes carry the admission assessment for the world feed");
  await t.test("the decision identity does not change when a threat moves 0.1 block", async () => {
    facts = { ...facts, contacts: [{ ...facts.contacts[0]!, distance: 2.1 }] };
    await tick();
    assert.equal(events.filter((event) => event.kind === "decision").length, 1);
  });
  await t.test("the decision identity does not change when 06a's margin changes", async () => {
    facts = { ...facts, assessment: { ...facts.assessment, margin: 0.5, healthLostToClear: 40 } };
    await tick();
    assert.equal(events.filter((event) => event.kind === "decision").length, 1);
  });
  facts = { ...facts, contacts: [{ ...facts.contacts[0]!, id: 8 }] };
  await tick();
  assert.equal(events.filter((event) => event.kind === "decision").length, 2);
  facts = { ...facts, assessment: { ...facts.assessment, margin: 2.1 } };
  await tick();
  assert.equal(events.filter((event) => event.kind === "decision").length, 3);
});
