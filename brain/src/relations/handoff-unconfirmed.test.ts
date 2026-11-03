// A toss no packet showed taken and nothing came back from is credited only when the partner's own record shows it (plan 2026-11-03 handover-ledge-and-unconfirmed-toss, Task F2).
import assert from "node:assert/strict";
import test from "node:test";
import { Body } from "../body.ts";
import type { Clock } from "../conversation/socialise.ts";
import type { SkillContext, SkillResult } from "../skills.ts";
import { FakeRuntime } from "../testing.ts";
import { awaitTheirSide, handoffOutcome, runHandoff, tellUnreachable, UNCONFIRMED_WAIT_MS, type GetBack, type PartnerWitness } from "./handoff.ts";
import type { ItemCount } from "./types.ts";

const contextFor = (runtime: FakeRuntime, signal = new AbortController().signal): SkillContext => ({ runtime, body: new Body(runtime, () => undefined), signal });

const BAG = [{ name: "bread", count: 5 }, { name: "oak_log", count: 4 }];
/** Theo stands 2 blocks away and the bag holds what the tests give. */
const near = (runtime: FakeRuntime): void => {
  runtime.snapshot = { ...runtime.snapshot, inventory: BAG, players: [{ username: "Theo", position: { x: 2, y: 64, z: 0 } }] };
};

/** A toss with no packet seen taken (`seenTaken` of `dropped`), the answer settled. */
const tossed = (item: string, dropped: number, seenTaken = 0) =>
  ({ status: "succeeded", error: null, dropped: [{ item, dropped }], recipient: { collected: seenTaken >= dropped, collectedCount: seenTaken, settled: true } }) as const;
/** A pick-back that finds nothing at the toss spot. */
const nothingBack = (runtime: FakeRuntime): void => {
  runtime.failures.pick_up_items = "[NO_MATCHING_ITEMS] No matching loaded dropped items were observed in the area.";
  runtime.failureResults.pick_up_items = { pickup: { observed: 0, sightings: [] } };
};
const dropCalls = (runtime: FakeRuntime): number => runtime.submitted.filter((call) => call.tool === "drop_item").length;

/** A clock that moves only when slept on; `onSleep` runs after each sleep (the partner's book moves with the time). */
function fakeClock(onSleep: (now: number) => void = () => undefined): Clock {
  let now = 0;
  return { now: () => now, sleep: async (ms) => { now += ms; onSleep(now); } };
}

/** The partner's record: what it shows received beyond my credit, as a function of the time on `clock` (null: it holds no such trade). */
function witnessOf(clock: Clock, shows: (now: number) => readonly ItemCount[] | null): PartnerWitness {
  return { unclaimed: () => shows(clock.now()), cannotReach: () => undefined, clock };
}

const give = (runtime: FakeRuntime, items: readonly ItemCount[], taken: ItemCount[], witness?: PartnerWitness, back?: GetBack, signal?: AbortSignal) =>
  runHandoff(contextFor(runtime, signal), { kind: "give", tradeId: "t", partner: "Theo", items }, (credit) => taken.push(credit), back, witness);

test("an unconfirmed toss the partner's record shows at 4.9 s is credited in full, with no doubt in the detail", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  nothingBack(runtime);
  runtime.dropOutcomes.push(tossed("oak_log", 4));
  const clock = fakeClock();
  const taken: ItemCount[] = [];
  const ended = handoffOutcome(await give(runtime, [{ item: "oak_log", count: 4 }], taken, witnessOf(clock, (now) => (now >= 4_900 ? [{ item: "oak_log", count: 4 }] : []))));
  assert.equal(ended.outcome, "done");
  assert.doesNotMatch(ended.detail, /not confirmed/u);
  assert.deepEqual(taken, [{ item: "oak_log", count: 4 }]);
  assert.equal(dropCalls(runtime), 1);
});

test("an unconfirmed toss the partner's record never shows ends not_taken after the wait, credits nothing and tells what was not seen taken", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  nothingBack(runtime);
  runtime.dropOutcomes.push(tossed("oak_log", 4));
  const clock = fakeClock();
  const taken: ItemCount[] = [];
  const ended = handoffOutcome(await give(runtime, [{ item: "oak_log", count: 4 }], taken, witnessOf(clock, () => [])));
  assert.equal(ended.outcome, "not_taken");
  assert.equal(ended.detail, "Theo has not got 4 oak_log: the toss was not seen taken");
  assert.deepEqual(taken, []);
  assert.ok(clock.now() >= UNCONFIRMED_WAIT_MS && clock.now() < UNCONFIRMED_WAIT_MS + 2_000, `waited ${clock.now()} ms on the clock`);
});

test("a toss result naming no take (no recipient) is unconfirmed too: not credited by the lack of a sighting", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  nothingBack(runtime);
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "oak_log", dropped: 4 }] });
  const taken: ItemCount[] = [];
  const ended = handoffOutcome(await give(runtime, [{ item: "oak_log", count: 4 }], taken, witnessOf(fakeClock(), () => [])));
  assert.equal(ended.outcome, "not_taken");
  assert.deepEqual(taken, []);
});

test("a partner outside the brain keeps today's credit with its note", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  nothingBack(runtime);
  runtime.dropOutcomes.push(tossed("oak_log", 4));
  const taken: ItemCount[] = [];
  const ended = handoffOutcome(await give(runtime, [{ item: "oak_log", count: 4 }], taken));
  assert.equal(ended.outcome, "done");
  assert.match(ended.detail, /4 oak_log not confirmed taken/u);
  assert.deepEqual(taken, [{ item: "oak_log", count: 4 }]);
});

test("a partner the board has no record for (a restart emptied it) is treated as a player: today's credit", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  nothingBack(runtime);
  runtime.dropOutcomes.push(tossed("oak_log", 4));
  const taken: ItemCount[] = [];
  const ended = handoffOutcome(await give(runtime, [{ item: "oak_log", count: 4 }], taken, witnessOf(fakeClock(), () => null)));
  assert.equal(ended.outcome, "done");
  assert.match(ended.detail, /not confirmed taken/u);
  assert.deepEqual(taken, [{ item: "oak_log", count: 4 }]);
});

test("a toss part-taken (1 of 2 seen) credits the seen one and asks the board for the other", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  nothingBack(runtime);
  runtime.dropOutcomes.push(tossed("bread", 2, 1));
  const clock = fakeClock();
  const taken: ItemCount[] = [];
  const ended = handoffOutcome(await give(runtime, [{ item: "bread", count: 2 }], taken, witnessOf(clock, (now) => [{ item: "bread", count: now >= 2_000 ? 2 : now >= 1_000 ? 1 : 0 }])));
  assert.equal(ended.outcome, "done");
  assert.equal(taken.reduce((sum, c) => sum + c.count, 0), 2);
});

test("a toss part-taken whose other half the board never shows ends not_taken for that half, the seen half credited", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  nothingBack(runtime);
  runtime.dropOutcomes.push(tossed("bread", 2, 1));
  const taken: ItemCount[] = [];
  const ended = handoffOutcome(await give(runtime, [{ item: "bread", count: 2 }], taken, witnessOf(fakeClock(), (now) => [{ item: "bread", count: now >= 1_000 ? 1 : 0 }])));
  assert.equal(ended.outcome, "not_taken");
  assert.equal(ended.detail, "Theo has not got 1 bread: the toss was not seen taken");
  assert.deepEqual(taken, [{ item: "bread", count: 1 }]);
});

test("several items, the second unconfirmed: the first stays credited and the give ends not_taken", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  nothingBack(runtime);
  runtime.dropOutcomes.push(tossed("bread", 5, 5), tossed("oak_log", 2));
  const taken: ItemCount[] = [];
  const ended = handoffOutcome(await give(runtime, [{ item: "bread", count: 5 }, { item: "oak_log", count: 2 }], taken, witnessOf(fakeClock(), () => [])));
  assert.equal(ended.outcome, "not_taken");
  assert.deepEqual(taken, [{ item: "bread", count: 5 }]);
});

test("what the record showed before the toss is not the toss: the wait reads the record against its state before the toss", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  nothingBack(runtime);
  runtime.dropOutcomes.push(tossed("oak_log", 2));
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_log", count: 4 }] };
  const taken: ItemCount[] = [];
  // The record shows 2 oak_log from before this give: they are credited at the start and only the other 2 are tossed; the record not moving since is no take of those.
  const ended = handoffOutcome(await give(runtime, [{ item: "oak_log", count: 4 }], taken, witnessOf(fakeClock(), () => [{ item: "oak_log", count: 2 }])));
  assert.equal(ended.outcome, "not_taken");
  assert.equal(ended.detail, "Theo has not got 2 oak_log: the toss was not seen taken");
  assert.deepEqual(taken, [{ item: "oak_log", count: 2 }]);
});

test("an item the record already shows received before the give (a late credit) is not tossed again", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  const taken: ItemCount[] = [];
  const ended = handoffOutcome(await give(runtime, [{ item: "oak_log", count: 4 }], taken, witnessOf(fakeClock(), () => [{ item: "oak_log", count: 4 }])));
  assert.equal(ended.outcome, "done");
  assert.deepEqual(taken, [{ item: "oak_log", count: 4 }]);
  assert.equal(dropCalls(runtime), 0);
});

test("an item the record shows received that I no longer carry is credited, not fetched back", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  runtime.snapshot = { ...runtime.snapshot, inventory: [] };
  const taken: ItemCount[] = [];
  const back = { getBackMs: 60_000, stillDue: () => true };
  const ended = handoffOutcome(await give(runtime, [{ item: "oak_log", count: 4 }], taken, witnessOf(fakeClock(), () => [{ item: "oak_log", count: 4 }]), back));
  assert.equal(ended.outcome, "done");
  assert.equal(dropCalls(runtime) > 0, false);
});

test("the trade ending during the wait gives no credit: the trade is over", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  nothingBack(runtime);
  runtime.dropOutcomes.push(tossed("oak_log", 4));
  const clock = fakeClock();
  const taken: ItemCount[] = [];
  const back = { getBackMs: 60_000, stillDue: () => clock.now() < 2_000 };
  const result = await give(runtime, [{ item: "oak_log", count: 4 }], taken, witnessOf(clock, () => []), back);
  assert.equal(result.status, "failed");
  assert.match(handoffOutcome(result).detail, /the trade is over/u);
  assert.deepEqual(taken, []);
});

test("a cancel during the wait is stopped", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  nothingBack(runtime);
  runtime.dropOutcomes.push(tossed("oak_log", 4));
  const abort = new AbortController();
  const clock = fakeClock((now) => { if (now >= 2_000) abort.abort(); });
  const taken: ItemCount[] = [];
  const result = await give(runtime, [{ item: "oak_log", count: 4 }], taken, witnessOf(clock, () => []), undefined, abort.signal);
  assert.equal(handoffOutcome(result).outcome, "dropped");
  assert.deepEqual(taken, []);
});

test("the wait looks once a second and stops at its bound on the clock, with no world tick", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  nothingBack(runtime);
  runtime.dropOutcomes.push(tossed("oak_log", 4));
  let looks = 0;
  await give(runtime, [{ item: "oak_log", count: 4 }], [], witnessOf(fakeClock(), () => { looks += 1; return []; }));
  assert.ok(looks <= UNCONFIRMED_WAIT_MS / 1_000 + 3, `${looks} looks`);
});

test("a give that failed as the recipient being out of reach tells a partner of this brain once; any other failure tells nobody", () => {
  let told = 0;
  const witness: PartnerWitness = { unclaimed: () => [], cannotReach: () => { told += 1; }, clock: fakeClock() };
  const failed = (reason?: "recipient_unreachable" | "recipient_busy"): SkillResult => ({ status: "failed", detail: "x", ...(reason !== undefined && { reason }) });
  tellUnreachable(failed("recipient_busy"), witness);
  tellUnreachable(failed(), witness);
  tellUnreachable({ status: "stopped" }, witness);
  assert.equal(told, 0);
  tellUnreachable(failed("recipient_unreachable"), witness);
  assert.equal(told, 1);
  tellUnreachable(failed("recipient_unreachable"), undefined);
});

/** A wait whose partner's payment comes after `paidAfter` polls; the giver asks it to come down from poll `askedAfter`. */
function waitWalks(runtime: FakeRuntime, o: { readonly paidAfter: number; readonly askedAfter: number }) {
  let polls = 0;
  let paid = false;
  let asks = 0;
  const clock: Clock = { now: () => polls * 1_000, sleep: async () => { polls += 1; if (polls === o.paidAfter) paid = true; } };
  const asked = () => polls >= o.askedAfter && asks++ === 0;
  return awaitTheirSide(contextFor(runtime), "Theo", { stillAwaiting: () => !paid, endedAs: () => null, clock, maxMs: 180_000, openingDistance: 16, askedToCome: asked });
}

test("wait walks to a giver that cannot reach, then the give is taken", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  const result = await waitWalks(runtime, { paidAfter: 6, askedAfter: 2 });
  assert.deepEqual(result, { status: "done", detail: "they gave" });
  assert.equal(runtime.submitted.filter((call) => call.tool === "navigate").length, 1, "walked to the giver once");
});

test("a recipient on a pillar the walk cannot reach: the give fails recipient_unreachable and the partner's wait walks down to the giver (F3, end to end)", async () => {
  const giver = new FakeRuntime();
  giver.snapshot = { ...giver.snapshot, inventory: BAG, players: [{ username: "Theo", position: { x: 2, y: 66, z: 0 } }] };
  giver.failures.navigate = "[NO_PATH] no path to Theo";
  giver.dropOutcomes.push({ status: "failed", error: "[DROP_RECIPIENT_OUT_OF_REACH] Theo stands still 2 blocks above me, where I found no floor to toss from that lets an item rest at their feet; nothing was tossed. Ask them to come down to my floor, then hand over again.", dropped: [{ item: "oak_log", dropped: 0 }] });
  let asked = false;
  const witness: PartnerWitness = { unclaimed: () => [], cannotReach: () => { asked = true; }, clock: fakeClock() };
  const ended = await give(giver, [{ item: "oak_log", count: 4 }], [], witness);
  assert.equal(ended.status === "failed" ? ended.reason : "", "recipient_unreachable");
  assert.equal(dropCalls(giver), 1);
  const partner = new FakeRuntime();
  near(partner);
  let polls = 0;
  const clock: Clock = { now: () => polls * 1_000, sleep: async () => { polls += 1; } };
  await awaitTheirSide(contextFor(partner), "Theo", { stillAwaiting: () => polls < 3, endedAs: () => null, clock, maxMs: 180_000, openingDistance: 16, askedToCome: () => asked && !(asked = false) });
  assert.equal(partner.submitted.filter((call) => call.tool === "navigate").length, 1, "the partner walked to the giver");
});
