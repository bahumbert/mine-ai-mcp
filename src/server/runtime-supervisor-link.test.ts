import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { IncidentRecorder } from "../diagnostics/incident-recorder.js";
import type { RestartSettings } from "./runtime-liveness.js";
import { startMcpSupervisor } from "./runtime-supervisor.js";

const fixtureFile = fileURLToPath(new URL("../test-support/link-runtime.fixture.ts", import.meta.url));
const fixtureArgs = (...waits: string[]) => [...process.execArgv, fixtureFile, ...waits];
const DEADLINES = { startupMs: 5_000, unresponsiveMs: 1_000, heartbeatMs: 100, killGraceMs: 500 };
/** One restart at once, then none: the second failure stays down. */
const RESTART_AT_ONCE: RestartSettings = { delays: [{ minMs: 0, maxMs: 0 }], attempts: 2, healthyMs: 60_000 };
const NEVER_READY_MS = 600_000;

/** A supervisor over the link fixture, closed and removed when the test ends; `lines` are its `[minecraft-supervisor]` lines. */
async function linked(t: TestContext, options: { restart?: RestartSettings | null; waits?: string[] } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-link-"));
  const lines: string[] = [];
  const supervisor = await startMcpSupervisor({
    executable: process.execPath,
    args: fixtureArgs(...(options.waits ?? [])),
    host: "127.0.0.1",
    port: 0,
    instanceId: "link-test",
    source: { kind: "unavailable", reason: "test fixture" },
    incidents: { directory, retention: { days: 1, maxBytes: 1024 * 1024 } },
    deadlines: DEADLINES,
    restart: options.restart ?? null,
    log: (line) => lines.push(line),
  });
  t.after(async () => {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  });
  const address = supervisor.server.address();
  assert.ok(address && typeof address !== "string");
  return { supervisor, lines, url: `http://127.0.0.1:${address.port}` };
}
type Linked = Awaited<ReturnType<typeof linked>>;

/** The runtime's state as the supervisor's own diagnostics route reports it. */
async function stateOf({ url }: Linked): Promise<string> {
  return (await (await fetch(`${url}/diagnostics/runtime`)).json()).state;
}

/** Bounded by the test's own timeout. */
async function whenState(target: Linked, wanted: string): Promise<void> {
  while ((await stateOf(target)) !== wanted) await delay(20);
}

async function connectClient(target: Linked): Promise<Client> {
  const client = new Client({ name: "link-test", version: "1.0.0" });
  await client.connect(await target.supervisor.openLink());
  return client;
}

/** A link opened as soon as the runtime is ready again (it refuses while it is starting). */
async function connectWhenReady(target: Linked): Promise<Client> {
  await whenState(target, "ready");
  return connectClient(target);
}

const echoText = async (client: Client, text: string) => {
  const result = await client.callTool({ name: "echo", arguments: { text } });
  return (result.content as { text: string }[])[0]!.text;
};
const closed = (client: Client) => new Promise<void>((resolve) => (client.onclose = resolve));

test("openLink before ready rejects with RUNTIME_STARTING", { timeout: 15_000 }, async (t) => {
  const target = await linked(t, { waits: [`--ready-ms=${NEVER_READY_MS}`] });
  await assert.rejects(target.supervisor.openLink(), /^Error: \[RUNTIME_STARTING\] the runtime is starting/u);
});

test("openLink after a failure rejects with the saved failure", { timeout: 20_000 }, async (t) => {
  const target = await linked(t);
  const client = await connectWhenReady(target);
  const wedged = client.callTool({ name: "wedge" }).catch((error: unknown) => error);
  await whenState(target, "failed");
  await assert.rejects(target.supervisor.openLink(), /^Error: \[RUNTIME_UNRESPONSIVE\] /u);
  assert.match(String(await wedged), /\[RUNTIME_UNRESPONSIVE\]/u);
});

test("a link call pending at the kill gets the failure", { timeout: 20_000 }, async (t) => {
  const target = await linked(t);
  const slowLink = await connectWhenReady(target);
  const wedgeLink = await connectClient(target);
  const slowClosed = closed(slowLink);
  const wedgeClosed = closed(wedgeLink);
  const startedAt = performance.now();
  const slowCall = slowLink.callTool({ name: "slow" });
  const wedgeCall = wedgeLink.callTool({ name: "wedge" }).catch(() => undefined);
  await assert.rejects(slowCall, /\[RUNTIME_UNRESPONSIVE\]/u);
  assert.ok(performance.now() - startedAt < 3_000, "the failure answers within the watchdog bound, not at the call's own end");
  await Promise.all([slowClosed, wedgeClosed, wedgeCall]);
});

test("a restarted runtime takes a new link", { timeout: 25_000 }, async (t) => {
  const target = await linked(t, { restart: RESTART_AT_ONCE });
  const first = await connectWhenReady(target);
  const firstClosed = closed(first);
  await first.callTool({ name: "wedge" }).catch(() => undefined);
  await firstClosed; // The link a restart ends: the next action opens another.
  await whenState(target, "starting");
  await assert.rejects(target.supervisor.openLink(), /^Error: \[RUNTIME_STARTING\]/u);
  const second = await connectWhenReady(target);
  assert.equal(await echoText(second, "after the restart"), "after the restart");
  await second.close();
  const events = target.lines.map((line) => JSON.parse(line.slice("[minecraft-supervisor] ".length)) as Record<string, unknown>);
  assert.ok(events.length > 0);
  assert.ok(events.every((row) => row.instanceId === "link-test"), "every supervisor line names its host (spec D2)");
});

test("close closes every link and the child exits", { timeout: 15_000 }, async (t) => {
  const target = await linked(t);
  const first = await connectWhenReady(target);
  const second = await connectClient(target);
  const bothClosed = Promise.all([closed(first), closed(second)]);
  const child = target.supervisor.child;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  await target.supervisor.close();
  await bothClosed;
  await exited;
});

test("a killed parent takes its child", { timeout: 20_000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-link-parent-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = path.join(directory, "parent.ts");
  const supervisorUrl = new URL("./runtime-supervisor.ts", import.meta.url).href;
  await writeFile(
    script,
    `import { startMcpSupervisor } from ${JSON.stringify(supervisorUrl)};
const { executable, args, directory } = JSON.parse(process.argv[2]!);
const supervisor = await startMcpSupervisor({ executable, args, host: "127.0.0.1", port: 0, instanceId: "parent-script",
  source: { kind: "unavailable", reason: "test" }, incidents: { directory, retention: { days: 1, maxBytes: 1048576 } },
  restart: null, log: () => {} });
console.log("child-pid " + supervisor.child.pid);
setInterval(() => {}, 1000);
`,
  );
  const parent = spawn(process.execPath, [script, JSON.stringify({ executable: process.execPath, args: fixtureArgs(), directory })], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  t.after(() => void parent.kill("SIGKILL"));
  const childPid = await new Promise<number>((resolve, reject) => {
    parent.stdout.on("data", (chunk: Buffer) => {
      const found = /child-pid (\d+)/u.exec(chunk.toString());
      if (found) resolve(Number(found[1]));
    });
    parent.once("exit", () => reject(new Error("the parent script ended before it printed its child's pid")));
  });
  assert.doesNotThrow(() => process.kill(childPid, 0), "the child runs while its parent does");
  parent.kill("SIGKILL");
  const deadline = performance.now() + 5_000;
  const alive = () => {
    try {
      process.kill(childPid, 0);
      return true;
    } catch {
      return false;
    }
  };
  while (alive() && performance.now() < deadline) await delay(50);
  assert.equal(alive(), false, "the child is gone within 5 s of its parent's SIGKILL");
});

/**
 * What `ChildProcess.send` does to a dead child, measured on Bun 1.4.3 (`.agent/reports/2026-11-18-in-process-baseline.md`,
 * "IPC probe"): it never throws and returns `true` with no error right after a SIGKILL, before `exit`; after `exit` it
 * returns `false`, calls the callback with `Subprocess.send() cannot be used after the process has exited.` and, when it
 * had no callback, emits `'error'` on the child, which with no listener is an uncaught exception of the parent. So every
 * send passes a callback and the failure answers what was in flight.
 */
test("sends on a killed child's links do not crash the parent", { timeout: 20_000 }, async (t) => {
  const target = await linked(t);
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  process.on("uncaughtException", onUncaught);
  t.after(() => void process.off("uncaughtException", onUncaught));
  const releaseCapture = holdIncidentCapture(t);
  const links = [await connectWhenReady(target), await connectClient(target)];
  const calls: Promise<unknown>[] = [];
  const callOnEachLink = () =>
    links.forEach((link, index) => calls.push(link.callTool({ name: "echo", arguments: { text: `${index}` } }).then(() => "answered", (error: unknown) => String(error))));
  target.supervisor.child.kill("SIGKILL");
  callOnEachLink(); // Before the exit event: the write succeeds and is lost.
  await whenState(target, "failing"); // The capture is held: the child is gone, the failure is not saved yet.
  callOnEachLink();
  callOnEachLink();
  releaseCapture();
  const outcomes = await Promise.all(calls);
  assert.equal(outcomes.length, 6);
  for (const outcome of outcomes) assert.match(String(outcome), /\[RUNTIME_EXITED\]/u, "each call ends with the failure");
  assert.deepEqual(uncaught, []);
});

test("a link request while the runtime is failing is kept for the failure and not forwarded", { timeout: 20_000 }, async (t) => {
  const target = await linked(t);
  const releaseCapture = holdIncidentCapture(t);
  const link = await connectWhenReady(target);
  const child = target.supervisor.child;
  const forwarded: unknown[] = [];
  assert.ok(child.send, "the fake child has an IPC channel");
  const send = child.send.bind(child);
  child.send = ((message: unknown, ...rest: never[]) => {
    forwarded.push(message);
    return (send as (message: unknown, ...rest: never[]) => boolean)(message, ...rest);
  }) as typeof child.send;
  child.kill("SIGKILL");
  await whenState(target, "failing");
  const writtenBefore = forwarded.length;
  const call = link.callTool({ name: "echo", arguments: { text: "late" } }).then(() => "answered", (error: unknown) => String(error));
  await delay(100);
  releaseCapture();
  assert.match(await call, /\[RUNTIME_EXITED\]/u);
  assert.equal(forwarded.length, writtenBefore, "nothing was written to the dead child for it");
});

/** Holds every incident capture of the supervisors under test until the returned function is called. */
function holdIncidentCapture(t: TestContext): () => void {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const capture = IncidentRecorder.prototype.capture;
  t.mock.method(IncidentRecorder.prototype, "capture", async function (this: IncidentRecorder, ...args: Parameters<typeof capture>) {
    await gate;
    return capture.apply(this, args);
  });
  t.after(release);
  return release;
}
