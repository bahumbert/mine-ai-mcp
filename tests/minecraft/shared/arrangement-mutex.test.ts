import test from "node:test";
import assert from "node:assert/strict";
import { ArrangementMutex } from "./arrangement-mutex.ts";

test("two lanes' arrangements never overlap and run in the order they asked", async () => {
  const mutex = new ArrangementMutex();
  const events: string[] = [];
  const arrange = async (name: string): Promise<void> => {
    const release = await mutex.acquire();
    events.push(`${name}:start`);
    await new Promise(resolve => setTimeout(resolve, 5));
    events.push(`${name}:end`);
    release();
  };
  await Promise.all([arrange("a"), arrange("b"), arrange("c")]);
  assert.deepEqual(events, ["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
});

test("releasing twice does not free the next holder's turn early", async () => {
  const mutex = new ArrangementMutex();
  const first = await mutex.acquire();
  const second = mutex.acquire();
  first();
  const releaseSecond = await second;
  first();
  let thirdHolds = false;
  void mutex.acquire().then(() => { thirdHolds = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(thirdHolds, false);
  releaseSecond();
});

test("a trial aborted while it waits for the mutex leaves the queue and the next one proceeds", async () => {
  const mutex = new ArrangementMutex();
  const held = await mutex.acquire();
  const controller = new AbortController();
  const aborted = mutex.acquire(controller.signal);
  const next = mutex.acquire();
  controller.abort("cancelled");
  await assert.rejects(aborted, /cancelled/u);
  held();
  (await next)();
});

test("an already aborted signal never takes the mutex", async () => {
  const mutex = new ArrangementMutex();
  await assert.rejects(mutex.acquire(AbortSignal.abort("stopped")), /stopped/u);
  (await mutex.acquire())();
});
