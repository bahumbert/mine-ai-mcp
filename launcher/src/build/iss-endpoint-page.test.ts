// The Inno Setup script (packaging/windows/mine-ai.iss), the endpoint page and the key box (the code of packaging/windows/endpoint-page.iss
// and the functions around it): the page's place in the wizard, the endpoint test and the model list, the /v1 notice, the combo box
// filter, Ollama on another PC, the saved key that never reaches a command line, the encryption notice, and the player doc's section.
// Pascal is not run: each test reads the script's code (iss-test-support.ts) for what must hold.
import assert from "node:assert/strict";
import test from "node:test";
import { code, codeFunctions, doc, functionBody, iss } from "./iss-test-support.ts";

// ---------- T4a: the endpoint page, the model list, the /v1 notice (spec D4) ----------

test("the endpoint page comes right after the model page, the server page after it, and the page is skipped for the local model and in a silent install", () => {
  assert.match(functionBody("CreateEndpointPage"), /EndpointPage := CreateCustomPage\(ModelPage\.ID, /u);
  assert.match(functionBody("CreateServerPage"), /ServerPage := CreateCustomPage\(EndpointPage\.ID, /u);
  const order = functionBody("InitializeWizard");
  assert.ok(order.indexOf("CreateModelPage()") < order.indexOf("CreateEndpointPage()") && order.indexOf("CreateEndpointPage()") < order.indexOf("CreateServerPage()"));
  const skip = functionBody("ShouldSkipPage");
  assert.match(skip, /WizardSilent and \([^\n]*PageID = EndpointPage\.ID/u);
  assert.match(skip, /if PageID = EndpointPage\.ID then\s+Result := Result or \(not ModelRemoteRadio\.Checked\)/u);
});

test("the endpoint is saved and tested on the endpoint page's Next, never on the model page's: the model page's Next goes on with the remote choice", () => {
  const next = functionBody("NextButtonClick");
  assert.match(next, /CurPageID = EndpointPage\.ID then\s+Result := AcceptRemoteEndpoint\(\)/u);
  assert.deepEqual([...codeFunctions()].filter(([, body]) => body.includes("AcceptRemoteEndpoint(")).map(([name]) => name).sort(), ["NextButtonClick"]);
  const modelPageBranch = next.slice(next.indexOf("CurPageID = ModelPage.ID"), next.indexOf("CurPageID = EndpointPage.ID"));
  assert.doesNotMatch(modelPageBranch, /AcceptRemoteEndpoint/u);
  assert.match(modelPageBranch, /if not ModelRemoteRadio\.Checked then\s+Result := AcceptLocalModel\(\)/u);
});

test("the model name is a drop-down combo box on the endpoint page; no RemoteModelEdit is left, the silent parameter and the prefill fill the combo", () => {
  assert.doesNotMatch(iss, /RemoteModelEdit/u);
  assert.match(code, /RemoteModelCombo: TNewComboBox/u);
  assert.match(functionBody("CreateEndpointPage"), /RemoteModelCombo\.Style := csDropDown/u);
  assert.match(functionBody("ApplySilentParameters"), /RemoteModelCombo\.Text := Param\('LLMMODEL', ''\)/u);
  assert.match(functionBody("PrefillFromSettings"), /RemoteModelCombo\.Text := JsonString\(Llm, 'model'\)/u);
});

test("the endpoint test and the model list run on the endpoint page's own gauge and status, never the model page's", () => {
  for (const name of ["SaveAndTestEndpoint", "AcceptRemoteEndpoint", "ListModels"]) {
    const body = functionBody(name);
    assert.match(body, /EndpointStepStatus/u, name);
    assert.doesNotMatch(body, /ModelGauge|ModelStepStatus/u, name);
  }
  assert.match(functionBody("SaveAndTestEndpoint"), /EndpointGauge/u);
  assert.match(functionBody("ListModels"), /EndpointGauge/u);
});

test("the /v1 correction is read after both endpoint steps: the corrected URL goes in the URL box before any configure, the notice is logged and shown once", () => {
  const apply = functionBody("ApplyEndpointCorrection");
  assert.match(apply, /JsonString\(Json, 'correctedUrl'\)/u);
  assert.match(apply, /JsonString\(Json, 'notice'\)/u);
  assert.match(apply, /RemoteUrlEdit\.Text := /u);
  assert.match(apply, /Log\(/u);
  assert.match(apply, /SuppressibleMsgBox\(Notice, mbInformation, MB_OK, IDOK\)/u);
  assert.match(apply, /if not WizardSilent then\s+SuppressibleMsgBox/u);
  for (const [name, step] of [["SaveAndTestEndpoint", "install endpoint-test"], ["ListModels", "install endpoint-models"]] as const) {
    const body = functionBody(name);
    const ran = body.indexOf(`'${step}`);
    assert.ok(ran >= 0, `${name} does not run ${step}`);
    assert.ok(body.indexOf("ApplyEndpointCorrection(Json)") > ran, `${name} does not read the correction after ${step}`);
  }
  // On a failure the launcher's error already starts with the notice: the failure text is shown without it, so the player reads it once.
  assert.match(functionBody("SaveAndTestEndpoint"), /WithoutNotice\(StepFailureText\(Json\), JsonString\(Json, 'notice'\)\)/u);
  assert.match(functionBody("ListModels"), /WithoutNotice\(/u);
});

test("the endpoint page's inputs are off while a launcher run is in progress, so no click starts a second run over the same step-result file", () => {
  assert.match(functionBody("SetEndpointControlsEnabled"), /ListModelsButton\.Enabled := Enabled;[\s\S]*RemoteUrlEdit\.Enabled := Enabled;[\s\S]*RemoteKeyEdit\.Enabled := Enabled;[\s\S]*RemoteModelCombo\.Enabled := Enabled;/u);
  for (const name of ["AcceptRemoteEndpoint", "ListModels"]) {
    const body = functionBody(name);
    assert.ok(body.indexOf("SetEndpointControlsEnabled(False)") >= 0 && body.indexOf("SetEndpointControlsEnabled(False)") < body.indexOf("SetEndpointControlsEnabled(True)"), name);
  }
});

test("the model list: the stale list file is deleted before each run and read only when the step succeeded; the key is always given; a failure shows the step's text in the list status without a box", () => {
  const list = functionBody("ListModels");
  assert.ok(list.includes("DeleteFile(ModelListFile())") && list.indexOf("DeleteFile(ModelListFile())") < list.indexOf("'install endpoint-models"), "the stale file is not deleted before the run");
  // A key option is always given, even for an empty key: without one the launcher falls back to the settings' key (endpoint-models.ts).
  assert.match(list, /'install endpoint-models --url ' \+ Quoted\(Trim\(RemoteUrlEdit\.Text\)\) \+ ListKeyArguments\(\)/u);
  assert.match(list, /' --list ' \+ Quoted\(ModelListFile\(\)\)/u);
  assert.match(list, /RemoteUrlProblem\(\)/u);
  assert.doesNotMatch(list, /RemoteFieldProblem/u, "listing must not demand the model name it is there to find");
  assert.match(list, /if Listed and LoadModelList\(\) then/u);
  assert.match(list, /ListStatus\.Caption := WithoutNotice\(StepFailureText\(Json\)/u);
  assert.doesNotMatch(list.slice(list.indexOf("ApplyEndpointCorrection")), /MsgBox\(/u, "a failed list is told in the list status only");
  assert.match(functionBody("LoadModelList"), /UTF8Decode\(Raw\)/u);
  assert.equal([...code.matchAll(/mine-ai-models\.txt/gu)].length, 1, "the list file's name is spelled once, in ModelListFile");
});

test("the combo box filter keeps what the player typed: the typed text is saved, the items refilled with the ids that contain the filter (case ignored), the text put back", () => {
  const fill = functionBody("FillModelCombo");
  const saved = fill.indexOf("Typed := RemoteModelCombo.Text");
  assert.ok(saved >= 0 && saved < fill.indexOf("Items.Clear") && fill.indexOf("Items.Clear") < fill.indexOf("RemoteModelCombo.Text := Typed"));
  assert.match(fill, /Lowercase\(/u);
  assert.match(functionBody("CreateEndpointPage"), /ModelFilterEdit\.OnChange := @FilterChanged/u);
  assert.match(functionBody("FilterChanged"), /FillModelCombo\(\)/u);
  assert.match(functionBody("CreateEndpointPage"), /RemoteModelCombo\.OnChange := @ModelComboChanged/u);
  assert.match(functionBody("ModelComboChanged"), /ModelInfoText\.Caption := /u);
});

test("Ollama on another PC: the fill button writes http://<IP>:11434/v1, empties the key and selects <IP>; Help... says what to set; a URL still holding < or > is refused before any call", () => {
  const fill = functionBody("FillOllamaOnAnotherPc");
  assert.match(fill, /RemoteUrlEdit\.Text := 'http:\/\/<IP>:11434\/v1'/u);
  assert.match(fill, /RemoteKeyEdit\.Text := ''/u);
  assert.match(fill, /SelStart := Pos\('<IP>', RemoteUrlEdit\.Text\) - 1/u);
  assert.match(fill, /SelLength := 4/u);
  const help = functionBody("ShowOllamaHelp");
  for (const part of ["OLLAMA_HOST=0.0.0.0:11434", "TCP port 11434", "Private networks only", "Ollama has no password", "Leave the key empty"]) assert.ok(help.includes(part), part);
  const problem = functionBody("RemoteUrlProblem");
  assert.match(problem, /\(Pos\('<', RemoteUrlEdit\.Text\) > 0\) or \(Pos\('>', RemoteUrlEdit\.Text\) > 0\)/u);
  assert.ok(problem.includes("Replace <IP> with the address of the PC that runs Ollama (for example 192.168.1.20)."));
  assert.match(functionBody("RemoteFieldProblem"), /RemoteUrlProblem\(\)/u);
});

// ---------- T4b: the saved key in the setup, the migration notice, the player doc (spec D3 "The setup never decrypts", D4(c)) ----------

test("the setup never reads a key: apiKey and apiKeyProtected are read in PrefillFromSettings only, and the box shows a mark when a blob is saved", () => {
  assert.deepEqual([...codeFunctions()].filter(([, body]) => /'apiKey/u.test(body)).map(([name]) => name), ["PrefillFromSettings"]);
  const prefill = functionBody("PrefillFromSettings");
  // Empty box and flag first, before the file is read: this also runs on the data page's Next, and a Back to another data folder must not keep the mark.
  const emptied = prefill.indexOf("RemoteKeyEdit.Text := '';");
  const cleared = prefill.indexOf("KeySaved := False;");
  const read = prefill.indexOf("ReadSettingsSections(");
  const wasCleared = prefill.indexOf("KeyWasSaved := False;");
  assert.ok(emptied >= 0 && cleared >= 0 && wasCleared >= 0 && emptied < read && cleared < read && wasCleared < read, "the box, KeySaved and KeyWasSaved are not reset before the file is read");
  // The mark first, the flags after it: an OnChange fired by the assignment must not leave the flag cleared.
  const mark = prefill.indexOf("RemoteKeyEdit.Text := SAVED_KEY_MARK;");
  const flag = prefill.indexOf("KeySaved := True;");
  const wasFlag = prefill.indexOf("KeyWasSaved := True;");
  assert.ok(mark > read && flag > mark && wasFlag > read, "KeySaved is set before the mark is in the box, or KeyWasSaved before the file is read");
  assert.match(prefill, /JsonString\(Llm, 'apiKeyProtected'\) <> ''/u);
  // The mark is the box's text and nothing else: it is read back by the prefill and the box's change handler, and the mark of a saved key reaches no launcher call (KeySaved gates the sending).
  assert.deepEqual([...codeFunctions()].filter(([, body]) => body.includes("SAVED_KEY_MARK")).map(([name]) => name).sort(), ["PrefillFromSettings", "RemoteKeyChanged"]);
});

test("a key typed in the box is sent; a key the setup did not touch is never on a command line: the box text goes to the launcher only behind a KeySaved test, in RemoteLlmArguments and ListKeyArguments", () => {
  const holders = [...codeFunctions()].filter(([, body]) => body.includes("Quoted(RemoteKeyEdit.Text)")).map(([name]) => name).sort();
  assert.deepEqual(holders, ["ListKeyArguments", "RemoteLlmArguments"]);
  assert.match(functionBody("RemoteLlmArguments"), /if KeySaved then\s+Result := '--llm-remote-saved-key ' \+ Quoted\(Trim\(RemoteUrlEdit\.Text\)\) \+ ' ' \+ Quoted\(Trim\(RemoteModelCombo\.Text\)\)\s+else\s+Result := '--llm-remote ' \+ Quoted\(Trim\(RemoteUrlEdit\.Text\)\) \+ ' ' \+ Quoted\(RemoteKeyEdit\.Text\)/u);
  assert.match(functionBody("ListKeyArguments"), /if KeySaved then\s+Result := ' --saved-key'\s+else\s+Result := ' --key ' \+ Quoted\(RemoteKeyEdit\.Text\)/u);
  // One builder of the configure's LLM part, used by the endpoint page's save and the progress page's save: no second `--llm-remote` spelling.
  assert.deepEqual([...codeFunctions()].filter(([, body]) => body.includes("'--llm-remote")).map(([name]) => name), ["RemoteLlmArguments"]);
  for (const name of ["SaveAndTestEndpoint", "ConfigureArguments"]) assert.match(functionBody(name), /RemoteLlmArguments\(\)/u, name);
});

// Review 2026-11-06 S1: a type-then-Backspace leaves the box on the mark; with KeySaved only cleared by an edit, Next saved the mark as the key.
test("the key box means the saved key only while it holds the mark of a key the prefill saw: KeySaved is KeyWasSaved and the mark text, attached after the first prefill; a silent /LLMKEY= forgets the saved key; no other place writes or reads KeyWasSaved", () => {
  const touching = (pattern: RegExp): string[] => [...codeFunctions()].filter(([, body]) => pattern.test(body)).map(([name]) => name).sort();
  assert.deepEqual(touching(/KeyWasSaved :=/u), ["ApplySilentParameters", "PrefillFromSettings"]);
  assert.deepEqual(touching(/KeyWasSaved\b(?! :=)/u), ["RemoteKeyChanged"]);
  assert.match(functionBody("RemoteKeyChanged"), /^\s*KeySaved := KeyWasSaved and \(RemoteKeyEdit\.Text = SAVED_KEY_MARK\);\s*$/mu);
  assert.doesNotMatch(functionBody("RemoteKeyChanged"), /KeySaved := False;/u);
  const init = functionBody("InitializeWizard");
  const attached = init.indexOf("RemoteKeyEdit.OnChange := @RemoteKeyChanged;");
  assert.ok(attached > init.indexOf("ApplySilentParameters()") && attached > init.indexOf("PrefillFromSettings()"), "the handler is attached before the first prefill");
  assert.match(functionBody("ApplySilentParameters"), /if ParamGiven\('LLMKEY'\) then\s+begin\s+RemoteKeyEdit\.Text := Param\('LLMKEY', ''\);\s+KeySaved := False;\s+KeyWasSaved := False;\s+end;/u);
});

test("a saved key that cannot be used is told in the setup's words, never the launcher's usage text, for the endpoint page's save and the progress page's save", () => {
  const text = functionBody("ConfigureFailure");
  assert.match(text, /KeySaved and ModelRemoteRadio\.Checked and \(Code = USAGE_EXIT_CODE\)/u);
  assert.match(code, /SAVED_KEY_UNUSABLE_TEXT = '[^']*Type the key again in the API key box[^']*\/LLMKEY=/u);
  // A silent run has no key box to type in: its text names /LLMKEY= and nothing of the wizard.
  const silentText = /SAVED_KEY_UNUSABLE_SILENT_TEXT = '([^']*)';/u.exec(code)?.[1];
  assert.ok(silentText !== undefined, "no SAVED_KEY_UNUSABLE_SILENT_TEXT");
  assert.match(silentText, /^The API key saved earlier cannot be used: [^]*\/LLMKEY=/u);
  assert.doesNotMatch(silentText, /box|Type the key|dots|wizard|page/iu);
  assert.match(text, /if WizardSilent then\s+Result := Lead \+ #13#10 \+ SAVED_KEY_UNUSABLE_SILENT_TEXT\s+else\s+Result := Lead \+ #13#10 \+ SAVED_KEY_UNUSABLE_TEXT/u);
  assert.match(functionBody("SaveAndTestEndpoint"), /ConfigureFailure\('Mine AI could not save the endpoint\.', Code\)/u);
  assert.match(functionBody("RunConfigure"), /ConfigureFailure\('Mine AI could not save your choices in settings\.json\.', Code\)/u);
  // Exit 2 is the launcher's code for any usage error, so a URL its configure refuses (a scheme with nothing after it) must be refused by the
  // setup first, or a good saved key would be reported unusable.
  assert.match(functionBody("RemoteUrlProblem"), /\(Trim\(RemoteUrlEdit\.Text\) = 'http:\/\/'\) or \(Trim\(RemoteUrlEdit\.Text\) = 'https:\/\/'\)/u);
});

test("the encryption notice is shown and logged once, after the first successful configure, and only when a key really was saved", () => {
  const note = functionBody("NoteClearKeyMigrated");
  assert.match(note, /if \(not ClearKeyMigrated\) or \(RemoteKeyEdit\.Text = ''\) then\s+Exit;/u);
  assert.ok(code.includes("KEY_ENCRYPTED_NOTICE = 'Your API key is now stored encrypted for this Windows user; it no longer appears in clear in settings.json.';"));
  assert.match(note, /ClearKeyMigrated := False;/u);
  assert.match(note, /if not WizardSilent then\s+SuppressibleMsgBox\(KEY_ENCRYPTED_NOTICE/u);
  // A clear key in the file: set by the prefill, from the settings' own apiKey.
  assert.match(functionBody("PrefillFromSettings"), /ClearKeyMigrated := True;/u);
  assert.match(functionBody("PrefillFromSettings"), /ClearKeyMigrated := False;/u);
  const save = functionBody("SaveAndTestEndpoint");
  const configured = save.indexOf("'configure ' + RemoteLlmArguments()");
  assert.ok(configured >= 0 && save.indexOf("NoteClearKeyMigrated()") > configured && save.indexOf("NoteClearKeyMigrated()") < save.indexOf("'install endpoint-test'"), "the notice is not between the save and the test");
  assert.match(save, /else\s+begin\s+NoteClearKeyMigrated\(\);/u, "the notice is not in the branch of a successful configure");
});

// ---------- T12 (owner 2026-11-07, review W10): the saved key stays when the URL changes; the player is warned, nothing is automated ----------

test("the URLs are compared trimmed and without trailing slashes", () => {
  const compare = functionBody("UrlForComparison");
  assert.match(compare, /Result := Trim\(Url\);/u);
  assert.match(compare, /while \(Result <> ''\) and \(Copy\(Result, Length\(Result\), 1\) = '\/'\) do\s+Result := Copy\(Result, 1, Length\(Result\) - 1\);/u);
});

test("the saved URL is remembered by the prefill only (and forgotten with the key flags), so a Back to another data folder compares with that folder's URL", () => {
  assert.match(code, /^\s*SavedBaseUrl, KeyUrlChangeTold: String;/mu);
  const prefill = functionBody("PrefillFromSettings");
  const reset = prefill.indexOf("SavedBaseUrl := '';");
  assert.ok(reset >= 0 && reset < prefill.indexOf("ReadSettingsSections("), "the saved URL is not forgotten before the settings are read");
  assert.match(prefill, /KeyUrlChangeTold := '';/u);
  assert.match(prefill, /SavedBaseUrl := JsonString\(Llm, 'baseUrl'\);/u);
  assert.deepEqual([...codeFunctions()].filter(([, body]) => /SavedBaseUrl := /u.test(body)).map(([name]) => name), ["PrefillFromSettings"]);
});

test("the player is warned when a saved key meets another URL: only when both hold, once per URL, the box in the wizard and a log line in a silent install, and no flag, key or URL changes", () => {
  const note = functionBody("NoteSavedKeyKeptForOtherUrl");
  assert.match(note, /\(not KeySaved\) or \(SavedBaseUrl = ''\) or \(NewUrl = UrlForComparison\(SavedBaseUrl\)\) or \(NewUrl = KeyUrlChangeTold\) then\s+Exit;/u);
  assert.match(note, /NewUrl := UrlForComparison\(RemoteUrlEdit\.Text\);/u);
  assert.match(note, /KeyUrlChangeTold := NewUrl;/u);
  assert.match(note, /The saved API key was made for ' \+ SavedBaseUrl/u);
  assert.match(note, /replace the dots in the API key box with that provider''s key/u);
  // A failed configure may prevent the endpoint test from running.
  assert.match(note, /Setup keeps it and sends it to ' \+ Shown \+ ' when it tests the endpoint/u);
  assert.match(note, /Log\('API key: /u);
  assert.match(note, /if not WizardSilent then\s+SuppressibleMsgBox\([^\n]*mbInformation, MB_OK, IDOK\);/u);
  // The silent log says the next action of a run with no key box.
  assert.match(note, /\/LLMKEY=/u);
  // No automation: the key, its flags and the URL are only read.
  assert.doesNotMatch(note, /KeySaved :=|KeyWasSaved :=|ClearKeyMigrated :=|RemoteKeyEdit\.Text :=|RemoteUrlEdit\.Text :=|SavedBaseUrl :=|Abort|Result :=/u);
});

test("the warning comes before the save, in the one routine both the endpoint page's Next and a silent install run, and nothing else calls it", () => {
  const save = functionBody("SaveAndTestEndpoint");
  const warned = save.indexOf("NoteSavedKeyKeptForOtherUrl()");
  assert.ok(warned >= 0 && warned < save.indexOf("'configure ' + RemoteLlmArguments()"), "the warning is not before the configure call");
  assert.deepEqual([...codeFunctions()].filter(([, body]) => body.includes("NoteSavedKeyKeptForOtherUrl()")).map(([name]) => name), ["SaveAndTestEndpoint"]);
  assert.match(functionBody("AcceptRemoteEndpoint"), /SaveAndTestEndpoint\(Failure\)/u);
  assert.match(functionBody("SilentSetupFailure"), /SaveAndTestEndpoint\(Failure\)/u);
});

test("the doc's key part tells the player about the warning", () => {
  const key = doc.slice(doc.indexOf("### Your API key"), doc.indexOf("## Ollama you already have"));
  assert.match(key, /shows a message when you press \*\*Next\*\* with a saved key\s+and a URL that differs from the saved one/u);
  assert.match(key, /replace the dots with the new provider's key/u);
});

test("the doc tells the player about the remote endpoint: Ollama on another PC with its firewall line, the list and what it costs, the /v1 correction, the encrypted key", () => {
  const titles = [...doc.matchAll(/^#{2,3} (.+)$/gmu)].map((match) => match[1]!);
  for (const title of ["A remote AI endpoint", "Listing the models", "The /v1 correction", "Ollama on another PC", "Your API key"]) assert.ok(titles.includes(title), `no section "${title}"`);
  const section = doc.slice(doc.indexOf("## A remote AI endpoint"), doc.indexOf("## Ollama you already have"));
  assert.ok(section.includes('New-NetFirewallRule -DisplayName "Ollama" -Direction Inbound -Protocol TCP -LocalPort 11434 -Profile Private -Action Allow'));
  assert.match(section, /OLLAMA_HOST=0\.0\.0\.0:11434/u);
  assert.match(section, /Ollama has no password/u);
  assert.match(section, /List models/u);
  assert.match(section, /no text|generates no text/u);
  assert.match(section, /one short test message/u);
  assert.match(section, /`\/v1`/u);
  assert.match(section, /another Windows user or on another PC/u);
  assert.match(section, /\/LLMKEY=/u);
  assert.match(section, /goes to whatever URL is in the URL box/u);
  assert.match(doc, /\| `\/LLMKEY=` \|[^\n]*an empty one removes the saved key[^\n]*Leave it out to keep/u);
  // settings.json: the key is not in clear.
  const settings = doc.slice(doc.indexOf("## Settings, data and logs"), doc.indexOf("## Ollama you already have"));
  assert.ok(settings.includes("apiKeyProtected"));
  // /LOG records the command line: a key given as /LLMKEY= is in the log.
  const silent = doc.slice(doc.indexOf("## Silent install"));
  assert.match(silent, /\/LOG=[^\n]*\/LLMKEY=|\/LLMKEY=[^\n]*\/LOG=/u);
  // The flag is internal: the player's doc never names it.
  assert.doesNotMatch(doc, /llm-remote-saved-key|--saved-key/u);
});
