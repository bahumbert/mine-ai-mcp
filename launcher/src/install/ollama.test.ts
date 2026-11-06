import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { DownloadError } from "./download.ts";
import { fakeOllama, type FakeOllamaOptions } from "./fixtures/fake-ollama.ts";
import { MEASURED_DXGI_ADAPTERS, tempDataRoot, testContext, testManifest } from "./fixtures/install-test-support.ts";
import { displayAdapters } from "./gpu.ts";
import { defaultStoreWithModels, ollama, ollamaExe, ollamaRemove, parseOllamaVersion, runCommand, type OllamaDeps } from "./ollama.ts";
import { loadInstallState, saveInstallState } from "./state.ts";

const GIB = 1024 ** 3;
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const ROCM_LOG = fixture("ollama-serve-rocm-igpu-dropped.txt");
// Hand-written in the form of W1's lines; what a 0.35.0 serve logs on a PC with no usable GPU is unmeasured (W5).
const CPU_ONLY_LOG ='time=2026-10-30T10:00:00.000+01:00 level=INFO source=types.go:32 msg="inference compute" id=cpu library=cpu compute="" name=cpu description=cpu type="" total="63.0 GiB" available="30.0 GiB"';
const OLD_EXE = "C:/Users/p/AppData/Local/Programs/Ollama/ollama.exe";

const dir = tempDataRoot();
after(() => dir.remove());
let rootCount = 0;
const newRoot = () => join(dir.root, `case-${rootCount++}`);

type Scenario = FakeOllamaOptions & {
  /** exe found before the setup runs (a preexisting install), null = none */
  exe?: string | null;
  versionOutput?: string;
  setupCode?: number | null;
  /** The default model store of Ollama holds models: the folder, or null (none). */
  defaultStore?: string | null;
};

/** Deps for the `ollama` and `ollamaRemove` steps; `exe` appears after the setup ran when it was absent before. */
function scenario(options: Scenario = {}) {
  const serve = fakeOllama({ output: ROCM_LOG, ...options });
  let exe = options.exe === undefined ? OLD_EXE : options.exe;
  const ran: { exe: string; args: string[] }[] = [];
  const downloads: { url: string; dest: string; hash: object }[] = [];
  const removed: string[] = [];
  const stateWhenSetupRan: object[] = [];
  let root = "";
  const deps: OllamaDeps = {
    ...serve.deps,
    ollamaExe: () => exe,
    async run(runExe, args) {
      ran.push({ exe: runExe, args });
      if (args[0] === "--version") return { code: 0, output: options.versionOutput ?? "ollama version is 0.35.0\n" };
      stateWhenSetupRan.push(loadInstallState(root));
      exe = OLD_EXE; // the setup put ollama.exe in place
      return { code: options.setupCode ?? 0, output: options.setupCode ? "setup failed: disk full" : "" };
    },
    async downloadVerified(url, dest, hash, onProgress) {
      downloads.push({ url, dest, hash });
      onProgress?.(0.5);
    },
    fileExists: () => true,
    defaultStoreWithModels: () => options.defaultStore ?? null,
    removeFile: (path) => removed.push(path),
    gpuFacts: { listAdapters: async () => displayAdapters(MEASURED_DXGI_ADAPTERS), totalRamBytes: () => 64 * GIB },
  };
  return { deps, serve, ran, downloads, removed, stateWhenSetupRan, useRoot: (r: string) => (root = r) };
}

function context(options: Scenario = {}, ollamaOverrides = {}) {
  const root = newRoot();
  const s = scenario(options);
  s.useRoot(root);
  return { root, s, ctx: testContext(root, testManifest(ollamaOverrides)) };
}

test("a preexisting Ollama of a good version is used, marked preexisting, never downloaded or set up", async () => {
  const { root, s, ctx } = context();
  const result = await ollama(ctx, s.deps);
  assert.equal(result.ok, true);
  assert.deepEqual(loadInstallState(root), { ollama: "preexisting" });
  assert.equal(s.downloads.length, 0);
  assert.deepEqual(s.ran.map((call) => call.args), [["--version"]]);
});

test("stage 2 reads the GPU Ollama reports from our serve", async () => {
  const { s, ctx } = context();
  const result = await ollama(ctx, s.deps);
  assert.ok(result.ok && "report" in result);
  assert.equal(result.report.choice.kind, "local");
  assert.equal(result.report.compute?.[0].library, "rocm");
});

test("stage 2: Ollama running on the cpu only is a remote answer even with a big card in DXGI's list", async () => {
  const { s, ctx } = context({ output: CPU_ONLY_LOG });
  const result = await ollama(ctx, s.deps);
  assert.ok(result.ok && "report" in result);
  assert.equal(result.report.choice.kind, "remote");
  assert.match(result.detail, /remote endpoint/);
});

test("stage 2: a serve that logs no device within the wait fails and asks for a new try, instead of choosing remote (a slow first discovery is not 'no GPU')", async () => {
  const { s, ctx } = context({ output: "msg=\"discovering available GPUs...\"" });
  const result = await ollama(ctx, s.deps);
  assert.ok(!result.ok);
  assert.match(result.error, /did not report/);
  assert.match(result.error, /discovering available GPUs/);
  assert.match(result.hint, /again/);
});

test("an older preexisting Ollama fails with a hint to update it, installs nothing and leaves the state alone", async () => {
  const { root, s, ctx } = context({ versionOutput: "ollama version is 0.20.1\n" });
  const result = await ollama(ctx, s.deps);
  assert.ok(!result.ok);
  assert.match(result.error, /0\.20\.1/);
  assert.match(result.hint, /Update Ollama/);
  assert.equal(s.downloads.length, 0);
  assert.equal(s.ran.length, 1);
  assert.deepEqual(loadInstallState(root), {});
});

test("a version that cannot be read fails and never reinstalls over the player's Ollama", async () => {
  const { root, s, ctx } = context({ versionOutput: "usage: ollama [flags]\n" });
  const result = await ollama(ctx, s.deps);
  assert.ok(!result.ok);
  assert.match(result.error, /version/);
  assert.equal(s.downloads.length, 0);
  assert.deepEqual(loadInstallState(root), {});
});

test("without Ollama it downloads the pinned setup, marks the state installed before the setup runs, then removes the setup file", async () => {
  const { root, s, ctx } = context({ exe: null });
  const result = await ollama(ctx, s.deps);
  assert.equal(result.ok, true);
  assert.deepEqual(s.downloads.map((d) => [d.url, d.hash]), [["https://example.test/OllamaSetup.exe", { sha256: "1".repeat(64) }]]);
  const setup = s.ran.find((call) => call.args[0] !== "--version");
  assert.deepEqual(setup?.args, ["/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES"]);
  assert.equal(setup?.exe, s.downloads[0].dest);
  // the first install of ours puts the model store in the data folder, recorded before the setup like the install itself
  assert.deepEqual(s.stateWhenSetupRan, [{ ollama: "installed", ollamaModels: join(root, "models") }]);
  assert.deepEqual(loadInstallState(root), { ollama: "installed", ollamaModels: join(root, "models"), ollamaPath: OLD_EXE });
  assert.deepEqual(s.removed, [s.downloads[0].dest]);
  assert.ok(ctx.progress.some(([fraction]) => fraction > 0 && fraction < 1), "download progress reaches the installer");
});

const SETUP_FLAGS = ["/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES"];
const setupCall = (s: ReturnType<typeof scenario>) => s.ran.find((call) => call.args[0] !== "--version");

test("a chosen folder (a space, an accent) is passed to Ollama's setup as one /DIR= argument, unchanged, and its ollama.exe and our model store are recorded", async () => {
  const { root, s, ctx } = context({ exe: null });
  const folder = "D:\\Programmes Perso\\Ollama é";
  const result = await ollama(ctx, s.deps, { dir: folder });
  assert.equal(result.ok, true);
  assert.deepEqual(setupCall(s)?.args, [...SETUP_FLAGS, `/DIR=${folder}`]);
  assert.deepEqual(loadInstallState(root), { ollama: "installed", ollamaModels: join(root, "models"), ollamaPath: join(folder, "ollama.exe") });
});

test("a setup that ends without ollama.exe in the chosen folder fails naming the folder, and records no path", async () => {
  const { root, s, ctx } = context({ exe: null });
  const folder = join(dir.root, "Apps", "Empty");
  s.deps.fileExists = (path) => path !== join(folder, "ollama.exe");
  const result = await ollama(ctx, s.deps, { dir: folder });
  assert.ok(!result.ok);
  assert.ok(result.error.includes(folder), result.error);
  assert.equal(loadInstallState(root).ollamaPath, undefined);
});

test("a player's Ollama with a folder chosen: no setup runs, the answer says the folder was not used, no store is recorded", async () => {
  const { root, s, ctx } = context();
  const result = await ollama(ctx, s.deps, { dir: join(dir.root, "Apps", "Ollama") });
  assert.ok(result.ok);
  assert.match(result.detail, new RegExp(`Ollama found at ${OLD_EXE.replace(/[.\\/]/gu, "\\$&")}; the folder you chose was not used\\.`, "u"));
  assert.deepEqual(s.ran.map((call) => call.args), [["--version"]]);
  assert.deepEqual(loadInstallState(root), { ollama: "preexisting" });
  assert.equal(s.serve.started[0].env.OLLAMA_MODELS, undefined);
});

test("an upgrade of our Ollama goes into the folder recorded, so it never moves, and keeps the store recorded", async () => {
  const folder = join(dir.root, "Apps", "Ollama é");
  const { root, s, ctx } = context({ versionOutput: "ollama version is 0.20.1\n", exe: join(folder, "ollama.exe") });
  const store = join(dir.root, "elsewhere", "models");
  saveInstallState(root, { ollama: "installed", ollamaPath: join(folder, "ollama.exe"), ollamaModels: store });
  const result = await ollama(ctx, s.deps);
  assert.equal(result.ok, true);
  assert.deepEqual(setupCall(s)?.args, [...SETUP_FLAGS, `/DIR=${folder}`]);
  assert.deepEqual(loadInstallState(root), { ollama: "installed", ollamaPath: join(folder, "ollama.exe"), ollamaModels: store });
});

test("a setup that fails reports its output and a retry hint", async () => {
  const { s, ctx } = context({ exe: null, setupCode: 5 });
  const result = await ollama(ctx, s.deps);
  assert.ok(!result.ok);
  assert.match(result.error, /code 5/);
  assert.match(result.error, /disk full/);
  assert.match(result.hint, /again/);
});

test("a setup that ends without ollama.exe on disk fails instead of reporting success", async () => {
  const { s, ctx } = context({ exe: null });
  s.deps.run = async () => ({ code: 0, output: "" });
  const result = await ollama(ctx, s.deps);
  assert.ok(!result.ok);
  assert.match(result.error, /ollama\.exe/);
});

test("running it again after our own install keeps the state installed (it is still ours) and downloads nothing", async () => {
  const { root, s, ctx } = context();
  saveInstallState(root, { ollama: "installed" });
  const result = await ollama(ctx, s.deps);
  assert.equal(result.ok, true);
  assert.deepEqual(loadInstallState(root), { ollama: "installed" });
  assert.equal(s.downloads.length, 0);
});

test("our own install that the manifest outdated is updated with the new setup, unlike a player's", async () => {
  const { root, s, ctx } = context({ versionOutput: "ollama version is 0.20.1\n" });
  saveInstallState(root, { ollama: "installed" });
  const result = await ollama(ctx, s.deps);
  assert.equal(result.ok, true);
  assert.equal(s.downloads.length, 1);
  // an Ollama of ours from before W7 has no recorded store: the upgrade keeps Ollama's default one (no re-download of the model)
  assert.deepEqual(loadInstallState(root), { ollama: "installed", ollamaPath: OLD_EXE });
  assert.deepEqual(s.ran.find((call) => call.args[0] !== "--version")?.args, ["/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES"]);
});

test("a serve that never answers is an error naming the log, with the state kept and the serve killed", async () => {
  const { root, s, ctx } = context({ neverAnswers: true, output: "msg=\"GPU driver crashed\"" });
  const result = await ollama(ctx, s.deps);
  assert.ok(!result.ok);
  assert.match(result.error, /GPU driver crashed/);
  assert.match(result.hint, /again/);
  assert.equal(s.serve.killed, 1);
  assert.deepEqual(loadInstallState(root), { ollama: "preexisting" });
});

test("something already answering on our port stops stage 2 with a hint instead of reading a log that is not ours", async () => {
  const { s, ctx } = context({ alreadyUp: true });
  const result = await ollama(ctx, s.deps);
  assert.ok(!result.ok);
  assert.match(result.error, /11435/);
  assert.match(result.hint, /Task Manager/, "a leftover serve of an interrupted install is the likely cause, and no `mine-ai stop` knows it");
  assert.equal(s.serve.killed, 0);
});

for (const [origin, state] of [["preexisting", { ollama: "preexisting" }], ["never recorded", {}]] as const) {
  test(`ollamaRemove keeps an Ollama whose origin is ${origin}: no uninstaller runs`, async () => {
    const { root, s, ctx } = context();
    saveInstallState(root, state);
    const result = await ollamaRemove(ctx, s.deps);
    assert.deepEqual(result, { ok: true, detail: "Ollama was not installed by Mine AI; kept." });
    assert.equal(s.ran.length, 0);
  });
}

test("ollamaRemove keeps Ollama when its store still holds models Mine AI did not pull (the uninstaller may delete them)", async () => {
  const { root, s, ctx } = context({ models: ["llama3:8b", "gemma4:12b"] });
  saveInstallState(root, { ollama: "installed", modelPulledByUs: true });
  const result = await ollamaRemove(ctx, s.deps);
  assert.ok(result.ok);
  assert.match(result.detail, /llama3:8b/);
  assert.doesNotMatch(result.detail, /gemma4:12b/, "our own model does not block the removal");
  assert.equal(s.ran.length, 0);
  assert.deepEqual(loadInstallState(root), { ollama: "installed", modelPulledByUs: true });
});

test("ollamaRemove treats the model it did not pull as the player's: it blocks the removal too", async () => {
  const { root, s, ctx } = context({ models: ["gemma4:12b"] });
  saveInstallState(root, { ollama: "installed", modelPulledByUs: false });
  const result = await ollamaRemove(ctx, s.deps);
  assert.match(result.ok ? result.detail : "", /gemma4:12b/);
  assert.equal(s.ran.length, 0);
});

test("ollamaRemove keeps Ollama when it cannot check the models (our serve does not answer)", async () => {
  const { root, s, ctx } = context({ neverAnswers: true });
  saveInstallState(root, { ollama: "installed" });
  const result = await ollamaRemove(ctx, s.deps);
  assert.ok(result.ok);
  assert.match(result.detail, /kept/);
  assert.equal(s.ran.length, 0);
  assert.deepEqual(loadInstallState(root), { ollama: "installed" });
});

test("ollamaRemove with no uninstaller next to ollama.exe fails and keeps the record, it never says removed", async () => {
  const { root, s, ctx } = context();
  saveInstallState(root, { ollama: "installed" });
  s.deps.fileExists = () => false;
  const result = await ollamaRemove(ctx, s.deps);
  assert.ok(!result.ok);
  assert.match(result.hint, /Settings/);
  assert.deepEqual(loadInstallState(root), { ollama: "installed" });
});

test("ollamaRemove runs the uninstaller next to ollama.exe silently for an Ollama we installed, and forgets it", async () => {
  const { root, s, ctx } = context();
  saveInstallState(root, { ollama: "installed", modelPulledByUs: true });
  const result = await ollamaRemove(ctx, s.deps);
  assert.equal(result.ok, true);
  assert.deepEqual(s.ran, [{ exe: "C:/Users/p/AppData/Local/Programs/Ollama/unins000.exe", args: ["/VERYSILENT", "/NORESTART", "/SUPPRESSMSGBOXES"] }]);
  assert.deepEqual(loadInstallState(root), { modelPulledByUs: true });
});

test("ollamaRemove of an install that is already gone succeeds and clears the record", async () => {
  const { root, s, ctx } = context({ exe: null });
  saveInstallState(root, { ollama: "installed" });
  const result = await ollamaRemove(ctx, s.deps);
  assert.equal(result.ok, true);
  assert.equal(s.ran.length, 0);
  assert.deepEqual(loadInstallState(root), {});
});

test("ollamaRemove whose uninstaller fails reports it and keeps the record so a retry can finish", async () => {
  const { root, s, ctx } = context();
  saveInstallState(root, { ollama: "installed" });
  s.deps.run = async () => ({ code: 2, output: "locked" });
  const result = await ollamaRemove(ctx, s.deps);
  assert.ok(!result.ok);
  assert.match(result.error, /code 2/);
  assert.deepEqual(loadInstallState(root), { ollama: "installed" });
});

test("the version is read from the client line when a running Ollama adds a warning", () => {
  assert.equal(parseOllamaVersion("ollama version is 0.34.0\nWarning: client version is 0.35.0\n"), "0.35.0");
  assert.equal(parseOllamaVersion("ollama version is 0.35.0\n"), "0.35.0");
  assert.equal(parseOllamaVersion("ollama version is 0.36.0-rc1\n"), "0.36.0");
  assert.equal(parseOllamaVersion("nothing here"), null);
});

test("ollamaExe finds the per-user install first, then a PATH entry, else null", () => {
  const present = new Set(["C:\\Users\\p\\AppData\\Local\\Programs\\Ollama\\ollama.exe", "D:\\tools\\ollama.exe"]);
  const exists = (path: string) => present.has(path);
  assert.equal(ollamaExe({ LOCALAPPDATA: "C:\\Users\\p\\AppData\\Local", PATH: "D:\\tools" }, "win32", exists), "C:\\Users\\p\\AppData\\Local\\Programs\\Ollama\\ollama.exe");
  assert.equal(ollamaExe({ LOCALAPPDATA: "C:\\Users\\q\\AppData\\Local", PATH: "E:\\bin;D:\\tools" }, "win32", exists), "D:\\tools\\ollama.exe");
  assert.equal(ollamaExe({ PATH: "E:\\bin" }, "win32", exists), null);
});

test("the real command runner returns the exit code and the joined output, and a missing program is a null code", async () => {
  const ok = await runCommand(process.execPath, ["-e", 'console.log("out"); console.error("err"); process.exit(4)']);
  assert.equal(ok.code, 4);
  assert.match(ok.output, /out/);
  assert.match(ok.output, /err/);
  const missing = await runCommand(join(dir.root, "no-such-program"), []);
  assert.equal(missing.code, null);
});

test("a download that cannot connect fails the step with the file, the host and the connection hint, and records nothing as installed", async () => {
  const { root, s, ctx } = context({ exe: null });
  s.deps.downloadVerified = async () => {
    throw new DownloadError("Cannot download OllamaSetup.exe from ollama.com: Unable to connect.", "network");
  };
  const result = await ollama(ctx, s.deps);
  assert.ok(!result.ok);
  assert.match(result.error, /OllamaSetup\.exe from ollama\.com/u);
  assert.match(result.hint, /internet connection/u);
  assert.deepEqual(loadInstallState(root), {});
});

test("ollamaRemove keeps Ollama when our store is elsewhere and the default store still holds models of the player's", async () => {
  const { root, s, ctx } = context({ defaultStore: "C:/Users/p/.ollama/models" });
  saveInstallState(root, { ollama: "installed", ollamaModels: join(root, "models") });
  const result = await ollamaRemove(ctx, s.deps);
  assert.ok(result.ok);
  assert.match(result.detail, /kept/u);
  assert.ok(result.detail.includes("C:/Users/p/.ollama/models"), result.detail);
  assert.equal(s.ran.length, 0);
});

test("ollamaRemove looks at the default store only when our serve does not serve it (a store recorded)", async () => {
  const { root, s, ctx } = context({ defaultStore: "C:/Users/p/.ollama/models" });
  saveInstallState(root, { ollama: "installed" });
  assert.equal((await ollamaRemove(ctx, s.deps)).ok, true);
  assert.equal(s.ran.length, 1, "the uninstaller ran: our serve listed the default store and found nothing");
});

test("ollamaRemove of an Ollama in a chosen folder runs its uninstaller there, forgets the path and keeps the store (the model may still be there)", async () => {
  // waits for W5 re-check R1: that Ollama's setup puts unins000.exe next to an ollama.exe installed with /DIR= is unmeasured (fileExists answers true)
  const folder = join(dir.root, "Apps", "Ollama é");
  const { root, s, ctx } = context({ exe: join(folder, "ollama.exe") });
  saveInstallState(root, { ollama: "installed", ollamaPath: join(folder, "ollama.exe"), ollamaModels: join(root, "models"), modelPulledByUs: true });
  assert.equal((await ollamaRemove(ctx, s.deps)).ok, true);
  assert.deepEqual(s.ran, [{ exe: join(folder, "unins000.exe"), args: SETUP_FLAGS }]);
  assert.deepEqual(loadInstallState(root), { modelPulledByUs: true, ollamaModels: join(root, "models") });
  assert.equal(ollamaExe({}, "linux", () => false, loadInstallState(root).ollamaPath), null, "the next lookup finds nothing recorded and nothing else");
});

test("ollamaExe takes the recorded path first when it exists, and falls through to the usual places when it does not", () => {
  const present = new Set(["D:\\Apps\\Ollama\\ollama.exe", "C:\\Users\\p\\AppData\\Local\\Programs\\Ollama\\ollama.exe"]);
  const exists = (path: string) => present.has(path);
  const env = { LOCALAPPDATA: "C:\\Users\\p\\AppData\\Local", PATH: "" };
  assert.equal(ollamaExe(env, "win32", exists, "D:\\Apps\\Ollama\\ollama.exe"), "D:\\Apps\\Ollama\\ollama.exe");
  assert.equal(ollamaExe(env, "win32", exists, "E:\\Gone\\ollama.exe"), "C:\\Users\\p\\AppData\\Local\\Programs\\Ollama\\ollama.exe");
});

test("defaultStoreWithModels names the player's default store only when a manifest file is in it", () => {
  const home = newRoot();
  const store = join(home, ".ollama", "models");
  assert.equal(defaultStoreWithModels(home), null, "no folder");
  mkdirSync(join(store, "manifests", "registry.ollama.ai", "library", "llama3"), { recursive: true });
  assert.equal(defaultStoreWithModels(home), null, "folders but no model");
  writeFileSync(join(store, "manifests", "registry.ollama.ai", "library", "llama3", "8b"), "{}");
  assert.equal(defaultStoreWithModels(home), store);
});

test("an Ollama found where ours is not recorded is the player's: remove runs no uninstaller, forgets our record and says so (review W7a 1)", async () => {
  const folder = join(dir.root, "Apps", "Ollama é");
  const { root, s, ctx } = context(); // the Ollama found is OLD_EXE, in Ollama's default folder
  saveInstallState(root, { ollama: "installed", ollamaPath: join(folder, "ollama.exe"), ollamaModels: join(root, "models") });
  const result = await ollamaRemove(ctx, s.deps);
  assert.ok(result.ok);
  assert.equal(s.ran.length, 0);
  assert.ok(result.detail.includes(OLD_EXE) && /not Mine AI's and was kept/u.test(result.detail), result.detail);
  assert.equal(loadInstallState(root).ollama, undefined);
});

test("an old Ollama found where ours is not recorded is the player's: no download, no setup over it (review W7a 1)", async () => {
  const { root, s, ctx } = context({ versionOutput: "ollama version is 0.20.1\n" });
  saveInstallState(root, { ollama: "installed", ollamaPath: join(dir.root, "Apps", "gone", "ollama.exe"), ollamaModels: join(root, "models") });
  const result = await ollama(ctx, s.deps);
  assert.ok(!result.ok);
  assert.match(result.hint, /Update Ollama/u);
  assert.equal(s.downloads.length, 0);
});

test("a player's Ollama found while only our old model store is recorded: marked preexisting and served from its own store (review W7a 4)", async () => {
  const { root, s, ctx } = context();
  saveInstallState(root, { ollamaModels: join(root, "models") });
  assert.ok((await ollama(ctx, s.deps)).ok);
  assert.deepEqual(loadInstallState(root), { ollama: "preexisting" });
  assert.equal(s.serve.started[0].env.OLLAMA_MODELS, undefined);
});

test("a retry after a stage-2 failure does not claim the folder was ignored when Ollama stands in that folder (review W7a 3)", async () => {
  const folder = join(dir.root, "Apps", "Ollama é");
  const { root, s, ctx } = context({ exe: join(folder, "ollama.exe") });
  saveInstallState(root, { ollama: "installed", ollamaPath: join(folder, "ollama.exe"), ollamaModels: join(root, "models") });
  const result = await ollama(ctx, s.deps, { dir: `${folder}/` });
  assert.ok(result.ok);
  assert.doesNotMatch(result.detail, /was not used/u);
});
