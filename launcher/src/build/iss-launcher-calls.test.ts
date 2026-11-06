// The Inno Setup script (packaging/windows/mine-ai.iss) is Pascal, not run by tests. What can be checked is that the calls
// it makes to the launcher are real: its `CALLS` comment lines name, per silent parameter set, the launcher calls in
// order; this test runs each on the launcher's CLI, and compares the lines with the code and with the player's doc.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findInnoCompiler } from "./build-windows.ts";
import type { CliContext } from "../cli-context.ts";
import { runConfigureCommand } from "../configure-command.ts";
import { STOP_REFUSED_EXIT_CODE } from "../control-commands.ts";
import { INSTALL_STEP_NAMES, runInstallCommand, type InstallSteps } from "../install-command.ts";
import { runCli } from "../main.ts";
import { loadManifest } from "../manifest.ts";
import { loadSettings, settingsPath } from "../settings.ts";

const repoRoot = join(import.meta.dirname, "..", "..", "..");
const iss = readFileSync(join(repoRoot, "packaging", "windows", "mine-ai.iss"), "utf8");
const doc = readFileSync(join(repoRoot, "docs", "install", "windows.md"), "utf8");
/** The `[Code]` section without its comment lines, so a step named in a comment is not taken for a call. */
const code = iss.slice(iss.indexOf("[Code]")).split(/\r?\n/u).filter((line) => !line.trim().startsWith("//")).join("\n");

const VALUES: Readonly<Record<string, string>> = { "<url>": "https://api.example.test/v1", "<key>": "sk-1", "<model>": "big-model", "<host>": "play.example", "<port>": "25570", "<ollamadir>": "D:\\Apps\\Ollama" };

interface CallsLine {
  readonly parameters: readonly string[];
  readonly calls: readonly string[];
}

function callsLines(): CallsLine[] {
  const lines = [...iss.matchAll(/^\/\/\s+CALLS (.+?): (.+)$/gmu)].map((match) => ({
    parameters: match[1]!.replace(/\s*\(uninstall\)/u, "").split(" "),
    calls: match[2]!.split("; ").map((call) => call.trim()),
  }));
  assert.notEqual(lines.length, 0, "the .iss has no CALLS comment lines");
  return lines;
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "mine-ai-iss-"));
  const out: string[] = [];
  const context: CliContext = { root, appRoot: root, out: (line) => void out.push(line), err: (line) => void out.push(line), loadManifest };
  const stepsRun: string[] = [];
  // The CLI hands `--dir` to the step as its third argument; what the step received is written back in the CLI's own words.
  const steps = Object.fromEntries(INSTALL_STEP_NAMES.map((name) => [name, async (_ctx: unknown, acceptEula: boolean, dir?: string) => (stepsRun.push([name, ...(acceptEula ? ["--accept-eula"] : []), ...(dir === undefined ? [] : ["--dir", dir])].join(" ")), { ok: true as const, detail: `${name} done` })])) as unknown as InstallSteps;
  return { root, context, stepsRun, steps };
}

/** A CALLS parameter set marked `(key-saved)` is an update over settings that already hold a remote key and are given no /LLMKEY=. */
const KEY_SAVED = "(key-saved)";

/** What the settings file holds for the remote key, as written (on Windows an `apiKeyProtected` blob, elsewhere the clear `apiKey`), and the key as the launcher reads it. */
function savedKey(root: string): { readonly fileApiKey: unknown; readonly fileBlob: unknown; readonly loaded: string } {
  const file = (JSON.parse(readFileSync(settingsPath(root), "utf8")) as { llm: { apiKey?: unknown; apiKeyProtected?: unknown } }).llm;
  const llm = loadSettings(root, loadManifest()).llm;
  assert.equal(llm.kind, "remote");
  return { fileApiKey: file.apiKey, fileBlob: file.apiKeyProtected, loaded: llm.kind === "remote" ? llm.apiKey : "" };
}

test("every launcher call of every silent parameter set runs on the CLI and leaves the settings the parameters name", async () => {
  for (const { parameters, calls } of callsLines()) {
    const t = setup();
    const label = `${parameters.join(" ")}: ${calls.join("; ")}`;
    const installs: string[] = [];
    const keyWasSaved = parameters.includes(KEY_SAVED);
    // The update's earlier install: the key is saved through `configure --llm-remote` (encrypted on Windows, clear in WSL).
    if (keyWasSaved) assert.equal(await runConfigureCommand(["--llm-remote", VALUES["<url>"]!, VALUES["<key>"]!, "old-model"], t.context, { totalRamBytes: () => 32 * 1024 ** 3 }), 0, `${label}: the earlier save`);
    const before = keyWasSaved ? savedKey(t.root) : undefined;
    for (const call of calls) {
      const words = call.split(" ").map((word) => VALUES[word] ?? word);
      const [name, ...args] = words;
      if (name === "configure") assert.equal(await runConfigureCommand(args, t.context, { totalRamBytes: () => 32 * 1024 ** 3 }), 0, `${label} -> ${call}`);
      else if (name === "install") {
        installs.push(args.join(" "));
        assert.equal(await runInstallCommand([...args, "--json", join(t.root, "step.json")], t.context, t.steps), 0, `${label} -> ${call}`);
      } else assert.equal(name, "stop", `${label}: ${call} is not a launcher command the test knows`);
    }
    assert.deepEqual(t.stepsRun, installs, label);
    const settings = (): { llm?: { kind: string }; server?: { kind: string } } => JSON.parse(readFileSync(join(t.root, "settings.json"), "utf8")) as never;
    const wanted = (name: string): string | undefined => parameters.find((parameter) => parameter.startsWith(`/${name}=`))?.slice(name.length + 2);
    if (wanted("LLM") !== undefined) assert.equal(settings().llm?.kind, wanted("LLM"), label);
    if (wanted("SERVER") !== undefined) assert.equal(settings().server?.kind, wanted("SERVER"), label);
    // The saved-key form keeps the key as it was (the blob byte for byte on Windows) and takes the new model.
    if (before !== undefined) {
      assert.deepEqual(savedKey(t.root), before, `${label}: the saved key changed`);
      assert.equal(before.loaded, VALUES["<key>"], label);
      assert.equal((settings() as { llm: { model?: string } }).llm.model, VALUES["<model>"], label);
    }
  }
});

/**
 * Install steps only the wizard runs, never a silent install: a CALLS line (one per silent parameter set) cannot name them.
 * Each has the reason it is exempt and the flags only it passes (the other flags stay checked against the CALLS lines).
 */
const WIZARD_ONLY_STEPS: Readonly<Record<string, { readonly reason: string; readonly flags: readonly string[] }>> = {
  "endpoint-models": { reason: "fills the endpoint page's model list on the player's button; a silent install gives /LLMMODEL= and never lists", flags: ["--url", "--key", "--saved-key", "--list"] },
  disk: { reason: "the model page's free-space text (spec D2); nobody reads it in a silent install, whose steps keep their own guards", flags: ["--no-model"] },
};

test("the CALLS lines name every flag and install step the .iss code uses, and nothing it does not, except the steps only the wizard runs", () => {
  const documented = callsLines().flatMap((line) => line.calls);
  const wizardOnlyFlags = Object.values(WIZARD_ONLY_STEPS).flatMap((step) => step.flags);
  const flagsIn = (text: string): string[] => [...new Set([...text.matchAll(/--[a-z]+(?:-[a-z]+)*/gu)].map((match) => match[0]))].filter((flag) => flag !== "--json").sort();
  assert.deepEqual(flagsIn(documented.join(" ")), flagsIn(code).filter((flag) => !wizardOnlyFlags.includes(flag)));
  const stepsInCode = [...code.matchAll(/(?:'install |RunSetupStep\('|RunInstallStepWithRetry\(')([a-z]+(?:-[a-z]+)*)/gu)].map((match) => match[1]!);
  const stepsDocumented = documented.filter((call) => call.startsWith("install ")).map((call) => call.split(" ")[1]!);
  assert.deepEqual([...new Set(stepsInCode)].filter((step) => !(step in WIZARD_ONLY_STEPS)).sort(), [...new Set(stepsDocumented)].sort());
});

test("the steps exempt from the CALLS lines are exactly endpoint-models and disk: the code runs each, and no CALLS line names either", () => {
  assert.deepEqual(Object.keys(WIZARD_ONLY_STEPS).sort(), ["disk", "endpoint-models"]);
  const documented = callsLines().flatMap((line) => line.calls);
  for (const [step, { flags }] of Object.entries(WIZARD_ONLY_STEPS)) {
    assert.match(code, new RegExp(`'install ${step}[ ']`, "u"), `the .iss no longer runs install ${step}: drop its exemption`);
    assert.equal(documented.some((call) => call.startsWith(`install ${step}`)), false, `a CALLS line names install ${step}, which is not exempt then`);
    for (const flag of flags) assert.ok(code.includes(flag), `the .iss no longer passes ${flag}: drop it from the exemption`);
  }
});

test("the progress page's steps run in the order the CALLS line for a local model and server gives", () => {
  const body = code.slice(code.indexOf("function AllSetupStepsSucceed"));
  const inCode = [...body.slice(0, body.indexOf("\nend;\n")).matchAll(/RunSetupStep\('([^']+)'\)/gu)].map((match) => match[1]);
  const line = callsLines().find((candidate) => candidate.parameters.includes("/SERVER=local"));
  assert.ok(line, "no CALLS line for /SERVER=local");
  const afterConfigure = line.calls.slice(line.calls.findIndex((call) => call.startsWith("configure")) + 1);
  assert.deepEqual(afterConfigure.map((call) => call.replace(/^install /u, "")), inCode);
});

test("the silent parameters the .iss reads are the ones docs/install/windows.md lists", () => {
  const read = [...iss.matchAll(/Param(?:Given)?\('([A-Z]+)'/gu)].map((match) => match[1]!);
  const listed = [...doc.slice(doc.indexOf("## Silent install")).matchAll(/^\| `\/([A-Z]+)=/gmu)].map((match) => match[1]!);
  assert.notEqual(listed.length, 0, "the doc has no 'Silent install' parameters");
  assert.deepEqual([...new Set(read)].sort(), [...new Set(listed)].sort());
});

// Pascal Script reads the by-value arguments of an outer call before the inner call has filled its `var` argument:
// `StepSucceeded(RunLauncher(..., Json), Json)` judged the Json from before the run, so every step "failed" (Sandbox cases
// S2/S4 of W5 and a probe setup on Inno Setup 6.7.3, 2026-10-30: the nested form gave False, the same calls in two statements True).
test("no .iss call takes a launcher run as an argument, so no outer argument is read before the run has filled it", () => {
  const nested = code.split("\n").filter((line) => !/^\s*(?:function|procedure)\b/u.test(line) && /\w\s*\([^;]*\bRunLauncher\(/u.test(line));
  assert.deepEqual(nested, []);
});

test("no .iss text adds the remote-endpoint advice that the launcher's hint already gives", () => {
  assert.doesNotMatch(code, /'Use a remote endpoint\.'/u);
});

/** The script without comment lines (`;` in the sections, `//` in [Code]). */
const scriptLines = iss.split(/\r?\n/u).filter((line) => !/^\s*(?:;|\/\/)/u.test(line));

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

/** The [Code] functions and procedures with their bodies (comment lines already removed), by name. */
function codeFunctions(): Map<string, string> {
  const found = new Map<string, string>();
  let name: string | undefined;
  for (const line of code.split("\n")) {
    const header = /^(?:function|procedure)\s+(\w+)/u.exec(line);
    if (header) {
      name = header[1]!;
      found.set(name, "");
    } else if (name !== undefined) found.set(name, `${found.get(name)}${line}\n`);
  }
  return found;
}

/** The text of one [Code] function, so a test names the function it pins. */
function functionBody(name: string): string {
  const body = codeFunctions().get(name);
  assert.notEqual(body, undefined, `the .iss has no function ${name}`);
  return body!;
}

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
  assert.match(say, /CurPageID = wpInstalling then\s+WizardForm\.PageNameLabel\.Caption := 'Updating'/u);
  assert.match(functionBody("CurPageChanged"), /SayUpdateOnPage\(CurPageID\)/u);
  assert.match(functionBody("IsUpdate"), /PrevAppDir <> ''/u);
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

test("the doc names Inno's own /DIR= beside the table, not in it: the script never reads it through Param", () => {
  const prose = doc.split(/\r?\n/u).filter((line) => !line.startsWith("|")).join("\n");
  assert.match(prose, /`\/DIR=`/u);
  assert.doesNotMatch(doc, /^\| `\/DIR=/mu);
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

// ---------- T4a: the endpoint page, the model list, the /v1 notice, the disk text (spec D2, D4) ----------

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
  assert.ok(emptied >= 0 && cleared >= 0 && emptied < read && cleared < read, "the box and KeySaved are not reset before the file is read");
  // The mark first, the flag after it: an OnChange fired by the assignment must not leave the flag cleared.
  const mark = prefill.indexOf("RemoteKeyEdit.Text := SAVED_KEY_MARK;");
  const flag = prefill.indexOf("KeySaved := True;");
  assert.ok(mark > read && flag > mark, "KeySaved is set before the mark is in the box");
  assert.match(prefill, /JsonString\(Llm, 'apiKeyProtected'\) <> ''/u);
  // The mark is the box's text and nothing else: it reaches no launcher call.
  assert.deepEqual([...codeFunctions()].filter(([, body]) => body.includes("SAVED_KEY_MARK")).map(([name]) => name), ["PrefillFromSettings"]);
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

test("any edit of the key box clears KeySaved, attached after the first prefill; a silent /LLMKEY= clears it too", () => {
  assert.match(functionBody("RemoteKeyChanged"), /KeySaved := False;/u);
  const init = functionBody("InitializeWizard");
  const attached = init.indexOf("RemoteKeyEdit.OnChange := @RemoteKeyChanged;");
  assert.ok(attached > init.indexOf("ApplySilentParameters()") && attached > init.indexOf("PrefillFromSettings()"), "the handler is attached before the first prefill");
  assert.match(functionBody("ApplySilentParameters"), /if ParamGiven\('LLMKEY'\) then\s+begin\s+RemoteKeyEdit\.Text := Param\('LLMKEY', ''\);\s+KeySaved := False;\s+end;/u);
});

test("a saved key that cannot be used is told in the setup's words, never the launcher's usage text, for the endpoint page's save and the progress page's save", () => {
  const text = functionBody("ConfigureFailure");
  assert.match(text, /KeySaved and ModelRemoteRadio\.Checked and \(Code = USAGE_EXIT_CODE\)/u);
  assert.match(code, /SAVED_KEY_UNUSABLE_TEXT = '[^']*Type the key again in the API key box[^']*\/LLMKEY=/u);
  assert.match(functionBody("SaveAndTestEndpoint"), /ConfigureFailure\('Mine AI could not save the endpoint\.', Code\)/u);
  assert.match(functionBody("RunConfigure"), /ConfigureFailure\('Mine AI could not save your choices in settings\.json\.', Code\)/u);
  // Exit 2 is the launcher's code for any usage error, so a URL its configure refuses (a scheme with nothing after it) must be refused by the
  // setup first, or a good saved key would be reported unusable.
  assert.match(functionBody("RemoteUrlProblem"), /\(Trim\(RemoteUrlEdit\.Text\) = 'http:\/\/'\) or \(Trim\(RemoteUrlEdit\.Text\) = 'https:\/\/'\)/u);
});

test("the launcher answers a configure that cannot keep the saved key with the exit code the setup reads as 'key unusable'", async () => {
  assert.equal(Number(/^\s+USAGE_EXIT_CODE = (\d+);/mu.exec(iss)?.[1]), 2);
  const t = setup();
  // No settings at all: no saved key (a blob another user wrote gives the same UsageError, configure-command.test.ts).
  const exit = await runCli(["configure", "--llm-remote-saved-key", VALUES["<url>"]!, VALUES["<model>"]!], t.context);
  assert.equal(exit, Number(/^\s+USAGE_EXIT_CODE = (\d+);/mu.exec(iss)?.[1]));
  assert.equal(existsSync(settingsPath(t.root)), false, "a refused configure wrote the settings");
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

interface TestCompiler {
  readonly program: string;
  /** A path of this machine as the compiler reads it (WSL: `wslpath -w`). */
  readonly path: (file: string) => string;
}

/** ISCC.exe: on Windows from `INNO_SETUP` or the default folders (as the release build); in WSL the same folders through the Windows drive. Undefined when Inno Setup is not installed. */
function findIsccForTests(): TestCompiler | undefined {
  if (process.platform === "win32") {
    try {
      return { program: findInnoCompiler(process.env, existsSync), path: (file) => file };
    } catch {
      return undefined;
    }
  }
  const users = existsSync("/mnt/c/Users") ? readdirSync("/mnt/c/Users").map((user) => `/mnt/c/Users/${user}/AppData/Local/Programs/Inno Setup 6`) : [];
  const folders = process.env.INNO_SETUP === undefined ? ["/mnt/c/Program Files (x86)/Inno Setup 6", "/mnt/c/Program Files/Inno Setup 6", ...users] : [process.env.INNO_SETUP];
  const program = folders.map((folder) => join(folder, "ISCC.exe")).find((file) => existsSync(file));
  if (program === undefined) return undefined;
  return { program, path: (file) => spawnSync("wslpath", ["-w", file], { encoding: "utf8" }).stdout.trim() };
}

// Pascal Script is only checked by a real compile: a typo or a property Inno lacks on the endpoint page is otherwise found by the
// master's build. ISCC runs on a stand-in stage folder (a bun.exe and a persona file), so the compile takes seconds.
// Facts "Inno Setup script": MSYS2_ARG_CONV_EXCL="*" keeps Git Bash from rewriting the /D arguments; the /D paths are absolute.
const compiler = findIsccForTests();
test("the real script compiles with Inno Setup's ISCC", { skip: compiler === undefined ? "ISCC.exe not found (set INNO_SETUP to Inno Setup 6's folder; in WSL as a /mnt/c/... path)" : false, timeout: 120_000 }, () => {
  mkdirSync(join(repoRoot, ".tmp"), { recursive: true });
  const work = mkdtempSync(join(repoRoot, ".tmp", "iss-compile-"));
  try {
    const stage = join(work, "stage");
    mkdirSync(join(stage, "personas"), { recursive: true });
    writeFileSync(join(stage, "bun.exe"), "stand-in");
    writeFileSync(join(stage, "personas", "stand-in.json"), "{}");
    const args = [`/DStageDir=${compiler!.path(stage)}`, `/DOutputDir=${compiler!.path(join(work, "out"))}`, "/DAppVersion=0.0.0", compiler!.path(join(repoRoot, "packaging", "windows", "mine-ai.iss"))];
    const result = spawnSync(compiler!.program, args, { encoding: "utf8", env: { ...process.env, MSYS2_ARG_CONV_EXCL: "*" } });
    const output = `${result.stdout}\n${result.stderr}`;
    // ISCC prints "Error on line <n> in <file>: Column <c>:" and, on the next line, what is wrong.
    const error = output.slice(Math.max(0, output.search(/^Error on line/mu)));
    assert.equal(result.status, 0, error);
  } finally {
    // maxRetries: a virus scanner may hold the freshly written setup exe for a moment on Windows.
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
