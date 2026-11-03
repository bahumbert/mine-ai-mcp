// What the ordered stop says (plan one-click-installer W10b, finding 3): a line per step in launcher.log and on every console.
import assert from "node:assert/strict";
import test from "node:test";
import { hostHealth, json, stackFixture, startedFixture } from "./stack-test-support.ts";
import { startStack, stopStack } from "./stack.ts";

test("stopStack says why it stops, each bot, the saved world, Ollama and how long it took, in order, and nothing on a second call", async () => {
  const { fixture, state } = await startedFixture((settings) => ({ ...settings, bots: ["ayla", "brea"] }));
  fixture.network.route("POST", `${fixture.ollamaUrl}/api/generate`, () => {
    fixture.clock.time += 12_000; // the model unload takes 12 s
    return json({ done: true });
  });
  fixture.said.length = 0;
  await Promise.all([stopStack(state, "Ctrl+C"), stopStack(state, "mine-ai stop")]);
  assert.deepEqual(fixture.said, [
    "Stopping Mine AI (Ctrl+C)...",
    "Ayla stopped.",
    "Brea stopped.",
    "The Minecraft server saved the world and stopped.",
    "Ollama stopped.",
    "Mine AI stopped (12 s).",
  ]);
  await stopStack(state, "again");
  assert.equal(fixture.said.length, 6);
});

test("a server that ignores its stop line is named as ended, with the wait and the warning about the world", async () => {
  const fixture = stackFixture();
  fixture.children.script("server", { lines: ['[12:00:00] [Server thread/INFO]: Done (3.2s)! For help, type "help"'], ignoresStop: true });
  hostHealth(fixture, 25_575);
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  fixture.said.length = 0;
  await stopStack(state, "mine-ai stop");
  const seconds = fixture.manifest.waits.serverStopMs / 1_000;
  assert.ok(fixture.said.includes(`The Minecraft server did not stop within ${seconds} s and was ended; the world may not be saved.`), fixture.said.join(" | "));
  assert.ok(!fixture.said.some((line) => line.includes("saved the world")));
  assert.match(fixture.said.at(-1)!, /^Mine AI stopped \(\d+ s\)\.$/u);
});

test("a server that ends with another code than 0 on its stop line is not said to have saved the world, and the code is named", async () => {
  const fixture = stackFixture();
  fixture.children.script("server", { lines: ['[12:00:00] [Server thread/INFO]: Done (3.2s)! For help, type "help"'], stopExitCode: 1 });
  hostHealth(fixture, 25_575);
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  fixture.said.length = 0;
  await stopStack(state, "mine-ai stop");
  assert.ok(fixture.said.includes("The Minecraft server ended with code 1 while stopping: its last save may be missing."), fixture.said.join(" | "));
  assert.ok(!fixture.said.some((line) => line.includes("saved the world")));
});

test("a server that ends by a signal on its stop line is named by the signal, not by a code it does not have", async () => {
  const fixture = stackFixture();
  fixture.children.script("server", { lines: ['[12:00:00] [Server thread/INFO]: Done (3.2s)! For help, type "help"'], stopSignal: "SIGTERM" });
  hostHealth(fixture, 25_575);
  const state = await startStack(fixture.settings, fixture.manifest, fixture.children, fixture.root, fixture.deps);
  fixture.said.length = 0;
  await stopStack(state, "mine-ai stop");
  assert.ok(fixture.said.includes("The Minecraft server ended with signal SIGTERM while stopping: its last save may be missing."), fixture.said.join(" | "));
});

test("a stack with a remote model says nothing about Ollama when it stops", async () => {
  const { fixture, state } = await startedFixture((settings) => ({ ...settings, llm: { kind: "remote", baseUrl: "https://api.example.test/v1", apiKey: "sk-1", model: "big-model" } }));
  fixture.said.length = 0;
  await stopStack(state, "mine-ai stop");
  assert.ok(!fixture.said.some((line) => line.includes("Ollama")), fixture.said.join(" | "));
});

test("an Ollama that ended by itself before the stop is not said to be stopped", async () => {
  const { fixture, state } = await startedFixture();
  fixture.children.crash("ollama", 1);
  fixture.said.length = 0;
  await stopStack(state, "mine-ai stop");
  assert.ok(!fixture.said.some((line) => line.includes("Ollama")), fixture.said.join(" | "));
});
