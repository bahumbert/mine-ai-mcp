// The Inno Setup script (packaging/windows/mine-ai.iss) is Pascal, not run by tests. What can be checked is that the calls
// it makes to the launcher are real: its `CALLS` comment lines name, per silent parameter set, the launcher calls in
// order; this test runs each on the launcher's CLI, and compares the lines with the code and with the player's doc.
// The other subjects of the script have their own files: iss-install-flow, iss-model-page, iss-endpoint-page, iss-compile.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { runConfigureCommand } from "../configure-command.ts";
import { runInstallCommand } from "../install-command.ts";
import { runCli } from "../main.ts";
import { loadManifest } from "../manifest.ts";
import { loadSettings, settingsPath } from "../settings.ts";
import { code, doc, iss, setup, VALUES } from "./iss-test-support.ts";

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
    const settings = (): { llm?: { kind: string }; server?: { kind: string }; checkUpdates?: boolean } => JSON.parse(readFileSync(join(t.root, "settings.json"), "utf8")) as never;
    const wanted = (name: string): string | undefined => parameters.find((parameter) => parameter.startsWith(`/${name}=`))?.slice(name.length + 2);
    if (wanted("LLM") !== undefined) assert.equal(settings().llm?.kind, wanted("LLM"), label);
    if (wanted("SERVER") !== undefined) assert.equal(settings().server?.kind, wanted("SERVER"), label);
    // The update check is on unless /CHECKUPDATES=0 is given (the setup's default at a first install).
    if (calls.some((call) => call.startsWith("configure "))) assert.equal(settings().checkUpdates, wanted("CHECKUPDATES") !== "0", label);
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

test("the doc names Inno's own /DIR= beside the table, not in it: the script never reads it through Param", () => {
  const prose = doc.split(/\r?\n/u).filter((line) => !line.startsWith("|")).join("\n");
  assert.match(prose, /`\/DIR=`/u);
  assert.doesNotMatch(doc, /^\| `\/DIR=/mu);
});

test("the launcher answers a configure that cannot keep the saved key with the exit code the setup reads as 'key unusable'", async () => {
  assert.equal(Number(/^\s+USAGE_EXIT_CODE = (\d+);/mu.exec(iss)?.[1]), 2);
  const t = setup();
  // No settings at all: no saved key (a blob another user wrote gives the same UsageError, configure-command.test.ts).
  const exit = await runCli(["configure", "--llm-remote-saved-key", VALUES["<url>"]!, VALUES["<model>"]!], t.context);
  assert.equal(exit, Number(/^\s+USAGE_EXIT_CODE = (\d+);/mu.exec(iss)?.[1]));
  assert.equal(existsSync(settingsPath(t.root)), false, "a refused configure wrote the settings");
});
