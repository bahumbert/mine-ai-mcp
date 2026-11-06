import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { UsageError } from "./cli-context.ts";
import { cliContext, okInstallSteps } from "./cli-test-support.ts";
import { diskStep, INSTALL_STEP_NAMES, runInstallCommand, type InstallSteps } from "./install-command.ts";
import type { DiskReportDeps } from "./install/disk-report.ts";
import type { GpuReport } from "./install/gpu.ts";

const REMOTE_REPORT: GpuReport = { adapters: [], compute: null, ramBytes: 8 * 1024 ** 3, choice: { kind: "remote", reason: "This PC has 2.0 GiB of video memory; the local model needs 10.", hint: "Use a remote endpoint." } };
const LOCAL_REPORT: GpuReport = { adapters: [{ name: "AMD Radeon RX 7900 XTX", bytes: 24 * 1024 ** 3 }], compute: null, ramBytes: 64 * 1024 ** 3, choice: { kind: "local", model: "gemma4:12b" } };

function setup(steps: Partial<InstallSteps> = {}) {
  const { root, out, context } = cliContext("install");
  const calls: string[] = [];
  // In a folder that does not exist yet: the command creates it, as the installer's temp path may need.
  const json = join(root, "tmp", "deeper", "step.json");
  return { out, context, calls, json, steps: { ...okInstallSteps(calls), ...steps } as InstallSteps };
}

const written = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

test("a step that succeeds writes its result to --json and exits 0", async () => {
  const t = setup();
  assert.equal(await runInstallCommand(["java", "--json", t.json], t.context, t.steps), 0);
  assert.deepEqual(written(t.json), { ok: true, detail: "java done" });
  assert.deepEqual(t.calls, ["java"]);
});

test("a step that fails writes its error and hint and exits 1", async () => {
  const t = setup({ java: async () => ({ ok: false, error: "hash mismatch", hint: "Try again." }) });
  assert.equal(await runInstallCommand(["java", "--json", t.json], t.context, t.steps), 1);
  assert.deepEqual(written(t.json), { ok: false, error: "hash mismatch", hint: "Try again." });
});

test("a step that throws still writes the --json file, with the message and a next step", async () => {
  const t = setup({
    model: async () => {
      throw new Error("settings.json is invalid: llm");
    },
  });
  assert.equal(await runInstallCommand(["model", "--json", t.json], t.context, t.steps), 1);
  const result = written(t.json);
  assert.equal(result.ok, false);
  assert.match(String(result.error), /settings\.json is invalid/u);
  assert.notEqual(result.hint, "");
});

test("--accept-eula reaches the server step, and its absence does too", async () => {
  const seen: boolean[] = [];
  const t = setup({ server: async (_ctx, accept) => (seen.push(accept), { ok: true, detail: "x" }) });
  await runInstallCommand(["server", "--accept-eula", "--json", t.json], t.context, t.steps);
  await runInstallCommand(["server", "--json", t.json], t.context, t.steps);
  assert.deepEqual(seen, [true, false]);
});

test("a remote verdict from `install gpu` is ok:false with the reason, so the installer switches to the remote page", async () => {
  const t = setup({ gpu: async () => ({ ok: true, detail: "x", report: REMOTE_REPORT }) });
  assert.equal(await runInstallCommand(["gpu", "--json", t.json], t.context, t.steps), 1);
  const result = written(t.json);
  assert.equal(result.ok, false);
  assert.equal(result.error, REMOTE_REPORT.choice.kind === "remote" ? REMOTE_REPORT.choice.reason : "");
  assert.equal(result.hint, REMOTE_REPORT.choice.kind === "remote" ? REMOTE_REPORT.choice.hint : "");
  assert.equal(result.remote, true);
  assert.deepEqual(result.report, JSON.parse(JSON.stringify(REMOTE_REPORT)));
});

test("a local verdict from `install gpu` is ok:true with the report", async () => {
  const t = setup({ gpu: async () => ({ ok: true, detail: "Local model gemma4:12b can run here.", report: LOCAL_REPORT }) });
  assert.equal(await runInstallCommand(["gpu", "--json", t.json], t.context, t.steps), 0);
  assert.equal(written(t.json).ok, true);
  assert.equal(written(t.json).detail, "Local model gemma4:12b can run here.");
});

for (const [label, reply, remote] of [
  ["finds the PC cannot run the model is ok:false with remote:true", { ok: true, detail: "x", report: REMOTE_REPORT }, true],
  ["fails for another reason is not marked remote", { ok: false, error: "setup ended with code 1", hint: "Close other installers." }, undefined],
] as const) {
  test(`\`install ollama\` that ${label}`, async () => {
    const t = setup({ ollama: async () => reply });
    assert.equal(await runInstallCommand(["ollama", "--json", t.json], t.context, t.steps), 1);
    assert.equal(written(t.json).remote, remote);
    assert.equal(written(t.json).ok, false);
  });
}

test("progress goes to stdout as `PROGRESS <fraction> <label>` lines, one per change", async () => {
  const t = setup({
    java: async (ctx) => {
      ctx.onProgress(0, "Downloading Java");
      ctx.onProgress(0.0001, "Downloading Java");
      ctx.onProgress(0.5, "Downloading Java");
      ctx.onProgress(0.5004, "Downloading Java");
      ctx.onProgress(0.5004, "Unpacking Java\nnow");
      return { ok: true, detail: "done" };
    },
  });
  await runInstallCommand(["java", "--json", t.json], t.context, t.steps);
  assert.deepEqual(t.out, ["PROGRESS 0.000 Downloading Java", "PROGRESS 0.500 Downloading Java", "PROGRESS 0.500 Unpacking Java now"]);
});

test("without --json the result is printed as one line", async () => {
  const t = setup();
  await runInstallCommand(["java"], t.context, t.steps);
  assert.ok(t.out.includes("java done"));
});

test("an unknown step or none is a usage error that lists the steps", async () => {
  const t = setup();
  for (const args of [["warp"], [], ["--json", t.json]]) {
    await assert.rejects(runInstallCommand(args, t.context, t.steps), (error: Error) => error instanceof UsageError && INSTALL_STEP_NAMES.every((name) => error.message.includes(name)));
  }
  assert.deepEqual(t.calls, []);
});

test("--dir reaches the ollama step as the folder to install Ollama into, and its absence does too", async () => {
  const seen: (string | undefined)[] = [];
  const t = setup({ ollama: async (_ctx, _accept, dir) => (seen.push(dir), { ok: true, detail: "x" }) });
  await runInstallCommand(["ollama", "--dir", "D:\\Programmes Perso\\Ollama é", "--json", t.json], t.context, t.steps);
  await runInstallCommand(["ollama", "--json", t.json], t.context, t.steps);
  assert.deepEqual(seen, ["D:\\Programmes Perso\\Ollama é", undefined]);
});

test("--dir on any step but `install ollama` and `install disk` is a usage error naming the step that takes it, and nothing runs", async () => {
  const t = setup();
  for (const step of INSTALL_STEP_NAMES.filter((name) => name !== "ollama" && name !== "disk")) {
    await assert.rejects(runInstallCommand([step, "--dir", "D:\\Apps", "--json", t.json], t.context, t.steps), (error: Error) => error instanceof UsageError && error.message.includes("install ollama --dir"), step);
  }
  assert.deepEqual(t.calls, []);
});

test("--dir that is empty, relative or drive-relative is a usage error: Ollama's setup would install into its own working folder", async () => {
  const t = setup();
  for (const dir of ["", "Ollama", "D:Ollama"]) {
    await assert.rejects(runInstallCommand(["ollama", "--dir", dir, "--json", t.json], t.context, t.steps), (error: Error) => error instanceof UsageError && error.message.includes("absolute"), dir);
  }
  assert.deepEqual(t.calls, []);
});

test("`install gpu --json` names the ollama.exe a later step will use, for a local and for a remote verdict, and null when there is none", async () => {
  const OLLAMA = "D:\\Apps\\Ollama é\\ollama.exe";
  for (const [report, exe] of [[LOCAL_REPORT, OLLAMA], [REMOTE_REPORT, OLLAMA], [LOCAL_REPORT, null]] as const) {
    const t = setup({ gpu: async () => ({ ok: true, detail: "x", report }) });
    const asked: string[] = [];
    await runInstallCommand(["gpu", "--json", t.json], t.context, t.steps, (root) => (asked.push(root), exe));
    assert.deepEqual(asked, [t.context.root]);
    assert.equal(written(t.json).ollamaExe, exe);
  }
});

test("`install gpu --json` is written even when install-state.json is corrupt: ollamaExe is null then (review W7a 2)", async () => {
  const t = setup({ gpu: async () => ({ ok: true, detail: "x", report: LOCAL_REPORT }) });
  writeFileSync(join(t.context.root, "install-state.json"), "{ not json");
  assert.equal(await runInstallCommand(["gpu", "--json", t.json], t.context, t.steps), 0);
  assert.equal(written(t.json).ollamaExe, null);
});

test("--dir loses its trailing separator (Inno's argument parser does not undo the escape), and a drive root keeps it", async () => {
  const seen: (string | undefined)[] = [];
  const t = setup({ ollama: async (_ctx, _accept, dir) => (seen.push(dir), { ok: true, detail: "x" }) });
  for (const dir of ["D:\\Jeux é\\", "D:\\Jeux é", "D:\\"]) await runInstallCommand(["ollama", "--dir", dir, "--json", t.json], t.context, t.steps);
  assert.deepEqual(seen, ["D:\\Jeux é", "D:\\Jeux é", "D:\\"]);
});

test("--dir that starts with a separator but names no drive is refused: it is relative to the current drive", async () => {
  const t = setup();
  await assert.rejects(runInstallCommand(["ollama", "--dir", "\\Apps\\Ollama", "--json", t.json], t.context, t.steps), (error: Error) => error instanceof UsageError);
});

test("`install gpu --json` says whether the model is on disk and which model: a hint for the model page, from the manifest, false when the lookup throws, and absent for the other steps", async () => {
  const asked: [string, string][] = [];
  const present = (root: string, manifest: { ollama: { model: string } }) => (asked.push([root, manifest.ollama.model]), true);
  const t = setup({ gpu: async () => ({ ok: true, detail: "x", report: LOCAL_REPORT }) });
  await runInstallCommand(["gpu", "--json", t.json], t.context, t.steps, () => null, present);
  assert.deepEqual(asked, [[t.context.root, "gemma4:12b"]]);
  assert.equal(written(t.json).modelInstalled, true);
  assert.equal(written(t.json).model, "gemma4:12b");

  const broken = setup({ gpu: async () => ({ ok: true, detail: "x", report: LOCAL_REPORT }) });
  await runInstallCommand(["gpu", "--json", broken.json], broken.context, broken.steps, () => null, () => {
    throw new Error("install-state.json is corrupt");
  });
  assert.equal(written(broken.json).modelInstalled, false);

  const other = setup();
  await runInstallCommand(["java", "--json", other.json], other.context, other.steps, () => null, present);
  assert.equal("modelInstalled" in written(other.json), false);

  const remote = setup({ gpu: async () => ({ ok: true, detail: "x", report: REMOTE_REPORT }) });
  await runInstallCommand(["gpu", "--json", remote.json], remote.context, remote.steps, () => null, present);
  assert.equal(written(remote.json).modelInstalled, true, "a remote verdict carries it too: the installer reads both from one file");
});

test("the keys the installer script reads from `install gpu`'s file are the keys the command writes: a rename on either side fails here", async () => {
  const script = readFileSync(new URL("../../packaging/windows/mine-ai.iss", import.meta.url), "utf8");
  const t = setup({ gpu: async () => ({ ok: true, detail: "x", report: LOCAL_REPORT }) });
  await runInstallCommand(["gpu", "--json", t.json], t.context, t.steps, () => "D:\\Ollama\\ollama.exe", () => true);
  const output = written(t.json);
  for (const key of ["ollamaExe", "modelInstalled", "model"]) {
    assert.match(script, new RegExp(`Json(?:IsTrue|String)\\(Json, '${key}'\\)`, "u"), `the .iss reads '${key}' from the gpu file`);
    assert.ok(key in output, `install gpu writes '${key}'`);
  }
  assert.equal(output.model, "gemma4:12b", "the wizard prints this name in 'The AI model <name> is already installed.'");
});

test("`install disk --json` writes the report as the step gave it: ok, detail, short and drives; a short drive is still ok:true and exit 0", async () => {
  const report = { ok: true as const, detail: "D: 2.0 GB free. The local AI model needs 2.8 GB here.", short: true, drives: [{ drive: "D:", freeBytes: 2 * 1024 ** 3, needs: [{ what: "Ollama", bytes: 2963753072 }] }] };
  const t = setup({ disk: async () => report });
  assert.equal(await runInstallCommand(["disk", "--json", t.json], t.context, t.steps), 0);
  assert.deepEqual(written(t.json), JSON.parse(JSON.stringify(report)));
});

test("`install disk` prints its detail when there is no --json, and an unreadable disk is exit 1 with the error and the hint", async () => {
  const t = setup({ disk: async () => ({ ok: true, detail: "C: 10.0 GB free.", short: false, drives: [] }) });
  await runInstallCommand(["disk"], t.context, t.steps);
  assert.deepEqual(t.out, ["C: 10.0 GB free."]);
  const failing = setup({ disk: async () => ({ ok: false, error: "The drive of X:\\a does not exist.", hint: "Choose another folder." }) });
  assert.equal(await runInstallCommand(["disk", "--json", failing.json], failing.context, failing.steps), 1);
  assert.equal(written(failing.json).hint, "Choose another folder.");
});

test("--dir and --no-model reach the disk step, each absent by default; --dir is checked like the one of `install ollama`: absolute, trailing separator dropped", async () => {
  const seen: [string | undefined, boolean | undefined][] = [];
  const t = setup({ disk: async (_ctx, _accept, dir, noModel) => (seen.push([dir, noModel]), { ok: true, detail: "x", short: false, drives: [] }) });
  await runInstallCommand(["disk", "--dir", "D:\\Jeux é\\", "--no-model", "--json", t.json], t.context, t.steps);
  await runInstallCommand(["disk", "--json", t.json], t.context, t.steps);
  assert.deepEqual(seen, [["D:\\Jeux é", true], [undefined, false]]);
  await assert.rejects(runInstallCommand(["disk", "--dir", "Ollama", "--json", t.json], t.context, t.steps), (error: Error) => error instanceof UsageError && error.message.includes("absolute"));
});

test("the real disk step passes --dir and --no-model to the report: the Ollama folder's drive is listed, and not with --no-model", async () => {
  const GIB = 1024 ** 3;
  const noBody = (async () => new Response(null, { headers: { "content-length": "1000" } })) as unknown as typeof fetch;
  const deps = (): DiskReportDeps => ({
    disk: { platform: "win32", exists: (path) => /^[CD]:\\$/u.test(path), statfs: async () => ({ bavail: BigInt(50 * GIB), bsize: 1n }), dev: () => "0" },
    fetchImpl: noBody,
    modelStoreDeps: { fetchImpl: noBody, exists: () => false, sizeOf: async () => 0, listDir: async () => [] },
    ollamaExe: () => null,
    modelOnDisk: () => false,
    modelStore: () => "C:\\MineAI\\models",
    pinnedJreInstalled: async () => false,
    defaultOllamaFolder: "C:\\Ollama",
  });
  const drivesFor = async (args: string[]) => {
    const { context, json, steps } = setup();
    await runInstallCommand(["disk", ...args, "--json", json], { ...context, root: "C:\\MineAI" }, { ...steps, disk: diskStep(deps) });
    return (written(json).drives as { drive: string }[]).map((drive) => drive.drive);
  };
  assert.deepEqual(await drivesFor([]), ["C:"]);
  assert.deepEqual(await drivesFor(["--dir", "D:\\Apps\\Ollama"]), ["C:", "D:"]);
  assert.deepEqual(await drivesFor(["--dir", "D:\\Apps\\Ollama", "--no-model"]), ["C:"]);
});

test("--no-model on any step but `install disk` is a usage error naming the step that takes it, and nothing runs", async () => {
  const t = setup();
  for (const step of INSTALL_STEP_NAMES.filter((name) => name !== "disk")) {
    await assert.rejects(runInstallCommand([step, "--no-model", "--json", t.json], t.context, t.steps), (error: Error) => error instanceof UsageError && error.message.includes("install disk"), step);
  }
  assert.deepEqual(t.calls, []);
});
