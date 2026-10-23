import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { setTimeout as pause } from "node:timers/promises";
import { z } from "zod";
import { defineAction, actionResultSchema } from "../actions/action.js";
import { temporaryBotData } from "../test-support/bot-data.js";
import { createFakeClock } from "../test-support/fake-bot/index.js";
import { ActionRunner } from "./action-runner.js";
import { AsyncActions, ExecutionStore } from "./async-actions.js";
import { RequestProgress, progressChange } from "./progress.js";

function fixture() {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => { finish = resolve; });
  let attempts = 0;
  const runner = new ActionRunner({ position: () => ({ dimension: "overworld", x: 0, y: 64, z: 0 }) });
  const action = defineAction({
    name: "work", description: "Retain observed work", inputSchema: z.object({ count: z.number().default(1) }),
    resultSchema: actionResultSchema({ count: z.number() }), formatResult: (result) => `Count: ${result.count}`,
    execution: { kind: "task" }, parse: (input) => z.object({ count: z.number().default(1) }).parse(input),
    execute: async ({ count }, context) => {
      attempts++;
      context.observeProgress?.(() => ({ baseline: 0, checkpoint: { gained: attempts }, completion: { kind: "current", observed: false, owes: "Finish work" } }));
      await Promise.race([gate, new Promise<void>((resolve) => context.signal?.addEventListener("abort", () => resolve(), { once: true }))]);
      context.signal?.throwIfAborted();
      return { status: "succeeded", count };
    },
  });
  const service = new AsyncActions(runner, runner.run);
  return { runner, service, action, finish, attempts: () => attempts };
}

test("submission deduplicates, timed waits preserve execution, and final retrieval gates the successor", async () => {
  const f = fixture();
  const accepted = f.service.submit(f.action, {}, { submission_id: "first" }, 1);
  assert.equal(accepted.state, "accepted"); if (accepted.state !== "accepted") return;
  const poll = await f.service.wait(accepted.actionId, 0);
  assert.equal(poll.state, "pending");
  assert.equal(f.service.submit(f.action, {}, { submission_id: "first" }, 2).state, "accepted");
  assert.equal(f.service.submit(f.action, { count: 2 }, { submission_id: "first" }, 3).state, "refused");
  assert.equal(f.service.submit(f.action, {}, { submission_id: "second" }, 4).state, "refused");
  const abort = new AbortController();
  const waiting = f.service.wait(accepted.actionId, 10000, abort.signal);
  abort.abort(new Error("Stop only this wait"));
  await assert.rejects(waiting, /Stop only this wait/);
  assert.equal(f.runner.status().busy, true);
  await pause(5);
  f.finish();
  await f.service.settled();
  const refused = f.service.submit(f.action, {}, { submission_id: "second" }, 5);
  assert.equal(refused.state, "refused");
  if (refused.state === "refused") assert.equal(refused.code, "RESULT_NOT_RETRIEVED");
  assert.equal(f.service.status().awaitingResult?.actionId, accepted.actionId);
  f.service.cancel(accepted.actionId, "Already finished");
  assert.equal(f.service.status().awaitingResult?.actionId, accepted.actionId);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(f.service.wait(accepted.actionId, 0, aborted.signal));
  assert.equal(f.service.status().awaitingResult?.actionId, accepted.actionId);
  const final = await f.service.wait(accepted.actionId, 1000);
  assert.equal(final.state, "settled"); if (final.state !== "settled") return;
  assert.equal(final.output.result.status, "succeeded");
  assert.equal(f.attempts(), 1);
  assert.deepEqual(await f.service.wait(accepted.actionId, 0), final);
  assert.equal(f.service.status().awaitingResult, null);
  const next = f.service.submit(f.action, {}, { submission_id: "second" }, 6);
  assert.equal(next.state, "accepted");
  if (next.state === "accepted") await f.service.wait(next.actionId, 1000);
  assert.deepEqual(await f.service.wait(accepted.actionId, 0), final);
});

test("targeted cancellation leaves a reflex alive, waits for release, and never cancels a newer ID", async () => {
  const f = fixture();
  const accepted = f.service.submit(f.action, {}, { submission_id: "first" }, 1);
  assert.equal(accepted.state, "accepted"); if (accepted.state !== "accepted") return;
  await pause(0);
  let release!: () => void;
  let reflexSignal: AbortSignal | null = null;
  const claim = f.runner.claim("hostile", "defend", async (signal) => {
    reflexSignal = signal;
    await new Promise<void>((resolve) => { release = resolve; });
    return { value: null, continuation: { kind: "resume" } };
  });
  await pause(0);
  f.service.cancel(accepted.actionId, "Choose a different objective");
  assert.equal((reflexSignal as AbortSignal | null)?.aborted, false);
  assert.equal((await f.service.wait(accepted.actionId, 0)).state, "pending");
  release();
  if (claim.kind === "claimed") await claim.outcome;
  const result = await f.service.wait(accepted.actionId, 1000);
  assert.equal(result.state, "settled");
  assert.equal(f.attempts(), 1);
  assert.equal(f.service.cancel("unknown", "old ID").state, "refused");
  if (result.state === "settled") {
    assert.equal("error" in result.output.result ? result.output.result.error : "", "Choose a different objective");
    const successor = f.service.submit(f.action, {}, { submission_id: "successor" }, 2);
    assert.equal(successor.state, "accepted");
    f.service.cancel(accepted.actionId, "Stale cancellation");
    assert.equal(f.runner.status().busy, true);
    f.finish();
    if (successor.state === "accepted") assert.equal((await f.service.wait(successor.actionId, 1000)).state, "settled");
  }
});

test("storage failure retains the result gate without repeating physical work", async (t) => {
  const data = temporaryBotData({ botId: "AsyncBot", closeAfter: t });
  const store = new ExecutionStore(data, "AsyncBot");
  const f = fixture();
  let fail = true;
  let failRetrieval = false;
  const service = new AsyncActions(f.runner, f.runner.run, {
    loadOpen: () => store.loadOpen(), findByAction: (id) => store.findByAction(id), findBySubmission: (id) => store.findBySubmission(id),
    write: (records) => { if (fail || (failRetrieval && records.some((record) => record.resultRetrieved))) throw new Error("Disk unavailable"); store.write(records); },
  });
  assert.equal(service.submit(f.action, {}, { submission_id: "durable" }, 1).state, "refused");
  assert.equal(f.attempts(), 0);
  fail = false;
  const first = service.submit(f.action, {}, { submission_id: "durable" }, 1, "Original intent");
  assert.equal(first.state, "accepted"); if (first.state !== "accepted") return;
  fail = true;
  f.finish();
  const unpersisted = await service.wait(first.actionId, 1000);
  assert.equal(unpersisted.state, "storage_failed");
  assert.equal(service.status().awaitingResult?.actionId, first.actionId);
  assert.equal(service.submit(f.action, {}, { submission_id: "next" }, 2).state, "refused");
  assert.equal(f.attempts(), 1);
  fail = false;
  failRetrieval = true;
  assert.equal((await service.wait(first.actionId, 0)).state, "storage_failed");
  assert.equal(store.load()[0]?.resultRetrieved, false);
  assert.equal(service.status().awaitingResult?.actionId, first.actionId);
  assert.equal(service.submit(f.action, {}, { submission_id: "next" }, 2).state, "refused");
  failRetrieval = false;
  const final = await service.wait(first.actionId, 0);
  assert.equal(final.state, "settled"); if (final.state !== "settled") return;
  assert.equal(service.submit(f.action, { count: "invalid" }, { submission_id: "next" }, 2).state, "refused");
  assert.equal(store.load()[0]?.resultRetrieved, true);
  let release!: () => void;
  const reflex = f.runner.claim("idle-protection", "Protect the idle bot", async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { value: null, continuation: { kind: "resume" as const } };
  });
  await pause(0);
  assert.equal(service.submit(f.action, {}, { submission_id: "next" }, 2).state, "refused");
  assert.equal(store.load()[0]?.resultRetrieved, true);
  release();
  if (reflex.kind === "claimed") await reflex.outcome;
  fail = true;
  assert.equal(service.submit(f.action, {}, { submission_id: "next" }, 3).state, "refused");
  assert.equal(store.load()[0]?.resultRetrieved, true);
  fail = false;
  const next = service.submit(f.action, {}, { submission_id: "next" }, 4);
  assert.equal(next.state, "accepted");
  if (next.state === "accepted") await service.wait(next.actionId, 1000);
  assert.equal(store.load()[0]?.rationale, "Original intent");
  assert.deepEqual(await service.wait(first.actionId, 0), final);
});

test("concurrent waits retain independent baselines and dispose their own abort listeners", async () => {
  const f = fixture();
  const accepted = f.service.submit(f.action, {}, { submission_id: "waiters" }, 1);
  assert.equal(accepted.state, "accepted"); if (accepted.state !== "accepted") return;
  const controller = new AbortController();
  const first = f.service.wait(accepted.actionId, 1000, controller.signal);
  const poll = await f.service.wait(accepted.actionId, 5, controller.signal);
  assert.equal(poll.state, "pending");
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  const second = f.service.wait(accepted.actionId, 1000, controller.signal);
  f.finish();
  assert.deepEqual(await first, await second);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("progress marks absent physics samples and retains regressing inventory evidence", async () => {
  const clock = createFakeClock({ mode: "mocked", startMs: Date.parse("2026-10-21T00:00:00.000Z") });
  using _timers = clock.install();
  const p = new RequestProgress({ dimension: "overworld", x: 0, y: 64, z: 0 });
  const before = p.snapshot();
  p.transition("suspended");
  await clock.advance(10);
  p.transition("resuming");
  await clock.advance(10);
  assert.ok(p.snapshot().suspendedMs >= 15);
  p.transition("running");
  await clock.advance(1010);
  const stale = p.snapshot();
  assert.equal(stale.movementCoverage.complete, false);
  assert.ok(stale.positionAgeMs! >= 1000);
  p.sample({ dimension: "overworld", x: 100, y: 64, z: 0 }, false);
  assert.equal(p.snapshot().distanceTravelledBlocks, 0);
  const evidence = (gained: number) => ({ baseline: null, checkpoint: { items: [{ item: "iron_ingot", gained }] },
    completion: { kind: "current" as const, observed: false, owes: "Keep the requested items" } });
  assert.equal(progressChange(before, p.snapshot(), evidence(5), evidence(2)).checkpointDelta["items.iron_ingot.gained"], -3);
});

test("each waiter sees only tool changes since its own progress baseline", () => {
  let durabilityLeft = 9;
  const p = new RequestProgress(null, () => ({ tools: [{ class: "pickaxe", tier: "iron", item: "iron_pickaxe", slot: 36,
    durabilityLeft, maximumDurability: 250 }], armour: [] }));
  const first = p.snapshot();
  durabilityLeft = 4;
  const second = p.snapshot();
  assert.deepEqual(progressChange(first, second, null, null).toolChanges.map((change) => change.reason), ["durability_used"]);
  assert.deepEqual(progressChange(second, second, null, null).toolChanges, []);
});

test("a broken progress reader reports missing evidence without replacing the physical result", async () => {
  const f = fixture();
  const action = defineAction({ ...f.action, execute: async (_request, context) => {
    context.observeProgress?.(() => { throw new Error("World observation unavailable"); });
    return { status: "succeeded" as const, count: 7 };
  } });
  const accepted = f.service.submit(action, {}, { submission_id: "broken-reader" }, 1);
  assert.equal(accepted.state, "accepted"); if (accepted.state !== "accepted") return;
  const result = await f.service.wait(accepted.actionId, 1000);
  assert.equal(result.state, "settled"); if (result.state !== "settled") return;
  assert.equal(result.output.result.status, "succeeded");
  assert.equal(result.output.request?.evidence, null);
  assert.match(result.output.request?.observationError ?? "", /World observation unavailable/);
});

test("retained storage recovers unread results and interrupts unfinished work without replay", async (t) => {
  const data = temporaryBotData({ botId: "AsyncBot", closeAfter: t });
  const f = fixture();
  const store = new ExecutionStore(data, "AsyncBot");
  const service = new AsyncActions(f.runner, f.runner.run, store);
  const accepted = service.submit(f.action, {}, { submission_id: "durable" }, 1);
  assert.equal(accepted.state, "accepted"); if (accepted.state !== "accepted") return;
  const recovered = new AsyncActions(new ActionRunner(), f.runner.run, store);
  assert.equal(recovered.status().awaitingResult?.actionId, accepted.actionId);
  const result = await recovered.wait(accepted.actionId, 0);
  assert.equal(result.state, "settled");
  if (result.state === "settled") {
    assert.equal(result.output.result.status, "failed");
    assert.match("error" in result.output.result ? result.output.result.error : "", /RUNTIME_INTERRUPTED/);
    assert.equal(recovered.status().awaitingResult, null);
  }
  f.finish();
  await service.wait(accepted.actionId, 1000);
  const latest = new AsyncActions(new ActionRunner(), f.runner.run, store);
  assert.equal(latest.status().awaitingResult, null);
  assert.equal(latest.submit(f.action, {}, { submission_id: "durable" }, 2).state, "accepted");
  assert.equal(f.attempts(), 1);
});

test("distance counts real segments across routes, excludes jumps, and freezes its final snapshot", () => {
  const p = new RequestProgress({ dimension: "overworld", x: 0, y: 64, z: 0 });
  p.sample({ dimension: "overworld", x: 3, y: 64, z: 4 }, false);
  p.transition("suspended");
  p.sample({ dimension: "overworld", x: 0, y: 64, z: 0 }, true);
  assert.equal(p.snapshot().distanceTravelledBlocks, 10);
  assert.equal(p.snapshot().reflexDistanceBlocks, 5);
  assert.equal(p.snapshot().distanceFromStartBlocks, 0);
  p.sample({ dimension: "the_nether", x: 1000, y: 64, z: 0 }, true, "portal");
  assert.equal(p.snapshot().distanceTravelledBlocks, 10);
  assert.equal(p.snapshot().distanceFromStartBlocks, null);
  const final = p.finish();
  p.sample({ dimension: "the_nether", x: 1010, y: 64, z: 0 }, false);
  assert.deepEqual(p.snapshot(), final);
});

type StoreRecord = Parameters<ExecutionStore["write"]>[0][number];
function storedRecord(index: number, state: "retrieved" | "unretrieved" | "pending"): StoreRecord {
  return {
    actionId: `action-${index}`, submissionId: `submission-${index}`, action: "work", arguments: {},
    admittedAt: new Date(index * 1000).toISOString(), requestId: index, rationale: null,
    resultRetrieved: state === "retrieved", checkpoint: null,
    terminal: state === "pending" ? null : { output: { action: "work", durationMs: 1, result: { kind: "runtime_failure", status: "failed", error: `stored ${index}` } } },
  };
}

test("a restart parses only open and unretrieved executions", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const store = new ExecutionStore(data, "Bot");
  store.write(Array.from({ length: 1000 }, (_, index) => storedRecord(index, "retrieved")));
  store.write([storedRecord(1000, "unretrieved"), storedRecord(1001, "pending")]);
  const read = data.read.bind(data);
  let rowsLoaded = 0;
  data.read = ((...args: Parameters<typeof read>) => { const rows = read(...args); rowsLoaded += rows.length; return rows; }) as typeof data.read;
  const f = fixture();
  const service = new AsyncActions(f.runner, f.runner.run, store);
  assert.equal(rowsLoaded, 2);
  const refusal = service.submit(f.action, {}, { submission_id: "fresh" }, 1);
  assert.equal(refusal.state, "refused");
  if (refusal.state === "refused") {
    assert.equal(refusal.code, "RESULT_NOT_RETRIEVED");
    assert.equal(refusal.unretrievedActionId, "action-1000");
  }
  assert.match(JSON.stringify(store.findByAction("action-1001")?.terminal), /RUNTIME_INTERRUPTED/);
});

test("rows written with the earlier acknowledgement field are open until acknowledged", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  const store = new ExecutionStore(data, "Bot");
  const legacy = (index: number, acknowledged: boolean) => {
    const { resultRetrieved, ...record } = storedRecord(index, "retrieved");
    return JSON.stringify({ ...record, acknowledged });
  };
  data.transaction((db) => {
    const put = db.prepare("INSERT INTO action_executions VALUES (?, ?, ?, ?)");
    put.run("Bot", "action-1", "submission-1", legacy(1, true));
    put.run("Bot", "action-2", "submission-2", legacy(2, false));
  }, { name: "seed-legacy-executions" });
  assert.deepEqual(store.loadOpen().map((record) => record.actionId), ["action-2"]);
  assert.equal(store.findByAction("action-1")?.resultRetrieved, true);
});

test("a restart loads only the rows of its own bot", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  new ExecutionStore(data, "Other").write([storedRecord(1, "unretrieved"), storedRecord(2, "pending")]);
  const mine = new ExecutionStore(data, "Mine");
  assert.deepEqual(mine.loadOpen(), []);
  assert.equal(mine.findByAction("action-1"), undefined);
  assert.equal(mine.findBySubmission("submission-1"), undefined);
  const f = fixture();
  assert.equal(new AsyncActions(f.runner, f.runner.run, mine).status().awaitingResult, null);
});

function countingStore(store: ExecutionStore) {
  const calls = { action: 0 };
  return { calls, store: {
    loadOpen: () => store.loadOpen(), write: (records: Parameters<ExecutionStore["write"]>[0]) => store.write(records),
    findByAction: (id: string) => { calls.action++; return store.findByAction(id); },
    findBySubmission: (id: string) => store.findBySubmission(id),
  } };
}

async function runRetrieved(service: AsyncActions, f: ReturnType<typeof fixture>, count: number) {
  f.finish();
  const accepted: string[] = [];
  for (let index = 0; index < count; index++) {
    const submitted = service.submit(f.action, { count: index + 1 }, { submission_id: `s${index}` }, index);
    assert.equal(submitted.state, "accepted"); if (submitted.state !== "accepted") return accepted;
    assert.equal((await service.wait(submitted.actionId, 2000)).state, "settled");
    accepted.push(submitted.actionId);
  }
  return accepted;
}

test("waiting on an execution evicted from memory reads it from the store", async (t) => {
  const counted = countingStore(new ExecutionStore(temporaryBotData({ closeAfter: t }), "Bot"));
  const f = fixture();
  const service = new AsyncActions(f.runner, f.runner.run, counted.store);
  const ids = await runRetrieved(service, f, 60);
  assert.equal(ids.length, 60);
  const first = await service.wait(ids[0]!, 0);
  assert.equal(first.state, "settled");
  if (first.state === "settled") assert.deepEqual(first.output.result, { status: "succeeded", count: 1 });
  assert.equal(counted.calls.action, 1);
  assert.equal((await service.wait(ids[0]!, 0)).state, "settled");
  assert.equal(counted.calls.action, 1, "the looked-up execution is cached");
  assert.equal((await service.wait(ids[59]!, 0)).state, "settled");
  assert.equal(counted.calls.action, 1, "a recent execution never reads the store");
});

test("a submission_id replayed after eviction returns the first acceptance or a conflict", async (t) => {
  const f = fixture();
  const service = new AsyncActions(f.runner, f.runner.run, new ExecutionStore(temporaryBotData({ closeAfter: t }), "Bot"));
  const ids = await runRetrieved(service, f, 60);
  const replay = service.submit(f.action, { count: 1 }, { submission_id: "s0" }, 100);
  assert.equal(replay.state, "accepted");
  if (replay.state === "accepted") assert.equal(replay.actionId, ids[0]);
  const conflict = service.submit(f.action, { count: 7 }, { submission_id: "s0" }, 101);
  assert.equal(conflict.state, "refused");
  if (conflict.state === "refused") assert.equal(conflict.code, "SUBMISSION_CONFLICT");
  assert.equal(f.attempts(), 60, "a replay never runs the work again");
});

function unstorableService(t: { after(fn: () => void): void }, result: unknown) {
  const f = fixture();
  const action = { ...f.action, outputSchema: z.any() } as typeof f.action;
  const output = { action: "work", durationMs: 1, result };
  const service = new AsyncActions(f.runner, () => Promise.resolve(output as never), new ExecutionStore(temporaryBotData({ closeAfter: t }), "Bot"));
  return { service, action };
}

test("an output that cannot be cloned settles the execution and frees the body", async (t) => {
  const { service, action } = unstorableService(t, { status: "succeeded", count: () => 1 });
  const accepted = service.submit(action, {}, { submission_id: "function" }, 1);
  assert.equal(accepted.state, "accepted"); if (accepted.state !== "accepted") return;
  const settled = await service.wait(accepted.actionId, 1000);
  assert.equal(settled.state, "settled"); if (settled.state !== "settled") return;
  assert.match("error" in settled.output.result ? settled.output.result.error : "", /^\[EXECUTION_OUTPUT_UNSTORABLE\] /);
  assert.equal(service.submit(action, {}, { submission_id: "after" }, 2).state, "accepted");
});

test("an output the store cannot write as JSON settles as unstorable instead of blocking the gate", async (t) => {
  const circular: Record<string, unknown> = { status: "succeeded", count: 1 };
  circular.self = circular;
  const { service, action } = unstorableService(t, circular);
  const accepted = service.submit(action, {}, { submission_id: "circular" }, 1);
  assert.equal(accepted.state, "accepted"); if (accepted.state !== "accepted") return;
  const settled = await service.wait(accepted.actionId, 1000);
  assert.equal(settled.state, "settled"); if (settled.state !== "settled") return;
  assert.match("error" in settled.output.result ? settled.output.result.error : "", /EXECUTION_OUTPUT_UNSTORABLE/);
});

test("a waiter listener that throws does not keep the others waiting", async () => {
  const f = fixture();
  const accepted = f.service.submit(f.action, {}, { submission_id: "listeners" }, 1);
  assert.equal(accepted.state, "accepted"); if (accepted.state !== "accepted") return;
  const broken = { aborted: false, throwIfAborted() {}, addEventListener() {}, removeEventListener() { throw new Error("listener broke"); } } as unknown as AbortSignal;
  const first = f.service.wait(accepted.actionId, 5000, broken);
  const second = f.service.wait(accepted.actionId, 5000);
  f.finish();
  const bounded = <T>(promise: Promise<T>) => Promise.race([promise, pause(2000).then(() => "still waiting" as const)]);
  const secondOutcome = await bounded(second);
  assert.equal(typeof secondOutcome === "string" ? secondOutcome : secondOutcome.state, "settled");
  assert.notEqual(await bounded(first), "still waiting");
  assert.equal(f.service.status().active, null);
  assert.equal(f.runner.status().busy, false);
});

test("a lookup whose store read throws answers EXECUTION_LOOKUP_FAILED and leaves the execution unchanged", async (t) => {
  const real = new ExecutionStore(temporaryBotData({ closeAfter: t }), "Bot");
  real.write([storedRecord(1, "retrieved")]);
  let broken = true;
  const failing = <T>(read: () => T): T => { if (broken) throw new Error("database is locked"); return read(); };
  const store = { loadOpen: () => real.loadOpen(), write: (records: Parameters<ExecutionStore["write"]>[0]) => real.write(records),
    findByAction: (id: string) => failing(() => real.findByAction(id)),
    findBySubmission: (id: string) => failing(() => real.findBySubmission(id)) };
  const f = fixture();
  const service = new AsyncActions(f.runner, f.runner.run, store);
  const waited = await service.wait("action-1", 0);
  assert.equal(waited.state, "refused");
  if (waited.state === "refused") { assert.equal(waited.code, "EXECUTION_LOOKUP_FAILED"); assert.match(waited.error, /database is locked.*Retry wait_for_action/); }
  const cancelled = service.cancel("action-1", "stop");
  assert.equal(cancelled.state, "refused");
  if (cancelled.state === "refused") assert.equal(cancelled.code, "EXECUTION_LOOKUP_FAILED");
  const submitted = service.submit(f.action, {}, { submission_id: "submission-1" }, 1);
  assert.equal(submitted.state, "refused");
  if (submitted.state === "refused") assert.equal(submitted.code, "EXECUTION_LOOKUP_FAILED");
  assert.equal(f.attempts(), 0);
  broken = false;
  assert.equal((await service.wait("action-1", 0)).state, "settled");
});
