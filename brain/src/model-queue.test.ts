import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChatModel, ChatReply } from "./chat-model.ts";
import { ModelQueue, startStaggered, type QueueSnapshot } from "./model-queue.ts";

const REPLY: ChatReply = { text: "{}", promptTokens: null, contextTokens: null };

/** A model whose calls stay open until the test settles them. */
function controlled(name = "fake"): { model: ChatModel; settle: (index: number, error?: Error) => void; calls: () => number } {
  const pending: { resolve: (reply: ChatReply) => void; reject: (error: Error) => void }[] = [];
  return {
    model: { name, complete: () => new Promise<ChatReply>((resolve, reject) => pending.push({ resolve, reject })) },
    settle: (index, error) => (error === undefined ? pending[index]!.resolve(REPLY) : pending[index]!.reject(error)),
    calls: () => pending.length,
  };
}

const signal = new AbortController().signal;

/** Lets queued promise callbacks run. */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

test("a tracked model keeps its name and counts calls in flight, per agent", async () => {
  const queue = new ModelQueue({ slots: 3, file: null });
  const fake = controlled("qwen3");
  const ada = queue.track(fake.model, "ada");
  const bo = queue.track(fake.model, "bo");
  assert.equal(ada.name, "qwen3");
  const first = ada.complete([], signal);
  const second = ada.complete([], signal);
  const third = bo.complete([], signal);
  assert.equal(queue.inFlight(), 3);
  assert.equal(queue.waiting(), 0);
  assert.equal(queue.free(), false);
  fake.settle(0);
  await first;
  assert.equal(queue.inFlight(), 2);
  assert.equal(queue.free(), true);
  fake.settle(1);
  fake.settle(2);
  await Promise.all([second, third]);
  assert.equal(queue.inFlight(), 0);
});

test("calls beyond the slots are held and counted as waiting, not in flight", async () => {
  const queue = new ModelQueue({ slots: 2, file: null });
  const fake = controlled();
  const model = queue.track(fake.model, "ada");
  const calls = [model.complete([], signal), model.complete([], signal), model.complete([], signal), model.complete([], signal)];
  await Promise.resolve();
  assert.equal(queue.inFlight(), 2);
  assert.equal(queue.waiting(), 2);
  fake.settle(0);
  await calls[0];
  await tick();
  assert.equal(queue.waiting(), 1);
  for (const index of [1, 2]) fake.settle(index);
  await tick();
  fake.settle(3);
  await Promise.all(calls);
});

test("a rejected call still counts down", async () => {
  const queue = new ModelQueue({ slots: 1, file: null });
  const fake = controlled();
  const call = queue.track(fake.model, "ada").complete([], signal);
  assert.equal(queue.inFlight(), 1);
  fake.settle(0, new Error("boom"));
  await assert.rejects(call, /boom/u);
  assert.equal(queue.inFlight(), 0);
});

test("unknown slots never wait", async () => {
  const queue = new ModelQueue({ slots: null, file: null });
  const fake = controlled();
  const model = queue.track(fake.model, "ada");
  const calls = [model.complete([], signal), model.complete([], signal), model.complete([], signal)];
  assert.equal(queue.waiting(), 0);
  assert.equal(queue.free(), true);
  for (const index of [0, 1, 2]) fake.settle(index);
  await Promise.all(calls);
});

test("whenFree resolves at once when free, after a call ends otherwise, and rejects on abort", async () => {
  const queue = new ModelQueue({ slots: 1, file: null });
  await queue.whenFree(signal);
  const fake = controlled();
  const call = queue.track(fake.model, "ada").complete([], signal);
  let freed = false;
  const waited = queue.whenFree(signal).then(() => (freed = true));
  await Promise.resolve();
  assert.equal(freed, false);
  fake.settle(0);
  await call;
  await waited;
  assert.equal(freed, true);

  const busy = queue.track(fake.model, "ada").complete([], signal);
  const abort = new AbortController();
  const aborted = queue.whenFree(abort.signal);
  abort.abort();
  await assert.rejects(aborted);
  fake.settle(1);
  await busy;
});

test("the file holds counts, history and starts, written whole", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-queue-"));
  const file = join(dir, "queue.json");
  let clock = 1_000;
  const queue = new ModelQueue({ slots: 2, file, now: () => clock });
  const fake = controlled();
  queue.started("ada");
  const call = queue.track(fake.model, "ada").complete([], signal);
  clock = 5_000;
  queue.started("bo");
  queue.flush();
  const busy = JSON.parse(readFileSync(file, "utf8")) as QueueSnapshot;
  assert.equal(busy.slots, 2);
  assert.equal(busy.inFlight, 1);
  assert.equal(busy.waiting, 0);
  assert.deepEqual(busy.byAgent, { ada: 1 });
  assert.deepEqual(busy.starts, [{ id: "ada", at: 1_000 }, { id: "bo", at: 5_000 }]);
  assert.equal(busy.history.at(-1)?.inFlight, 1);
  clock = 6_000;
  fake.settle(0);
  await call;
  queue.flush();
  const idle = JSON.parse(readFileSync(file, "utf8")) as QueueSnapshot;
  assert.equal(idle.inFlight, 0);
  assert.deepEqual(idle.byAgent, {});
  assert.equal(idle.at, 6_000);
  assert.equal(idle.history.at(-1)?.inFlight, 0);
});

test("writes are at most one per 500 ms, with a trailing write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-queue-"));
  const file = join(dir, "queue.json");
  let clock = 0;
  const queue = new ModelQueue({ slots: 3, file, now: () => clock });
  const fake = controlled();
  const model = queue.track(fake.model, "ada");
  const first = model.complete([], signal);
  // The first change is written at once; the next ones inside 500 ms wait for the trailing write.
  assert.equal((JSON.parse(readFileSync(file, "utf8")) as QueueSnapshot).inFlight, 1);
  clock = 100;
  const second = model.complete([], signal);
  assert.equal((JSON.parse(readFileSync(file, "utf8")) as QueueSnapshot).inFlight, 1);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal((JSON.parse(readFileSync(file, "utf8")) as QueueSnapshot).inFlight, 2);
  fake.settle(0);
  fake.settle(1);
  await Promise.all([first, second]);
  queue.flush();
});

test("history keeps the last hour and at most 4000 samples", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-queue-"));
  const file = join(dir, "queue.json");
  let clock = 0;
  const queue = new ModelQueue({ slots: 1, file, now: () => clock });
  queue.started("old");
  clock = 10;
  queue.started("older");
  clock = 61 * 60_000;
  queue.started("new");
  queue.flush();
  const snapshot = JSON.parse(readFileSync(file, "utf8")) as QueueSnapshot;
  assert.deepEqual(snapshot.starts.map((start) => start.id), ["new"]);

  const fake = controlled();
  const model = queue.track(fake.model, "ada");
  for (let index = 0; index < 2_100; index += 1) {
    clock += 1;
    void model.complete([], signal);
  }
  for (let index = 0; index < 2_100; index += 1) {
    fake.settle(index);
    await tick();
  }
  queue.flush();
  assert.ok((JSON.parse(readFileSync(file, "utf8")) as QueueSnapshot).history.length <= 4_000);
});

test("agents start in order, each after the gap and once the queue is free", async () => {
  const events: string[] = [];
  const slept: number[] = [];
  let clock = 0;
  let freeCalls = 0;
  await startStaggered(["a", "b", "c"], (id, afterMs) => events.push(`${id}@${clock}+${afterMs}`), {
    gapMs: 10_000,
    whenFree: async () => {
      freeCalls += 1;
      clock += 500; // the queue was busy for a while after the gap
    },
    signal,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });
  assert.deepEqual(slept, [10_000, 10_000]);
  assert.equal(freeCalls, 2);
  assert.deepEqual(events, ["a@0+null", "b@10500+10500", "c@21000+10500"]);
});

test("no gap and no queue start everyone at once", async () => {
  const events: string[] = [];
  await startStaggered(["a", "b"], (id) => events.push(id), {
    gapMs: 0,
    whenFree: null,
    signal,
    now: () => 0,
    sleep: async () => assert.fail("must not sleep"),
  });
  assert.deepEqual(events, ["a", "b"]);
});

test("a shutdown during the wait stops starting agents without an error", async () => {
  const abort = new AbortController();
  const events: string[] = [];
  await startStaggered(["a", "b", "c"], (id) => events.push(id), {
    gapMs: 5_000,
    whenFree: null,
    signal: abort.signal,
    now: () => 0,
    sleep: async () => {
      abort.abort();
      throw abort.signal.reason;
    },
  });
  assert.deepEqual(events, ["a"]);
});

test("a snapshot that cannot be written (rename refused on a shared drive) is logged once and never fails a model call or the timer (review C19)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "model-queue-"));
  // A directory where the file goes: the rename fails whatever the platform.
  const file = join(dir, "queue.json");
  mkdirSync(file);
  const logs: string[] = [];
  let clock = 0;
  const queue = new ModelQueue({ slots: 3, file, now: () => clock, log: (line) => logs.push(line) });
  const fake = controlled();
  const call = queue.track(fake.model, "ada").complete([], signal);
  clock = 100;
  queue.started("bo");
  queue.flush();
  fake.settle(0);
  await call;
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.equal(logs.length, 1);
});

test("freeFor: with known slots a free slot, with unknown slots no call of this agent in flight", async () => {
  const fake = controlled();
  const known = new ModelQueue({ slots: 2, file: null });
  const ada = known.track(fake.model, "ada");
  void ada.complete([], signal);
  assert.equal(known.freeFor("ada"), true);
  assert.equal(known.freeFor("bo"), true);
  void known.track(fake.model, "bo").complete([], signal);
  assert.equal(known.freeFor("bo"), false, "both slots taken");

  const unknown = new ModelQueue({ slots: null, file: null });
  const cy = unknown.track(fake.model, "cy");
  assert.equal(unknown.freeFor("cy"), true);
  const call = cy.complete([], signal);
  assert.equal(unknown.free(), true, "unknown slots: free() is always true");
  assert.equal(unknown.freeFor("cy"), false, "one call of this agent in flight is its limit");
  assert.equal(unknown.freeFor("di"), true);
  fake.settle(2);
  await call;
  assert.equal(unknown.freeFor("cy"), true);
});

test("freeWithin is true once a slot frees in time, false on time-out or abort", async () => {
  const queue = new ModelQueue({ slots: 1, file: null });
  assert.equal(await queue.freeWithin("ada", 50, signal), true, "free at once");
  const fake = controlled();
  const call = queue.track(fake.model, "ada").complete([], signal);
  assert.equal(await queue.freeWithin("bob", 20, signal), false, "time-out");
  const abort = new AbortController();
  const aborted = queue.freeWithin("bob", 5_000, abort.signal);
  abort.abort();
  assert.equal(await aborted, false, "abort");
  const freed = queue.freeWithin("bob", 5_000, signal);
  fake.settle(0);
  await call;
  assert.equal(await freed, true);
});


test("the third call on two slots is held until one ends, and only it reports a wait", async () => {
  let clock = 0;
  const queue = new ModelQueue({ slots: 2, file: null, now: () => clock });
  const fake = controlled();
  const model = queue.track(fake.model, "ada");
  const first = model.complete([], signal);
  const second = model.complete([], signal);
  const third = model.complete([], signal);
  await tick();
  assert.equal(fake.calls(), 2);
  assert.equal(queue.inFlight(), 2);
  assert.equal(queue.waiting(), 1);
  clock = 700;
  fake.settle(0);
  assert.equal((await first).waitMs, 0);
  await tick();
  assert.equal(fake.calls(), 3);
  assert.equal(queue.waiting(), 0);
  fake.settle(1);
  fake.settle(2);
  assert.equal((await second).waitMs, 0);
  assert.equal((await third).waitMs, 700);
});

test("a chat call held behind a work call goes first when a slot frees", async () => {
  const queue = new ModelQueue({ slots: 1, file: null });
  const order: string[] = [];
  const pending: (() => void)[] = [];
  const model: ChatModel = {
    name: "fake",
    complete: (turns) => new Promise<ChatReply>((resolve) => {
      order.push(turns[0]!.content);
      pending.push(() => resolve(REPLY));
    }),
  };
  const tracked = queue.track(model, "ada");
  const busy = tracked.complete([{ role: "user", content: "busy" }], signal);
  const work = tracked.complete([{ role: "user", content: "work" }], signal, { priority: 2 });
  const chat = tracked.complete([{ role: "user", content: "chat" }], signal, { priority: 0 });
  await tick();
  pending[0]!();
  await busy;
  await tick();
  pending[1]!();
  await chat;
  await tick();
  pending[2]!();
  await work;
  assert.deepEqual(order, ["busy", "chat", "work"]);
});

test("the same priority goes out in arrival order", async () => {
  const queue = new ModelQueue({ slots: 1, file: null });
  const order: string[] = [];
  const pending: (() => void)[] = [];
  const model: ChatModel = {
    name: "fake",
    complete: (turns) => new Promise<ChatReply>((resolve) => {
      order.push(turns[0]!.content);
      pending.push(() => resolve(REPLY));
    }),
  };
  const tracked = queue.track(model, "ada");
  const calls = ["a", "b", "c", "d"].map((name) => tracked.complete([{ role: "user", content: name }], signal, { priority: 1 }));
  for (let i = 0; i < 4; i += 1) {
    await tick();
    pending[i]!();
  }
  await Promise.all(calls);
  assert.deepEqual(order, ["a", "b", "c", "d"]);
});

test("a call aborted while held leaves the queue, takes no slot, and the next waiter still runs", async () => {
  const queue = new ModelQueue({ slots: 1, file: null });
  const fake = controlled();
  const tracked = queue.track(fake.model, "ada");
  const busy = tracked.complete([], signal);
  const abort = new AbortController();
  const aborted = tracked.complete([], abort.signal);
  const next = tracked.complete([], signal);
  await tick();
  assert.equal(queue.waiting(), 2);
  abort.abort(new Error("stopped"));
  await assert.rejects(aborted, /stopped/u);
  assert.equal(queue.waiting(), 1);
  assert.equal(queue.inFlight(), 1);
  fake.settle(0);
  await busy;
  await tick();
  assert.equal(fake.calls(), 2);
  fake.settle(1);
  await next;
  assert.equal(queue.inFlight(), 0);
  assert.equal(queue.waiting(), 0);
});

test("a signal already aborted never takes a slot", async () => {
  const queue = new ModelQueue({ slots: 1, file: null });
  const fake = controlled();
  const abort = new AbortController();
  abort.abort(new Error("late"));
  await assert.rejects(queue.track(fake.model, "ada").complete([], abort.signal), /late/u);
  assert.equal(fake.calls(), 0);
  assert.equal(queue.inFlight(), 0);
});

test("a model that throws frees its slot for the next waiter", async () => {
  const queue = new ModelQueue({ slots: 1, file: null });
  const fake = controlled();
  const tracked = queue.track(fake.model, "ada");
  const failing = tracked.complete([], signal);
  const next = tracked.complete([], signal);
  await tick();
  fake.settle(0, new Error("boom"));
  await assert.rejects(failing, /boom/u);
  await tick();
  assert.equal(fake.calls(), 2);
  assert.equal(queue.inFlight(), 1);
  fake.settle(1);
  await next;
  assert.equal(queue.inFlight(), 0);
  assert.equal(queue.free(), true);
});

test("unknown slots run five calls at once with no wait", async () => {
  // A fixed clock: on the wall clock a loaded machine crosses a millisecond between the ask and the start (flaky, 2026-10-25).
  const queue = new ModelQueue({ slots: null, file: null, now: () => 0 });
  const fake = controlled();
  const tracked = queue.track(fake.model, "ada");
  const calls = [0, 1, 2, 3, 4].map(() => tracked.complete([], signal));
  await tick();
  assert.equal(fake.calls(), 5);
  for (const index of [0, 1, 2, 3, 4]) fake.settle(index);
  for (const reply of await Promise.all(calls)) assert.equal(reply.waitMs, 0);
});
