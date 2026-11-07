// The Inno Setup script (packaging/windows/mine-ai.iss), the update-check choice (spec 2026-11-07-installer-code-signing D4, D5):
// the tasks-page box at a first install, the saved value an update keeps, /CHECKUPDATES= for a silent one, the `--check-updates`
// the final configure call passes, the Ready line, and the product metadata SignPath's artifact configuration restricts.
// Pascal is not run: each test reads the script's code (iss-test-support.ts) for what must hold.
import assert from "node:assert/strict";
import test from "node:test";
import { doc, functionBody, iss, scriptLines } from "./iss-test-support.ts";

const PRIVACY_URL = "https://github.com/bahumbert/mine-ai-mcp/blob/main/docs/privacy.md";

test("the privacy page URL is defined once; [Tasks] has the checkupdates box, checked by default, saying what GitHub sees and naming it", () => {
  assert.deepEqual([...iss.matchAll(/^#define PrivacyUrl "([^"]+)"$/gmu)].map((match) => match[1]), [PRIVACY_URL]);
  assert.equal(iss.split(PRIVACY_URL).length - 1, 1, "the URL is spelled outside its #define");
  const entry = /^Name: "checkupdates"; Description: "([^"]+)"(.*)$/mu.exec(iss.slice(iss.indexOf("\n[Tasks]")));
  assert.ok(entry, "no checkupdates task in [Tasks]");
  assert.match(entry[1]!, /GitHub sees this PC's address, nothing else is sent/u);
  assert.match(entry[1]!, /Privacy: \{#PrivacyUrl\}$/u, "the box does not carry the privacy page URL");
  assert.doesNotMatch(entry[2]!, /unchecked/u, "the box must be checked by default");
});

test("an update keeps the saved check: it skips the tasks page, the prefill reads checkUpdates, and the choice is silent parameter, then box at a first install, then saved value", () => {
  assert.match(functionBody("ShouldSkipPage"), /PageID = wpSelectTasks then\s+Result := Result or IsUpdate\(\);/u);
  const prefill = functionBody("PrefillFromSettings");
  const reset = prefill.indexOf("SavedCheckUpdates := True;");
  assert.ok(reset >= 0 && reset < prefill.indexOf("ReadSettingsSections("), "SavedCheckUpdates is not reset to true before the settings are read");
  assert.match(prefill, /SavedCheckUpdates := SavedCheckUpdatesValue\(\);/u);
  const reader = functionBody("SavedCheckUpdatesValue");
  assert.match(reader, /Result := True;/u, "a missing file or key must leave the check on, as the launcher's default does");
  assert.match(reader, /JsonValueStart\(Settings, 'checkUpdates'\)/u);
  assert.match(reader, /Copy\(Settings, P, 5\) = 'false'/u);
  const wanted = functionBody("CheckUpdatesWanted");
  const param = wanted.indexOf("ParamGiven('CHECKUPDATES')");
  const task = wanted.indexOf("WizardIsTaskSelected('checkupdates')");
  assert.ok(param >= 0 && task > param && wanted.indexOf("SavedCheckUpdates") > task, `order is wrong: ${wanted}`);
  assert.match(wanted, /Param\('CHECKUPDATES', ''\) = '1'/u);
  assert.match(wanted, /not IsUpdate\(\)/u, "the task box must count at a first install only");
  // Every other parameter is read in a silent setup only: a wizard run shows its box and must report that box.
  assert.match(wanted, /WizardSilent and ParamGiven\('CHECKUPDATES'\)/u);
});

test("the final configure call, the Ready list and the silent parameter check all carry the choice; the endpoint-only configure does not", () => {
  const args = functionBody("ConfigureArguments");
  assert.match(args, /if CheckUpdatesWanted\(\) then\s+Result := Result \+ ' --check-updates on'\s+else\s+Result := Result \+ ' --check-updates off';/u);
  assert.ok(args.lastIndexOf("--server-none") < args.indexOf("--check-updates"), "--check-updates comes after the server choice");
  assert.equal(args.split("--check-updates").length - 1, 2, "--check-updates on / off: two spellings, both here");
  assert.doesNotMatch(functionBody("SaveAndTestEndpoint"), /check-updates/u);
  // The steps' signature is ConfigureArguments(), so a changed choice runs the configure step again.
  assert.match(functionBody("RunSetupSteps"), /Signature := ConfigureArguments\(\)/u);
  const problem = functionBody("SilentParameterProblem");
  assert.match(problem, /CheckUpdates := Param\('CHECKUPDATES', '1'\);/u);
  assert.match(problem, /CheckUpdates <> '0'\) and \(CheckUpdates <> '1'\)/u);
  assert.match(problem, /'\/CHECKUPDATES= must be 0 or 1\.'/u);
  const memo = functionBody("UpdateReadyMemo");
  assert.match(memo, /CheckUpdatesWanted\(\)/u);
  assert.match(memo, /\(privacy: \{#PrivacyUrl\}\)/u, "the Ready line does not name the privacy page");
  // A statement of its own after the if/else (two-space indent), so both the first install and the update show it.
  assert.match(memo, /^  Result := Result \+ NewLine \+ NewLine \+ 'Check for updates at each start: '/mu);
});

test("the header lists /CHECKUPDATES=0|1 and the CALLS lines pass --check-updates on every final configure", () => {
  const header = iss.slice(0, iss.indexOf("#ifndef StageDir"));
  assert.match(header, /\/CHECKUPDATES=0\|1/u);
  const lines = [...iss.matchAll(/^\/\/\s+CALLS (.+?): (.+)$/gmu)].filter((match) => !match[1]!.includes("(uninstall)"));
  assert.notEqual(lines.length, 0);
  for (const [, parameters, calls] of lines) {
    const configures = calls!.split("; ").filter((call) => call.startsWith("configure "));
    assert.match(configures.at(-1)!, / --check-updates (?:on|off)$/u, `${parameters}: the final configure has no --check-updates`);
  }
  assert.ok(lines.some(([, parameters, calls]) => parameters!.includes("/CHECKUPDATES=0") && calls!.includes("--check-updates off")), "no CALLS line for /CHECKUPDATES=0");
});

// The silent table row is held by iss-launcher-calls.test.ts (the .iss reads /CHECKUPDATES=, so the table must list it).
test("docs/install/windows.md links the policy and privacy pages at its top and says in Updating how the choice is kept and changed", () => {
  const top = doc.slice(0, doc.indexOf("\n## "));
  assert.match(top, /\(\.\.\/code-signing-policy\.md\)/u);
  assert.match(top, /\(\.\.\/privacy\.md\)/u);
  const updating = doc.slice(doc.indexOf("## Updating"));
  assert.match(updating, /settings\.json/u);
  assert.match(updating, /--check-updates/u);
});

// SignPath's artifact configuration restricts the product name; the compiled file's resource strings were read once with a throwaway
// probe (report of task T2b: FileDescription "Mine AI Setup", ProductName "Mine AI", FileVersion and ProductVersion the version).
test("[Setup] sets the version resource the signature page shows: product name Mine AI, file and product version AppVersion", () => {
  const setupSection = scriptLines.slice(scriptLines.indexOf("[Setup]"), scriptLines.indexOf("[Languages]"));
  assert.ok(setupSection.includes("VersionInfoVersion={#AppVersion}"));
  assert.ok(setupSection.includes("VersionInfoProductVersion={#AppVersion}"));
  assert.ok(setupSection.includes("VersionInfoProductName=Mine AI"));
  assert.match(iss, /^; .*SignPath.*product name/mu, "no comment citing SignPath's product name and version rule");
});
