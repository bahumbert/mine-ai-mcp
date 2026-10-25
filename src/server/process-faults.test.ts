import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  formatProcessFault,
  reportFaultToStderrAndParent,
  reportUnhandledRejections,
  type ProcessFault,
} from "./process-faults.js";

interface FixtureRun {
  readonly faults: ProcessFault[];
  readonly alive: boolean;
  readonly exitCode: number | null;
}

/** Runs the fixture in a child process, bounded on the wall clock. */
async function runFixture(mode: string, repeatMs = 60_000): Promise<FixtureRun> {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./process-faults.fixture.ts", import.meta.url)), mode, String(repeatMs)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const bound = setTimeout(() => child.kill("SIGKILL"), 10_000);
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const [exitCode] = (await once(child, "close")) as [number | null];
  clearTimeout(bound);
  assert.equal(exitCode, 0, output);
  const lines = output.split("\n");
  return {
    faults: lines.filter((line) => line.startsWith("FAULT ")).map((line) => JSON.parse(line.slice(6))),
    alive: lines.includes("alive"),
    exitCode,
  };
}

test("an unhandled rejection is reported and the process keeps running", { timeout: 15_000 }, async () => {
  const run = await runFixture("single");
  assert.equal(run.faults.length, 1);
  assert.deepEqual(
    { kind: run.faults[0]!.kind, message: run.faults[0]!.message, repeats: run.faults[0]!.repeats },
    { kind: "unhandled_rejection", message: "boom", repeats: 0 },
  );
  assert.match(run.faults[0]!.stack ?? "", /process-faults\.fixture/);
  assert.ok(Number.isFinite(Date.parse(run.faults[0]!.observedAt)));
  assert.ok(run.alive, "the process ran on after the rejection");
});

test("100 identical rejections give one full report and a count", { timeout: 15_000 }, async () => {
  const run = await runFixture("storm");
  assert.deepEqual(run.faults.map((fault) => fault.repeats), [0, 99], "the full report, then the 99 others as one count on stop");
  assert.ok(run.alive);
});

test("an identical fault after the repeat window reports its count again", { timeout: 15_000 }, async () => {
  const run = await runFixture("storm-later", 300);
  assert.deepEqual(run.faults.map((fault) => fault.repeats), [0, 100], "99 held back plus the one that came after the window");
});

test("two distinct rejections give two reports", { timeout: 15_000 }, async () => {
  const run = await runFixture("distinct");
  assert.deepEqual(run.faults.map((fault) => fault.message), ["first fault", "second fault"]);
});

test("a rejection that is not an Error is reported by its text with no stack", { timeout: 15_000 }, async () => {
  const run = await runFixture("plain-string");
  assert.deepEqual(
    { message: run.faults[0]?.message, stack: run.faults[0]?.stack },
    { message: "plain reason", stack: null },
  );
});

test("more distinct faults than the reporter remembers still all report, and a forgotten one reports in full again", { timeout: 15_000 }, async () => {
  const run = await runFixture("many");
  assert.equal(run.faults.filter((fault) => fault.repeats === 0).length, 151, "150 distinct faults, then the evicted first one anew");
});

test("disposing the reporter removes its listener", () => {
  const before = process.listenerCount("unhandledRejection");
  const reporter = reportUnhandledRejections(() => {});
  assert.equal(process.listenerCount("unhandledRejection"), before + 1);
  reporter[Symbol.dispose]();
  assert.equal(process.listenerCount("unhandledRejection"), before);
});

const fault: ProcessFault = { kind: "unhandled_rejection", message: "boom", stack: "Error: boom\n    at x", observedAt: "2026-10-20T00:00:00.000Z", repeats: 0 };
const stderrLines = () => {
  const lines: string[] = [];
  return { lines, stderr: { write: (text: string) => void lines.push(text) } };
};

test("a fault goes to stderr and to the supervisor over the IPC channel", () => {
  const { lines, stderr } = stderrLines();
  const sent: unknown[] = [];
  reportFaultToStderrAndParent("runtime", fault, { connected: true, send: (message: unknown) => (sent.push(message), true) }, stderr);
  assert.deepEqual(sent, [{ kind: "fault", fault }]);
  assert.equal(lines.join(""), formatProcessFault("runtime", fault));
  assert.match(lines.join(""), /\[runtime\] unhandled rejection: boom/);
});

test("a closed IPC channel leaves the fault on stderr only and never throws", () => {
  const throwing = stderrLines();
  assert.doesNotThrow(() =>
    reportFaultToStderrAndParent("runtime", fault, { connected: true, send: () => { throw new Error("ERR_IPC_CHANNEL_CLOSED"); } }, throwing.stderr));
  assert.equal(throwing.lines.length, 1);
  const refused = stderrLines();
  assert.doesNotThrow(() => reportFaultToStderrAndParent("runtime", fault, { connected: true, send: () => false }, refused.stderr));
  assert.equal(refused.lines.length, 1);
  const detached = stderrLines();
  let sends = 0;
  reportFaultToStderrAndParent("runtime", fault, { connected: false, send: () => (sends++, true) }, detached.stderr);
  assert.equal(sends, 0);
  assert.equal(detached.lines.length, 1);
});

test("a count report says how many times the fault repeated", () => {
  assert.match(formatProcessFault("runtime", { ...fault, repeats: 99 }), /boom \(99 more since the last report\)/);
});
