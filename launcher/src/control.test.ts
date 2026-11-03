import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { acquireLauncherLock, findRunningLauncher, launcherLockFile, releaseLauncherLock, setLockControlPort, startControlServer, STREAM_HEARTBEAT_MS, type StartTimer } from "./control.ts";
import type { BotOutcome } from "./stack.ts";
import { attach, cliContext, POST, RecordingHandlers, STATUS, until } from "./cli-test-support.ts";

const answerBotCall = (call: string): BotOutcome =>
  call === "start nobody"
    ? { ok: false, reason: "unknown-persona", message: 'No persona "nobody": C:/MineAI/personas has no nobody.json' }
    : call.startsWith("start ")
      ? { ok: true, message: `${call.slice(6)} is running` }
      : { ok: false, reason: "not-running", message: `${call.slice(5)} is not running.` };

async function withServer(run: (base: string, handlers: RecordingHandlers, control: Awaited<ReturnType<typeof startControlServer>>) => Promise<void>, startPort = 26_100, startTimer?: StartTimer): Promise<void> {
  const handlers = new RecordingHandlers(answerBotCall);
  const control = await startControlServer({ startPort, handlers, ...(startTimer ? { startTimer } : {}) });
  try {
    await run(`http://127.0.0.1:${control.port}`, handlers, control);
  } finally {
    await control.close();
  }
}

test("GET /status answers the stack's snapshot", () =>
  withServer(async (base) => {
    const answer = await fetch(`${base}/status`);
    assert.equal(answer.status, 200);
    assert.deepEqual(await answer.json(), STATUS);
  }));

test("POST /bots/<id>/start and /stop reach the stack and answer its message", () =>
  withServer(async (base, handlers) => {
    const started = await fetch(`${base}/bots/ayla/start`, POST);
    assert.deepEqual(await started.json(), { ok: true, message: "ayla is running" });
    const stopped = await fetch(`${base}/bots/ayla/stop`, POST);
    assert.equal(stopped.status, 409);
    assert.deepEqual(handlers.calls, ["start ayla", "stop ayla"]);
  }));

test("a persona without a file is a 404 that names the persona folder", () =>
  withServer(async (base) => {
    const answer = await fetch(`${base}/bots/nobody/start`, POST);
    assert.equal(answer.status, 404);
    assert.match(((await answer.json()) as { message: string }).message, /personas/u);
  }));

test("POST /stop starts the ordered stop once and answers at once", () =>
  withServer(async (base, handlers) => {
    const answer = await fetch(`${base}/stop`, POST);
    assert.equal(answer.status, 200);
    assert.deepEqual(handlers.calls, ["stop stack"]);
  }));

for (const [label, path, init, status] of [
  ["a web page cannot drive the launcher: a POST without the control header is refused", "/stop", { method: "POST" }, 403],
  ["a bad percent-escape in the persona id is a 400, not a crash", "/bots/%E0%A4%A/start", POST, 400],
  ["an unknown path is a 404", "/nope", undefined, 404],
] as const) {
  test(label, () =>
    withServer(async (base, handlers) => {
      assert.equal((await fetch(`${base}${path}`, init)).status, status);
      assert.deepEqual(handlers.calls, []);
    }));
}

test("a web page cannot hold the stack up: /attach without the control header is refused and counts as no console", () =>
  withServer(async (base, handlers, control) => {
    assert.equal((await fetch(`${base}/attach`)).status, 403);
    assert.equal(control.hasConsoleAttached(), false);
    const stream = await attach(base);
    assert.equal(control.hasConsoleAttached(), true);
    stream.hangUp();
    await until(() => handlers.lastStreamClosed === 1);
  }));

test("a request whose Host is not the loopback address (DNS rebinding) is refused", () =>
  withServer(async (base, handlers) => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(`${base}/status`, { headers: { host: "evil.example" } }, (response) => resolve(response.statusCode ?? 0));
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
    assert.deepEqual(handlers.calls, []);
  }));

test("a stream gets the lines already published, then the live ones", () =>
  withServer(async (base, _handlers, control) => {
    control.publish("Starting Ollama...");
    const stream = await attach(base);
    await stream.waitFor("Starting Ollama...");
    control.publish("Ayla is running");
    await stream.waitFor("Ayla is running");
    stream.hangUp();
  }));

test("when the last attached stream closes the stop starts once", () =>
  withServer(async (base, handlers) => {
    const stream = await attach(base);
    stream.hangUp();
    await until(() => handlers.lastStreamClosed === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(handlers.lastStreamClosed, 1);
  }));

test("a stream closing while another stays attached stops nothing", () =>
  withServer(async (base, handlers, control) => {
    const first = await attach(base);
    const second = await attach(base);
    first.hangUp();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(handlers.lastStreamClosed, 0);
    control.publish("still here");
    await second.waitFor("still here");
    second.hangUp();
    await until(() => handlers.lastStreamClosed === 1);
  }));

test("nothing stops a launcher that no console ever attached to", () =>
  withServer(async (base, handlers) => {
    await fetch(`${base}/status`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(handlers.lastStreamClosed, 0);
  }));

test("attaching to a stack that is stopping is refused with a line saying to wait", () =>
  withServer(async (base, handlers) => {
    handlers.status$ = { ...STATUS, phase: "stopping" };
    const answer = await fetch(`${base}/attach`, { headers: POST.headers });
    assert.equal(answer.status, 503);
    assert.match(((await answer.json()) as { message: string }).message, /stopping/u);
  }));

test("a taken control port is skipped and the free one is reported", async () => {
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(26_200, "0.0.0.0", resolve));
  try {
    await withServer(async (base, _handlers, control) => {
      assert.ok(control.port > 26_200);
      assert.equal((await fetch(`${base}/status`)).status, 200);
    }, 26_200);
  } finally {
    holder.close();
  }
});

// ---------- the lock file ----------

const rootFolder = (): string => cliContext("lock").root;
const alive = (pids: number[]) => (pid: number): boolean => pids.includes(pid);
const answering = (ports: number[]): typeof fetch => (async (url: string | URL | Request) => {
  if (!ports.includes(Number(new URL(String(url)).port))) throw new TypeError("refused");
  return new Response(JSON.stringify(STATUS));
}) as typeof fetch;

function writeLock(root: string, lock: unknown): void {
  mkdirSync(join(root, "run"), { recursive: true });
  writeFileSync(launcherLockFile(root), JSON.stringify(lock));
}

test("the first launcher takes the lock and a second sees it as running", async () => {
  const root = rootFolder();
  const deps = { isPidAlive: alive([4242]), fetch: answering([25_599]), now: () => 1_000, ownPid: 4242 };
  assert.deepEqual(await acquireLauncherLock(root, deps), { kind: "acquired" });
  setLockControlPort(root, 25_599);
  const second = await acquireLauncherLock(root, { ...deps, ownPid: 5151 });
  assert.deepEqual(second, { kind: "running", lock: { pid: 4242, controlPort: 25_599, startedAt: 1_000 } });
});

for (const [label, pids, ports] of [
  ["whose process is gone", [], [25_599]],
  ["whose pid runs but whose control port is silent (a reused pid)", [111], []],
] as const) {
  test(`a lock ${label} is replaced`, async () => {
    const root = rootFolder();
    writeLock(root, { pid: 111, controlPort: 25_599, startedAt: 1 });
    const deps = { isPidAlive: alive([...pids]), fetch: answering([...ports]), now: () => 9, ownPid: 222 };
    assert.deepEqual(await acquireLauncherLock(root, deps), { kind: "acquired" });
    assert.equal(JSON.parse(readFileSync(launcherLockFile(root), "utf8")).pid, 222);
  });
}

test("a lock still waiting for its control port counts as live for a minute, then as stale", async () => {
  const root = rootFolder();
  writeLock(root, { pid: 111, controlPort: null, startedAt: 1_000 });
  const base = { isPidAlive: alive([111]), fetch: answering([]), ownPid: 222 };
  assert.equal((await acquireLauncherLock(root, { ...base, now: () => 30_000 })).kind, "running");
  assert.equal((await acquireLauncherLock(root, { ...base, now: () => 120_000 })).kind, "acquired");
});

test("two launchers racing for the lock: exactly one takes it", async () => {
  const root = rootFolder();
  const deps = { isPidAlive: alive([1, 2]), fetch: answering([]), now: () => 5 };
  const results = await Promise.all([acquireLauncherLock(root, { ...deps, ownPid: 1 }), acquireLauncherLock(root, { ...deps, ownPid: 2 })]);
  assert.deepEqual(results.map((result) => result.kind).sort(), ["acquired", "running"]);
});

test("findRunningLauncher answers the live launcher, null for none or a dead one", async () => {
  const root = rootFolder();
  const deps = { isPidAlive: alive([111]), fetch: answering([25_599]), now: () => 9 };
  assert.equal(await findRunningLauncher(root, deps), null);
  writeLock(root, { pid: 111, controlPort: 25_599, startedAt: 1 });
  assert.equal((await findRunningLauncher(root, deps))?.controlPort, 25_599);
  assert.equal(await findRunningLauncher(root, { ...deps, isPidAlive: alive([]) }), null);
});

test("releasing the lock removes only our own", async () => {
  const root = rootFolder();
  writeLock(root, { pid: 111, controlPort: 1, startedAt: 1 });
  releaseLauncherLock(root, 222);
  assert.equal(JSON.parse(readFileSync(launcherLockFile(root), "utf8")).pid, 111);
  releaseLauncherLock(root, 111);
  assert.equal(await findRunningLauncher(root, { isPidAlive: alive([111]), fetch: answering([1]), now: () => 2 }), null);
});

// ---------- the stream heartbeat (Bun's fetch ends a stream with no byte for 360 s) ----------

/** Reads the raw bytes of `/attach` until `text` came in, or `limitMs` passed; the text read so far. */
async function readRawUntil(base: string, text: string, limitMs = 3000): Promise<string> {
  const abort = new AbortController();
  const response = await fetch(`${base}/attach`, { signal: abort.signal, headers: POST.headers });
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = "";
  const timer = setTimeout(() => abort.abort(), limitMs);
  try {
    while (!received.includes(text)) {
      const { done, value } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
    }
  } catch {
    // the limit hung up
  } finally {
    clearTimeout(timer);
    abort.abort();
  }
  return received;
}

test("an attached stream gets a `: ping` comment line every heartbeat, so no client sees 360 s of silence", async () => {
  const control = await startControlServer({ startPort: 26_110, handlers: new RecordingHandlers(), heartbeatMs: 20 });
  try {
    const received = await readRawUntil(`http://127.0.0.1:${control.port}`, ": ping\n\n: ping\n\n");
    assert.match(received, /: attached\n\n(: ping\n\n){2}/u);
  } finally {
    await control.close();
  }
});

/** Stands in for the heartbeat timer: `started` lists the timers asked for, `stopped` counts the ones stopped. */
function fakeTimer() {
  const started: { tick: () => void; everyMs: number }[] = [];
  let stopped = 0;
  return {
    started,
    get stopped() {
      return stopped;
    },
    startTimer: (tick: () => void, everyMs: number) => {
      started.push({ tick, everyMs });
      return () => void stopped++;
    },
  };
}

test("one timer of STREAM_HEARTBEAT_MS serves all streams: it starts at the first attach, runs while one stream stays, stops with the last, and a later attach starts a new one", () => {
  const timer = fakeTimer();
  return withServer(async (base) => {
    assert.equal(STREAM_HEARTBEAT_MS, 30_000);
    assert.equal(timer.started.length, 0, "no timer while no console is attached");
    const first = await attach(base);
    const second = await attach(base);
    assert.equal(timer.started.length, 1);
    assert.equal(timer.started[0]!.everyMs, STREAM_HEARTBEAT_MS);
    first.hangUp();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(timer.stopped, 0, "a stream stays attached: the timer runs on");
    second.hangUp();
    await until(() => timer.stopped === 1);
    const third = await attach(base);
    assert.equal(timer.started.length, 2);
    third.hangUp();
    await until(() => timer.stopped === 2);
  }, 26_120, timer.startTimer);
});

test("closing the server stops the heartbeat of streams still attached", () => {
  const timer = fakeTimer();
  return withServer(async (base, _handlers, control) => {
    const stream = await attach(base);
    await control.close();
    assert.equal(timer.stopped, 1);
    stream.hangUp();
  }, 26_130, timer.startTimer);
});
