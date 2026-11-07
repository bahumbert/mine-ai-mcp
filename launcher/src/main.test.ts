import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { iss as issWithIncludes } from "./build/iss-test-support.ts";
import { cliContext, okInstallSteps } from "./cli-test-support.ts";
import { CONFIGURE_FLAGS } from "./configure-command.ts";
import { STOP_REFUSED_EXIT_CODE } from "./control-commands.ts";
import type { DoctorDeps } from "./doctor.ts";
import { INSTALL_STEP_NAMES } from "./install-command.ts";
import { appRoot } from "./paths.ts";
import { EXPECT_CONSOLE_FLAG } from "./client.ts";
import { COMMANDS, runCli, USAGE, type CliDeps } from "./main.ts";

const setup = () => cliContext("main", appRoot());

const doctorDeps: DoctorDeps = {
  diskLines: async () => [],
  bunVersion: "1.4.2",
  platform: "win32 x64",
  ollamaVersion: async () => "0.35.0",
  javaInstalled: () => true,
  gpuSummary: async () => ["Local model gemma4:12b can run here."],
  portOwner: async () => "free",
};

test("no command, or an unknown one, prints the usage and exits 2", async () => {
  for (const argv of [[], ["fly"]]) {
    const t = setup();
    assert.equal(await runCli(argv, t.context), 2);
    assert.ok(t.out.includes(USAGE));
  }
  assert.ok(COMMANDS.every((command) => USAGE.includes(command)));
});

test("arguments a command does not take print the usage and exit 2", async () => {
  for (const argv of [["install"], ["install", "warp"], ["install", "java", "--bogus"], ["configure"], ["configure", "--server-remote", "host"], ["bot", "start"]]) {
    const t = setup();
    assert.equal(await runCli(argv, t.context, { guardChildren: () => null }), 2, argv.join(" "));
    assert.ok(t.out.includes(USAGE), argv.join(" "));
  }
});

/** Overrides that throw when a command reaches outside the process: a test that sees none of them called proves nothing ran. */
const nothingMayRun: Partial<CliDeps> = {
  consoleDeps: () => assert.fail("console deps were used"),
  startDeps: () => assert.fail("start deps were used"),
  controlDeps: () => assert.fail("control deps were used"),
  doctorDeps: () => assert.fail("doctor deps were used"),
  guardChildren: () => assert.fail("install guard was used"),
};

test("--help or -h prints the usage and exits 0, whatever the command", async () => {
  const argvs = [["--help"], ["-h"], ["help"], ["console", "--help"], ["start", "--help"], ["bot", "start", "brea", "--help"], ["install", "java", "--help"], ["configure", "--help"]];
  for (const argv of argvs) {
    const t = setup();
    assert.equal(await runCli(argv, t.context, nothingMayRun), 0, argv.join(" "));
    assert.ok(t.out.includes(USAGE), argv.join(" "));
  }
});

test("a command that takes no argument refuses one: usage, exit 2, nothing ran", async () => {
  const argvs = [["console", "x"], ["stop", "now"], ["status", "-v"], ["doctor", "x"], ["start", "--bogus"], ["bot", "start", "brea", "extra"]];
  for (const argv of argvs) {
    const t = setup();
    assert.equal(await runCli(argv, t.context, nothingMayRun), 2, argv.join(" "));
    assert.ok(t.out.includes(USAGE), argv.join(" "));
  }
});

test("the refusal names the command and the argument, and not the console's internal flag", async () => {
  for (const [argv, command, argument] of [[["stop", "now"], "stop", "now"], [["start", "--bogus"], "start", "--bogus"], [["bot", "start", "brea", "extra"], "bot", "extra"]] as const) {
    const t = setup();
    await runCli(argv, t.context, nothingMayRun);
    const message = t.out.find((line) => line.includes(`"${command}"`));
    assert.ok(message?.includes(`"${argument}"`), `${argv.join(" ")}: ${message}`);
    assert.ok(!t.out.some((line) => line !== USAGE && line.includes(EXPECT_CONSOLE_FLAG)), "a hand-typed --expect-console makes the launcher quit 60 s after start");
  }
});

test("start still takes --expect-console", async () => {
  const t = setup();
  let started = false;
  const startDeps = (() => {
    started = true;
    throw new Error("start reached");
  }) as CliDeps["startDeps"];
  assert.equal(await runCli(["start", EXPECT_CONSOLE_FLAG], t.context, { startDeps }), 1);
  assert.ok(started, "the flag start accepts reaches the start command");
});

test("configure is routed to its command and saves in the data root", async () => {
  const t = setup();
  assert.equal(await runCli(["configure", "--server-remote", "h", "25570"], t.context), 0);
  assert.equal(await runCli(["configure", "--llm-remote", "https://u.test/v1", "k", "m"], t.context), 0);
  const saved = JSON.parse(readFileSync(join(t.root, "settings.json"), "utf8"));
  assert.deepEqual(saved.server, { kind: "remote", host: "h", port: 25_570 });
  assert.equal(saved.llm.baseUrl, "https://u.test/v1");
});

test("doctor lists the versions, the ports, the settings path and the last error lines", async () => {
  const t = setup();
  mkdirSync(join(t.root, "logs"), { recursive: true });
  writeFileSync(join(t.root, "logs", "host-ayla.log"), "2026-10-30T10:00:00.000Z Error: connect ECONNREFUSED 127.0.0.1:25565\n");
  assert.equal(await runCli(["doctor"], t.context, { doctorDeps: () => doctorDeps }), 0);
  assert.match(t.out.join("\n"), /Bun 1\.4\.2[\s\S]*ECONNREFUSED/u, "the doctor report (its own tests pin the sections) reaches the player, with the logs' error");
});

test("doctor with a settings file that is invalid says so and still reports", async () => {
  const t = setup();
  writeFileSync(join(t.root, "settings.json"), "{ nope");
  assert.equal(await runCli(["doctor"], t.context, { doctorDeps: () => doctorDeps }), 0);
  assert.match(t.out.join("\n"), /Settings problem: .*settings\.json is invalid/u);
  assert.match(t.out.join("\n"), /Bun 1\.4\.2/u);
});

test("install warns once when the job object cannot be made, and goes on", async () => {
  const t = setup();
  const json = join(t.root, "step.json");
  assert.equal(await runCli(["install", "java", "--json", json], t.context, { installSteps: okInstallSteps(), guardChildren: () => "CreateJobObjectW failed (Win32 error 5)" }), 0);
  assert.equal(t.out.filter((line) => line.includes("CreateJobObjectW")).length, 1);
});

// `stop` is in the loop: a throw there exits 1, never the refusal code, so the installer's update goes on.
for (const command of ["status", "stop"]) {
  test(`an unexpected error in \`${command}\` is printed as one line and exits 1, never the stop refusal code`, async () => {
    const t = setup();
    const failing = () => {
      throw new Error("disk on fire");
    };
    const code = await runCli([command], t.context, { controlDeps: failing });
    assert.equal(code, 1);
    assert.notEqual(code, STOP_REFUSED_EXIT_CODE);
    assert.deepEqual(t.out, ["disk on fire"]);
  });
}

// ---------- the installer calls the CLI exactly like this (packaging/windows/mine-ai.iss) ----------

const runMain = promisify(execFile);
const MAIN = join(appRoot(), "launcher", "src", "main.ts");

async function runLikeTheInstaller(args: string[]): Promise<{ code: number; stdout: string; stderr: string; dataFolder: string }> {
  const dataFolder = mkdtempSync(join(tmpdir(), "mine-ai-cli-"));
  // dataRoot() reads LOCALAPPDATA on Windows and XDG_DATA_HOME elsewhere; both point at the test's folder.
  const env = { ...process.env, LOCALAPPDATA: dataFolder, XDG_DATA_HOME: dataFolder };
  try {
    const { stdout, stderr } = await runMain(process.execPath, [MAIN, ...args], { env, cwd: appRoot() });
    return { code: 0, stdout, stderr, dataFolder };
  } catch (error) {
    const failure = error as { code: number; stdout: string; stderr: string };
    return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr, dataFolder };
  }
}

test("`install gpu --json <file>` as the installer runs it: the file always answers, and the exit code follows ok", async () => {
  const jsonFolder = mkdtempSync(join(tmpdir(), "mine-ai-json-"));
  const json = join(jsonFolder, "mine-ai-step.json");
  const run = await runLikeTheInstaller(["install", "gpu", "--json", json]);
  const result = JSON.parse(readFileSync(json, "utf8")) as { ok: boolean; error?: string; detail?: string };
  assert.equal(run.code, result.ok ? 0 : 1);
  assert.ok(result.ok ? (result.detail ?? "") !== "" : (result.error ?? "") !== "");
});

test("`configure` then `stop` as the installer runs them: settings are written and stop with nothing running exits 0", async () => {
  const configured = await runLikeTheInstaller(["configure", "--llm-remote", "https://x.test/v1", "key with space", "model-1", "--server-remote", "10.0.0.5", "25565"]);
  assert.equal(configured.code, 0, configured.stderr);
  const saved = JSON.parse(readFileSync(join(configured.dataFolder, process.platform === "win32" ? "MineAI" : "mine-ai", "settings.json"), "utf8"));
  if (process.platform === "win32") assert.equal(typeof saved.llm.apiKeyProtected, "string"); // encrypted for the Windows user
  else assert.equal(saved.llm.apiKey, "key with space");
  assert.equal(saved.server.host, "10.0.0.5");
  const stopped = await runLikeTheInstaller(["stop"]);
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.match(stopped.stdout, /not running/u);
});

test("every command, install step and configure flag the Inno Setup script uses exists", () => {
  // The script with its #include files (the endpoint page's `--llm-remote*` flags and `install endpoint-models` are in endpoint-page.iss).
  const script = issWithIncludes;
  assert.match(script, /--llm-remote-saved-key/u, "the endpoint page's flags are not in the script read here");
  assert.ok(existsSync(MAIN));
  const stepNames = [...script.matchAll(/(?:RunSetupStep|RunInstallStepWithRetry)\('([a-z-]+)/gu), ...script.matchAll(/'install ([a-z-]+)/gu)].map((match) => match[1]);
  assert.ok(stepNames.length >= 6, `found ${stepNames.length} install steps in the script`);
  for (const step of stepNames) assert.ok((INSTALL_STEP_NAMES as readonly (string | undefined)[]).includes(step), `${step} is not an install step`);
  const code = script.split("\n").filter((line) => !/^\s*(\/\/|;)/u.test(line)).join("\n");
  const literals = [...code.matchAll(/'([^'\n]*)'/gu)].map((match) => match[1]!);
  const flags = literals.flatMap((literal) => [...literal.matchAll(/--[a-z]+(?:-[a-z]+)*/gu)].map((match) => match[0])).filter((flag) => !["--json", "--accept-eula", "--dir", "--no-model", "--url", "--key", "--saved-key", "--list"].includes(flag)); // flags of `install <step>`, not of configure (`iss-launcher-calls.test.ts` runs `install ollama --dir`; `install disk --no-model` and `install endpoint-models --url --key --list` are the wizard's alone, `install-command.test.ts` holds their options)
  assert.ok(flags.length >= 4, `found ${flags.length} configure flags in the script`);
  for (const flag of flags) assert.ok(flag in CONFIGURE_FLAGS, `${flag} is not a configure flag`);
  for (const command of [...script.matchAll(/RunLauncherAndWait\('([a-z]+)/gu)].map((match) => match[1]!)) assert.ok((COMMANDS as readonly string[]).includes(command), `${command} is not a command`);
});

test("`install ollama` and `install gpu` say remote:true / ok:false the way the script reads them", () => {
  const script = issWithIncludes;
  assert.match(script, /JsonIsTrue\(Json, 'remote'\)/u);
  assert.match(script, /RunStepSucceeded\('install gpu'/u);
});
