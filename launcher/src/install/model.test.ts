import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { diskWithRoomForAnything, twoDrives } from "./fixtures/fake-disk.ts";
import { fakeOllama, type FakeOllamaOptions } from "./fixtures/fake-ollama.ts";
import { tempDataRoot, testContext, testManifest } from "./fixtures/install-test-support.ts";
import { model, modelOnDisk, modelRemove, type ModelDeps } from "./model.ts";
import { ollamaServeEnv } from "./ollama-serve.ts";
import { loadInstallState, saveInstallState, type InstallState } from "./state.ts";

const dir = tempDataRoot();
after(() => dir.remove());
let rootCount = 0;

function setup(options: FakeOllamaOptions = {}, state: InstallState = {}, exe: string | null = "C:/ollama.exe", tag = "gemma4:12b") {
  const root = join(dir.root, `case-${rootCount++}`);
  saveInstallState(root, state);
  const serve = fakeOllama(options);
  // by default the registry does not know the model and the disk has room: the free-space guard (below) lets the pull go on
  const deps: ModelDeps = { ...serve.deps, ollamaExe: () => exe, registryFetch: registryAnswering(404, "{}").fetchImpl, disk: diskWithRoomForAnything() };
  return { root, serve, deps, ctx: testContext(root, testManifest({ model: tag })) };
}

/** A registry that answers every manifest request with `status` and `body`, counting the requests. */
function registryAnswering(status: number, body: string) {
  const urls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(body, { status });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

const pullLines = [
  { status: "pulling manifest" },
  { status: "pulling aaa", digest: "sha256:aaa", total: 100, completed: 25 },
  { status: "pulling aaa", digest: "sha256:aaa", total: 100, completed: 100 },
  { status: "pulling bbb", digest: "sha256:bbb", total: 100, completed: 50 },
  { status: "pulling bbb", digest: "sha256:bbb", total: 100, completed: 100 },
  { status: "success" },
];

test("a tag present again on a later run keeps modelPulledByUs true (the update path)", async () => {
  const { root, deps, ctx } = setup({ models: ["gemma4:12b"] }, { modelPulledByUs: true });
  assert.equal((await model(ctx, deps)).ok, true);
  assert.equal(loadInstallState(root).modelPulledByUs, true);
});

test("a tag without a version matches its :latest entry", async () => {
  const { serve, deps, ctx } = setup({ models: ["gemma4:latest"] }, {}, "C:/ollama.exe", "gemma4");
  assert.equal((await model(ctx, deps)).ok, true);
  assert.equal(serve.requestsTo("/api/pull").length, 0);
});

test("a missing tag is pulled with streaming, progress follows completed/total of all layers, and the model is marked ours", async () => {
  const { root, serve, deps, ctx } = setup({ pullLines });
  const result = await model(ctx, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(serve.requestsTo("/api/pull")[0].body, { model: "gemma4:12b", stream: true });
  const fractions = ctx.progress.map(([fraction]) => fraction);
  assert.ok(fractions.includes(0.25), `a quarter of the first layer shows: ${fractions}`);
  assert.ok(fractions.every((fraction) => fraction >= 0 && fraction <= 1));
  assert.equal(loadInstallState(root).modelPulledByUs, true);
  assert.equal(serve.killed, 1);
});

test("a progress line cut in two network chunks is still read", async () => {
  const { deps, ctx } = setup();
  const line = JSON.stringify({ status: "pulling aaa", digest: "sha256:aaa", total: 100, completed: 40 });
  const chunks = [line.slice(0, 20), `${line.slice(20)}\n${JSON.stringify({ status: "success" })}\n`];
  const realFetch = deps.fetch;
  deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).endsWith("/api/pull")) return realFetch(input, init);
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({ start(controller) { chunks.forEach((chunk) => controller.enqueue(encoder.encode(chunk))); controller.close(); } }));
  }) as typeof fetch;
  const result = await model(ctx, deps);
  assert.equal(result.ok, true);
  assert.ok(ctx.progress.some(([fraction]) => fraction === 0.4));
});

test("a pull error line fails with Ollama's words and says a new run resumes", async () => {
  const { deps, ctx } = setup({ pullLines: [{ status: "pulling manifest" }, { error: "pull model manifest: file does not exist" }] });
  const result = await model(ctx, deps);
  assert.ok(!result.ok);
  assert.match(result.error, /file does not exist/);
  assert.match(result.hint, /resume/);
});

test("a pull that ends without a success line fails (the connection was cut)", async () => {
  const { deps, ctx } = setup({ pullLines: [{ status: "pulling aaa", digest: "sha256:aaa", total: 100, completed: 30 }] });
  const result = await model(ctx, deps);
  assert.ok(!result.ok);
  assert.match(result.error, /ended before/);
});

test("a pull answered with an HTTP error fails with the status", async () => {
  const { deps, ctx } = setup({ pullLines: ["boom"], pullStatus: 500 });
  const result = await model(ctx, deps);
  assert.ok(!result.ok);
  assert.match(result.error, /500/);
});

// Free-space guard (plan T1b). The registry's answer for gemma4:12b is 8021618941 bytes (measured 2026-11-06); Mine AI keeps 1 GiB free.
const GIB = 1024 ** 3;
const REGISTRY_ANSWER = readFileSync(new URL("./fixtures/gemma4-12b-registry-manifest.json", import.meta.url), "utf8");
const MODEL_LAYER_FILE = "sha256-bb722270d54346adc198f213851dbe0207e87c3ecf2a0aff4d92262726215391";

/** The step on our own Ollama whose store is `<root>/models` (or on the other drive), over a disk with the given free bytes, with the registry answering gemma4:12b. */
function guarded(free: { data: number; other?: number }, options: { fake?: FakeOllamaOptions; storeOnOtherDrive?: boolean; registry?: typeof fetch } = {}) {
  const root = join(dir.root, `case-${rootCount}`);
  const drives = twoDrives(dir.root, { data: free.data, other: free.other ?? 0 });
  const store = options.storeOnOtherDrive ? drives.otherFolder("models") : join(root, "models");
  const made = setup({ pullLines, ...options.fake }, { ollama: "installed", ollamaModels: store });
  const registry = registryAnswering(200, REGISTRY_ANSWER);
  made.deps.registryFetch = options.registry ?? registry.fetchImpl;
  made.deps.disk = drives.disk;
  return { ...made, registry, store, disk: drives.disk };
}

test("a store too small for the model's layers fails before the pull is sent and before the model is recorded as ours, naming the drive and the sizes", async () => {
  const { root, serve, deps, ctx, registry } = guarded({ data: 8 * GIB });
  const result = await model(ctx, deps);
  assert.ok(!result.ok);
  assert.match(result.error, /^Not enough free space on \S+ for the model gemma4:12b: it needs 8\.5 GB \(including the 1\.0 GB Mine AI keeps free\) and \S+ has 8\.0 GB free\.$/u);
  assert.match(result.hint, /^Free some space on \S+, then run the step again\.$/u);
  assert.equal(serve.requestsTo("/api/pull").length, 0);
  assert.equal(loadInstallState(root).modelPulledByUs, undefined, "a cut-short step leaves nothing for model-remove to clean up");
  assert.equal(serve.killed, 1, "our serve is stopped as after any failure");
  assert.deepEqual(registry.urls, ["https://registry.ollama.ai/v2/library/gemma4/manifests/12b"]);
});

test("a store on another drive than the data folder is counted on that drive", async () => {
  const short = guarded({ data: 1000 * GIB, other: 8 * GIB }, { storeOnOtherDrive: true });
  assert.ok(!(await model(short.ctx, short.deps)).ok);
  assert.equal(short.serve.requestsTo("/api/pull").length, 0);
  const fits = guarded({ data: 1 * GIB, other: 9 * GIB }, { storeOnOtherDrive: true });
  assert.equal((await model(fits.ctx, fits.deps)).ok, true, "the data drive holds none of the model: only 9 GB on the other drive count");
  assert.equal(fits.serve.requestsTo("/api/pull").length, 1);
});

test("layers already in the store, and the finished part of a cut pull, are not counted again (Ollama's -partial-N files say how far it got)", async () => {
  const resumed = guarded({ data: 5 * GIB });
  const blobs = join(resumed.store, "blobs");
  mkdirSync(blobs, { recursive: true });
  // Ollama 0.35.0's layout of a cut pull, measured 2026-11-06: the -partial file is already the whole layer long, the part files hold the progress
  writeFileSync(join(blobs, `${MODEL_LAYER_FILE}-partial`), "x");
  writeFileSync(join(blobs, `${MODEL_LAYER_FILE}-partial-0`), JSON.stringify({ N: 0, Offset: 0, Size: 100_000_000, Completed: 4_000_000_000 }));
  assert.equal((await model(resumed.ctx, resumed.deps)).ok, true, "7.5 GB minus the 3.7 GB done leaves 3.7 GB, plus the 1.0 GB reserve is 4.7 GB: 5.0 GB holds it");

  const fresh = guarded({ data: 5 * GIB });
  assert.ok(!(await model(fresh.ctx, fresh.deps)).ok, "the same 5.0 GB cannot hold the whole model");
});

test("a model that is listed already, or a serve that was reused (the player's Ollama on our port, maybe another store), makes no registry request", async () => {
  const listed = guarded({ data: 0 }, { fake: { models: ["gemma4:12b"] } });
  assert.equal((await model(listed.ctx, listed.deps)).ok, true);
  assert.deepEqual(listed.registry.urls, []);
  assert.deepEqual(listed.disk.statfsCalls, []);

  const reused = guarded({ data: 0 }, { fake: { alreadyUp: true } });
  assert.equal((await model(reused.ctx, reused.deps)).ok, true, "no check: the pull goes to the Ollama that answered");
  assert.deepEqual(reused.registry.urls, []);
  assert.equal(reused.serve.requestsTo("/api/pull").length, 1);
});

test("a registry that cannot be reached does not stop the pull (its own error stays the guard)", async () => {
  const unreachable = guarded({ data: 0 }, { registry: (async () => { throw new TypeError("Unable to connect"); }) as unknown as typeof fetch });
  assert.equal((await model(unreachable.ctx, unreachable.deps)).ok, true);
  assert.equal(unreachable.serve.requestsTo("/api/pull").length, 1);
});

test("a model store on a drive that is not there fails saying so, before the pull", async () => {
  const missing = process.platform === "win32" ? "X:\\models" : "/no-such-drive/models";
  const { root, serve, deps, ctx } = guarded({ data: 1000 * GIB });
  saveInstallState(root, { ollama: "installed", ollamaModels: missing });
  const result = await model(ctx, deps);
  assert.ok(!result.ok);
  assert.equal(result.error, `The drive of ${missing} does not exist.`);
  assert.doesNotMatch(result.hint, /free some space/iu);
  assert.equal(serve.requestsTo("/api/pull").length, 0);
});

test("without Ollama on disk the step fails and names the Ollama step", async () => {
  const { deps, ctx } = setup({}, {}, null);
  const result = await model(ctx, deps);
  assert.ok(!result.ok);
  assert.match(result.hint, /Install Ollama first/);
});

test("a serve that never answers fails with its log and is killed", async () => {
  const { serve, deps, ctx } = setup({ neverAnswers: true, output: "msg=\"out of memory\"" });
  const result = await model(ctx, deps);
  assert.ok(!result.ok);
  assert.match(result.error, /out of memory/);
  assert.equal(serve.killed, 1);
});

test("modelRemove skips a model we did not pull: no serve starts, no delete is sent, later or never", async () => {
  const { root, serve, deps, ctx } = setup({ models: ["llama3:8b", "gemma4:12b"] });
  assert.equal((await model(ctx, deps)).ok, true);
  assert.equal(serve.requestsTo("/api/pull").length, 0, "a tag already listed is not pulled");
  serve.requests.length = 0;
  const result = await modelRemove(ctx, deps);
  assert.deepEqual(result, { ok: true, detail: "Model gemma4:12b was not pulled by Mine AI; kept." });
  assert.equal(serve.requests.length, 0);
  assert.equal(serve.started.length, 1, "only the serve of the earlier model step");
  assert.equal(loadInstallState(root).modelPulledByUs, false);
});

test("modelRemove deletes through our serve the model we pulled, then clears the record", async () => {
  const { root, serve, deps, ctx } = setup({}, { ollama: "installed", modelPulledByUs: true });
  const result = await modelRemove(ctx, deps);
  assert.equal(result.ok, true);
  assert.deepEqual(serve.requestsTo("/api/delete").map((r) => [r.method, r.body]), [["DELETE", { model: "gemma4:12b" }]]);
  assert.deepEqual(loadInstallState(root), { ollama: "installed", modelPulledByUs: false });
  assert.equal(serve.killed, 1);
});

test("modelRemove of a model that is already gone succeeds and clears the record", async () => {
  const { root, deps, ctx } = setup({ deleteStatus: 404 }, { modelPulledByUs: true });
  assert.equal((await modelRemove(ctx, deps)).ok, true);
  assert.equal(loadInstallState(root).modelPulledByUs, false);
});

test("modelRemove whose delete fails reports the status and keeps the record so a retry can finish", async () => {
  const { root, deps, ctx } = setup({ deleteStatus: 500 }, { modelPulledByUs: true });
  const result = await modelRemove(ctx, deps);
  assert.ok(!result.ok);
  assert.match(result.error, /500/);
  assert.equal(loadInstallState(root).modelPulledByUs, true);
});

test("modelRemove after Ollama itself was removed has nothing to delete and clears the record", async () => {
  const { root, serve, deps, ctx } = setup({}, { modelPulledByUs: true }, null);
  const result = await modelRemove(ctx, deps);
  assert.equal(result.ok, true);
  assert.equal(serve.started.length, 0);
  assert.equal(loadInstallState(root).modelPulledByUs, false);
});

test("a pull and a removal run in the model store of the stack: the serve env is the one ollamaServeEnv builds, OLLAMA_MODELS included", async () => {
  const store = join(dir.root, "chosen", "models");
  const state: InstallState = { ollama: "installed", ollamaModels: store, modelPulledByUs: true };
  const pulled = setup({ pullLines }, { ollama: "installed", ollamaModels: store });
  await model(pulled.ctx, pulled.deps);
  const removed = setup({}, state);
  await modelRemove(removed.ctx, removed.deps);
  for (const t of [pulled, removed]) {
    const expected = ollamaServeEnv(t.ctx.manifest, t.ctx.manifest.ollama.port, loadInstallState(t.root));
    assert.equal(expected.OLLAMA_MODELS, store);
    assert.equal(t.serve.started.length, 1);
    assert.deepEqual(Object.fromEntries(Object.entries(t.serve.started[0].env).filter(([key]) => key in expected)), expected);
  }
});

// A pull answer whose chunks and silences the test scripts; `cancel` runs when the step gives up on the body.
type Beat = { after: number; text?: string; fail?: Error };
function scriptedPull(deps: ModelDeps, beats: Beat[], seen: { init?: RequestInit } = {}) {
  const realFetch = deps.fetch;
  deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).endsWith("/api/pull")) return realFetch(input, init);
    seen.init = init;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          let at = 0;
          for (const beat of beats) {
            at += beat.after;
            timers.push(setTimeout(() => (beat.fail ? controller.error(beat.fail) : controller.enqueue(encoder.encode(beat.text ?? ""))), at));
          }
          timers.push(setTimeout(() => { try { controller.close(); } catch { /* already cancelled */ } }, at + 5));
        },
        cancel: () => timers.forEach(clearTimeout),
      }),
    );
  }) as typeof fetch;
  return seen;
}
const ndjson = (...lines: object[]) => lines.map((line) => `${JSON.stringify(line)}\n`).join("");
const IDLE_MS = 60;

test("a pull that sends two download lines and then nothing fails after the idle bound, names the percent, and the serve is killed", async () => {
  const { serve, deps, ctx, root } = setup({}, {}, "C:/ollama.exe");
  ctx.manifest.waits.modelPullIdleMs = IDLE_MS;
  const request = scriptedPull(deps, [{ after: 0, text: ndjson({ status: "pulling aaa", digest: "sha256:aaa", total: 100, completed: 25 }, { status: "pulling aaa", digest: "sha256:aaa", total: 100, completed: 50 }) }, { after: 2000, text: ndjson({ status: "success" }) }]);
  const result = await model(ctx, deps);
  assert.ok(!result.ok);
  assert.match(result.error, /^Ollama sent nothing for \d+(\.\d+)? min while downloading gemma4:12b \(50 % done\)\.$/);
  assert.match(result.hint, /resume/);
  assert.equal(serve.killed, 1);
  assert.equal(loadInstallState(root).modelPulledByUs, true, "layers are on disk: an uninstall must still clean them up");
  assert.equal((request.init as { timeout?: unknown }).timeout, false, "Bun's own 360 s limit is off: our bound is the only one");
  assert.ok(request.init?.signal instanceof AbortSignal);
});

test("a pull that never sends a first line is bounded too (0 % done)", async () => {
  const { deps, ctx } = setup();
  ctx.manifest.waits.modelPullIdleMs = IDLE_MS;
  scriptedPull(deps, [{ after: 2000, text: ndjson({ status: "success" }) }]);
  const result = await model(ctx, deps);
  assert.ok(!result.ok);
  assert.match(result.error, /\(0 % done\)/);
});

test("after a `verifying sha256 digest` line a silence longer than the bound is not cut: Ollama reads the layers then", async () => {
  const { deps, ctx } = setup();
  ctx.manifest.waits.modelPullIdleMs = IDLE_MS;
  scriptedPull(deps, [
    { after: 0, text: ndjson({ status: "pulling aaa", digest: "sha256:aaa", total: 100, completed: 100 }) },
    { after: 10, text: ndjson({ status: "verifying sha256 digest" }) },
    { after: IDLE_MS * 4, text: ndjson({ status: "writing manifest" }) },
    { after: 10, text: ndjson({ status: "success" }) },
  ]);
  const result = await model(ctx, deps);
  assert.deepEqual(result, { ok: true, detail: "Model gemma4:12b pulled." });
});

test("a body that throws, and a fetch that throws, fail with the pull's words and the resume hint, never as a raw throw", async () => {
  const cut = setup();
  scriptedPull(cut.deps, [{ after: 0, fail: new Error("The socket connection was closed unexpectedly.") }]);
  const broken = await model(cut.ctx, cut.deps);
  assert.ok(!broken.ok);
  assert.equal(broken.error, "The pull of gemma4:12b stopped: The socket connection was closed unexpectedly.");
  assert.match(broken.hint, /resume/);

  const refused = setup();
  const realFetch = refused.deps.fetch;
  refused.deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/api/pull")) throw new TypeError("fetch failed");
    return realFetch(input, init);
  }) as typeof fetch;
  const result = await model(refused.ctx, refused.deps);
  assert.ok(!result.ok);
  assert.match(result.error, /^The pull of gemma4:12b stopped: fetch failed$/);
});

test("the pull's stop text drops Bun's hint for programmers, as every other fetch error the player reads", async () => {
  const { deps, ctx } = setup();
  scriptedPull(deps, [{ after: 0, fail: new Error("The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()") }]);
  const result = await model(ctx, deps);
  assert.ok(!result.ok);
  assert.equal(result.error, "The pull of gemma4:12b stopped: The socket connection was closed unexpectedly.");
});

test("when the connection honours the abort (a real fetch), the idle failure is still the one named, not the abort's message", async () => {
  const { deps, ctx } = setup();
  ctx.manifest.waits.modelPullIdleMs = IDLE_MS;
  const realFetch = deps.fetch;
  deps.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).endsWith("/api/pull")) return realFetch(input, init);
    return new Response(new ReadableStream({ start(controller) { init?.signal?.addEventListener("abort", () => controller.error(new DOMException("The operation was aborted.", "AbortError"))); } }));
  }) as typeof fetch;
  const result = await model(ctx, deps);
  assert.ok(!result.ok);
  assert.match(result.error, /^Ollama sent nothing for /);
});

function modelStore(folder: string, relative: string): string {
  const file = join(folder, "manifests", relative);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "{}");
  return folder;
}

test("modelOnDisk finds the manifest file of the manifest's model: library/<name>/<tag>, latest for no tag, a namespace and a host under registry.ollama.ai or as given", () => {
  const cases: [string, string][] = [
    ["gemma4:12b", "registry.ollama.ai/library/gemma4/12b"],
    ["gemma4", "registry.ollama.ai/library/gemma4/latest"],
    ["user/model:tag", "registry.ollama.ai/user/model/tag"],
    ["hf.co/user/model:Q4", "hf.co/user/model/Q4"],
  ];
  for (const [tag, file] of cases) {
    const { root, ctx } = setup({}, {}, "C:/ollama.exe", tag);
    const store = modelStore(join(dir.root, `store-${rootCount++}`), file);
    assert.equal(modelOnDisk(root, ctx.manifest, { OLLAMA_MODELS: store }), true, tag);
    assert.equal(modelOnDisk(root, ctx.manifest, { OLLAMA_MODELS: join(dir.root, "empty") }), false, `${tag}: another store`);
  }
});

test("modelOnDisk looks where our serve would: the recorded store of our own Ollama, else OLLAMA_MODELS, else <home>/.ollama/models", () => {
  const file = "registry.ollama.ai/library/gemma4/12b";
  const recorded = modelStore(join(dir.root, `store-${rootCount++}`), file);
  const fromEnv = modelStore(join(dir.root, `store-${rootCount++}`), file);
  const home = join(dir.root, `home-${rootCount++}`);
  modelStore(join(home, ".ollama", "models"), file);
  const empty = join(dir.root, "empty");

  const ours = setup({}, { ollama: "installed", ollamaModels: recorded });
  assert.equal(modelOnDisk(ours.root, ours.ctx.manifest, { OLLAMA_MODELS: empty }, empty), true, "recorded store wins over the environment");

  const ownedEmpty = setup({}, { ollama: "installed", ollamaModels: empty });
  assert.equal(modelOnDisk(ownedEmpty.root, ownedEmpty.ctx.manifest, { OLLAMA_MODELS: fromEnv }, home), false, "an own store that lacks the model is not the environment's");

  const players = setup({}, { ollama: "preexisting", ollamaModels: empty });
  assert.equal(modelOnDisk(players.root, players.ctx.manifest, { OLLAMA_MODELS: fromEnv }, empty), true, "a player's Ollama keeps the player's store: the environment");
  assert.equal(modelOnDisk(players.root, players.ctx.manifest, {}, home), true, "no variable: the home folder's store");
  assert.equal(modelOnDisk(players.root, players.ctx.manifest, {}, empty), false);

  const otherTag = modelStore(join(dir.root, `store-${rootCount++}`), "registry.ollama.ai/library/gemma4/27b");
  assert.equal(modelOnDisk(players.root, players.ctx.manifest, { OLLAMA_MODELS: otherTag }, empty), false, "another tag of the same model is not this model");
});

test("a `success` line ends the bound: a connection that stays open after it is not a stalled pull (review W10d 2)", async () => {
  const { deps, ctx } = setup();
  ctx.manifest.waits.modelPullIdleMs = IDLE_MS;
  scriptedPull(deps, [
    { after: 0, text: ndjson({ status: "pulling aaa", digest: "sha256:aaa", total: 100, completed: 100 }) },
    { after: 0, text: ndjson({ status: "success" }) },
    { after: IDLE_MS * 4, text: "" },
  ]);
  assert.deepEqual(await model(ctx, deps), { ok: true, detail: "Model gemma4:12b pulled." });
});

test("progress lines that repeat the same bytes do not keep the bound alive: a download that does not move ends as a stalled pull (review W10d 1)", async () => {
  const { deps, ctx } = setup();
  ctx.manifest.waits.modelPullIdleMs = IDLE_MS;
  const same = ndjson({ status: "pulling aaa", digest: "sha256:aaa", total: 100, completed: 50 });
  scriptedPull(deps, [{ after: 0, text: same }, ...Array.from({ length: 10 }, () => ({ after: 20, text: same })), { after: 20, text: ndjson({ status: "success" }) }]);
  const result = await model(ctx, deps);
  assert.ok(!result.ok);
  assert.match(result.error, /^Ollama sent nothing for .* \(50 % done\)\.$/);
});
