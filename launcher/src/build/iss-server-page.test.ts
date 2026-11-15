// The Inno Setup script (packaging/windows/mine-ai.iss), the Minecraft server page's program choice (plan 2026-11-14-p4-31-paper-server,
// Task 9b): Paper (recommended) or vanilla for a local server, saved in settings.json `server.program`, passed to `configure
// --server-program`, shown on the Ready page and in the silent parameters. Pascal is not run: each test reads the script's code
// (iss-test-support.ts) for what must hold.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { code, doc, functionBody, iss, issIncludes, issPath } from "./iss-test-support.ts";

const PAPER_TEXT = "The same game, run by a faster server program. With many companions spread over the world it keeps the game close to full speed (about 20 ticks a second in our test with 20 companions at work, where the standard server fell behind three to four times as often). What changes: animals and monsters far from every player move less.";
const VANILLA_TEXT = "The standard server program. It may slow down with many companions.";
const REMOTE_WORDS = "vanilla or Paper Minecraft 1.21.4 with online-mode=false";

/** A Pascal string literal's text: the `''` of the source is the one quote it stands for. */
const pascal = (text: string): string => text.replace(/'/gu, "''");

test("the server page's code is in server-page.iss, pulled in after the endpoint page's, and mine-ai.iss no longer holds it", () => {
  const includes = issIncludes();
  const server = includes.find((include) => include.name === "server-page.iss");
  assert.ok(server, 'mine-ai.iss has no #include "server-page.iss"');
  assert.ok(server.exists, "server-page.iss does not exist next to mine-ai.iss");
  const script = readFileSync(issPath, "utf8");
  assert.ok(script.indexOf('#include "server-page.iss"') > script.indexOf('#include "endpoint-page.iss"'), "the server page uses EndpointPage.ID: its include comes after the endpoint page's");
  const own = readFileSync(server.path, "utf8");
  for (const name of ["AddProgramRadio", "ProgramWords", "ServerDownloadCaption", "ShowServerDownloadText", "ServerChoiceChanged", "ServerProgramArgument", "CreateServerPage"]) {
    assert.match(own, new RegExp(`^(?:function|procedure) ${name}\\b`, "mu"), `${name} is not in server-page.iss`);
    assert.doesNotMatch(script, new RegExp(`^(?:function|procedure) ${name}\\b`, "mu"), `${name} is still in mine-ai.iss`);
  }
});

test("the program radios have their own parent: a panel made on the server page, not ServerPage.Surface", () => {
  const page = functionBody("CreateServerPage");
  assert.match(page, /ServerProgramPanel := TPanel\.Create\(ServerPage\);/u);
  assert.match(page, /ServerProgramPanel\.Parent := ServerPage\.Surface;/u);
  // The radios are made by the helper that parents them to the panel they are given; AddRadio would put them on the page's surface,
  // where Windows makes them one group with the three server radios (one click would uncheck the other group).
  assert.match(page, /ServerPaperRadio := AddProgramRadio\(ServerProgramPanel, /u);
  assert.match(page, /ServerVanillaRadio := AddProgramRadio\(ServerProgramPanel, /u);
  assert.doesNotMatch(page, /Server(?:Paper|Vanilla)Radio := AddRadio\(/u);
  // The radio and its text both sit on the panel (two parents set to it), so a disabled panel covers the whole block.
  assert.match(functionBody("AddProgramRadio"), /\.Parent := Panel;[\s\S]*\.Parent := Panel;/u);
});

test("the program radios and their texts carry the owner's words verbatim", () => {
  assert.ok(code.includes("'Paper (recommended)'"));
  assert.ok(code.includes("'Vanilla (Mojang''s own server)'"));
  assert.ok(code.includes(`'${pascal(PAPER_TEXT)}'`), "the Paper text is not the one of the plan");
  assert.ok(code.includes(`'${pascal(VANILLA_TEXT)}'`), "the vanilla text is not the one of the plan");
});

test("a first install checks Paper, and a prefill without a settings file or a local server goes back to it", () => {
  assert.match(functionBody("CreateServerPage"), /ServerPaperRadio\.Checked := True;/u);
  const prefill = functionBody("PrefillFromSettings");
  const reset = prefill.indexOf("ServerPaperRadio.Checked := True;");
  assert.ok(reset >= 0 && reset < prefill.indexOf("ReadSettingsSections("), "the prefill does not reset the program to Paper before it reads the file");
});

test("an update prefills the saved program: `\"program\":\"vanilla\"` checks vanilla, no key checks vanilla, only \"paper\" checks Paper", () => {
  const prefill = functionBody("PrefillFromSettings");
  const local = /if Kind = 'local' then\s+begin([\s\S]*?)\n    end\s+else if Kind = 'remote'/u.exec(prefill)?.[1];
  assert.notEqual(local, undefined, "the local branch of the prefill has another shape");
  assert.match(local!, /ServerLocalRadio\.Checked := True;/u);
  assert.match(local!, /if JsonString\(Server, 'program'\) = 'paper' then\s+ServerPaperRadio\.Checked := True\s+else\s+ServerVanillaRadio\.Checked := True;/u);
});

test("/SERVERPROGRAM=vanilla is passed to configure: `configure --server-local --server-program vanilla`, Paper is the other word", () => {
  const args = functionBody("ConfigureArguments");
  assert.match(args, /if ServerLocalRadio\.Checked then\s+Result := Result \+ ' --server-local' \+ ServerProgramArgument\(\)/u);
  const program = functionBody("ServerProgramArgument");
  assert.match(program, /if ServerVanillaRadio\.Checked then\s+Result := ' --server-program vanilla'\s+else\s+Result := ' --server-program paper';/u);
  const silent = functionBody("ApplySilentParameters");
  assert.match(silent, /Param\('SERVERPROGRAM', PARAM_UNSET\)/u);
  assert.match(silent, /ServerVanillaRadio\.Checked := True/u);
  assert.match(silent, /ServerPaperRadio\.Checked := True/u);
  // The parameter is read after the prefill, so a parameter not given keeps the saved program.
  assert.ok(silent.indexOf("PrefillFromSettings()") < silent.indexOf("'SERVERPROGRAM'"));
  assert.match(functionBody("SilentParameterProblem"), /'\/SERVERPROGRAM= must be paper or vanilla\.'/u);
});

test("the CALLS lines have a first install's Paper and /SERVERPROGRAM=vanilla, and the header and the doc list the parameter", () => {
  assert.match(iss, /^\/\/\s+CALLS \/LLM=local \/SERVER=local \/EULA=accept: [^\n]*configure --llm-local --server-local --server-program paper --check-updates on;/mu);
  assert.match(iss, /^\/\/\s+CALLS \/LLM=local \/SERVER=local \/SERVERPROGRAM=vanilla \/EULA=accept: [^\n]*configure --llm-local --server-local --server-program vanilla --check-updates on;/mu);
  assert.match(iss, /\/SERVERHOST= \/SERVERPORT= \/SERVERPROGRAM=paper\|vanilla/u);
  assert.match(doc, /^\| `\/SERVERPROGRAM=` \| `paper` or `vanilla` \|/mu);
  assert.match(doc, /mine-ai configure --server-local --server-program paper\|vanilla/u);
});

test("the Ready summary names the program: the saved one in words, vanilla when the file holds none", () => {
  const summary = functionBody("SettingsSummary");
  assert.match(summary, /ProgramWords\(JsonString\(ServerSection, 'program'\)\)/u);
  assert.match(functionBody("ProgramWords"), /if Saved = 'paper' then\s+Result := 'Paper'\s+else\s+Result := 'vanilla';/u);
});

test("the program radios are disabled unless the local server is chosen, and a change of the server radios refreshes the download line", () => {
  const changed = functionBody("ServerChoiceChanged");
  for (const control of ["ServerProgramPanel", "ServerPaperRadio", "ServerVanillaRadio"]) assert.match(changed, new RegExp(`${control}\\.Enabled := ServerLocalRadio\\.Checked;`, "u"));
  assert.match(functionBody("CreateServerPage"), /ServerPaperRadio\.OnClick := @ServerChoiceChanged;\s+ServerVanillaRadio\.OnClick := @ServerChoiceChanged;/u);
  assert.match(changed, /ShowServerDownloadText\(\)/u);
});

test("the remote texts say vanilla or Paper: the server page's note and the finish page's line", () => {
  assert.ok(code.includes(`${REMOTE_WORDS} (the bots join without a Minecraft account)`), "the server page's note");
  assert.ok(functionBody("JoinText").includes(`That server must be ${REMOTE_WORDS}.`), "the finish page's line");
  assert.doesNotMatch(code, /must be vanilla Minecraft 1\.21\.4/u);
});

test("the download line names PaperMC for Paper and Mojang alone for vanilla, and is written when the page shows and when the choice changes", () => {
  const caption = functionBody("ServerDownloadCaption");
  assert.match(caption, /if ServerPaperRadio\.Checked then/u);
  const [paper, vanilla] = caption.split(/\n\s*else\b/u);
  assert.match(paper!, /PaperMC/u);
  assert.match(paper!, /Mojang/u, "Paper needs Mojang's server file too: the line says so");
  assert.doesNotMatch(vanilla!, /PaperMC/u);
  assert.match(vanilla!, /Mojang/u);
  assert.match(functionBody("ShowServerDownloadText"), /ServerDownloadText\.Caption := ServerDownloadCaption\(\);/u);
  const shown = functionBody("CurPageChanged");
  assert.match(shown, /else if CurPageID = ServerPage\.ID then\s+begin\s+ShowServerDownloadText\(\);/u);
});

test("the server page's rows do not overlap: the panel under the local radio, then the remote radio, the address, the remote note and the download line", () => {
  const page = functionBody("CreateServerPage");
  const number = (pattern: RegExp, what: string): number => {
    const match = pattern.exec(page);
    assert.notEqual(match, null, `${what} is not placed with a number`);
    return Number(match![1]);
  };
  const local = number(/ServerLocalRadio := AddRadio\(ServerPage, '[^\n]*', (\d+)\)/u, "the local radio");
  const panelTop = number(/ServerProgramPanel\.Top := ScaleY\((\d+)\);/u, "the panel's top");
  const panelHeight = number(/ServerProgramPanel\.Height := ScaleY\((\d+)\);/u, "the panel's height");
  const remote = number(/ServerRemoteRadio := AddRadio\(ServerPage, '[^\n]*', (\d+)\)/u, "the remote radio");
  const address = number(/AddText\(ServerPage, 'Address', (\d+), /u, "the address label");
  const edits = number(/ServerHostEdit := AddEdit\(ServerPage, (\d+), /u, "the address edits");
  const note = /AddText\(ServerPage, '[^\n]*online-mode=false[^\n]*', (\d+), (\d+)\)/u.exec(page);
  const download = /ServerDownloadText := AddText\(ServerPage, '', (\d+), (\d+)\)/u.exec(page);
  assert.ok(note !== null && download !== null, "the note or the download line is not placed with numbers");
  assert.ok(local + 17 <= panelTop, "the panel overlaps the local radio");
  assert.ok(panelTop + panelHeight <= remote, "the remote radio overlaps the panel");
  assert.ok(remote + 17 <= address, "the address label overlaps the remote radio");
  assert.ok(address + 14 <= edits, "the address edits overlap their label");
  assert.ok(edits + 23 <= Number(note![1]), "the remote note overlaps the address edits");
  assert.ok(Number(note![1]) + Number(note![2]) <= Number(download![1]), "the download line overlaps the remote note");
});
