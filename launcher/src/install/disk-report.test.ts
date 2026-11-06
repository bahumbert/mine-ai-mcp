import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { defaultOllamaFolder, diskReport, driveLines, type DiskReport, type DiskReportDeps } from "./disk-report.ts";
import { gb, type DiskDeps, type ModelStoreDeps } from "./disk.ts";
import { testContext, testManifest } from "./fixtures/install-test-support.ts";
import type { StepFailure } from "./step.ts";

const GIB = 1024 ** 3;
const ROOT = "C:\\MineAI";
const OLLAMA_SETUP = 1_571_105_888;
const JAVA_ZIP = 49_106_397;
const JAR = 56_880_250;
// The registry's answer for gemma4:12b, measured 2026-11-06 (same fixture as disk.test.ts): 8021618941 bytes in all.
const REGISTRY_ANSWER = readFileSync(new URL("./fixtures/gemma4-12b-registry-manifest.json", import.meta.url), "utf8");
const MODEL = 8_021_618_941;
const INSTALLED_OLLAMA = testManifest().ollama.installedBytes;
const JAVA_INSTALLED = testManifest().java.installedBytes;

/** A Windows disk: `free` bytes per drive prefix; a drive absent from `free` does not exist. */
function windowsDisk(free: Record<string, number>): DiskDeps & { statfsCalls: string[] } {
  const statfsCalls: string[] = [];
  const driveOf = (path: string) => Object.keys(free).find((drive) => path.toUpperCase().startsWith(drive));
  return {
    platform: "win32",
    statfsCalls,
    exists: (path) => /^[A-Z]:\\$/u.test(path) && driveOf(path) !== undefined,
    statfs: async (path) => (statfsCalls.push(path), { bavail: BigInt(free[driveOf(path)!]), bsize: 1n }),
    dev: () => "0",
  };
}

type Answers = { sizes?: Record<string, number | null>; registry?: "ok" | "down" | "nojson"; blobs?: Record<string, number> };

/** HEAD answers by URL and the registry's GET; `requests` lists `METHOD url` in arrival order. */
function fakeNetwork(answers: Answers = {}) {
  const manifest = testManifest();
  const sizes: Record<string, number | null> = { [manifest.ollama.url]: OLLAMA_SETUP, [manifest.java.url]: JAVA_ZIP, [manifest.minecraft.jar.url]: JAR, ...answers.sizes };
  const requests: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (init?.method === "HEAD") {
      const size = sizes[url];
      return new Response(null, { status: 200, headers: size == null ? {} : { "content-length": String(size) } });
    }
    if (answers.registry === "down") throw new TypeError("Unable to connect");
    return new Response(answers.registry === "nojson" ? "<html>no</html>" : REGISTRY_ANSWER, { status: 200 });
  }) as typeof fetch;
  const store: ModelStoreDeps = {
    fetchImpl,
    exists: () => false,
    sizeOf: async () => 0,
    listDir: async () => [],
  };
  return { fetchImpl, store, requests };
}

function setup(options: { free?: Record<string, number>; answers?: Answers; ollamaExe?: () => string | null; modelOnDisk?: boolean; pinnedJre?: boolean; existing?: string[]; network?: ReturnType<typeof fakeNetwork> } = {}) {
  const manifest = testManifest();
  const ctx = testContext(ROOT, manifest);
  const network = options.network ?? fakeNetwork(options.answers);
  const disk = windowsDisk(options.free ?? { "C:": 100 * GIB, "D:": 50 * GIB });
  const present = new Set(options.existing ?? []);
  const deps: DiskReportDeps = {
    disk: { ...disk, exists: (path) => disk.exists(path) || present.has(path) },
    fetchImpl: network.fetchImpl,
    modelStoreDeps: network.store,
    ollamaExe: options.ollamaExe ?? (() => null),
    modelOnDisk: () => options.modelOnDisk ?? false,
    modelStore: (ollamaFound) => (ollamaFound ? "C:\\Users\\me\\.ollama\\models" : "C:\\MineAI\\models"),
    pinnedJreInstalled: async () => options.pinnedJre ?? false,
    defaultOllamaFolder: "C:\\Users\\me\\AppData\\Local\\Programs\\Ollama",
  };
  return { ctx, deps, network, disk };
}

const asReport = (result: DiskReport | StepFailure): DiskReport => {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result as DiskReport;
};

test("no Ollama and no model: each drive lists its free space and what the local model and the server put there, from the downloads' own sizes", async () => {
  const t = setup();
  const report = asReport(await diskReport(t.ctx, { dir: "D:\\Apps\\Ollama", noModel: false }, t.deps));
  assert.equal(report.short, false);
  assert.deepEqual(report.drives.map((drive) => [drive.drive, drive.freeBytes]), [["C:", 100 * GIB], ["D:", 50 * GIB]]);
  const needsOf = (drive: string) => report.drives.find((entry) => entry.drive === drive)!.needs;
  assert.deepEqual(needsOf("D:"), [{ what: "Ollama", bytes: INSTALLED_OLLAMA }]);
  assert.deepEqual(needsOf("C:"), [
    { what: "Ollama", bytes: OLLAMA_SETUP },
    { what: "model", bytes: MODEL },
    { what: "Java", bytes: JAVA_ZIP },
    { what: "Java", bytes: JAVA_INSTALLED },
    { what: "server jar", bytes: JAR },
  ]);
  const [lineC, lineD] = report.detail.split("\n");
  assert.equal(lineC, `C: ${gb(100 * GIB)} free. The local AI model needs ${gb(OLLAMA_SETUP + MODEL)} here (Ollama ${gb(OLLAMA_SETUP)}, model ${gb(MODEL)}). A local Minecraft server needs ${gb(JAVA_ZIP + JAVA_INSTALLED + JAR)} here (Java ${gb(JAVA_ZIP + JAVA_INSTALLED)}, server jar ${gb(JAR)}).`);
  assert.equal(lineD, `D: ${gb(50 * GIB)} free. The local AI model needs ${gb(INSTALLED_OLLAMA)} here.`);
});

test("the Ollama folder defaults to the one Ollama's own setup uses, and shares a drive with the data folder: one drive entry", async () => {
  const t = setup({ free: { "C:": 100 * GIB } });
  const report = asReport(await diskReport(t.ctx, { dir: undefined, noModel: false }, t.deps));
  assert.deepEqual(report.drives.map((drive) => drive.drive), ["C:"]);
  assert.ok(report.drives[0]!.needs.some((need) => need.what === "Ollama" && need.bytes === INSTALLED_OLLAMA));
  assert.equal(report.detail.split("\n").length, 1, "one line per drive");
});

test("a drive too small for its needs plus the reserve is still ok:true, with short:true and a line that says what to do", async () => {
  const t = setup({ free: { "C:": 100 * GIB, "D:": 2 * GIB } });
  const report = asReport(await diskReport(t.ctx, { dir: "D:\\Apps\\Ollama", noModel: false }, t.deps));
  assert.equal(report.short, true);
  const lineD = report.detail.split("\n")[1]!;
  assert.match(lineD, /^D: 2\.0 GB free\./u);
  assert.match(lineD, /may not be enough/u);
  assert.match(lineD, /1\.0 GB free/u, "names the reserve Mine AI keeps");
  assert.match(lineD, /free some space on D: or choose another Ollama folder\.$/u, "D: holds the folder of the Ollama row");
  assert.ok(!report.detail.split("\n")[0]!.match(/not be enough/iu), "the drive that fits says nothing of the kind");
});

test("a short drive that holds only folders the player cannot move here (the model store, the data folder) is not told to choose another folder", async () => {
  const t = setup({ free: { "C:": 2 * GIB, "D:": 100 * GIB } });
  const report = asReport(await diskReport(t.ctx, { dir: "D:\\Apps\\Ollama", noModel: false }, t.deps));
  const lineC = report.detail.split("\n")[0]!;
  assert.match(lineC, /^C: 2\.0 GB free\./u);
  assert.match(lineC, /free some space on C:\.$/u);
  assert.ok(!lineC.includes("choose"), lineC);
});

test("exactly enough passes and one byte short does not", async () => {
  const need = INSTALLED_OLLAMA + 1_073_741_824;
  const fits = setup({ free: { "C:": 100 * GIB, "D:": need } });
  assert.equal(asReport(await diskReport(fits.ctx, { dir: "D:\\Apps\\Ollama", noModel: false }, fits.deps)).short, false);
  const short = setup({ free: { "C:": 100 * GIB, "D:": need - 1 } });
  assert.equal(asReport(await diskReport(short.ctx, { dir: "D:\\Apps\\Ollama", noModel: false }, short.deps)).short, true);
});

test("Ollama found and the model on disk: nothing to download for the model, and no request for Ollama's setup or the registry", async () => {
  const t = setup({ ollamaExe: () => "C:\\Ollama\\ollama.exe", modelOnDisk: true });
  const report = asReport(await diskReport(t.ctx, { dir: undefined, noModel: false }, t.deps));
  assert.match(report.detail, /Nothing to download for the local AI model\./u);
  assert.ok(!t.network.requests.some((request) => request.includes("OllamaSetup") || request.includes("registry")), t.network.requests.join(", "));
  assert.deepEqual(report.drives[0]!.needs.filter((need) => need.what === "model" || need.what === "Ollama").map((need) => need.bytes), [0]);
});

test("Ollama found and the model not on disk: the model alone is counted, in the store the existing Ollama uses", async () => {
  const stores: boolean[] = [];
  const t = setup({ ollamaExe: () => "C:\\Ollama\\ollama.exe" });
  const report = asReport(await diskReport(t.ctx, { dir: "D:\\Apps\\Ollama", noModel: false }, { ...t.deps, modelStore: (found) => (stores.push(found), "D:\\models") }));
  assert.deepEqual(stores, [true]);
  assert.deepEqual(report.drives.find((drive) => drive.drive === "D:")!.needs, [{ what: "model", bytes: MODEL }], "--dir is ignored when Ollama is already there");
});

test("the model is counted less by what the store already holds (modelBytesToPull)", async () => {
  const network = fakeNetwork();
  network.store.exists = (path) => path.endsWith("sha256-0cb0cd0a5c499d92942caa22fe5abb98f6e8874868d590e2b094ece4ac8e6d28");
  const t = setup({ network });
  const report = asReport(await diskReport(t.ctx, { dir: undefined, noModel: false }, t.deps));
  assert.equal(report.drives[0]!.needs.find((need) => need.what === "model")!.bytes, MODEL - 175_115_616);
});

test("--no-model leaves out the model and Ollama lines and makes no registry or Ollama request: the server alone", async () => {
  const t = setup();
  const report = asReport(await diskReport(t.ctx, { dir: "D:\\Apps\\Ollama", noModel: true }, t.deps));
  assert.deepEqual(report.drives.map((drive) => drive.drive), ["C:"], "no D: line: nothing of the Ollama folder is asked");
  assert.equal(report.detail, `C: ${gb(100 * GIB)} free. A local Minecraft server needs ${gb(JAVA_ZIP + JAVA_INSTALLED + JAR)} here (Java ${gb(JAVA_ZIP + JAVA_INSTALLED)}, server jar ${gb(JAR)}).`);
  assert.deepEqual(t.network.requests.map((request) => request.split(" ")[1]).sort(), [testManifest().java.url, testManifest().minecraft.jar.url].sort());
});

test("a pinned Java that is installed and a jar that is there need nothing: no request for them, and the line says so", async () => {
  const jar = join(ROOT, "server", "server.jar");
  const t = setup({ pinnedJre: true, existing: [jar], ollamaExe: () => "C:\\Ollama\\ollama.exe", modelOnDisk: true });
  const report = asReport(await diskReport(t.ctx, { dir: undefined, noModel: false }, t.deps));
  assert.match(report.detail, /Nothing to download for a local Minecraft server\./u);
  assert.deepEqual(t.network.requests, []);
  assert.equal(report.short, false);
});

test("a size that cannot be read is 'size unknown', never a guess: no content-length, a registry that is down or answers non-JSON", async () => {
  const manifest = testManifest();
  const t = setup({ answers: { sizes: { [manifest.ollama.url]: null, [manifest.java.url]: null }, registry: "down" } });
  const report = asReport(await diskReport(t.ctx, { dir: "D:\\Apps\\Ollama", noModel: false }, t.deps));
  const lineC = report.detail.split("\n")[0]!;
  assert.match(lineC, /The local AI model: size unknown \(Ollama size unknown, model size unknown\)\./u);
  assert.match(lineC, /A local Minecraft server needs at least .* \(Java at least /u, "the installed Java is known, its zip is not");
  assert.equal(report.drives[0]!.needs.find((need) => need.what === "model")!.bytes, null);
  assert.equal(report.short, false, "an unknown size never makes a drive short");
  const nonJson = setup({ answers: { registry: "nojson" } });
  assert.equal(asReport(await diskReport(nonJson.ctx, { dir: undefined, noModel: false }, nonJson.deps)).drives[0]!.needs.find((need) => need.what === "model")!.bytes, null);
});

test("an unknown size next to a known one reads 'at least'", async () => {
  const t = setup({ answers: { registry: "down" } });
  const report = asReport(await diskReport(t.ctx, { dir: undefined, noModel: false }, t.deps));
  assert.match(report.detail, new RegExp(`The local AI model needs at least ${gb(OLLAMA_SETUP + INSTALLED_OLLAMA).replace(".", "\\.")} here \\(Ollama ${gb(OLLAMA_SETUP + INSTALLED_OLLAMA).replace(".", "\\.")}, model size unknown\\)`, "u"));
});

test("an Ollama lookup that throws counts as 'no Ollama found', as `install gpu` does", async () => {
  const t = setup({
    ollamaExe: () => {
      throw new Error("install-state.json is not a valid install state");
    },
  });
  const report = asReport(await diskReport(t.ctx, { dir: undefined, noModel: false }, t.deps));
  assert.ok(report.drives[0]!.needs.some((need) => need.what === "Ollama" && need.bytes === OLLAMA_SETUP));
});

test("the requests go out together: the HEADs and the registry read are all sent before the first answer arrives", { timeout: 3000 }, async () => {
  const network = fakeNetwork();
  const waiting: (() => void)[] = [];
  const answer = network.fetchImpl;
  const gated = (async (input: string | URL | Request, init?: RequestInit) => {
    await new Promise<void>((resolve) => {
      waiting.push(resolve);
      if (waiting.length === 4) waiting.forEach((release) => release());
    });
    return answer(input, init);
  }) as typeof fetch;
  const t = setup({ network: { ...network, fetchImpl: gated, store: { ...network.store, fetchImpl: gated } } });
  asReport(await diskReport(t.ctx, { dir: undefined, noModel: false }, t.deps));
  assert.equal(waiting.length, 4, "Ollama's setup, the registry, Java and the jar");
});

test("a folder on a drive that is not there is listed with its reason and no free space; the other drives still report", async () => {
  const t = setup();
  const report = asReport(await diskReport(t.ctx, { dir: "X:\\Apps\\Ollama", noModel: false }, t.deps));
  const missing = report.drives.find((drive) => drive.drive === "X:")!;
  assert.equal(missing.freeBytes, null);
  assert.match(report.detail, /The drive of X:\\Apps\\Ollama does not exist\. It is needed for the local AI model\. Choose another Ollama folder\./u);
  assert.equal(report.short, false);
  assert.equal(report.drives.find((drive) => drive.drive === "C:")!.freeBytes, 100 * GIB);
});

test("a missing drive for a folder the player cannot move here says what it is needed for and offers no folder choice", async () => {
  const t = setup();
  const report = asReport(await diskReport(t.ctx, { dir: undefined, noModel: false }, { ...t.deps, modelStore: () => "Z:\\models" }));
  const line = report.detail.split("\n").find((entry) => entry.startsWith("The drive of Z:"))!;
  assert.equal(line, "The drive of Z:\\models does not exist. It is needed for the local AI model.");
});

test("a drive whose free space cannot be read (not a missing drive) says so with the system's reason, in the report and in the doctor's lines", async () => {
  const t = setup();
  const denied: DiskDeps = {
    ...t.disk,
    statfs: async () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    },
  };
  const failed = await diskReport(t.ctx, { dir: undefined, noModel: true }, { ...t.deps, disk: denied });
  assert.equal(failed.ok, false, "no drive could be read at all");
  assert.match((failed as StepFailure).error, /The free space of .* could not be read \(EACCES: permission denied\)/u);
  assert.deepEqual(await driveLines([{ what: "app folder", folder: "C:\\app" }], denied), ["C: free space could not be read (app folder)"]);
});

test("no drive can be read at all: ok:false with what was tried and what to do", async () => {
  const t = setup({ free: {} });
  const result = await diskReport(t.ctx, { dir: undefined, noModel: true }, t.deps);
  assert.equal(result.ok, false);
  const failed = result as StepFailure;
  assert.match(failed.error, /does not exist/u);
  assert.notEqual(failed.hint, "");
});

test("defaultOllamaFolder is the per-user folder of Ollama's own setup: LOCALAPPDATA, else the home's AppData\\Local; elsewhere the data root's", () => {
  assert.equal(defaultOllamaFolder({ LOCALAPPDATA: "D:\\Local" }, "win32", "C:\\Users\\me", "C:\\MineAI"), "D:\\Local\\Programs\\Ollama");
  assert.equal(defaultOllamaFolder({}, "win32", "C:\\Users\\me", "C:\\MineAI"), "C:\\Users\\me\\AppData\\Local\\Programs\\Ollama");
  assert.equal(defaultOllamaFolder({}, "linux", "/home/me", "/data/mine-ai"), "/data/mine-ai");
});

test("driveLines groups folders by drive, names what is on each, and says 'not found' for a drive that is gone", async () => {
  const deps = windowsDisk({ "C:": 123_634_737_152, "D:": 10 * GIB });
  const lines = await driveLines(
    [
      { what: "app folder", folder: "C:\\Program Files\\Mine AI" },
      { what: "data folder", folder: "C:\\MineAI" },
      { what: "Ollama", folder: "D:\\Apps\\Ollama" },
      { what: "Ollama models", folder: "X:\\models" },
    ],
    deps,
  );
  assert.deepEqual(lines, ["C: 115.1 GB free (app folder, data folder)", "D: 10.0 GB free (Ollama)", "X: not found (Ollama models)"]);
});
