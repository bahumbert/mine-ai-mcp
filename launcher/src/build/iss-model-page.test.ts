// The Inno Setup script (packaging/windows/mine-ai.iss), the AI model page and the texts of the other option pages: the wording of the
// server and endpoint options, the EULA page's layout, the GPU text that says the model is installed, and the disk-space text.
// Pascal is not run: each test reads the script's code (iss-test-support.ts) for what must hold.
import assert from "node:assert/strict";
import test from "node:test";
import { code, codeFunctions, functionBody } from "./iss-test-support.ts";

// Findings 6c, 6d, 6f: wording and the EULA page's layout.
test("the server and endpoint options say what they do, and the EULA check box has room above and below", () => {
  assert.match(code, /'Install a Minecraft server on this PC \(only this PC can join, by default\)'/u);
  assert.match(code, /'On a remote OpenAI-compatible API \(OpenRouter, your own server\.\.\.\)'/u);
  assert.match(code, /'Endpoint URL \(for example https:\/\/openrouter\.ai\/api\/v1\)'/u);
  assert.doesNotMatch(code, /reachable from this PC only/u);
  const eula = functionBody("CreateEulaPage");
  assert.match(eula, /EulaCheck\.Top := ScaleY\(86\)/u);
  assert.match(eula, /EulaCheck\.Height := ScaleY\(24\)/u);
});

// Finding 6e: `install gpu` now says whether the model is already there (W10d's `modelInstalled` and `model`); absent = false.
test("the model page says the model is installed when install gpu says so, and keeps today's caption when the field is absent", () => {
  const gpu = functionBody("CheckGpuOnce");
  assert.match(gpu, /JsonIsTrue\(Json, 'modelInstalled'\)/u);
  assert.match(gpu, /On this PC \(uses the Ollama and the AI model already installed\)/u);
  assert.match(gpu, /The AI model ' \+ JsonString\(Json, 'model'\) \+ ' is already installed\./u);
  assert.match(gpu, /On this PC \(uses the Ollama already installed; downloads the AI model if it is missing\)/u);
});

test("`install disk` is run by the model page's disk text only, after `install gpu`, not in a silent install, with --no-model when the local model is not offered", () => {
  assert.deepEqual([...codeFunctions()].filter(([, body]) => body.includes("'install disk")).map(([name]) => name), ["ShowDiskSpace"]);
  const gpu = functionBody("CheckGpuOnce");
  assert.ok(gpu.indexOf("'install gpu'") >= 0 && gpu.indexOf("ShowDiskSpace()") > gpu.indexOf("'install gpu'"), "the disk text comes after the GPU text");
  assert.match(gpu, /if not WizardSilent then\s+ShowDiskSpace\(\);/u);
  const disk = functionBody("ShowDiskSpace");
  assert.match(disk, /DiskStatus\.Caption := 'Checking disk space\.\.\.'/u);
  assert.match(disk, /if not ModelLocalRadio\.Enabled then\s+Args := Args \+ ' --no-model'/u);
  assert.match(disk, /JsonString\(Json, 'detail'\)/u);
  // A run that failed shows nothing.
  assert.match(disk, /else\s+DiskStatus\.Caption := '';/u);
});
