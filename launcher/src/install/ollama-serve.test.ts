import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after } from "node:test";
import { monotonicNow } from "../clocks.ts";
import { fakeOllama } from "./fixtures/fake-ollama.ts";
import { tempDataRoot, testManifest } from "./fixtures/install-test-support.ts";
import { ollamaServeEnv, startServeProcess, withOurOllamaServe } from "./ollama-serve.ts";

const manifest = testManifest();
const dir = tempDataRoot();
after(() => dir.remove());
/** A data root with no install-state.json: nothing of ours is installed. */
const noState = join(dir.root, "no-state");

test("ollamaServeEnv is the manifest env, the host and port, and our model store only when one is recorded for an Ollama of ours (a player's Ollama keeps its own store)", () => {
  const withoutStore = ollamaServeEnv(manifest, 11436, {});
  assert.deepEqual(withoutStore, { OLLAMA_NUM_PARALLEL: "3", OLLAMA_HOST: "127.0.0.1:11436" });
  const store = "D:\\Mine AI é\\models";
  assert.deepEqual(ollamaServeEnv(manifest, 11436, { ollama: "installed", ollamaModels: store }), { ...withoutStore, OLLAMA_MODELS: store });
  assert.deepEqual(ollamaServeEnv(manifest, 11436, { ollamaModels: store }), withoutStore);
  assert.deepEqual(ollamaServeEnv(manifest, 11436, { ollama: "preexisting", ollamaModels: store }), withoutStore);
});

test("our serve starts on the manifest port with the manifest env, the work runs, then the serve is killed", async () => {
  const ollama = fakeOllama();
  const seen = await withOurOllamaServe("C:/ollama.exe", manifest, noState, async (serve) => serve.baseUrl, ollama.deps);
  assert.equal(seen, "http://127.0.0.1:11435");
  assert.equal(ollama.started.length, 1);
  assert.equal(ollama.started[0].exe, "C:/ollama.exe");
  assert.equal(ollama.started[0].env.OLLAMA_HOST, "127.0.0.1:11435");
  assert.equal(ollama.started[0].env.OLLAMA_NUM_PARALLEL, "3");
  assert.equal(ollama.killed, 1);
});

test("an Ollama already answering on our port is reused and never killed (it may be a player's or a running launcher's)", async () => {
  const ollama = fakeOllama({ alreadyUp: true });
  const reused = await withOurOllamaServe("C:/ollama.exe", manifest, noState, async (serve) => serve.reused, ollama.deps);
  assert.equal(reused, true);
  assert.equal(ollama.started.length, 0);
  assert.equal(ollama.killed, 0);
});

test("a serve that never answers fails after waits.ollamaUpMs naming the port and the log, and is killed", async () => {
  const ollama = fakeOllama({ neverAnswers: true, output: "level=ERROR msg=\"bind failed\"" });
  await assert.rejects(
    withOurOllamaServe("C:/ollama.exe", manifest, noState, async () => "unreachable", ollama.deps),
    (error: Error) => error.message.includes("11435") && error.message.includes("bind failed"),
  );
  assert.equal(ollama.killed, 1);
});

test("a serve that exits before answering fails with its exit code and last output instead of waiting out the timeout", async () => {
  const ollama = fakeOllama({ exitsWith: 3, output: "Error: listen tcp 127.0.0.1:11435: bind: address already in use" });
  const started = monotonicNow();
  await assert.rejects(
    withOurOllamaServe("C:/ollama.exe", testManifest({}, { ollamaUpMs: 60_000 }), noState, async () => "unreachable", ollama.deps),
    (error: Error) => error.message.includes("code 3") && error.message.includes("address already in use"),
  );
  assert.ok(monotonicNow() - started < 5_000);
});

test("the serve is killed when the work throws", async () => {
  const ollama = fakeOllama();
  await assert.rejects(
    withOurOllamaServe("C:/ollama.exe", manifest, noState, async () => Promise.reject(new Error("pull broke")), ollama.deps),
    /pull broke/,
  );
  assert.equal(ollama.killed, 1);
});

test("the real process adapter collects stdout and stderr and its kill ends the process", async () => {
  const script = 'console.log("out line"); console.error("err line"); setInterval(() => {}, 1000);';
  const serve = startServeProcess(process.execPath, {}, ["-e", script]);
  let text = "";
  serve.onOutput((chunk) => (text += chunk));
  const deadline = monotonicNow() + 10_000;
  while (!(text.includes("out line") && text.includes("err line")) && monotonicNow() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.match(text, /out line/);
  assert.match(text, /err line/);
  serve.kill();
  await serve.exited;
});
