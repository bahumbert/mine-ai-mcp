/** Contract checks against the runtime fixtures and the measured child-process signal probe. */
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeRuntimeChild } from "./fake-runtime-child.js";
import { runtimeMessageSchema } from "../server/runtime-liveness.js";
import { createFakeClock } from "./fake-bot/fake-clock.js";

test("slow replies use the manual clock and each arrival waits for its own request", async (t) => {
  const clock = createFakeClock({ mode: "manual" });
  const child = createFakeRuntimeChild({ clock, slowMs: 1_000 });
  t.after(() => child.close());
  await child.ready();
  const url = `http://127.0.0.1:${child.port}/slow`;
  const first = fetch(url).then((reply) => reply.text());
  await child.arrived("/slow");
  await clock.advance(1_000);
  assert.equal(await first, "finished");
  let arrived = false;
  const next = child.arrived("/slow").then(() => { arrived = true; });
  await clock.advance(0);
  assert.equal(arrived, false, "the preceding request cannot satisfy the next arrival");
  const second = fetch(url).then((reply) => reply.text());
  await next;
  await clock.advance(1_000);
  assert.equal(await second, "finished");
});

test("fake runtime messages parse and preserve active execution and fault attribution", async (t) => {
  const child = createFakeRuntimeChild();
  t.after(() => child.close());
  const messages: any[] = [];
  child.on("message", (raw) => messages.push(runtimeMessageSchema.parse(raw)));
  child.fault({ kind: "unhandled_rejection", message: "before ready", stack: null, observedAt: new Date().toISOString(), repeats: 0 });
  await child.ready();
  child.beat();
  const reply = await fetch(`http://127.0.0.1:${child.port}/fault-during-request`);
  assert.equal(await reply.text(), '{"ok":true}'); // faulting-runtime.ts:33
  assert.ok(messages.some((m) => m.kind === "ready"));
  assert.ok(messages.some((m) => m.kind === "heartbeat" && m.memory.rss > 0));
  assert.ok(messages.some((m) => m.kind === "execution" && m.activity.active[0]?.owner.requestId === 812));
  assert.ok(messages.some((m) => m.kind === "fault" && m.fault.message === "raised during request 812"));
  child.beat();
  assert.deepEqual(messages.filter((m) => m.kind === "execution").map((m) => m.event.kind), ["entered", "returned"]);
  assert.deepEqual(messages.at(-1).activity.active, []);
  assert.equal(messages.at(-1).activity.precedingRequestId, null, "faulting-runtime.ts:28 keeps the scope undisposed");
  assert.equal((await fetch(`http://127.0.0.1:${child.port}/fault`)).status, 200);
  child.beat();
  assert.equal(messages.at(-1).activity.precedingRequestId, null);
});

for (const ignoreSigterm of [false, true]) {
  test(`fake runtime exits on a later turn with measured signal fields (ignore SIGTERM: ${ignoreSigterm})`, async (t) => {
    const child = createFakeRuntimeChild({ ignoreSigterm });
    t.after(() => child.close());
    let exited = false;
    child.once("exit", () => { exited = true; });
    const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve([code, signal])));
    assert.equal(child.kill("SIGTERM"), true);
    assert.equal(exited, false);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, null);
    if (ignoreSigterm) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(exited, false);
      assert.equal(child.kill("SIGKILL"), true);
    }
    assert.deepEqual(await exit, [null, ignoreSigterm ? "SIGKILL" : "SIGTERM"]);
    assert.equal(child.exitCode, null);
    assert.equal(child.signalCode, ignoreSigterm ? "SIGKILL" : "SIGTERM");
    assert.equal(child.kill("SIGKILL"), false);
  });
}

for (const route of ["health", "slow", "pause", "fault", "fault-twice"] as const) {
  test(`fake runtime /${route} answers like its fixture`, async (t) => {
    const clock = createFakeClock({ mode: "manual" });
    const child = createFakeRuntimeChild({ clock, slowMs: 1, pauseMs: 1 });
    t.after(() => child.close());
    const faults: string[] = [];
    let beats = 0;
    child.on("message", (raw) => {
      const message = runtimeMessageSchema.parse(raw);
      if (message.kind === "fault") faults.push(message.fault.message);
      if (message.kind === "heartbeat") beats++;
    });
    await child.ready();
    const request = fetch(`http://127.0.0.1:${child.port}/${route}`);
    await child.arrived(`/${route}`);
    if (route === "slow") await clock.advance(1);
    const reply = await request;
    assert.equal(reply.status, 200);
    // wedged-runtime.ts:49-62; faulting-runtime.ts:22-33.
    assert.equal(await reply.text(), route === "slow" ? "finished" : route === "pause" ? "accepted" : '{"ok":true}');
    assert.deepEqual(faults, route === "fault" ? ["raised while ready"] : route === "fault-twice" ? ["first distinct fault", "second distinct fault"] : []);
    if (route === "pause") {
      await clock.advance(99);
      child.beat();
      assert.equal(beats, 1);
      await clock.advance(1);
      child.beat();
      assert.equal(beats, 1, "the blocked pause cannot emit a heartbeat");
      await clock.advance(1);
      child.beat();
      assert.equal(beats, 2, "heartbeats resume after the pause");
    }
  });
}

for (const route of ["hang", "microtask", "sse-hang", "crash"] as const) {
  test(`fake runtime /${route} arrives before a held request or exit`, async (t) => {
    const child = createFakeRuntimeChild();
    t.after(() => child.close());
    await child.ready();
    const messages: any[] = [];
    child.on("message", (raw) => messages.push(runtimeMessageSchema.parse(raw)));
    const cancellation = new AbortController();
    t.after(() => cancellation.abort());
    const request = fetch(`http://127.0.0.1:${child.port}/${route}`, { signal: cancellation.signal }).then(async (reply) => {
      if (route === "sse-hang") assert.match(reply.headers.get("content-type") ?? "", /text\/event-stream/);
      return reply.text();
    });
    const rejected = assert.rejects(request);
    await child.arrived(`/${route}`);
    // wedged-runtime.ts:65-78: crash exits 23; other routes keep an attributed operation pending.
    if (route === "crash") assert.equal(child.exitCode, 23);
    else {
      assert.equal(messages.at(-1).activity.active[0].owner.operation, "fault_injection");
      const before = messages.length;
      child.beat();
      assert.equal(messages.length, before, "a blocked fixture loop cannot send heartbeats");
    }
    cancellation.abort();
    await rejected;
  });
}

test("fake background request keeps the restored route active after replying", async (t) => {
  const clock = createFakeClock({ mode: "manual" });
  const child = createFakeRuntimeChild({ clock, historyMs: 1 });
  t.after(() => child.close());
  const realPerformanceNow = performance.now;
  performance.now = clock.now;
  t.after(() => { performance.now = realPerformanceNow; });
  const realNow = Date.now;
  let wallTime = Date.now();
  Date.now = () => wallTime;
  t.after(() => { Date.now = realNow; });
  const messages: any[] = [];
  child.on("message", (raw) => messages.push(runtimeMessageSchema.parse(raw)));
  await child.ready();
  const reply = await fetch(`http://127.0.0.1:${child.port}/background`);
  assert.equal(await reply.text(), "accepted"); // wedged-runtime.ts:32-47
  child.beat();
  assert.equal(messages.at(-1).activity.active[0].owner.requestId, 812);
  assert.equal(messages.at(-1).activity.active[0].activePhase, "route");
  wallTime -= 2_000;
  await clock.advance(2_000);
  const before = messages.length;
  child.beat();
  assert.equal(messages.length, before + 1, "the background delay has not elapsed on the monotonic clock");
  await clock.advance(50);
  const expired = messages.length;
  child.beat();
  assert.equal(messages.length, expired, "a backward wall step cannot extend the background delay");
});
