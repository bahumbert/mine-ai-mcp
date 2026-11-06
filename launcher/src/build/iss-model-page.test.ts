// The Inno Setup script (packaging/windows/mine-ai.iss), the AI model page and the texts of the other option pages: the wording of the
// server and endpoint options, the EULA page's layout, the GPU text that says the model is installed, and the disk-space text.
// Pascal is not run: each test reads the script's code (iss-test-support.ts) for what must hold.
import assert from "node:assert/strict";
import test from "node:test";
import { code, codeFunctions, doc, functionBody } from "./iss-test-support.ts";

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

// T11 (owner 2026-11-06): the disk figures count the downloads and installs only; the player is told what they do not count.
const ROOM_WARNING_PARTS = [/downloads and installs only/u, /Ollama's own installer also needs temporary room on the Windows drive \(C:\)/u, /bots' memories and worlds grow as they play/u, /keep several GB free/u] as const;

test("the room warning says what the setup does not count, in one constant that the model page, the Ready list and the silent log share", () => {
  const constant = /ROOM_WARNING_TEXT = ((?:'(?:[^']|'')*'\s*\+?\s*)+);/u.exec(code)?.[1];
  assert.notEqual(constant, undefined, "the .iss has no ROOM_WARNING_TEXT constant");
  const text = constant!.replace(/'\s*\+\s*'/gu, "").replace(/''/gu, "'");
  for (const part of ROOM_WARNING_PARTS) assert.match(text, part);
  assert.match(functionBody("CreateModelPage"), /AddText\(ModelPage, ROOM_WARNING_TEXT, /u);
  // After the Ready list's model and server lines, whichever branch they took (first install or update).
  assert.match(functionBody("UpdateReadyMemo"), /else\s+Result := Result[^\n]*\n\s*Result := Result \+ NewLine \+ NewLine \+ 'Disk room:' \+ NewLine \+ Space \+ ROOM_WARNING_TEXT;/u);
  // Silent: logged, never a box (nobody reads the page).
  const silent = functionBody("ApplySilentParameters");
  assert.match(silent, /Log\('Disk room: ' \+ ROOM_WARNING_TEXT\)/u);
  assert.doesNotMatch(silent, /MsgBox/u);
});

test("the room warning has its own place on the model page: under the remote choice, above the step status and the gauge, none overlapping", () => {
  const page = functionBody("CreateModelPage");
  const place = (call: string) => {
    const match = new RegExp(`${call}, (\\d+)(?:, (\\d+))?\\)`, "u").exec(page);
    assert.notEqual(match, null, `${call} is not placed with a number`);
    return { top: Number(match![1]), height: Number(match![2] ?? 0) };
  };
  const remote = /ModelRemoteRadio := AddRadio\(ModelPage, '[^\n]*', (\d+)\)/u.exec(page);
  const warning = place("AddText\\(ModelPage, ROOM_WARNING_TEXT");
  const status = place("ModelStepStatus := AddText\\(ModelPage, ''");
  const gauge = place("ModelGauge := AddGauge\\(ModelPage");
  assert.ok(remote !== null && Number(remote[1]) + 20 <= warning.top, "the warning overlaps the remote radio");
  assert.ok(warning.top + warning.height <= status.top, "the warning overlaps the step status");
  assert.ok(status.top + status.height <= gauge.top, "the step status overlaps the gauge");
  // The endpoint page already reaches a gauge at 270: nothing on the model page goes lower.
  assert.ok(gauge.top <= 270, "the model page goes lower than the endpoint page's gauge");
});

test("the doc's disk part says the same as the wizard: the setup counts downloads and installs, Ollama's installer needs room on C:, the bots' memories grow", () => {
  const section = doc.slice(doc.indexOf("## Disk space"), doc.indexOf("## The Minecraft server"));
  assert.ok(section.length > 0, "the doc has no section \"Disk space\" before \"The Minecraft server\"");
  for (const part of ROOM_WARNING_PARTS) assert.match(section, part);
});
