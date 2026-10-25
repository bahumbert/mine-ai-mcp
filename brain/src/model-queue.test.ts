import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ChatModel, ChatReply, ChatTurn } from "./chat-model.ts";
import { ModelQueue, startStaggered, type QueueSnapshot } from "./model-queue.ts";

const REPLY: ChatReply = { text: "{}", promptTokens: null, contextTokens: null };

/** A model whose calls stay open until the test settles them. */
function controlled(name = "fake"): {
  model: ChatModel;
  settle: (index: number, error?: Error) => void;
  calls: () => number;
  /** What each call that reached the model said (its first turn), in the order they reached it. */
  entered: string[];
  /** Settles every call that reaches the model, including those a slot lets in meanwhile, until none is left. */
  drain: () => Promise<void>;
} {
  const pending: { resolve: (reply: ChatReply) => void; reject: (error: Error) => void }[] = [];
  const entered: string[] = [];
  let settled = 0;
  return {
    model: {
      name,
      complete: (turns) => {
        entered.push(turns[0]?.content ?? "");
        return new Promise<ChatReply>((resolve, reject) => pending.push({ resolve, reject }));
      },
    },
    settle: (index, error) => (error === undefined ? pending[index]!.resolve(REPLY) : pending[index]!.reject(error)),
    calls: () => pending.length,
    entered,
    drain: async () => {
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (settled >= pending.length) return;
        while (settled < pending.length) pending[settled++]!.resolve(REPLY);
      }
    },
  };
}

const say = (content: string): ChatTurn[] => [{ role: "user", content }];

const signal = new AbortController().signal;

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

test("calls beyond the slots are counted as waiting", async () => {
  const queue = new ModelQueue({ slots: 2, file: null });
  const fake = controlled();
  const model = queue.track(fake.model, "ada");
  const calls = [model.complete([], signal), model.complete([], signal), model.complete([], signal), model.complete([], signal)];
  assert.equal(queue.inFlight(), 4);
  assert.equal(queue.waiting(), 2);
  fake.settle(0);
  await calls[0];
  assert.equal(queue.waiting(), 1);
  await fake.drain();
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
  await fake.drain();
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

test("with 3 slots a 4th call reaches the model only once one of the first three ends, and the held time is not inside the call", async () => {
  const queue = new ModelQueue({ slots: 3, file: null });
  const fake = controlled();
  const model = queue.track(fake.model, "ada");
  const calls = ["a", "b", "c", "d"].map((name) => model.complete(say(name), signal));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(fake.entered, ["a", "b", "c"]);
  assert.equal(queue.inFlight(), 4);
  assert.equal(queue.waiting(), 1);
  fake.settle(1);
  await calls[1];
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(fake.entered, ["a", "b", "c", "d"]);
  assert.equal(queue.waiting(), 0);
  await fake.drain();
  await Promise.all(calls);
  assert.equal(queue.inFlight(), 0);
});

test("held calls get the slot in the order they asked", async () => {
  const queue = new ModelQueue({ slots: 1, file: null });
  const fake = controlled();
  const model = queue.track(fake.model, "ada");
  const calls = ["first", "second", "third", "fourth"].map((name) => model.complete(say(name), signal));
  await fake.drain();
  await Promise.all(calls);
  assert.deepEqual(fake.entered, ["first", "second", "third", "fourth"]);
});

/** An abort controller that counts the listeners on its signal (a `{ once: true }` one leaves when the event fires). */
function listenerCounted(): { abort: AbortController; listeners: () => number } {
  const abort = new AbortController();
  let listeners = 0;
  const { addEventListener, removeEventListener } = abort.signal;
  abort.signal.addEventListener = ((...args: Parameters<typeof addEventListener>) => {
    listeners += 1;
    if (typeof args[2] === "object" && args[2].once === true) addEventListener.call(abort.signal, args[0], () => (listeners -= 1), { once: true });
    return addEventListener.apply(abort.signal, args);
  }) as typeof addEventListener;
  abort.signal.removeEventListener = ((...args: Parameters<typeof removeEventListener>) => {
    listeners -= 1;
    return removeEventListener.apply(abort.signal, args);
  }) as typeof removeEventListener;
  return { abort, listeners: () => listeners };
}

test("a held call whose signal aborts leaves the line; the next one gets the slot; no listener is left on either signal", async () => {
  const queue = new ModelQueue({ slots: 1, file: null });
  const fake = controlled();
  const model = queue.track(fake.model, "ada");
  const running = model.complete(say("running"), signal);
  const leaver = listenerCounted();
  const stayer = listenerCounted();
  const leaving = model.complete(say("leaving"), leaver.abort.signal);
  const next = model.complete(say("next"), stayer.abort.signal);
  assert.equal(queue.waiting(), 2);
  const reason = new Error("stopped");
  leaver.abort.abort(reason);
  await assert.rejects(leaving, (error) => error === reason);
  assert.equal(queue.waiting(), 1);
  assert.equal(queue.inFlight(), 2);
  assert.equal(leaver.listeners(), 0, "the aborted waiter's listener is gone");
  fake.settle(0);
  await running;
  await fake.drain();
  await next;
  assert.deepEqual(fake.entered, ["running", "next"]);
  assert.equal(stayer.listeners(), 0, "the waiter that got the slot dropped its listener");
  assert.equal(queue.inFlight(), 0);
});

test("a held call whose signal is already aborted never reaches the model", async () => {
  const queue = new ModelQueue({ slots: 1, file: null });
  const fake = controlled();
  const model = queue.track(fake.model, "ada");
  const running = model.complete(say("running"), signal);
  const gone = AbortSignal.abort(new Error("gone"));
  await assert.rejects(model.complete(say("late"), gone), /gone/u);
  assert.equal(queue.waiting(), 0);
  await fake.drain();
  await running;
  assert.deepEqual(fake.entered, ["running"]);
});

test("a call that rejects gives its slot to the next one", async () => {
  const queue = new ModelQueue({ slots: 1, file: null });
  const fake = controlled();
  const model = queue.track(fake.model, "ada");
  const failing = model.complete(say("failing"), signal);
  const next = model.complete(say("next"), signal);
  assert.deepEqual(fake.entered, ["failing"]);
  fake.settle(0, new Error("boom"));
  await assert.rejects(failing, /boom/u);
  await fake.drain();
  await next;
  assert.deepEqual(fake.entered, ["failing", "next"]);
  assert.equal(queue.inFlight(), 0);
});

test("with 20 calls on 3 slots, never more than 3 run at once and all 20 finish", async () => {
  const queue = new ModelQueue({ slots: 3, file: null });
  let running = 0;
  let most = 0;
  let finished = 0;
  const model = queue.track(
    {
      name: "fake",
      complete: async () => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running -= 1;
        finished += 1;
        return REPLY;
      },
    },
    "ada",
  );
  await Promise.all(Array.from({ length: 20 }, () => model.complete([], signal)));
  assert.equal(finished, 20);
  assert.equal(most, 3);
  assert.equal(queue.inFlight(), 0);
  assert.equal(queue.waiting(), 0);
});
