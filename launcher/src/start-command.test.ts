import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { attach, cliContext, POST, until } from "./cli-test-support.ts";
import { launcherLockFile } from "./control.ts";
import { fakeKeyCipher } from "./key-cipher-test-support.ts";
import { saveSettings, type Settings } from "./settings.ts";
import { hostHealth, stackFixture, type StackFixture } from "./stack-test-support.ts";
import { runStartCommand, type StartDeps } from "./start-command.ts";

const CONTROL_PORT = 26_400;
const NO_CIPHER = { platform: "linux", cipher: null } as const;

interface Launch {
  fixture: StackFixture;
  out: string[];
  context: ReturnType<typeof cliContext>["context"];
  deps: StartDeps;
  signal(name?: string): void;
  order: string[];
  warning: string | null;
  update: { latest: string; url?: string } | null;
}

function launch(change: Parameters<typeof stackFixture>[0] = (settings) => settings, share?: Launch): Launch {
  const fixture = share?.fixture ?? stackFixture((settings) => change({ ...settings, controlPort: CONTROL_PORT }));
  if (!share) saveSettings(fixture.root, fixture.settings, NO_CIPHER); // the key as a player's hand-edited file holds it, on any system the tests run on
  const { out, context } = cliContext("start", fixture.root, fixture.root);
  let signalHandler: (signal: string) => void = () => {};
  const result: Launch = {
    fixture,
    context,
    out,
    signal: (name = "SIGINT") => signalHandler(name),
    order: share?.order ?? [],
    warning: null,
    update: null,
    deps: undefined as unknown as StartDeps,
  };
  result.deps = {
    lock: { isPidAlive: (pid) => pid === process.pid || pid === 7777, fetch, now: fixture.clock.now, ownPid: process.pid },
    cleanupStale: async () => {
      result.order.push("cleanupStale");
      return { killed: [], failed: [], launcherStillRunning: [] };
    },
    guardChildren: () => result.warning,
    createChildren: () => fixture.children,
    stackDeps: (say) => ({ ...fixture.deps, say: (line) => (fixture.said.push(line), say(line)) }),
    checkUpdate: async () => result.update,
    sleep: fixture.clock.sleep,
    onSignal: (handler) => {
      signalHandler = handler;
      return () => {};
    },
    settings: NO_CIPHER,
  };
  return result;
}

/** The control port this process's launcher wrote into its lock file. */
function publishedControlPort(root: string): number | null {
  if (!existsSync(launcherLockFile(root))) return null;
  const lock = JSON.parse(readFileSync(launcherLockFile(root), "utf8")) as { pid: number; controlPort: number | null };
  return lock.pid === process.pid ? lock.controlPort : null;
}

/** A launcher running on its real control socket (only its services are fake). */
async function boot(change?: Parameters<typeof stackFixture>[0], customize: (run: Launch) => void = () => {}) {
  const run = launch(change);
  hostHealth(run.fixture, 25_575);
  customize(run);
  const finished = runStartCommand(run.context, run.deps);
  await until(() => publishedControlPort(run.fixture.root) !== null);
  const base = `http://127.0.0.1:${publishedControlPort(run.fixture.root)}`;
  const post = (path: string) => fetch(`${base}${path}`, POST);
  return { run, finished, base, post, stop: async () => (await post("/stop"), finished) };
}

/** `boot`, and the launcher is asked to stop afterwards even when an assertion threw, so no socket outlives the test. */
async function withBoot(run: (launched: Awaited<ReturnType<typeof boot>>) => Promise<void>, change?: Parameters<typeof stackFixture>[0], customize?: (run: Launch) => void): Promise<void> {
  const launched = await boot(change, customize);
  try {
    await run(launched);
  } finally {
    await launched.stop().catch(() => {}); // already stopped by the test: nothing answers
  }
}

test("a second start while one runs says so, exits 0, and cleans up and starts nothing", () =>
  withBoot(async (first) => {
    first.run.order.length = 0;
    const second = launch((settings) => settings, first.run);
    assert.equal(await runStartCommand(second.context, second.deps), 0);
    assert.match(second.out.join("\n"), /already running/u);
    assert.deepEqual(first.run.order, [], "cleanupStale would kill the running launcher's children");
    assert.equal(await first.stop(), 0);
  }));

test("a lock left by a launcher that is gone is replaced and the start goes on", () =>
  withBoot(
    async ({ run, stop }) => {
      assert.equal(await stop(), 0);
      assert.deepEqual(run.order, ["cleanupStale"]);
    },
    undefined,
    (run) => {
      mkdirSync(join(run.fixture.root, "run"), { recursive: true });
      writeFileSync(launcherLockFile(run.fixture.root), JSON.stringify({ pid: 99_999, controlPort: CONTROL_PORT, startedAt: 1 }));
    },
  ));

test("a stack that cannot start: the problem is printed, the launcher lingers for a console, then exits 1", async () => {
  const run = launch();
  run.deps = { ...run.deps, stackDeps: (say) => ({ ...run.fixture.deps, ollamaExe: () => null, say }) };
  assert.equal(await runStartCommand(run.context, run.deps), 1);
  assert.match(run.out.join("\n"), /install ollama/u);
  assert.ok(launcherLogLines(run.fixture.root).includes("Stopping Mine AI (the start failed)..."));
  assert.ok(run.fixture.clock.time > 0, "it waited for a console to attach before exiting");
  assert.equal(existsSync(launcherLockFile(run.fixture.root)), false);
});

test("the stack's dependencies are made for the data root the launcher runs in, so ollama.exe is found where the install recorded it", async () => {
  const run = launch();
  hostHealth(run.fixture, 25_575);
  const roots: string[] = [];
  run.deps = { ...run.deps, stackDeps: (say, root) => (roots.push(root), { ...run.fixture.deps, say }) };
  assert.equal(await runStartCommand(run.context, run.deps, { expectConsole: true }), 0);
  assert.deepEqual(roots, [run.fixture.root]);
});

test("a launcher the console started stops itself when no console ever attaches", async () => {
  const run = launch();
  hostHealth(run.fixture, 25_575);
  assert.equal(await runStartCommand(run.context, run.deps, { expectConsole: true }), 0);
  assert.match(run.out.join("\n"), /No console attached/u);
  assert.ok(launcherLogLines(run.fixture.root).includes("Stopping Mine AI (no console attached)..."));
  assert.equal(existsSync(launcherLockFile(run.fixture.root)), false);
});

test("a launcher started by hand (no --expect-console) waits for a stop even when no console attaches", () =>
  withBoot(async ({ run, stop }) => {
    await until(() => run.fixture.events.includes("spawn brain-ayla"));
    assert.ok(!run.fixture.events.includes("stop ollama"));
    assert.equal(await stop(), 0);
  }));

/** `launcher.log` lines without their timestamp. */
const launcherLogLines = (root: string): string[] => readFileSync(join(root, "logs", "launcher.log"), "utf8").split("\n").filter(Boolean).map((line) => line.replace(/^\S+ /u, ""));

/** What the log says from the first line of the stop: it must hold these, in this order, and the stop is exit 0. */
function assertStopLines(root: string, reason: string): void {
  const lines = launcherLogLines(root);
  const wanted = [`Stopping Mine AI (${reason})...`, "Ayla stopped.", "The Minecraft server saved the world and stopped.", "Ollama stopped.", "Mine AI stopped ("];
  let from = 0;
  for (const text of wanted) {
    const at = lines.findIndex((line, index) => index >= from && line.startsWith(text));
    assert.ok(at >= from, `"${text}" after line ${from} in: ${lines.join(" | ")}`);
    from = at + 1;
  }
  assert.equal(lines.filter((line) => line.startsWith("Stopping Mine AI (")).length, 1, "one stop, one first line");
}

// Finding 3: every trigger of the ordered stop leaves the same lines in launcher.log, headed by its own reason.
const STOP_TRIGGERS: readonly (readonly [string, string, (launched: Awaited<ReturnType<typeof boot>>) => Promise<void> | void])[] = [
  ["SIGINT", "Ctrl+C", ({ run }) => run.signal("SIGINT")],
  ["SIGBREAK", "Ctrl+Break", ({ run }) => run.signal("SIGBREAK")],
  ["SIGHUP (its console window was closed)", "its window was closed", ({ run }) => run.signal("SIGHUP")],
  ["SIGTERM", "asked to end", ({ run }) => run.signal("SIGTERM")],
  ["the last console closing", "the last Mine AI window was closed", async ({ base }) => (await attach(base)).hangUp()],
  ["the stop command", "mine-ai stop", async ({ post }) => void (await post("/stop"))],
];
for (const [trigger, reason, fire] of STOP_TRIGGERS) {
  test(`${trigger} runs the ordered stop and launcher.log says "${reason}", each step and the end`, () =>
    withBoot(async (launched) => {
      const { run, finished } = launched;
      await until(() => run.fixture.events.includes("spawn brain-ayla"));
      await fire(launched);
      assert.equal(await finished, 0);
      assertStopLines(run.fixture.root, reason);
      assert.equal(run.fixture.events.filter((event) => event === "stop server").length, 1, "the stack is stopped once");
      assert.equal(existsSync(launcherLockFile(run.fixture.root)), false, "the lock is released");
    }));
}

test("a job object that cannot be made gives one warning line and the start goes on", () =>
  withBoot(
    async ({ run, stop }) => {
      await stop();
      const warnings = run.out.filter((line) => line.includes("CreateJobObjectW"));
      assert.equal(warnings.length, 1);
      assert.match(warnings[0]!, /killed|close/u);
    },
    undefined,
    (launched) => void (launched.warning = "CreateJobObjectW failed (Win32 error 5)"),
  ));

test("children left alone because their launcher still runs are named, and the start goes on", () =>
  withBoot(
    async ({ run, stop }) => {
      await stop();
      assert.match(run.out.join("\n"), /Left server \(pid 100\) alone: .*launcher that started it \(pid 50\) is still running/u);
    },
    undefined,
    (launched) => {
      launched.deps.cleanupStale = async () => ({ killed: [], failed: [], launcherStillRunning: [{ pid: 100, parentPid: 50, image: "java", name: "server" }] });
    },
  ));

test("a newer release is announced once, a missing answer says nothing", () =>
  withBoot(
    async ({ run, stop }) => {
      await until(() => run.out.some((line) => line.includes("9.9.9")));
      await stop();
      assert.equal(run.out.filter((line) => line.includes("9.9.9")).length, 1);
    },
    undefined,
    (launched) => void (launched.update = { latest: "9.9.9", url: "https://example.test/r" }),
  ));

test("a bot started through the control endpoint runs, and one stopped there ends", () =>
  withBoot(
    async ({ run, base, post, stop }) => {
      const phase = async () => ((await (await fetch(`${base}/status`)).json()) as { phase: string }).phase;
      for (let i = 0; i < 300 && (await phase()) !== "running"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal((await post("/bots/ayla/start")).status, 200);
      assert.ok(run.fixture.events.includes("spawn brain-ayla"));
      const status = (await (await fetch(`${base}/status`)).json()) as { bots: unknown[] };
      assert.equal(status.bots.length, 1);
      assert.equal((await post("/bots/ayla/stop")).status, 200);
      await stop();
    },
    (settings) => ({ ...settings, bots: [] }),
  ));

test("a settings file that is invalid stops the start with its path, before any lock or process", async () => {
  const run = launch();
  writeFileSync(join(run.fixture.root, "settings.json"), "{ nope");
  assert.equal(await runStartCommand(run.context, run.deps), 1);
  assert.match(run.out.join("\n"), /settings\.json is invalid/u);
  assert.equal(existsSync(launcherLockFile(run.fixture.root)), false);
  assert.deepEqual(run.fixture.children.spawns, []);
});

// The API key (plan 2026-11-06-installer-improvements T2, spec D3): a fake Windows with a fake cipher.
const withClearKey = (settings: Settings): Settings => ({ ...settings, llm: { kind: "remote", baseUrl: "https://api.test/v1", apiKey: "sk-old", model: "m" } });
const MIGRATION_LINE = /is now encrypted for the Windows user/u;

/** A launcher a console started and none attached to: it runs the whole start and stops by itself, so the test sees every line. */
async function startOnce(run: Launch): Promise<number> {
  hostHealth(run.fixture, 25_575);
  return await runStartCommand(run.context, run.deps, { expectConsole: true });
}

test("a start on Windows encrypts a key found in clear, says so once, and the second start says nothing", async () => {
  const first = launch(withClearKey);
  const cipher = fakeKeyCipher();
  first.deps = { ...first.deps, settings: { platform: "win32", cipher } };
  assert.equal(await startOnce(first), 0);
  const file = join(first.fixture.root, "settings.json");
  assert.equal(readFileSync(file, "utf8").includes("sk-old"), false);
  assert.equal(first.out.filter((line) => MIGRATION_LINE.test(line)).length, 1);
  assert.equal(launcherLogLines(first.fixture.root).filter((line) => MIGRATION_LINE.test(line)).length, 1, "the log keeps it too");
  const second = launch((settings) => settings, first);
  second.deps = { ...second.deps, settings: { platform: "win32", cipher } };
  assert.equal(await startOnce(second), 0);
  assert.equal(second.out.some((line) => MIGRATION_LINE.test(line)), false);
});

test("a save that fails is said with the file, and the start goes on with the key it read", async () => {
  const run = launch(withClearKey);
  const cipher = { ...fakeKeyCipher(), protect: () => { throw new Error("CryptProtectData failed (error 5)"); } };
  run.deps = { ...run.deps, settings: { platform: "win32", cipher } };
  assert.equal(await startOnce(run), 0);
  assert.ok(run.out.some((line) => line.includes("Could not encrypt the API key") && line.includes("CryptProtectData failed (error 5)") && line.includes("settings.json")), run.out.join(" | "));
  assert.equal(run.out.some((line) => line.includes("could not start")), false);
  assert.ok(run.fixture.children.spawns.length > 0, "the stack started");
});
