// The Inno Setup script (packaging/windows/mine-ai.iss) is Pascal, not run by tests. What can be checked is that the calls
// it makes to the launcher are real: its `CALLS` comment lines name, per silent parameter set, the launcher calls in
// order; this test runs each on the launcher's CLI, and compares the lines with the code and with the player's doc.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CliContext } from "../cli-context.ts";
import { runConfigureCommand } from "../configure-command.ts";
import { INSTALL_STEP_NAMES, runInstallCommand, type InstallSteps } from "../install-command.ts";
import { loadManifest } from "../manifest.ts";

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

test("every launcher call of every silent parameter set runs on the CLI and leaves the settings the parameters name", async () => {
  for (const { parameters, calls } of callsLines()) {
    const t = setup();
    const label = `${parameters.join(" ")}: ${calls.join("; ")}`;
    const installs: string[] = [];
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
  }
});

test("the CALLS lines name every flag and install step the .iss code uses, and nothing it does not", () => {
  const documented = callsLines().flatMap((line) => line.calls);
  const flagsIn = (text: string): string[] => [...new Set([...text.matchAll(/--[a-z]+(?:-[a-z]+)*/gu)].map((match) => match[0]))].filter((flag) => flag !== "--json").sort();
  assert.deepEqual(flagsIn(documented.join(" ")), flagsIn(code));
  const stepsInCode = [...code.matchAll(/(?:'install |RunSetupStep\('|RunInstallStepWithRetry\(')([a-z]+(?:-[a-z]+)*)/gu)].map((match) => match[1]!);
  const stepsDocumented = documented.filter((call) => call.startsWith("install ")).map((call) => call.split(" ")[1]!);
  assert.deepEqual([...new Set(stepsInCode)].sort(), [...new Set(stepsDocumented)].sort());
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
  const stop = prepare.indexOf("RunLauncherAndWait('stop')");
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
