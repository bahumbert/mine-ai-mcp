import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createFakeBot } from "../../src/test-support/fake-bot/index.ts";
import { openRuntimeWith } from "./runtime.ts";

interface StubRuntime extends AsyncDisposable {
  close(): Promise<void>;
  closes: number;
}

/** A runtime whose close either resolves, or rejects with `closeError` when one is given. */
function stubRuntime(closeError?: Error): StubRuntime {
  const runtime: StubRuntime = {
    closes: 0,
    async close() {
      runtime.closes += 1;
      if (closeError) throw closeError;
    },
    [Symbol.asyncDispose]() {
      return runtime.close();
    },
  };
  return runtime;
}

/** Records every watch the scenario starts and how often each is disposed. */
function stubWatches() {
  const started: { dir: string; botName: string; disposals: number }[] = [];
  const startWatch = ({ dir, botName }: { dir: string; botName: string }) => {
    const watch = { dir, botName, disposals: 0 };
    started.push(watch);
    return {
      lastRecord: () => null,
      [Symbol.dispose]() {
        watch.disposals += 1;
      },
    };
  };
  return { started, startWatch };
}

const { bot } = createFakeBot({ username: "Actor" });
const options = {};

test("a runtime that fails to create starts no freeze watch", async () => {
  const { started, startWatch } = stubWatches();
  const creation = new Error("connection refused");
  await assert.rejects(
    openRuntimeWith(
      { createRuntime: async () => { throw creation; }, startWatch },
      bot,
      "world",
      options,
      "/artifacts",
    ),
    creation,
  );
  assert.equal(started.length, 0);
});

test("closing the runtime disposes its freeze watch once, at the artifacts folder of its bot", async () => {
  const { started, startWatch } = stubWatches();
  const runtime = stubRuntime();
  const opened = await openRuntimeWith(
    { createRuntime: async () => runtime, startWatch },
    bot,
    "world",
    options,
    "/artifacts",
  );
  assert.equal(started.length, 1);
  assert.equal(started[0]!.dir, path.join("/artifacts", "Actor", "freezes"));
  assert.equal(started[0]!.botName, "Actor");
  await opened.close();
  assert.equal(runtime.closes, 1);
  assert.equal(started[0]!.disposals, 1);
});

test("a close that throws still disposes the freeze watch once and rethrows the error", async () => {
  const { started, startWatch } = stubWatches();
  const closeError = new Error("world save failed");
  const opened = await openRuntimeWith(
    { createRuntime: async () => stubRuntime(closeError), startWatch },
    bot,
    "world",
    options,
    "/artifacts",
  );
  await assert.rejects(opened.close(), closeError);
  assert.equal(started[0]!.disposals, 1);
});

test("close and asyncDispose, in either order, dispose the freeze watch once", async () => {
  const orders = [
    ["close", "asyncDispose"],
    ["asyncDispose", "close"],
  ] as const;
  for (const order of orders) {
    const { started, startWatch } = stubWatches();
    const opened = await openRuntimeWith(
      { createRuntime: async () => stubRuntime(), startWatch },
      bot,
      "world",
      options,
      "/artifacts",
    );
    for (const step of order) {
      if (step === "close") await opened.close();
      else await opened[Symbol.asyncDispose]();
    }
    assert.equal(started[0]!.disposals, 1, `order: ${order.join(" then ")}`);
  }
});

test("without an artifacts folder no freeze watch is started", async () => {
  const { started, startWatch } = stubWatches();
  const opened = await openRuntimeWith(
    { createRuntime: async () => stubRuntime(), startWatch },
    bot,
    "world",
    options,
    undefined,
  );
  await opened.close();
  assert.equal(started.length, 0);
});
