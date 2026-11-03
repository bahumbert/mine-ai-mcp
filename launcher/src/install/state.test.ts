import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { after } from "node:test";
import { tempDataRoot } from "./fixtures/install-test-support.ts";
import { loadInstallState, saveInstallState } from "./state.ts";

const dir = tempDataRoot();
after(() => dir.remove());
const stateFile = (root: string) => join(root, "install-state.json");

test("a missing install-state.json is an empty state: nothing was installed by us", () => {
  assert.deepEqual(loadInstallState(join(dir.root, "fresh")), {});
});

test("a saved state loads back, and saving creates the data root", () => {
  const root = join(dir.root, "not-yet-created");
  saveInstallState(root, { ollama: "preexisting", modelPulledByUs: false });
  assert.deepEqual(loadInstallState(root), { ollama: "preexisting", modelPulledByUs: false });
});

test("keys of a newer launcher survive a load and save", () => {
  const root = join(dir.root, "unknown-keys");
  saveInstallState(root, { ollama: "installed" });
  const file = stateFile(root);
  writeFileSync(file, JSON.stringify({ ollama: "installed", futureThing: { a: 1 } }));
  saveInstallState(root, { ...loadInstallState(root), modelPulledByUs: true });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { ollama: "installed", futureThing: { a: 1 }, modelPulledByUs: true });
});

test("a corrupt file fails with its path and is never replaced (it may be the only record of what is ours)", () => {
  const root = join(dir.root, "corrupt");
  saveInstallState(root, {});
  writeFileSync(stateFile(root), "{ not json");
  assert.throws(() => loadInstallState(root), (error: Error) => error.message.includes(stateFile(root)));
  assert.equal(readFileSync(stateFile(root), "utf8"), "{ not json");
});

test("a file with a wrong value fails with its path and the zod issue", () => {
  const root = join(dir.root, "wrong-value");
  saveInstallState(root, {});
  writeFileSync(stateFile(root), JSON.stringify({ ollama: "borrowed" }));
  assert.throws(() => loadInstallState(root), (error: Error) => error.message.includes(stateFile(root)) && error.message.includes("ollama"));
});

test("saving leaves no temporary file behind", () => {
  const root = join(dir.root, "no-leftover");
  saveInstallState(root, { ollama: "installed" });
  assert.deepEqual(readdirSync(root), ["install-state.json"]);
  assert.equal(existsSync(`${stateFile(root)}.tmp`), false);
});

test("the Ollama we installed and our model store round-trip, and a file from before W7 without them loads as it was", () => {
  const root = join(dir.root, "folders");
  const chosen = { ollama: "installed", ollamaPath: "D:\\Apps\\Ollama é\\ollama.exe", ollamaModels: "D:\\Mine AI data\\models" } as const;
  saveInstallState(root, chosen);
  assert.deepEqual(loadInstallState(root), chosen);
  writeFileSync(stateFile(root), JSON.stringify({ ollama: "installed", modelPulledByUs: true }));
  assert.deepEqual(loadInstallState(root), { ollama: "installed", modelPulledByUs: true });
});

test("a recorded folder that is not text fails with its path", () => {
  const root = join(dir.root, "folders-wrong");
  saveInstallState(root, {});
  writeFileSync(stateFile(root), JSON.stringify({ ollamaPath: 5 }));
  assert.throws(() => loadInstallState(root), (error: Error) => error.message.includes(stateFile(root)) && error.message.includes("ollamaPath"));
});
