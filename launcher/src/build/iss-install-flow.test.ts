// The Inno Setup script (packaging/windows/mine-ai.iss), the install and uninstall flow around the pages: where the app and data
// folders are written and checked, the update's texts and its stop of a running Mine AI, the one launcher script define, [InstallDelete],
// and the uninstaller's removals. Pascal is not run: each test reads the script's code (iss-test-support.ts) for what must hold.
import assert from "node:assert/strict";
import test from "node:test";
import { STOP_REFUSED_EXIT_CODE } from "../control-commands.ts";
import { code, codeFunctions, functionBody, iss, scriptLines } from "./iss-test-support.ts";

// W7: the player picks the data folder, so the default `{localappdata}\MineAI` is written once, in the function that
// answers "no folder chosen"; every other place asks `DataDir`. A second spelling would read or delete a folder the player did
// not choose (H4 of the W5 host run and the uninstaller's DelTree both named the default).
test("the default data folder is written once, in DefaultDataDir; every other use asks DataDir", () => {
  const spellings = scriptLines.map((line, index) => ({ line, index })).filter(({ line }) => /localappdata\}\\MineAI/iu.test(line));
  assert.equal(spellings.length, 1, spellings.map(({ line }) => line.trim()).join(" | "));
  const header = scriptLines.slice(0, spellings[0]!.index).reverse().find((line) => /^\s*(?:function|procedure)\b/u.test(line));
  assert.match(header ?? "", /function DefaultDataDir\b/u);
  assert.match(iss, /DestDir: "\{code:DataDir\}\\personas"/u);
  assert.match(iss, /^Name: "\{code:DataDir\}"; Flags: uninsneveruninstall/mu);
});

test("the default app folder is written once, in [Setup], and the app folder is the player's to choose", () => {
  assert.equal(scriptLines.filter((line) => /localappdata\}\\Programs\\MineAI/iu.test(line)).length, 1);
  assert.match(iss, /^DisableDirPage=auto$/mu);
  assert.doesNotMatch(iss, /^DisableDirPage=yes$/mu);
});

// The launcher writes its JSON (step results, install-state.json, settings.json) as UTF-8; `String(Raw)` of the AnsiString that
// LoadStringFromFile returns turned an `é` in a folder into two wrong characters (probe, Inno Setup 6.7.3, 2026-10-31).
test("every JSON file the .iss reads is decoded as UTF-8", () => {
  assert.doesNotMatch(code, /String\(Raw\)/u);
  assert.equal([...code.matchAll(/LoadStringFromFile\(/gu)].length, [...code.matchAll(/UTF8Decode\(Raw\)/gu)].length);
});

// The uninstaller finds the data folder in the key Inno writes for this AppId: the constant must be the script's own AppId.
test("the uninstall key the uninstaller reads is the key of the script's AppId", () => {
  const appId = /^AppId=\{(\{[0-9A-F-]+\})$/mu.exec(iss)?.[1];
  assert.ok(appId, "no AppId in [Setup]");
  assert.ok(iss.includes(`Uninstall\\${appId}_is1'`), `the [Code] uninstall key does not name ${appId}`);
});

// Finding 1 of the W5 re-check ("a check that changes what it checks"): FolderIsWritable made the folder it was asked about,
// so a refused or abandoned install left an empty program folder and Inno showed its own "folder already exists" box.
test("a folder check never makes the folder: only WriteDataFolderFiles calls ForceDirectories, only FolderIsWritable calls CreateDir, always with RemoveDir of the same name", () => {
  const callers = (call: string): string[] => [...codeFunctions()].filter(([, body]) => body.includes(`${call}(`)).map(([name]) => name);
  assert.deepEqual(callers("ForceDirectories"), ["WriteDataFolderFiles"]);
  assert.deepEqual(callers("CreateDir"), ["FolderIsWritable"]);
  const writable = functionBody("FolderIsWritable");
  const created = /CreateDir\((\w+)\)/u.exec(writable)?.[1];
  assert.ok(created, "FolderIsWritable does not CreateDir a named probe folder");
  assert.match(writable, new RegExp(`RemoveDir\\(${created}\\)`, "u"));
  assert.match(writable, /\.mine-ai-write-test-/u);
});

test("FolderIsWritable probes a folder that exists with a file, one that does not with a sub-folder of its nearest existing parent, and refuses when there is none", () => {
  const writable = functionBody("FolderIsWritable");
  assert.match(writable, /NearestExistingFolder\(Folder\)/u);
  assert.match(writable, /if Base = '' then\s+Exit;/u);
  assert.match(writable, /if DirExists\(Folder\) then\s+begin\s+Probe := AddBackslash\(Folder\)[^\n]*\s+Result := SaveStringToFile\(Probe/u);
  assert.match(writable, /AddBackslash\(Base\) \+ '\.mine-ai-write-test-' \+ GetDateTimeString\(/u);
  const nearest = functionBody("NearestExistingFolder");
  assert.match(nearest, /DirExists\(/u);
  assert.match(nearest, /ExtractFileDir\(/u);
  // A drive root is its own parent (the walk ends there, not loops) and a path part that is a file holds no folder.
  assert.match(nearest, /\(Length\(Parent\) >= Length\(Result\)\) or FileExists\(Result\)/u);
});

// Finding 5: `/DELETEDATA=0` left no line saying the data folder was kept.
test("the uninstaller logs 'Data folder kept: ' on the branch that does not delete the data", () => {
  const step = functionBody("CurUninstallStepChanged");
  assert.match(step, /if DeleteDataOnUninstall then\s+DeleteDataFolder\(\)\s+else\s+Log\('Data folder kept: ' \+ UninstallDataDir/u);
});

// Finding 6a: an update (Ready is its first page) read Inno's "Ready to Install" and "Install"; the owner said "repair".
test("an update says 'update or repair' on the Ready page and 'Updating' while copying; a first install keeps Inno's texts", () => {
  const say = functionBody("SayUpdateOnPage");
  assert.match(say, /if not IsUpdate\(\) then\s+Exit;/u);
  assert.match(say, /CurPageID = wpReady then[\s\S]*PageNameLabel\.Caption := 'Ready to update or repair'/u);
  assert.match(say, /PageDescriptionLabel\.Caption := 'Setup will update Mine AI and repair any missing file\. Your data folder, worlds and bots stay as they are; the AI model and server settings are set again on the next pages\.'/u);
  assert.match(say, /NextButton\.Caption := 'Update'/u);
  assert.match(say, /CurPageID = wpInstalling then\s+begin\s+WizardForm\.PageNameLabel\.Caption := 'Updating';/u);
  assert.match(functionBody("CurPageChanged"), /SayUpdateOnPage\(CurPageID\)/u);
  assert.match(functionBody("IsUpdate"), /PrevAppDir <> ''/u);
});

// T20 (wizard walk of build 1f2b723, F2): Inno's Ready line says "Click Install ... or click Back", but the update's button is "Update" and Ready is its first page.
test("the update's Ready page line names the Update button and no Back; a first install keeps Inno's line", () => {
  const say = functionBody("SayUpdateOnPage");
  // Only the Ready branch: from `wpReady then` to the `end` before `else if CurPageID = wpInstalling`.
  const readyBranch = /CurPageID = wpReady then([\s\S]*?)\n  end\n  else if CurPageID = wpInstalling/u.exec(say)?.[1] ?? "";
  const caption = /WizardForm\.ReadyLabel\.Caption := '([^']*)';/u.exec(readyBranch)?.[1];
  assert.notEqual(caption, undefined, "SayUpdateOnPage does not set the Ready line");
  assert.match(caption!, /Update/u);
  assert.doesNotMatch(caption!, /Back|Install/u);
  // After the early Exit of a first install: only an update sets it.
  assert.ok(say.indexOf("ReadyLabel.Caption") > say.indexOf("if not IsUpdate() then"), "the Ready line is set before the first-install exit: a first install would lose Inno's line");
});

// The text a branch of SayUpdateOnPage sets on a label: from `CurPageID = <page> then` to the next `else if CurPageID` or the end.
function updateBranchCaption(page: string, label: string): string | undefined {
  const branch = new RegExp(`CurPageID = ${page} then([\\s\\S]*?)(?:\\n  else if CurPageID|\\nend;|$)`, "u").exec(functionBody("SayUpdateOnPage"))?.[1] ?? "";
  return new RegExp(`WizardForm\\.${label}\\.Caption := '([^']*)';`, "u").exec(branch)?.[1];
}

// T23: on an update the Installing and Preparing pages kept Inno's "install" wording (Preparing shows when the stop of a running Mine AI is refused).
test("the update's Installing and Preparing pages describe an update, never an install; a first install keeps Inno's texts", () => {
  for (const [page, labels] of [["wpInstalling", ["PageDescriptionLabel"]], ["wpPreparing", ["PageNameLabel", "PageDescriptionLabel"]]] as const) {
    for (const label of labels) {
      const text = updateBranchCaption(page, label);
      assert.notEqual(text, undefined, `the ${page} branch does not set ${label}`);
      assert.match(text!, /update/iu);
      assert.doesNotMatch(text!, /install/iu);
    }
  }
  assert.match(updateBranchCaption("wpInstalling", "PageDescriptionLabel")!, /updates/u);
  const say = functionBody("SayUpdateOnPage");
  assert.ok(say.indexOf("wpPreparing") > say.indexOf("if not IsUpdate() then"));
});

// T23: "Mine AI is installed." is false on an update; "up to date" is true there and after a first install run again (IsUpdate is true then too).
test("the Finished page opens with 'up to date' on an update and 'installed' on a first install; a failed run keeps its own text", () => {
  const finish = functionBody("ShowFinishText");
  assert.match(finish, /if IsUpdate\(\) then\s+Line := 'Mine AI is up to date\.'\s+else\s+Line := 'Mine AI is installed\.';/u);
  assert.match(finish, /FinishedLabel\.Caption := Line \+ #13#10#13#10 \+\s+JoinText\(\)/u);
  assert.match(finish, /'Setup did not finish\. Run the installer again to resume: the steps that are done are not repeated\.' \+ #13#10#13#10 \+ 'Details are on the previous page\.'/u);
});

// T23: Inno's exit box says "the program will not be installed", false on an update (the old install stays). Only before the copy
// is "Mine AI stays as it was" true: the model, server, EULA and steps pages come after it, so they keep Inno's box.
test("cancelling an update before the copy asks its own question; a first install and the pages after the copy keep Inno's box", () => {
  const cancel = functionBody("CancelButtonClick");
  const updateBranch = /if IsUpdate\(\) and \(\(CurPageID = wpReady\) or \(CurPageID = wpPreparing\)\) then\s+begin([\s\S]*?)\n  end;/u.exec(cancel)?.[1] ?? "";
  assert.match(updateBranch, /Confirm := False;/u);
  assert.match(updateBranch, /Cancel := SuppressibleMsgBox\('Stop the update\? Mine AI stays as it was before this update; run the setup again to update it\.', mbConfirmation, MB_YESNO, IDNO\) = IDYES;/u);
  assert.doesNotMatch(updateBranch, /installed/u);
  // Confirm is assigned only inside that branch.
  assert.doesNotMatch(cancel.replace(updateBranch, ""), /Confirm :=/u);
});

// T20 (F3): the "Disk room" line of the Ready memo ran off to the right under a horizontal scroll bar.
test("the Ready memo wraps its lines and scrolls vertically only, set once for a first install and an update alike", () => {
  const init = functionBody("InitializeWizard");
  assert.match(init, /WizardForm\.ReadyMemo\.WordWrap := True;/u);
  assert.match(init, /WizardForm\.ReadyMemo\.ScrollBars := ssVertical;/u);
  assert.doesNotMatch(init, /IsUpdate\(\)[^\n]*\n[^\n]*ReadyMemo/u);
  assert.deepEqual([...codeFunctions()].filter(([, body]) => body.includes("ReadyMemo.")).map(([name]) => name), ["InitializeWizard"]);
});

// Finding 6b: the Ready page showed only the destination.
test("the Ready summary lists the folders, and the model and server of an update read from settings.json by the helper the pages use", () => {
  const memo = functionBody("UpdateReadyMemo");
  assert.match(memo, /MemoDirInfo/u);
  // Inno leaves MemoDirInfo empty when the folder page was skipped (an update) unless this is set.
  assert.match(iss, /^AlwaysShowDirOnReadyPage=yes$/mu);
  // An update with no settings.json falls to the sentence too: the pages after the copy still ask both.
  assert.match(memo, /IsUpdate\(\) and SettingsSummary\(Model, Server\) then[\s\S]*\n\s+else\n[\s\S]*chosen on the next pages/u);
  assert.match(memo, /Data folder:/u);
  assert.match(memo, /AI model:/u);
  assert.match(memo, /Minecraft server:/u);
  assert.match(memo, /AI model and Minecraft server: chosen on the next pages, after the files are copied/u);
  assert.match(memo, /SettingsSummary\(/u);
  // One reader of the file's `llm` and `server` objects: the summary and the pages' prefill both call it, none repeats it.
  assert.deepEqual([...codeFunctions()].filter(([, body]) => /JsonSection\([^)]*'llm'\)/u.test(body)).map(([name]) => name), ["ReadSettingsSections"]);
  for (const reader of ["SettingsSummary", "PrefillFromSettings"]) assert.match(functionBody(reader), /ReadSettingsSections\(/u, `${reader} does not use ReadSettingsSections`);
});

// Finding 2: the copy time was measured wrongly from the log; the next log separates the stop from the copy.
test("PrepareToInstall logs the stop of a running Mine AI before the copy, and its end", () => {
  const prepare = functionBody("PrepareToInstall");
  const start = prepare.indexOf("Stopping a running Mine AI before the copy");
  const stop = prepare.indexOf("RunLauncherAndWait('stop'");
  const end = prepare.indexOf("Stopping a running Mine AI before the copy: done");
  assert.ok(start >= 0 && stop > start && end > stop, "the log lines do not surround the stop");
  assert.match(prepare, /InstalledLauncherScript\(\) <> ''/u);
});

// W10e: the setup ships a bundle (`launcher\src\main.js`), not the sources. One define names the script every place runs;
// only the update's stop looks for the older layout, since a d3-era install holds `main.ts` when the new copy has not run yet.
test("every place that runs the launcher uses the one LauncherScript define; main.ts appears only as the older layout the update's stop and the uninstaller's folder check look for", () => {
  assert.match(iss, /^#define LauncherScript "launcher\\src\\main\.js"$/mu);
  assert.match(iss, /^#define SourceLauncherScript "launcher\\src\\main\.ts"$/mu);
  const usesOfOldName = scriptLines.map((line) => line.trim()).filter((line) => line.includes("main.ts") && !line.startsWith("#define SourceLauncherScript"));
  assert.deepEqual(usesOfOldName, []);
  assert.match(iss, /Parameters: "\{#LauncherScript\} console"/u);
  assert.equal([...iss.matchAll(/Parameters: "\{#LauncherScript\} console"/gu)].length, 2, "the Start-menu entry and the finish page's run");
  assert.match(functionBody("RunLauncher"), /\{#LauncherScript\}/u);
  assert.match(functionBody("FolderIsOurs"), /\{#LauncherScript\}[\s\S]*\{#SourceLauncherScript\}|\{#SourceLauncherScript\}[\s\S]*\{#LauncherScript\}/u);
});

test("the stop before the copy and the uninstaller's stop run the bundle's main.js when it exists, else the sources' main.ts, else nothing; one function decides, both guards use it", () => {
  const script = functionBody("InstalledLauncherScript");
  assert.match(script, /FileExists\(ExpandConstant\('\{app\}\\bun\.exe'\)\)/u);
  const bundle = script.indexOf("{#LauncherScript}");
  const sources = script.indexOf("{#SourceLauncherScript}");
  assert.ok(bundle >= 0 && sources > bundle, "the bundle must be tried before the sources");
  for (const caller of ["PrepareToInstall", "RunLauncherAndWait"]) assert.match(functionBody(caller), /InstalledLauncherScript\(\)/u, caller);
  // No second guard of its own: bun.exe is checked in InstalledLauncherScript only.
  assert.deepEqual([...codeFunctions()].filter(([name, body]) => name !== "InstalledLauncherScript" && /FileExists\(ExpandConstant\('\{app\}\\bun\.exe'\)\)/u.test(body)).map(([name]) => name), []);
});

test("[InstallDelete] clears the old source tree and node_modules before the bundle lands, and never the data-root marker or the uninstaller", () => {
  // Inno Setup runs [InstallDelete] before it copies [Files], so the new copy lands in empty folders.
  const section = /^\[InstallDelete\]\r?\n([\s\S]*?)(?=^\[)/mu.exec(iss)?.[1];
  assert.ok(section, "the .iss has no [InstallDelete] section");
  const deleted = [...section.matchAll(/^Type: (?:files|filesandordirs); Name: "\{app\}\\([^"]+)"/gmu)].map((match) => match[1]);
  assert.deepEqual(deleted.sort(), ["bun.lock", "brain\\src", "launcher\\src", "node_modules", "package.json", "patches", "src"].sort());
  assert.doesNotMatch(section.split(/\r?\n/u).filter((line) => !line.startsWith(";")).join("\n"), /data-root|unins000/u);
});

// S9 of review 2026-11-01-pre-alpha-0.1.0: the uninstaller threw away what `stop`, `install model-remove` and `install ollama-remove`
// said, and an update went on over a launcher that had not stopped. Probe (Inno Setup 6.7.3, 2026-11-01, uninstaller run with
// /VERYSILENT /LOG): ExecAndLogOutput works in the uninstaller; stdout and stderr lines reach a log-only callback, the exit code
// comes back, and an exe that is missing gives False with code 2.
test("every RunLauncherAndWait caller logs the result code and the launcher's words through LogLauncherResult", () => {
  const callers = [...codeFunctions()].filter(([name, body]) => name !== "RunLauncherAndWait" && body.includes("RunLauncherAndWait(")).map(([name]) => name);
  assert.deepEqual(callers.sort(), ["CurUninstallStepChanged", "PrepareToInstall", "RemoveStepOnUninstall"]);
  for (const caller of callers) assert.match(functionBody(caller), /Code := RunLauncherAndWait\([^\n]*, Lines\);\s+LogLauncherResult\(/u, caller);
  assert.match(iss, /^function RunLauncherAndWait\(const Args: String; var Lines: String\): Integer;/mu);
  const logged = functionBody("LogLauncherResult");
  assert.match(logged, /Log\([^\n]*IntToStr\(Code\)/u);
  assert.match(logged, /Lines/u);
});

test("no launcher run outside the wizard's steps touches a wizard control or reads PROGRESS lines: only RunLauncher uses OnLauncherLine, every other ExecAndLogOutput uses the log-only callback", () => {
  assert.deepEqual([...codeFunctions()].filter(([, body]) => body.includes("@OnLauncherLine")).map(([name]) => name), ["RunLauncher"]);
  assert.deepEqual([...codeFunctions()].filter(([name, body]) => name !== "RunLauncher" && body.includes("ExecAndLogOutput(")).map(([name]) => name), ["RunLauncherAndWait"]);
  assert.match(functionBody("RunLauncherAndWait"), /@OnLauncherLogLine\)/u);
  assert.doesNotMatch(code, /\bExec\(/u, "a plain Exec throws the launcher's words away");
  const logOnly = functionBody("OnLauncherLogLine");
  assert.match(logOnly, /Log\(/u);
  assert.match(logOnly, /KeepLauncherLine\(/u);
  assert.match(functionBody("KeepLauncherLine"), /Length\(\w+\) > 600/u);
  assert.doesNotMatch(logOnly, /ActiveGauge|ActiveStatus|PROGRESS/u);
});

test("an update stops over a launcher that refuses to stop: PrepareToInstall returns the stop's words, which cancels the update before any file is copied", () => {
  const prepare = functionBody("PrepareToInstall");
  assert.match(prepare, /if Code = STOP_REFUSED_EXIT_CODE then\s+Result := [^\n]*cancelled before any file was copied[^\n]*\+ Lines;/u);
  assert.equal(Number(/^\s+STOP_REFUSED_EXIT_CODE = (\d+);/mu.exec(iss)?.[1]), STOP_REFUSED_EXIT_CODE, "the .iss constant is the launcher's");
  // The launcher's `stop` ends with its own code for "still starting", "not answering" and "did not finish stopping" only; a `stop` that
  // throws (exit 1 from runCli), a bundle that fails to load (Bun ends 1) and a launcher that cannot start at all (bun.exe or the script
  // missing) must not block the update that would repair them.
  assert.match(iss, /^\s+LAUNCHER_NOT_STARTED = -1;/mu);
  assert.match(functionBody("RunLauncherAndWait"), /Result := LAUNCHER_NOT_STARTED;/u);
});

test("the uninstaller skips both removals when the launcher refuses to stop and says what to end and remove by hand; otherwise it runs each removal the player asked for", () => {
  const step = functionBody("CurUninstallStepChanged");
  assert.match(step, /Code := RunLauncherAndWait\('stop', Lines\);\s+LogLauncherResult\('stop', Code, Lines\);\s+if Code = STOP_REFUSED_EXIT_CODE then\s+NoteUninstall\(StopRefusedNote\(\)\)/u);
  const refused = functionBody("StopRefusedNote");
  assert.match(refused, /bun\.exe and java\.exe in Task Manager, then delete the folder ' \+ ExpandConstant\('\{app\}'\) \+ ' and the rest by hand/u);
  assert.match(refused, /if RemoveModelOnUninstall then\s+Result := Result \+ #13#10 \+ ModelRemoveByHand\(\);\s+if RemoveOllamaOnUninstall then\s+Result := Result \+ #13#10 \+ OLLAMA_REMOVE_BY_HAND;/u);
  const afterElse = step.slice(step.search(/\n\s+else\n/u));
  assert.match(afterElse, /if RemoveModelOnUninstall then\s+RemoveStepOnUninstall\('install model-remove'/u);
  assert.match(afterElse, /if RemoveOllamaOnUninstall then\s+RemoveStepOnUninstall\('install ollama-remove'/u);
  assert.match(step, /ShowUninstallNotes\(\)/u);
});

test("a removal the player asked for logs its result, shows the detail unless it is a plain removal and the error otherwise, and never the hint that says to run the step again", () => {
  const removal = functionBody("RemoveStepOnUninstall");
  assert.match(removal, /--json/u);
  assert.match(removal, /UTF8Decode\(Raw\)/u);
  assert.match(removal, /JsonString\(Json, 'detail'\)/u);
  assert.match(removal, /JsonString\(Json, 'error'\)/u);
  assert.doesNotMatch(removal, /'hint'/u, "the launcher's hint says to run the step again; {app} is gone by then");
  assert.match(removal, /IsPlainRemoval\(/u);
  assert.match(removal, /ByHand/u);
  assert.match(functionBody("IsPlainRemoval"), /' removed\.'/u);
  // Hand removal the player can follow once {app} is gone: Ollama through Windows Settings, the model through the folder the model step names.
  const step = functionBody("CurUninstallStepChanged");
  assert.match(code, /Windows Settings > Apps/u);
  assert.match(step, /RemoveStepOnUninstall\('install ollama-remove', 'Ollama', OLLAMA_REMOVE_BY_HAND\)/u);
  assert.match(step, /RemoveStepOnUninstall\('install model-remove', 'The AI model', ModelRemoveByHand\(\)\)/u);
  // The folder is named only for Mine AI's own store (it holds the model alone); another Ollama's store holds the player's other models,
  // so there the text gives Ollama's command and never a folder to delete.
  const byHand = functionBody("ModelRemoveByHand");
  assert.match(byHand, /UninstallDataDir \+ '\\models'/u);
  assert.match(byHand, /if DeleteDataOnUninstall then\s+Result := [^\n]*goes with your data folder/u);
  assert.match(byHand, /ollama rm <name>/u);
  assert.doesNotMatch(byHand, /USERPROFILE|\.ollama\\models/u);
  // Shown once, together, and only when the player can answer.
  assert.match(functionBody("ShowUninstallNotes"), /\(UninstallNotes <> ''\) and \(not UninstallSilent\)/u);
  assert.match(functionBody("NoteUninstall"), /Log\(/u);
});
