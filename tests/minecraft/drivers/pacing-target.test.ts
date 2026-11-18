// The pacing judge requires a no-damage fight and witnessed re-offer, and releases every observer on exit.
import assert from "node:assert/strict";
import test from "node:test";
import { scenarioDefinitionSchema } from "mine-labs";
import { ExecutionScope, executionChannel } from "../../../src/execution/execution-scope.ts";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { SurvivalPolicyState } from "../../../src/survival/state/survival-policy.ts";
import { arenaFrame } from "../arena/frame.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import type { ScenarioCall } from "../scenario.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "./server-ticks.ts";
import { judgePacing, MAX_FIGHT_TICKS, run } from "./pacing-target.ts";

const FIRST = { target: 7, startAge: 100, endAge: 700 };
const OUTCOME = { targets: [7], outcome: "target_unreachable", error: "No confirmed damage to zombie#7 during 600 server ticks of fighting." };
const PASSING = { fights: [FIRST], outcomes: [OUTCOME], contacts: [{ target: 7, age: 800 }], healthChanged: false };

test("the same target claimed at +200 after contact fails; +620 and another target pass", () => {
  assert.match(judgePacing({ ...PASSING, fights: [FIRST, { target: 7, startAge: 900, endAge: null }] }).join("; "), /claimed again/u);
  assert.deepEqual(judgePacing({ ...PASSING, fights: [FIRST, { target: 7, startAge: 1320, endAge: null }] }), []);
  assert.deepEqual(judgePacing({ ...PASSING, fights: [FIRST, { target: 8, startAge: 900, endAge: null }] }), []);
});

test("fight and answer bounds allow one stale packet: 580 fails, 581 passes", () => {
  for (const span of [570, 580, 581]) {
    const problems = judgePacing({ ...PASSING, fights: [{ ...FIRST, startAge: FIRST.endAge - span }] });
    assert.equal(problems.length, span < 581 ? 1 : 0, JSON.stringify({ span, problems }));
  }
  for (const gap of [580, 581]) {
    const problems = judgePacing({ ...PASSING, fights: [FIRST, { target: 7, startAge: 700 + gap, endAge: null }] });
    assert.equal(problems.length, gap < 581 ? 1 : 0, JSON.stringify({ gap, problems }));
  }
});

test("missing, early, expired or other-target contact cannot prove a re-offer", () => {
  for (const contacts of [[], [{ target: 7, age: 699 }], [{ target: 7, age: 1281 }], [{ target: 8, age: 800 }]]) {
    assert.match(judgePacing({ ...PASSING, contacts }).join("; "), /no re-offer/u);
  }
  assert.deepEqual(judgePacing({ ...PASSING, contacts: [{ target: 7, age: FIRST.endAge }] }), []);
  assert.deepEqual(judgePacing({ ...PASSING, contacts: [{ target: 7, age: 1280 }] }), []);
});

test("no_progress, another target's receipt, a different error, missing close or changed health fail", () => {
  for (const outcomes of [[], [{ ...OUTCOME, outcome: "no_progress" }], [{ ...OUTCOME, targets: [8] }], [{ ...OUTCOME, error: "No route" }]]) {
    assert.match(judgePacing({ ...PASSING, outcomes }).join("; "), /target_unreachable/u);
  }
  assert.match(judgePacing({ ...PASSING, fights: [{ ...FIRST, endAge: null }] }).join("; "), /no end/u);
  assert.match(judgePacing({ ...PASSING, healthChanged: true }).join("; "), /health/u);
});

interface Schedule {
  readonly rate: 20 | 10;
  readonly span?: number;
  readonly claimAfter?: number;
  readonly contactAfter?: number | null;
  readonly outcome?: string;
  readonly cancelThrows?: boolean;
  readonly commandThrows?: boolean;
  readonly healthDip?: boolean;
  readonly contactAfterSeparationOnly?: boolean;
}

/** Script execution receipts and command chat only; the real YAML measures the reflex and server contact. */
function pacingFixture(options: Schedule) {
  const clock = createFakeClock({ mode: "mocked" });
  const installed = clock.install();
  const harness = createFakeBot({ clock, server: { ticksPerSecond: options.rate } });
  const { bot } = harness;
  const added = listenersAddedSince(bot);
  const status = { summary: "safe", request: null,
    owner: { current: null, reserved: null, connected: true, transfer: null }, dangers: [], response: null,
    decisions: [], budgets: [], answered: [], observations: { missing: [], stale: [] },
    policy: new SurvivalPolicyState(bot).snapshot(), vitals: { health: 20, food: 20, air: null, inWater: false },
    runtime: { liveness: "observed_in_process", observedAt: 0, physicsObservedAt: null } };
  const unread: unknown[] = [];
  const calls: string[] = [];
  const commands: string[] = [];
  let activated = false;
  let contactQueries = 0;
  const msOf = (ticks: number) => ticks * 1000 / options.rate;
  const end = 100 + msOf(options.span ?? 600);
  clock.after(100, () => {
    if (!activated) return;
    const scope = new ExecutionScope({ bot: bot.username, operation: "combat", targetId: 7 });
    scope.runSync("swing", () => {});
    clock.after(end - 100, () => scope[Symbol.dispose]());
  });
  if (options.claimAfter !== undefined) clock.after(end + msOf(options.claimAfter), () => {
    using scope = new ExecutionScope({ bot: bot.username, operation: "combat", targetId: 7 });
    scope.runSync("swing", () => {});
  });
  clock.after(end, () => unread.push({
    eventId: 1, botId: bot.username, type: "survival_outcome", observedAt: new Date().toISOString(), summary: "fight settled",
    payload: { kind: "outcome", source: "hostile_reflex", evidence: { outcome: {
      response: "fight", threats: [{ id: 7 }], outcome: options.outcome ?? OUTCOME.outcome, error: OUTCOME.error,
    } }, status },
  }));
  clock.after(end + msOf(120), () => unread.push({
    eventId: 2, botId: bot.username, type: "survival_outcome", observedAt: new Date().toISOString(), summary: "separated",
    payload: { kind: "outcome", source: "hostile_reflex", evidence: { outcome: {
      response: "evade", threats: [{ id: 7 }], outcome: "safe_separation", error: null,
    } }, status },
  }));
  // A command interpreter is outside the shared fake: supply only the say answer used by this driver (S3).
  bot.chat = command => {
    commands.push(command);
    if (options.commandThrows) throw new Error("command refused");
    if (command === "/tag @e[type=zombie,limit=1] add pacing_active") activated = true;
    if (!command.endsWith("run say pacing_contact") || options.contactAfter === null) return;
    if (++contactQueries === 1 && options.contactAfterSeparationOnly) return;
    clock.after(msOf(options.contactAfter ?? 100), () => bot.emit("messagestr", `[${bot.username}] pacing_contact`, "system", {} as never));
  };
  if (options.healthDip) clock.after(500, () => {
    bot.health = 19;
    bot.emit("health");
    bot.health = 20;
    bot.emit("health");
  });
  const context = scenarioTestContext({ bot, arena: arenaFrame({ x: 64, z: 1536 }),
    scenario: scenarioDefinitionSchema.parse({ goal: { kind: "completion" } }),
    call: async (action: string) => {
      calls.push(action);
      if (action === "cancel_foreground_action" && options.cancelThrows) throw new Error("cancel refused");
      return { action, durationMs: 0, summary: "trace", result: {
        status: "succeeded", source: { queryIds: ["unread-events-page"] }, events: unread.splice(0), readThroughEventId: 1, remainingEventCount: 0,
      } } as ScenarioCall;
    },
  });
  return { clock, installed, harness, bot, context, sleep: clock.sleep, added, calls, commands, startAge: bot.time.age };
}

/** Each exit removes observers, cancels once, and performs no work at the old deadlines. */
async function assertCleanExit(fixture: ReturnType<typeof pacingFixture>) {
  const calls = [...fixture.calls];
  const commands = [...fixture.commands];
  assert.equal(calls.filter(call => call === "cancel_foreground_action").length, 1);
  assert.equal(calls.at(-1), "cancel_foreground_action");
  assert.equal(executionChannel.hasSubscribers, false);
  assert.equal(fixture.added("messagestr"), 0);
  assert.equal(fixture.added("health"), 0);
  await fixture.clock.advance(300_000);
  assert.deepEqual(fixture.calls, calls);
  assert.deepEqual(fixture.commands, commands);
}

for (const rate of [20, 10] as const) {
  test(`re-offer after safe separation provides contact when the first offer was missed at ${rate} tps`, async () => {
    const fixture = pacingFixture({ rate, contactAfterSeparationOnly: true });
    using _installed = fixture.installed;
    const result = await fixture.clock.settle(run(fixture.context, fixture.sleep), 300_000);
    assert.equal(JSON.parse(result.detail).contacts[0].age - JSON.parse(result.detail).fights[0].endAge, 220);
    await assertCleanExit(fixture);
  });

  test(`driver witnesses re-offer and waits the answer window at ${rate} tps`, async () => {
    const fixture = pacingFixture({ rate });
    using _installed = fixture.installed;
    const result = await fixture.clock.settle(run(fixture.context, fixture.sleep), 300_000);
    assert.equal(result.status, "succeeded");
    const detail = JSON.parse(result.detail);
    assert.equal(detail.fights.length, 1);
    assert.equal(detail.fights[0].endAge - detail.fights[0].startAge, 600);
    assert.equal(detail.contacts[0].age - detail.fights[0].endAge, 100);
    assert.equal(detail.ageTicks, 1200, `cached age at fake time ${1200 * 1000 / rate} ms`);
    assert.equal(fixture.clock.now(), 1200 * 1000 / rate);
    assert.ok(fixture.commands.some(command => command.startsWith("/tp @e[type=zombie,limit=1] ")));
    await assertCleanExit(fixture);
  });

  for (const [label, schedule, reason] of [
    ["early same-target claim", { claimAfter: 200 }, /claimed again/u],
    ["missing contact", { contactAfter: null }, /no re-offer/u],
    ["wrong outcome", { outcome: "no_progress" }, /target_unreachable/u],
    ["transient damage", { healthDip: true }, /health/u],
    ["command failure", { commandThrows: true }, /command refused/u],
    ["cancel failure", { cancelThrows: true }, /cancel refused/u],
  ] as const) test(`${label} fails and cleans up at ${rate} tps`, async () => {
    const fixture = pacingFixture({ rate, ...schedule });
    using _installed = fixture.installed;
    await assert.rejects(fixture.clock.settle(run(fixture.context, fixture.sleep), 300_000), reason);
    await assertCleanExit(fixture);
  });

  test(`stopped clock fails 30 seconds after its last advance at ${rate} tps`, async () => {
    const fixture = pacingFixture({ rate });
    using _installed = fixture.installed;
    fixture.clock.after(30_100, () => fixture.harness.server.stop());
    await assert.rejects(fixture.clock.settle(run(fixture.context, fixture.sleep), 300_000), /server clock stopped/u);
    assert.equal(fixture.bot.time.age - fixture.startAge, 30 * rate);
    assert.equal(fixture.clock.now(), 30_000 + DRIVER_CLOCK_STOPPED_MS);
    await assertCleanExit(fixture);
  });

  test(`unfinished fight fails past the world-age budget at ${rate} tps`, async () => {
    const fixture = pacingFixture({ rate, span: MAX_FIGHT_TICKS + 100 });
    using _installed = fixture.installed;
    await assert.rejects(fixture.clock.settle(run(fixture.context, fixture.sleep), 500_000), /no end/u);
    assert.equal(fixture.bot.time.age - fixture.startAge, MAX_FIGHT_TICKS + 20);
    assert.equal(fixture.clock.now(), (MAX_FIGHT_TICKS + 20) * 1000 / rate);
    await assertCleanExit(fixture);
  });

  test(`a late close cannot pass before the entire answer window at ${rate} tps`, async () => {
    const fixture = pacingFixture({ rate, span: MAX_FIGHT_TICKS - 200, contactAfter: 20 });
    using _installed = fixture.installed;
    await assert.rejects(fixture.clock.settle(run(fixture.context, fixture.sleep), 500_000), /answer window/u);
    await assertCleanExit(fixture);
  });
}
