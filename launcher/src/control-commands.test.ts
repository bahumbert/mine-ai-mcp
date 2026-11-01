import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UsageError, type CliContext } from "./cli-context.ts";
import { runBotCommand, runStatusCommand, runStopCommand, type ControlCommandDeps } from "./control-commands.ts";
import { startControlServer, type LauncherLock } from "./control.ts";
import { loadManifest } from "./manifest.ts";
import { cleanupStale } from "./processes.ts";
import type { BotOutcome } from "./stack.ts";
import { RecordingHandlers } from "./cli-test-support.ts";

interface Running {
  calls: string[];
  launcher: LauncherLock;
}

/** A control endpoint on a real socket for the length of `run`, closed after it even when an assertion fails. */
async function withLauncher(startPort: number, run: (running: Running) => Promise<void>, reply?: (call: string) => BotOutcome): Promise<void> {
  const handlers = new RecordingHandlers(reply);
  const control = await startControlServer({ startPort, handlers });
  try {
    await run({ calls: handlers.calls, launcher: { pid: 1, controlPort: control.port, startedAt: 0 } });
  } finally {
    await control.close();
  }
}

function setup(find: () => LauncherLock | null) {
  const out: string[] = [];
  const context: CliContext = { root: "C:/MineAI", appRoot: "C:/MineAI", out: (line) => void out.push(line), err: (line) => void out.push(line), loadManifest };
  let time = 0;
  const cleaned: string[] = [];
  const deps: ControlCommandDeps = {
    findRunningLauncher: async () => find(),
    cleanupStale: async (root) => (cleaned.push(root), { killed: [], failed: [], launcherStillRunning: [] }),
    fetch,
    now: () => time,
    sleep: async (ms) => void (time += ms),
  };
  return { out, context, deps, cleaned };
}

test("stop with nothing running says so, exits 0 and ends the leftovers of a crashed launcher", async () => {
  const t = setup(() => null);
  assert.equal(await runStopCommand(t.context, t.deps), 0);
  assert.match(t.out.join("\n"), /not running/u);
  assert.deepEqual(t.cleaned, ["C:/MineAI"]);
});

test("stop never ends the children of a launcher that runs but did not answer in time, and says so", async () => {
  const root = mkdtempSync(join(tmpdir(), "stop-live-launcher-"));
  mkdirSync(join(root, "run"), { recursive: true });
  writeFileSync(join(root, "run", "children.json"), JSON.stringify([{ pid: 100, parentPid: 50, image: "java", name: "server" }]));
  const killed: number[] = [];
  const t = setup(() => null);
  const running = [{ pid: 50, parentPid: 4, image: "bun.exe" }, { pid: 100, parentPid: 50, image: "java.exe" }];
  t.deps.cleanupStale = (staleRoot) => cleanupStale(staleRoot, async () => running, (pid) => void killed.push(pid));
  assert.equal(await runStopCommand({ ...t.context, root }, t.deps), 1);
  assert.deepEqual(killed, []);
  const text = t.out.join("\n");
  assert.match(text, /pid 50/u);
  assert.match(text, /not answering/u);
  assert.match(text, /left alone: server \(pid 100\)/u, "names what was left alone");
  assert.match(text, /Task Manager/u);
  assert.doesNotMatch(text, /not running/u);
});

test("stop ends the children of a launcher that is gone", async () => {
  const root = mkdtempSync(join(tmpdir(), "stop-gone-launcher-"));
  mkdirSync(join(root, "run"), { recursive: true });
  writeFileSync(join(root, "run", "children.json"), JSON.stringify([{ pid: 100, parentPid: 50, image: "java", name: "server" }]));
  const killed: number[] = [];
  const t = setup(() => null);
  t.deps.cleanupStale = (staleRoot) => cleanupStale(staleRoot, async () => [{ pid: 100, parentPid: 50, image: "java.exe" }], (pid) => void killed.push(pid));
  assert.equal(await runStopCommand({ ...t.context, root }, t.deps), 0);
  assert.deepEqual(killed, [100]);
  assert.match(t.out.join("\n"), /Ended server/u);
});

test("stop asks the launcher to stop and waits until it is gone", () =>
  withLauncher(26_500, async ({ calls, launcher }) => {
    let asked = false;
    let polls = 0;
    const t = setup(() => (asked && ++polls > 2 ? null : launcher));
    const original = t.deps.fetch;
    t.deps.fetch = (async (...args: Parameters<typeof fetch>) => ((asked ||= String(args[0]).endsWith("/stop")), original(...args))) as typeof fetch;
    assert.equal(await runStopCommand(t.context, t.deps), 0);
    assert.deepEqual(calls, ["stop stack"]);
    assert.match(t.out.join("\n"), /stopped/u);
  }));

test("stop that the launcher never finishes ends with exit 1 and what to do", () =>
  withLauncher(26_510, async ({ launcher }) => {
    const t = setup(() => launcher);
    assert.equal(await runStopCommand(t.context, t.deps), 1);
    assert.match(t.out.join("\n"), /Task Manager/u);
  }));

test("status lists the model, the join address and each bot", () =>
  withLauncher(26_520, async ({ launcher }) => {
    const t = setup(() => launcher);
    assert.equal(await runStatusCommand(t.context, t.deps), 0);
    const text = t.out.join("\n");
    for (const pattern of [/running/u, /gemma4:12b/u, /localhost:25565/u, /Ayla.*25575/u]) assert.match(text, pattern);
  }));

test("bot start and bot stop reach the launcher and print its answer", () =>
  withLauncher(26_530, async ({ calls, launcher }) => {
    const t = setup(() => launcher);
    assert.equal(await runBotCommand(["start", "ayla"], t.context, t.deps), 0);
    assert.equal(await runBotCommand(["stop", "ayla"], t.context, t.deps), 0);
    assert.deepEqual(calls, ["start ayla", "stop ayla"]);
    assert.deepEqual(t.out, ["done", "done"]);
  }));

test("a refusal prints the launcher's message and exits 1", () =>
  withLauncher(
    26_540,
    async ({ launcher }) => {
      const t = setup(() => launcher);
      assert.equal(await runBotCommand(["start", "x"], t.context, t.deps), 1);
      assert.match(t.out.join("\n"), /C:\/MineAI\/personas/u);
    },
    () => ({ ok: false, reason: "unknown-persona", message: 'No persona "x": C:/MineAI/personas has no x.json' }),
  ));

test("a persona id is sent escaped, so a path in it cannot change the route", () =>
  withLauncher(26_550, async ({ calls, launcher }) => {
    const t = setup(() => launcher);
    await runBotCommand(["start", "a/b"], t.context, t.deps);
    assert.deepEqual(calls, ["start a/b"]);
  }));

for (const [label, run, pattern] of [
  ["status", runStatusCommand, /not running/u],
  ["bot start", (context: CliContext, deps: ControlCommandDeps) => runBotCommand(["start", "ayla"], context, deps), /mine-ai console/u],
] as const) {
  test(`${label} with Mine AI not running: a line saying so and exit 1`, async () => {
    const t = setup(() => null);
    assert.equal(await run(t.context, t.deps), 1);
    assert.match(t.out.join("\n"), pattern);
  });
}

test("a launcher that has not published its control port yet is waited for, then reported as starting", () =>
  withLauncher(26_560, async ({ launcher }) => {
    const waiting = setup(() => ({ pid: 1, controlPort: null, startedAt: 0 }));
    for (const run of [() => runStopCommand(waiting.context, waiting.deps), () => runStatusCommand(waiting.context, waiting.deps), () => runBotCommand(["start", "ayla"], waiting.context, waiting.deps)]) {
      waiting.out.length = 0;
      assert.equal(await run(), 1);
      assert.match(waiting.out.join("\n"), /still starting/u);
    }
    let calls = 0;
    const late = setup(() => (++calls < 3 ? { pid: 1, controlPort: null, startedAt: 0 } : launcher));
    assert.equal(await runStatusCommand(late.context, late.deps), 0);
  }));

test("bot with a missing action or id is a usage error", async () => {
  const t = setup(() => null);
  for (const args of [[], ["start"], ["jump", "ayla"]]) await assert.rejects(runBotCommand(args, t.context, t.deps), UsageError);
});
