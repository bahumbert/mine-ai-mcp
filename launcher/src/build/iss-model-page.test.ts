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

// ---------- T19 (wizard walk of build 1f2b723, F1): one writer of the model radios, written once on the verdict ----------
// The model page opened on the remote radio although the local one was checked from code: the checked-from-code radio did not hold the
// focus, and the focused one re-checked itself when the window got its focus back. The choice is written once (ApplyModelChoice, on the
// verdict) and a visit to a page only moves the focus to the radio already checked (FocusCheckedRadio, never a write).

const MODEL_RADIO_WRITE = /\bModel(?:Local|Remote)Radio\.Checked\s*:=/u;
/** The routines that may write the two model radios: the one writer, the radio's creation default, a new verdict, and the silent path's parameters. */
const MODEL_RADIO_WRITERS = ["ApplyModelChoice", "ApplySilentParameters", "SilentLocalModelFailure", "SilentSetupFailure", "SwitchToRemoteAfterOllama", "CreateModelPage"];

test("only ApplyModelChoice, a new verdict, the silent path and the radios' creation write the model radios; a page change never writes a .Checked", () => {
  const writers = [...codeFunctions()].filter(([, body]) => MODEL_RADIO_WRITE.test(body)).map(([name]) => name);
  assert.ok(writers.includes("ApplyModelChoice"), "no ApplyModelChoice writes the radios");
  assert.deepEqual(writers.filter((name) => !MODEL_RADIO_WRITERS.includes(name)), [], "a function outside the writers' list assigns a model radio's .Checked");
  assert.doesNotMatch(functionBody("CurPageChanged"), /\.Checked\s*:=/u);
});

test("ApplyModelChoice: local when the verdict allows it and the saved kind is not remote, remote otherwise; both radios set, focus moved, the Ollama folder row updated", () => {
  const apply = functionBody("ApplyModelChoice");
  assert.match(apply, /ModelLocalRadio\.Enabled and \(not PreviousLlmWasRemote\)/u);
  assert.match(apply, /ModelLocalRadio\.Checked := Local;/u);
  assert.match(apply, /ModelRemoteRadio\.Checked := not Local;/u);
  assert.match(apply, /FocusCheckedRadio\(ModelPage, ModelLocalRadio, ModelRemoteRadio, nil\);/u);
  assert.match(apply, /ModelChoiceChanged\(nil\);/u);
  assert.ok(apply.indexOf("FocusCheckedRadio(") > apply.indexOf("Checked :="), "the focus moves before the radios are set: it would go to a radio about to be unchecked");
});

test("FocusCheckedRadio moves the focus to the radio already checked when its page is the current page, and never writes a .Checked", () => {
  const focus = functionBody("FocusCheckedRadio");
  assert.match(focus, /WizardForm\.CurPageID <> Page\.ID then\s+Exit;/u);
  // All three radios are looked at: dropping the third leaves the server page's "use an existing server" unfocused.
  assert.match(focus, /if First\.Checked then\s+Checked := First\s+else if Second\.Checked then\s+Checked := Second\s+else if \(Third <> nil\) and Third\.Checked then\s+Checked := Third;/u);
  assert.match(focus, /WizardForm\.ActiveControl := Checked;/u);
  // A disabled control cannot take the focus (Delphi raises): the local radio is disabled when the verdict is remote.
  assert.match(focus, /Checked\.Enabled/u);
  assert.doesNotMatch(focus, /\.Checked\s*:=/u);
});

test("CheckGpuOnce makes the choice once, in each branch, before the disk text runs while the window answers clicks; it no longer reads the saved kind", () => {
  const gpu = functionBody("CheckGpuOnce");
  const calls = [...gpu.matchAll(/ApplyModelChoice\(\);/gu)].map((match) => match.index!);
  assert.equal(calls.length, 2, "ApplyModelChoice is not called once in each branch");
  const failed = gpu.indexOf("GpuProblem := StepFailureText(Json);");
  assert.ok(calls[0]! < failed && calls[1]! > failed, "the two calls are not one in each branch");
  assert.ok(calls[1]! < gpu.indexOf("ShowDiskSpace()"), "the choice is made after the disk text starts: a click on remote during it would be overwritten");
  assert.doesNotMatch(gpu, /PreviousLlmWasRemote/u);
  assert.match(gpu, /if GpuChecked then\s+Exit;/u);
});

test("a visit to the model page or the server page only moves the focus to the radio already checked", () => {
  const changed = functionBody("CurPageChanged");
  assert.match(changed, /CheckGpuOnce\(\);\s+FocusCheckedRadio\(ModelPage, ModelLocalRadio, ModelRemoteRadio, nil\);/u);
  assert.match(changed, /FocusCheckedRadio\(ServerPage, ServerNoneRadio, ServerLocalRadio, ServerRemoteRadio\);/u);
});

test("PrefillFromSettings resets what it may not set before it reads the file, and finishes the same way whether or not a file was found", () => {
  const prefill = functionBody("PrefillFromSettings");
  const read = prefill.indexOf("ReadSettingsSections(");
  assert.ok(read > 0);
  for (const reset of ["PreviousLlmWasRemote := False;", "RemoteUrlEdit.Text := '';", "RemoteModelCombo.Text := '';", "ServerNoneRadio.Checked := True;", "ServerHostEdit.Text := '';", "ServerPortEdit.Text := IntToStr(DEFAULT_SERVER_PORT);"]) {
    const at = prefill.indexOf(reset);
    assert.ok(at >= 0 && at < read, `${reset} is not before the file is read`);
  }
  // No early Exit: a missing file leaves the creation defaults, with the server boxes enabled to match and the key caption set.
  assert.doesNotMatch(prefill, /\bExit;/u);
  for (const finish of ["ServerChoiceChanged(nil);", "ShowKeyLabel();"]) assert.ok(prefill.lastIndexOf(finish) > read, `${finish} does not run after the read`);
  assert.match(prefill, /if ReadSettingsSections\(Llm, Server\) then\s+begin/u);
  assert.match(prefill, /end;\s+ServerChoiceChanged\(nil\);\s+ShowKeyLabel\(\);\s+end;\s*$/u);
});

test("the server port's default is one constant: the server page, the prefill's reset and the configure fallback share it", () => {
  assert.match(code, /DEFAULT_SERVER_PORT = 25565;/u);
  // The text of JoinText ("normally 25565") is words for the player, not a default.
  assert.doesNotMatch(code, /'25565'|StrToIntDef\([^\n]*, 25565\)/u, "a default port is spelled outside the constant");
  assert.match(functionBody("CreateServerPage"), /ServerPortEdit\.Text := IntToStr\(DEFAULT_SERVER_PORT\);/u);
  assert.match(functionBody("ConfigureArguments"), /StrToIntDef\(Trim\(ServerPortEdit\.Text\), DEFAULT_SERVER_PORT\)/u);
});

test("the doc's disk part says the same as the wizard: the setup counts downloads and installs, Ollama's installer needs room on C:, the bots' memories grow", () => {
  const section = doc.slice(doc.indexOf("## Disk space"), doc.indexOf("## The Minecraft server"));
  assert.ok(section.length > 0, "the doc has no section \"Disk space\" before \"The Minecraft server\"");
  for (const part of ROOM_WARNING_PARTS) assert.match(section, part);
});
