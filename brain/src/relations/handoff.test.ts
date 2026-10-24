import assert from "node:assert/strict";
import test from "node:test";
import { Body } from "../body.ts";
import type { SkillContext } from "../skills.ts";
import { FakeRuntime } from "../testing.ts";
import type { Clock } from "../conversation/socialise.ts";
import type { ItemCount } from "./types.ts";
import { awaitTheirSide, describeHandoff, handoffKey, handoffOutcome, runHandoff, type AwaitOptions } from "./handoff.ts";

function contextFor(runtime: FakeRuntime): SkillContext {
  return { runtime, body: new Body(runtime, () => undefined), signal: new AbortController().signal };
}

const near = (runtime: FakeRuntime): void => {
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Theo", position: { x: 2, y: 64, z: 0 } }], inventory: [{ name: "bread", count: 5 }, { name: "oak_log", count: 4 }] };
};

test("a give hands each entry of my side to the partner and ends done", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  const result = await runHandoff(contextFor(runtime), { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "bread", count: 5 }, { item: "oak_log", count: 2 }] });
  assert.equal(handoffOutcome(result).outcome, "done");
  const drops = runtime.submitted.filter((call) => call.tool === "drop_item").map((call) => call.input);
  assert.deepEqual(drops.map((d) => [(d.items as { item_name: string; count: number }[])[0], d.to_player]), [[{ item_name: "bread", count: 5 }, "Theo"], [{ item_name: "oak_log", count: 2 }, "Theo"]]);
});

test("a give with items missing ends items_gone and hands over nothing", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  const result = await runHandoff(contextFor(runtime), { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "oak_log", count: 2 }, { item: "bread", count: 9 }] });
  const ended = handoffOutcome(result);
  assert.equal(ended.outcome, "items_gone");
  assert.match(ended.detail, /bread/u);
  assert.equal(runtime.submitted.some((call) => call.tool === "drop_item"), false);
});

test("a give that fails for another reason ends failed with the reason", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  runtime.failures.drop_item = "[PLAYER_UNREACHABLE] cannot reach Theo";
  const ended = handoffOutcome(await runHandoff(contextFor(runtime), { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "bread", count: 1 }] }));
  assert.equal(ended.outcome, "failed");
  assert.match(ended.detail, /PLAYER_UNREACHABLE/u);
});

test("a stopped hand-off is dropped, not failed", () => {
  assert.equal(handoffOutcome({ status: "stopped" }).outcome, "dropped");
});

test("a collect picks up each item of their side within 6 blocks", async () => {
  const runtime = new FakeRuntime();
  const result = await runHandoff(contextFor(runtime), { kind: "collect", tradeId: "t", items: [{ item: "iron_ingot", count: 5 }, { item: "bread", count: 1 }] });
  assert.equal(handoffOutcome(result).outcome, "done");
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "pick_up_items").map((call) => call.input), [{ item: "iron_ingot", radius: 6 }, { item: "bread", radius: 6 }]);
});

test("a collect after a give left items on the ground picks them up", async () => {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.groundItems = [{ item: "iron_ingot", count: 5 }, { item: "stick", count: 3 }];
  const result = await runHandoff(contextFor(runtime), { kind: "collect", tradeId: "t", items: [{ item: "iron_ingot", count: 5 }] });
  assert.equal(handoffOutcome(result).outcome, "done");
  assert.deepEqual(runtime.snapshot.inventory.map((s) => [s.name, s.count]), [["iron_ingot", 5]]);
  assert.deepEqual(runtime.groundItems, [{ item: "stick", count: 3 }]);
});

test("a collect that fails reports it", async () => {
  const runtime = new FakeRuntime();
  runtime.failures.pick_up_items = "[NO_ITEMS] nothing to pick up";
  const ended = handoffOutcome(await runHandoff(contextFor(runtime), { kind: "collect", tradeId: "t", items: [{ item: "bread", count: 1 }] }));
  assert.equal(ended.outcome, "failed");
});

const MIN = 60_000;
const awaitTheo = { kind: "await", tradeId: "t", partner: "Theo" } as const;

/** A fake clock that jumps as the game does (1 s polls), and a payment that arrives after `paidAfter` polls (never when null). */
function waiting(runtime: FakeRuntime, paidAfter: number | null, over: Partial<AwaitOptions> = {}) {
  let now = 0;
  const state = { polls: 0, paid: false };
  const clock: Clock = { now: () => now, sleep: async (ms) => { now += ms; state.polls += 1; if (state.polls === paidAfter) state.paid = true; } };
  const options: AwaitOptions = { stillAwaiting: () => !state.paid, clock, maxMs: 3 * MIN, openingDistance: 16, ...over };
  return { state, options, now: () => now, run: (context = contextFor(runtime)) => awaitTheirSide(context, "Theo", options) };
}

const navigates = (runtime: FakeRuntime): number => runtime.submitted.filter((call) => call.tool === "navigate").length;

test("an await names the partner whose side is awaited", () => {
  assert.equal(describeHandoff(awaitTheo), "wait for Theo to give their side (trade)");
  assert.equal(handoffKey(awaitTheo), "await:t");
  assert.equal(handoffKey({ kind: "collect", tradeId: "t", items: [] }), "t");
});

test("an await near the partner stays put and ends done when the payment is credited", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  const w = waiting(runtime, 4);
  const result = await w.run();
  assert.deepEqual(result, { status: "done", detail: "they gave" });
  assert.equal(navigates(runtime), 0, "within the opening distance: no walk");
  assert.equal(w.now(), 4_000, "polled every second");
});

test("an await far from the partner walks to them once, then waits", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Theo", position: { x: 40, y: 64, z: 0 } }] };
  const w = waiting(runtime, 3);
  assert.equal((await w.run()).status, "done");
  assert.equal(navigates(runtime), 1);
});

test("an await with the payment already credited ends done at once and walks nowhere", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Theo", position: { x: 40, y: 64, z: 0 } }] };
  const w = waiting(runtime, null, { stillAwaiting: () => false });
  assert.deepEqual(await w.run(), { status: "done", detail: "they gave" });
  assert.equal(navigates(runtime), 0);
  assert.equal(w.now(), 0);
});

test("no payment: the await fails after the bound on the clock alone, naming the minutes", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  const w = waiting(runtime, null);
  const result = await w.run();
  assert.deepEqual(result, { status: "failed", detail: "Theo did not give within 3 min" });
  assert.equal(handoffOutcome(result).outcome, "failed");
  assert.equal(w.now(), 3 * MIN, "no tick or game event is needed to end the wait");
});

test("a partner out of sight: go_to_player fails once, the wait still runs where it is and ends on the payment", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [] };
  const paid = waiting(runtime, 5);
  assert.equal((await paid.run()).status, "done");
  assert.equal(navigates(runtime), 0, "nothing to walk to");
  const unpaid = waiting(runtime, null);
  assert.equal((await unpaid.run()).status, "failed");
});

test("a walk that fails does not end the wait", async () => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [{ username: "Theo", position: { x: 40, y: 64, z: 0 } }] };
  runtime.failures.navigate = "[NO_PATH] no path";
  const w = waiting(runtime, 6);
  assert.deepEqual(await w.run(), { status: "done", detail: "they gave" });
  assert.equal(navigates(runtime), 1, "one try");
});

test("an await stopped mid-wait is dropped, not failed", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  const abort = new AbortController();
  const w = waiting(runtime, null);
  const clock: Clock = { now: w.options.clock.now, sleep: async (ms, signal) => { await w.options.clock.sleep(ms, signal); if (w.state.polls === 3) abort.abort(); } };
  const result = await awaitTheirSide({ ...contextFor(runtime), signal: abort.signal }, "Theo", { ...w.options, clock });
  assert.equal(handoffOutcome(result).outcome, "dropped");
  assert.equal(w.state.polls, 3, "no poll after the stop");
});

const tossed = (item: string, dropped: number, collectedCount: number) =>
  ({ status: "succeeded", error: null, dropped: [{ item, dropped }], recipient: { collected: collectedCount >= dropped, collectedCount } }) as const;
/** The toss lies on the ground (the fake's pick-up takes it back into the inventory). */
const onGround = (runtime: FakeRuntime, item: string, count: number): void => {
  runtime.simulateInventory = true;
  runtime.groundItems = [{ item, count }];
};
const picksUp = (runtime: FakeRuntime): unknown[] => runtime.submitted.filter((call) => call.tool === "pick_up_items").map((call) => call.input);

test("a toss the partner did not take is picked back up and the hand-off ends not_taken, naming what was not taken (s1d, bug A)", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  onGround(runtime, "oak_log", 4);
  runtime.dropOutcomes.push(tossed("oak_log", 4, 0));
  const taken: ItemCount[] = [];
  const result = await runHandoff(contextFor(runtime), { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "oak_log", count: 4 }] }, (credit) => taken.push(credit));
  const ended = handoffOutcome(result);
  assert.equal(ended.outcome, "not_taken");
  assert.equal(ended.detail, "Theo did not take 4 oak_log");
  assert.deepEqual(picksUp(runtime), [{ item: "oak_log", radius: 16 }]);
  assert.deepEqual(taken, [], "nothing taken, nothing credited");
});

test("a partial take credits what was taken and picks the rest back up", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  onGround(runtime, "bread", 2);
  runtime.dropOutcomes.push(tossed("bread", 5, 3));
  const taken: ItemCount[] = [];
  const ended = handoffOutcome(await runHandoff(contextFor(runtime), { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "bread", count: 5 }] }, (credit) => taken.push(credit)));
  assert.equal(ended.outcome, "not_taken");
  assert.equal(ended.detail, "Theo did not take 2 bread");
  assert.deepEqual(taken, [{ item: "bread", count: 3 }]);
  assert.equal(picksUp(runtime).length, 1);
});

test("a hand-off with a second entry still gives it after a first that was taken, and stops at the first not taken", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  onGround(runtime, "oak_log", 2);
  runtime.dropOutcomes.push(tossed("bread", 5, 5), tossed("oak_log", 2, 0));
  const taken: ItemCount[] = [];
  const ended = handoffOutcome(await runHandoff(contextFor(runtime), { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "bread", count: 5 }, { item: "oak_log", count: 2 }] }, (credit) => taken.push(credit)));
  assert.equal(ended.outcome, "not_taken");
  assert.deepEqual(taken, [{ item: "bread", count: 5 }]);
  assert.deepEqual(picksUp(runtime), [{ item: "oak_log", radius: 16 }], "only the untaken item is picked up");
});

test("a toss lying at the feet is not 'taken' even when someone else took it: only the recipient's count counts", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  onGround(runtime, "oak_log", 4);
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "oak_log", dropped: 4 }], recipient: { collected: false, collectedCount: 0 } });
  const ended = handoffOutcome(await runHandoff(contextFor(runtime), { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "oak_log", count: 4 }] }));
  assert.equal(ended.outcome, "not_taken");
});

test("a pick-back that finds nothing means the items are gone from the ground: credited as given, not confirmed, never given twice", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  runtime.dropOutcomes.push(tossed("oak_log", 4, 0));
  runtime.failures.pick_up_items = "[NO_ITEMS] nothing to pick up";
  const taken: ItemCount[] = [];
  const ended = handoffOutcome(await runHandoff(contextFor(runtime), { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "oak_log", count: 4 }] }, (credit) => taken.push(credit)));
  assert.equal(ended.outcome, "done");
  assert.match(ended.detail, /4 oak_log not confirmed taken/u);
  assert.deepEqual(taken, [{ item: "oak_log", count: 4 }]);
  assert.equal(dropCalls(runtime), 1);
});

test("a settled toss with no packet (collectedCount 0) whose pick-back returns 2 of 4 credits 2 and ends not_taken for the 2 (the server sends no packet for a partial pickup)", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  onGround(runtime, "oak_log", 2);
  runtime.dropOutcomes.push({ ...tossed("oak_log", 4, 0), recipient: { collected: false, collectedCount: 0, settled: true } });
  const taken: ItemCount[] = [];
  const ended = handoffOutcome(await runHandoff(contextFor(runtime), { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "oak_log", count: 4 }] }, (credit) => taken.push(credit)));
  assert.equal(ended.outcome, "not_taken");
  assert.equal(ended.detail, "Theo did not take 2 oak_log");
  assert.deepEqual(taken, [{ item: "oak_log", count: 2 }]);
});

test("a cancel during the toss is stopped, nothing is picked up or credited", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  const abort = new AbortController();
  runtime.dropOutcomes.push({ ...tossed("oak_log", 4, 0), effect: () => abort.abort() });
  const taken: ItemCount[] = [];
  const result = await runHandoff({ ...contextFor(runtime), signal: abort.signal }, { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "oak_log", count: 4 }] }, (credit) => taken.push(credit));
  assert.equal(handoffOutcome(result).outcome, "dropped");
  assert.equal(handoffOutcome(result).detail, "stopped");
  assert.deepEqual(picksUp(runtime), []);
  assert.deepEqual(taken, []);
});

test("a runtime that reports no recipient counts the give as taken, as before", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "oak_log", dropped: 4 }] });
  const taken: ItemCount[] = [];
  const result = await runHandoff(contextFor(runtime), { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "oak_log", count: 4 }] }, (credit) => taken.push(credit));
  assert.equal(handoffOutcome(result).outcome, "done");
  assert.deepEqual(taken, [{ item: "oak_log", count: 4 }]);
});

test("handoffOutcome reads the reason of a failed result, not its text", () => {
  assert.equal(handoffOutcome({ status: "failed", detail: "I no longer carry 2 bread", reason: "items_gone" }).outcome, "items_gone");
  assert.equal(handoffOutcome({ status: "failed", detail: "Theo did not take 2 bread", reason: "not_taken" }).outcome, "not_taken");
  assert.equal(handoffOutcome({ status: "failed", detail: "[items gone] [not taken] looks like a tag but has no reason" }).outcome, "failed");
  assert.equal(handoffOutcome({ status: "failed", detail: "x", reason: "did_not_come" }).outcome, "failed");
});

test("a give with items missing carries the reason items_gone and no tag in the detail", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  const result = await runHandoff(contextFor(runtime), { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "bread", count: 9 }] });
  assert.deepEqual(result, { status: "failed", detail: "I no longer carry 9 bread", reason: "items_gone" });
});

/** A toss whose answer is not settled (the server was late): the items left the giver, the recipient may or may not have them. */
function unsettled(runtime: FakeRuntime, item: string, dropped: number, seenTaken: number) {
  return { status: "succeeded", error: null, dropped: [{ item, dropped }], recipient: { collected: seenTaken >= dropped, collectedCount: seenTaken, settled: false },
    effect: () => { runtime.snapshot = { ...runtime.snapshot, inventory: runtime.snapshot.inventory.filter((s) => s.name !== item) }; } } as const;
}
const dropCalls = (runtime: FakeRuntime): number => runtime.submitted.filter((call) => call.tool === "drop_item").length;

test("a settled partial take credits the taken part and ends not_taken (the rest is picked back up)", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  onGround(runtime, "bread", 2);
  runtime.dropOutcomes.push({ ...tossed("bread", 5, 3), recipient: { collected: false, collectedCount: 3, settled: true } });
  const taken: ItemCount[] = [];
  const result = await runHandoff(contextFor(runtime), { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "bread", count: 5 }] }, (credit) => taken.push(credit));
  assert.equal(result.status === "failed" ? result.reason : undefined, "not_taken");
  assert.deepEqual(taken, [{ item: "bread", count: 3 }]);
});

test("an unsettled toss with nothing back is credited in full and never given a second time", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  runtime.simulateInventory = true;
  runtime.dropOutcomes.push(unsettled(runtime, "oak_log", 4, 0));
  const taken: ItemCount[] = [];
  const result = await runHandoff(contextFor(runtime), { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "oak_log", count: 4 }] }, (credit) => taken.push(credit));
  assert.equal(handoffOutcome(result).outcome, "done");
  assert.match(handoffOutcome(result).detail, /4 oak_log not confirmed taken/u);
  assert.deepEqual(taken, [{ item: "oak_log", count: 4 }]);
  assert.equal(dropCalls(runtime), 1);
  assert.deepEqual(picksUp(runtime), [{ item: "oak_log", radius: 16 }], "what is on the ground is picked back first");
});

test("an unsettled toss that all came back ends not_taken and credits nothing", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  runtime.simulateInventory = true;
  runtime.groundItems = [{ item: "oak_log", count: 4 }];
  runtime.dropOutcomes.push(unsettled(runtime, "oak_log", 4, 0));
  const taken: ItemCount[] = [];
  const result = await runHandoff(contextFor(runtime), { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "oak_log", count: 4 }] }, (credit) => taken.push(credit));
  assert.equal(handoffOutcome(result).outcome, "not_taken");
  assert.deepEqual(taken, []);
});

test("an unsettled toss with part back credits the difference and ends not_taken for the rest", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  runtime.simulateInventory = true;
  runtime.groundItems = [{ item: "oak_log", count: 1 }];
  runtime.dropOutcomes.push(unsettled(runtime, "oak_log", 4, 0));
  const taken: ItemCount[] = [];
  const result = await runHandoff(contextFor(runtime), { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "oak_log", count: 4 }] }, (credit) => taken.push(credit));
  const ended = handoffOutcome(result);
  assert.equal(ended.outcome, "not_taken");
  assert.match(ended.detail, /1 oak_log/u);
  assert.deepEqual(taken, [{ item: "oak_log", count: 3 }], "the retake gives only the 1 that came back");
});

test("an unsettled first entry with nothing back goes on to the next entry", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  runtime.simulateInventory = true;
  runtime.dropOutcomes.push(unsettled(runtime, "bread", 5, 0), tossed("oak_log", 2, 2));
  const taken: ItemCount[] = [];
  const result = await runHandoff(contextFor(runtime), { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "bread", count: 5 }, { item: "oak_log", count: 2 }] }, (credit) => taken.push(credit));
  assert.equal(handoffOutcome(result).outcome, "done");
  assert.deepEqual(taken, [{ item: "bread", count: 5 }, { item: "oak_log", count: 2 }]);
  assert.equal(dropCalls(runtime), 2);
});

test("a stop during the pick-back of an unsettled toss is stopped and credits nothing it did not see", async () => {
  const runtime = new FakeRuntime();
  near(runtime);
  runtime.simulateInventory = true;
  const abort = new AbortController();
  runtime.dropOutcomes.push({ ...unsettled(runtime, "oak_log", 4, 0), effect: () => abort.abort() });
  const result = await runHandoff({ ...contextFor(runtime), signal: abort.signal }, { kind: "give", tradeId: "t", partner: "Theo", items: [{ item: "oak_log", count: 4 }] });
  assert.equal(result.status, "stopped");
});
