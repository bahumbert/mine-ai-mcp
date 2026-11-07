; Mine AI installer (Inno Setup 6.4 or later: ExecAndLogOutput), built by launcher/src/build/build-windows.ts, which passes:
;   /DStageDir=<staged package> /DOutputDir=<folder for the setup exe> /DAppVersion=<manifest version>
;   and, for a signed build, /DSign=1 /SMineAiSign=<sign command with $f>.
; The pages after the file copy ask the questions: the GPU check, the endpoint test and the downloads are
; `bun.exe launcher\src\main.js install <step>` (the launcher's own tested code, bundled), and the launcher is on disk only after
; the copy. The first of these pages has no Back button, so an interrupted setup is finished by running the installer
; again (every install step resumes, and the pages start from the saved settings.json).
; Silent install (/SILENT or /VERYSILENT): one command-line parameter per wizard choice, read by `Param()` below and
; listed in docs/install/windows.md (launcher/src/build/iss-launcher-calls.test.ts keeps the two in step):
;   /LLM=local|remote /LLMURL= /LLMKEY= /LLMMODEL= /SERVER=none|local|remote /SERVERHOST= /SERVERPORT=
;   /DATADIR= /OLLAMADIR= /EULA=accept /CHECKUPDATES=0|1 /STARTNOW=0|1; uninstall: /DELETEDATA=0|1.
; The app folder is Inno's own /DIR=; the data folder (/DATADIR=) and the Ollama folder (/OLLAMADIR=) are asked by pages of
; this script. The folders chosen at the first install are kept by every update; the uninstaller removes them.
; A parameter not given keeps the choice saved in settings.json by an earlier install, else the first value listed.
; Setup runs the same code as the progress page (AllSetupStepsSucceed); a failed step ends the setup with a non-zero exit
; code (7 for a wrong parameter, 100 for a failed step) and the error and hint in the /LOG= file. Pass /SUPPRESSMSGBOXES
; too: Setup's own error boxes are not silent without it.
; iss-compile.test.ts compiles it with ISCC (a stand-in stage folder) when Inno Setup is installed; W5 walks every page.
; The [Code] section is split in two files: this one, and endpoint-page.iss (the endpoint page and its key box), pulled in by `#include`
; where its code used to stand. ISCC reads the included file from this file's folder; the tests read the two as one (iss-test-support.ts).

#ifndef StageDir
  #error StageDir is not defined: build with launcher/src/build/build-windows.ts.
#endif
; The launcher's entry in the built app (build-windows.ts bundles the sources into a few .js files that keep the source paths), and
; the same file in the version before the bundle, which an update meets in {app} until its copy has run.
#define LauncherScript "launcher\src\main.js"
#define SourceLauncherScript "launcher\src\main.ts"
; The privacy page the update-check box and the Ready list point to (SignPath asks for the privacy policy at install, spec D5).
#define PrivacyUrl "https://github.com/bahumbert/mine-ai-mcp/blob/main/docs/privacy.md"
#ifndef OutputDir
  #error OutputDir is not defined: build with launcher/src/build/build-windows.ts.
#endif
#ifndef AppVersion
  #error AppVersion is not defined: build with launcher/src/build/build-windows.ts.
#endif

[Setup]
; Fixed: a new installer with this AppId installs over the old one and keeps the folders chosen at the first install (D6).
AppId={{6D0F3C2A-8B1E-4F57-9A64-2E7C5B91D3A8}
AppName=Mine AI
AppVersion={#AppVersion}
AppPublisher=AI Bengineering
; The version resource of the setup file. SignPath's artifact configuration restricts the product name and version (rule "product name
; and version"), so the product name is written here and does not follow a later AppName change; Inno's defaults give the file
; description "Mine AI Setup" (iss-compile.test.ts compiles the script).
VersionInfoVersion={#AppVersion}
VersionInfoProductVersion={#AppVersion}
VersionInfoProductName=Mine AI
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\MineAI
DefaultGroupName=Mine AI
; auto: the folder page shows at a first install only; an update keeps the first folder (UsePreviousAppDir).
DisableDirPage=auto
; Without it the Ready list has no destination when the folder page was skipped (an update): UpdateReadyMemo starts from it.
AlwaysShowDirOnReadyPage=yes
DisableProgramGroupPage=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutputDir}
OutputBaseFilename=MineAI-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=Mine AI
UninstallDisplayIcon={app}\bun.exe
#ifdef Sign
SignTool=MineAiSign
SignedUninstaller=yes
#endif

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
; The tasks page shows at a first install only (ShouldSkipPage); an update keeps what settings.json says (SavedCheckUpdates).
Name: "checkupdates"; Description: "Check for a newer Mine AI at each start (one request to GitHub's release list: GitHub sees this PC's address, nothing else is sent). Privacy: {#PrivacyUrl}"

[Dirs]
; The data folder is the player's choice (DataDir in [Code]); the uninstaller deletes it by itself, and only on request.
Name: "{code:DataDir}"; Flags: uninsneveruninstall

[InstallDelete]
; An update over a version that shipped its sources (about 11,000 files, most of them node_modules): Setup runs this before it copies
; [Files], so the bundle lands in clean folders. Never data-root.txt (the player's data folder) or unins000.* (the uninstaller).
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\src"
Type: filesandordirs; Name: "{app}\brain\src"
Type: filesandordirs; Name: "{app}\launcher\src"
Type: filesandordirs; Name: "{app}\patches"
Type: files; Name: "{app}\package.json"
Type: files; Name: "{app}\bun.lock"

[Files]
; The app, without the personas: a user's edit of a persona survives updates (second entry).
Source: "{#StageDir}\*"; DestDir: "{app}"; Excludes: "\personas\*"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "{#StageDir}\personas\*"; DestDir: "{code:DataDir}\personas"; Flags: onlyifdoesntexist uninsneveruninstall

[Icons]
; The console takes the shortcut's name as its title.
Name: "{group}\Mine AI"; Filename: "{app}\bun.exe"; Parameters: "{#LauncherScript} console"; WorkingDir: "{app}"; Comment: "Start the Mine AI bots"
Name: "{group}\Uninstall Mine AI"; Filename: "{uninstallexe}"

[Run]
; Hidden on the finish page when the setup steps failed (CurPageChanged).
Filename: "{app}\bun.exe"; Parameters: "{#LauncherScript} console"; WorkingDir: "{app}"; Description: "Start Mine AI now"; Flags: postinstall nowait; Check: StartNowWanted

[UninstallDelete]
Type: filesandordirs; Name: "{app}"

[Code]
const
  MINECRAFT_EULA_URL = 'https://aka.ms/MinecraftEULA';
  PROGRESS_STEPS = 1000;
  // The port of the server page's box at creation, of the prefill's reset and of the configure fallback.
  DEFAULT_SERVER_PORT = 25565;
  // The default of a silent parameter that was not given; no real value looks like it.
  PARAM_UNSET = '(not given)';
  // Setup's own exit codes are 0-8; a silent setup whose steps failed returns this one.
  SILENT_FAILURE_EXIT_CODE = 100;
  // `mine-ai stop` ends 3 when the launcher is still starting, does not answer or did not finish stopping (control-commands.ts, kept equal by
  // iss-install-flow.test.ts); any other non-zero code (a stop that throws, a bundle Bun cannot load: 1) is a stop that failed, not a refusal.
  // RunLauncherAndWait gives LAUNCHER_NOT_STARTED when bun.exe or the launcher is missing or cannot start: that is no refusal to stop either.
  STOP_REFUSED_EXIT_CODE = 3;
  LAUNCHER_NOT_STARTED = -1;
  // The launcher's exit code for arguments it cannot use (main.ts runCli; iss-launcher-calls.test.ts runs it). `configure
  // --llm-remote-saved-key` ends with it when the settings hold no key it can read: another Windows user's or PC's blob, or none.
  USAGE_EXIT_CODE = 2;
  // The key box shows this (masked) while the settings hold an encrypted key: the setup never decrypts, so it has no key to show. The
  // mark of a saved key reaches no launcher call (KeyWasSaved and the mark in the box make KeySaved); a mark typed with no saved key is a typed key.
  SAVED_KEY_MARK = 'saved-key-unchanged';
  KEY_ENCRYPTED_NOTICE = 'Your API key is now stored encrypted for this Windows user; it no longer appears in clear in settings.json.';
  // What the free-space figures (`install disk`) leave out (owner 2026-11-06: no measure of Ollama's own temporary files, only this warning).
  // The model page, the Ready list and the silent log say it.
  ROOM_WARNING_TEXT = 'The setup counts the downloads and installs only. Ollama''s own installer also needs temporary room on the Windows drive (C:) while it runs, and the bots'' memories and worlds grow as they play: keep several GB free.';
  SAVED_KEY_UNUSABLE_TEXT = 'The API key saved earlier cannot be used: it was saved by another Windows user or on another PC, or settings.json no longer holds it. Type the key again in the API key box, replacing the dots (silent install: /LLMKEY=).';
  // The same cause for a silent run, which has no key box: the next action is the parameter.
  SAVED_KEY_UNUSABLE_SILENT_TEXT = 'The API key saved earlier cannot be used: it was saved by another Windows user or on another PC, or settings.json no longer holds it. Run the setup again with /LLMKEY=<the key>.';
  // What the player does by hand when a removal asked for at uninstall did not happen: {app} is gone by then, so no "run this step again".
  OLLAMA_REMOVE_BY_HAND = 'Remove Ollama yourself: Windows Settings > Apps > Installed apps > Ollama > Uninstall.';
  // Setup stores the data folder under this name (GetPreviousData/SetPreviousData); the uninstaller reads it back from the
  // uninstall key of this script's AppId (the test in iss-install-flow.test.ts keeps the two in step) as the value
  // "Inno Setup CodeFile: DataDir".
  DATA_DIR_KEY = 'DataDir';
  UNINSTALL_KEY = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{6D0F3C2A-8B1E-4F57-9A64-2E7C5B91D3A8}_is1';
  UNINSTALL_DATA_DIR_VALUE = 'Inno Setup CodeFile: DataDir';
  // The marker that makes a data folder deletable by the uninstaller; the launcher reads {app}\data-root.txt (paths.ts).
  DATA_MARKER_FILE = 'mine-ai-data.txt';
  DATA_MARKER_TEXT = 'Mine AI data folder; deleted with its contents when you uninstall Mine AI and choose to delete your data.';
  DATA_ROOT_FILE = 'data-root.txt';

var
  DataPage: TInputDirWizardPage;
  // The endpoint page's variables are in endpoint-page.iss.
  ModelPage, ServerPage, EulaPage, StepsPage: TWizardPage;
  ModelStatus, DiskStatus, ModelStepStatus, OllamaDirLabel, ServerDownloadText: TNewStaticText;
  ModelLocalRadio, ModelRemoteRadio: TNewRadioButton;
  OllamaDirEdit: TEdit;
  OllamaBrowseButton: TButton;
  ModelGauge: TNewProgressBar;
  ServerNoneRadio, ServerLocalRadio, ServerRemoteRadio: TNewRadioButton;
  ServerHostEdit, ServerPortEdit: TEdit;
  EulaCheck: TNewCheckBox;
  StepsStatus: TNewStaticText;
  StepsGauge: TNewProgressBar;
  StepsLog: TNewMemo;
  ActiveGauge: TNewProgressBar;
  ActiveStatus: TNewStaticText;
  GpuChecked, GpuVerdictIsRemote, OllamaFolderNeeded, OllamaReady, SetupDone, PreviousLlmWasRemote, SilentWantsLocalModel: Boolean;
  // The update check the saved settings.json holds (PrefillFromSettings); an update keeps it, a first install asks (CheckUpdatesWanted).
  SavedCheckUpdates: Boolean;
  LastLogTail, GpuProblem, GpuReason, SetupFailure, SilentFailure, StepsDoneFor, DataFolderFailure, OllamaFolderChecked: String;
  DeleteDataOnUninstall, RemoveModelOnUninstall, RemoveOllamaOnUninstall: Boolean;
  // Read once in InitializeUninstall: by usPostUninstall Inno has removed the uninstall key it comes from.
  UninstallDataDir: String;
  // What the uninstaller tells the player once, after its removals.
  UninstallNotes: String;

// ---------- folders: the app, the data and the Ollama folder are the player's to choose ----------

// The data folder of a player who chose none (and of every install before the folders were a choice).
function DefaultDataDir(): String;
begin
  Result := ExpandConstant('{localappdata}\MineAI');
end;

function NormalFolder(const Folder: String): String;
begin
  Result := RemoveBackslashUnlessRoot(ExpandFileName(Trim(Folder)));
end;

// The data folder of this run, for `{code:DataDir}` and every other use: Setup, the page's value (set from /DATADIR= when
// silent, from the previous install on an update); the uninstaller, the value read in InitializeUninstall.
function DataDir(Ignored: String): String;
begin
  if IsUninstaller() then
    Result := UninstallDataDir
  else if DataPage <> nil then
    Result := NormalFolder(DataPage.Values[0])
  else
    Result := DefaultDataDir();
end;

// The data folder of the install being updated, '' at a first install. An install made before the folders were a choice saved
// no DataDir: when there is a previous program folder (WizardForm.PrevAppDir) its data is in the default folder.
function PreviousDataDir(): String;
begin
  Result := GetPreviousData(DATA_DIR_KEY, '');
  if (Result = '') and (WizardForm.PrevAppDir <> '') then
    Result := DefaultDataDir();
end;

// A full path (a drive letter, a colon, a backslash): a relative one would resolve from Setup's own current folder.
function IsFullFolder(const Folder: String): Boolean;
var
  Text: String;
begin
  Text := Trim(Folder);
  Result := (Length(Text) >= 3) and (Text[2] = ':') and (Text[3] = '\') and (Uppercase(Text[1]) >= 'A') and (Uppercase(Text[1]) <= 'Z');
end;

function SameFolder(const A, B: String): Boolean;
begin
  Result := CompareText(NormalFolder(A), NormalFolder(B)) = 0;
end;

// True for the folder itself too.
function FolderIsInside(const Inner, Outer: String): Boolean;
begin
  Result := Pos(AddBackslash(Lowercase(NormalFolder(Outer))), AddBackslash(Lowercase(NormalFolder(Inner)))) = 1;
end;

function FolderHoldsFiles(const Folder: String): Boolean;
var
  Found: TFindRec;
begin
  Result := False;
  if FindFirst(AddBackslash(Folder) + '*', Found) then
  begin
    try
      repeat
        if (Found.Name <> '.') and (Found.Name <> '..') then
          Result := True;
      until Result or (not FindNext(Found));
    finally
      FindClose(Found);
    end;
  end;
end;

// What the uninstaller may delete. `unins000.exe` and `settings.json` sit in many other programs' folders, so neither proves a
// folder ours: the program folder holds the launcher, the data folder the marker (or is the default folder of a data folder
// made before there was a marker). Never the Ollama folder: Ollama's own setup and uninstaller own it.
function FolderIsOurs(const Folder, Kind: String): Boolean;
begin
  if Kind = 'app' then
    Result := FileExists(AddBackslash(Folder) + '{#LauncherScript}') or FileExists(AddBackslash(Folder) + '{#SourceLauncherScript}')
  else if Kind = 'data' then
    Result := FileExists(AddBackslash(Folder) + DATA_MARKER_FILE) or SameFolder(Folder, DefaultDataDir())
  else
    Result := False;
end;

// The folder itself when it exists, else its nearest existing parent; '' when not even the drive exists.
function NearestExistingFolder(const Folder: String): String;
var
  Parent: String;
begin
  Result := Folder;
  while (Result <> '') and (not DirExists(Result)) do
  begin
    Parent := ExtractFileDir(Result);
    // A root (`C:\`) is its own parent: stop there instead of looping. A path part that is a file (`C:\Games` as a file) cannot
    // hold the folder: no parent, so the install is refused here, as ForceDirectories refused it before.
    if (Length(Parent) >= Length(Result)) or FileExists(Result) then
      Result := ''
    else
      Result := Parent;
  end;
end;

// Whether Setup may make the folder, without making it (a check that creates what it checks left an empty program folder after a
// refusal, and made Inno show its own "folder already exists" box: W5 re-check, finding 1). A folder that exists gets a file
// probe. One that does not gets a sub-folder made and removed in its nearest existing parent, which is the permission the install
// will use: Setup runs without administrator rights, and Windows' default ACL may let it make a folder in `C:\` but not a file
// there, so a file probe in the parent would refuse C:\Games\MineAI. The sub-folder is named by the time, so it never meets a
// folder of the player's, and a parent that is a drive root gets the same probe.
function FolderIsWritable(const Folder: String): Boolean;
var
  Base, Probe: String;
begin
  Result := False;
  Base := NearestExistingFolder(Folder);
  if Base = '' then
    Exit;
  if DirExists(Folder) then
  begin
    Probe := AddBackslash(Folder) + '.mine-ai-write-test';
    Result := SaveStringToFile(Probe, 'x', False);
    DeleteFile(Probe);
  end
  else
  begin
    Probe := AddBackslash(Base) + '.mine-ai-write-test-' + GetDateTimeString('yyyymmddhhnnss', '-', '-');
    Result := CreateDir(Probe);
    if Result then
      RemoveDir(Probe);
  end;
end;

function FolderKindName(const Kind: String): String;
begin
  if Kind = 'app' then
    Result := 'The program folder'
  else if Kind = 'data' then
    Result := 'The data folder'
  else
    Result := 'The Ollama folder';
end;

// What is wrong with a folder the player chose ('app', 'data' or 'ollama'), else ''. Used by the wizard's Next button and by
// the silent parameters: a folder the uninstaller would delete must not be one that holds somebody else's files.
function FolderProblem(const Folder, Kind: String): String;
var
  Name: String;
begin
  Result := '';
  Name := FolderKindName(Kind);
  if not IsFullFolder(Folder) then
    Result := Name + ' must be a full path such as D:\Games\MineAI (got "' + Folder + '").'
  else if Length(NormalFolder(Folder)) <= 3 then
    Result := Name + ' cannot be a whole drive: choose a folder on it, for example ' + AddBackslash(NormalFolder(Folder)) + 'MineAI.'
  else if (Kind = 'data') and FolderIsInside(Folder, WizardDirValue) then
    Result := Name + ' cannot be the program folder or inside it, because the uninstaller removes the program folder. Choose another folder.'
  else if (Kind = 'ollama') and (FolderIsInside(Folder, WizardDirValue) or FolderIsInside(Folder, DataDir(''))) then
    Result := Name + ' cannot be inside the Mine AI program or data folder, because Ollama''s own uninstaller owns it. Choose another folder.'
  else if DirExists(NormalFolder(Folder)) and FolderHoldsFiles(NormalFolder(Folder)) and (not FolderIsOurs(NormalFolder(Folder), Kind)) then
    Result := Name + ' ' + NormalFolder(Folder) + ' already holds files that Mine AI did not put there. Choose an empty folder or a new one.'
  else if not FolderIsWritable(NormalFolder(Folder)) then
    Result := 'Mine AI cannot write in ' + NormalFolder(Folder) + '. Choose another folder.';
end;

// Right after the files are copied, in both modes and before any launcher call: the data folder, the marker that lets the
// uninstaller delete it, and {app}\data-root.txt (one UTF-8 line) that tells the launcher where the folder is. Without the
// last the launcher would work in the default folder, so a failure ends the setup (AllSetupStepsSucceed reads this).
procedure WriteDataFolderFiles();
var
  Folder: String;
  Line: TArrayOfString;
begin
  DataFolderFailure := '';
  Folder := DataDir('');
  SetArrayLength(Line, 1);
  Line[0] := Folder;
  if not ForceDirectories(Folder) then
    DataFolderFailure := 'Mine AI could not create the data folder ' + Folder + '. Run the installer again and choose another folder.'
  else if not SaveStringToFile(Folder + '\' + DATA_MARKER_FILE, DATA_MARKER_TEXT + #13#10, False) then
    DataFolderFailure := 'Mine AI could not write in the data folder ' + Folder + '. Run the installer again and choose another folder.'
  else if not SaveStringsToUTF8File(ExpandConstant('{app}\' + DATA_ROOT_FILE), Line, False) then
    DataFolderFailure := 'Mine AI could not write ' + ExpandConstant('{app}\' + DATA_ROOT_FILE) + ', which tells it where your data folder is.';
  if DataFolderFailure <> '' then
    Log(DataFolderFailure)
  else
    Log('Data folder ' + Folder + ' (' + ExpandConstant('{app}\' + DATA_ROOT_FILE) + ' written).');
end;

// ---------- the launcher: one `bun.exe launcher\src\main.js <args>` run, its output read line by line ----------

// Text as one command-line argument; backslashes before the closing quote are doubled (Windows argv rule).
function Quoted(const Text: String): String;
var
  Slashes: String;
  I: Integer;
begin
  Slashes := '';
  I := Length(Text);
  while (I > 0) and (Text[I] = '\') do
  begin
    Slashes := Slashes + '\';
    I := I - 1;
  end;
  Result := '"' + Text + Slashes + '"';
end;

// The value of the silent command-line parameter /Name=, else Default (which may not hold a comma, a bar or a closing brace).
function Param(const Name, Default: String): String;
begin
  Result := ExpandConstant('{param:' + Name + '|' + Default + '}');
end;

function ParamGiven(const Name: String): Boolean;
begin
  Result := Param(Name, PARAM_UNSET) <> PARAM_UNSET;
end;

// [Run] "Start Mine AI now": the finish page's box in the wizard; silent, only with /STARTNOW=1.
function StartNowWanted(): Boolean;
begin
  Result := (not WizardSilent) or (Param('STARTNOW', '0') = '1');
end;

// "0.42" -> 420; the decimal separator of the user's locale never enters (StrToFloat would read a comma).
function FractionPermille(const Text: String): Integer;
var
  Dot: Integer;
  Whole, Part: String;
begin
  Dot := Pos('.', Text);
  if Dot = 0 then
  begin
    Whole := Text;
    Part := '';
  end
  else
  begin
    Whole := Copy(Text, 1, Dot - 1);
    Part := Copy(Text, Dot + 1, 3);
  end;
  while Length(Part) < 3 do
    Part := Part + '0';
  Result := StrToIntDef(Whole, 0) * 1000 + StrToIntDef(Part, 0);
  if Result > PROGRESS_STEPS then
    Result := PROGRESS_STEPS;
end;

// Keeps the last 600 characters of what the launcher said (LastLogTail), for an error text.
procedure KeepLauncherLine(const Text: String);
begin
  LastLogTail := LastLogTail + Text + #13#10;
  if Length(LastLogTail) > 600 then
    LastLogTail := Copy(LastLogTail, Length(LastLogTail) - 599, 600);
end;

// Why a launcher run did not start: Windows refused bun.exe.
function BunNotStartedText(const App: String; ErrorCode: Integer): String;
begin
  Result := 'Windows could not start ' + App + '\bun.exe (error ' + IntToStr(ErrorCode) + ').';
end;

// Moves the bar and label on a `PROGRESS <0..1> <label>` line; keeps the last lines of anything else for an error text.
procedure OnLauncherLine(const Line: String; const Error, FirstLine: Boolean);
var
  Text, Rest: String;
  Space: Integer;
begin
  Text := Trim(Line);
  if Text = '' then
    Exit;
  if Copy(Text, 1, 9) = 'PROGRESS ' then
  begin
    Rest := Copy(Text, 10, Length(Text));
    Space := Pos(' ', Rest);
    if Space = 0 then
      Space := Length(Rest) + 1;
    ActiveGauge.Position := FractionPermille(Copy(Rest, 1, Space - 1));
    ActiveStatus.Caption := Trim(Copy(Rest, Space + 1, Length(Rest)));
    Exit;
  end;
  KeepLauncherLine(Text);
end;

// Runs the launcher hidden and waits (Setup keeps answering its window meanwhile). WithJson adds `--json <file>` and
// returns the StepResult text in JsonText; the exit code is the result.
function RunLauncher(const Args: String; WithJson: Boolean; Gauge: TNewProgressBar; Status: TNewStaticText; var JsonText: String): Integer;
var
  App, JsonFile, Params: String;
  Raw: AnsiString;
  ResultCode: Integer;
begin
  App := ExpandConstant('{app}');
  JsonFile := ExpandConstant('{tmp}\mine-ai-step.json');
  DeleteFile(JsonFile);
  JsonText := '';
  LastLogTail := '';
  ActiveGauge := Gauge;
  ActiveStatus := Status;
  Gauge.Position := 0;
  Params := Quoted(App + '\{#LauncherScript}') + ' ' + Args;
  if WithJson then
    Params := Params + ' --json ' + Quoted(JsonFile);
  if not ExecAndLogOutput(App + '\bun.exe', Params, App, SW_HIDE, ewWaitUntilTerminated, ResultCode, @OnLauncherLine) then
  begin
    LastLogTail := BunNotStartedText(App, ResultCode);
    Result := 1;
    Exit;
  end;
  Result := ResultCode;
  if WithJson then
  begin
    // The launcher writes UTF-8: a folder with an accent in a step's text reads back exact only through UTF8Decode.
    if LoadStringFromFile(JsonFile, Raw) then
      JsonText := UTF8Decode(Raw);
  end;
end;

// The launcher script an installed app folder can run, with the bun.exe beside it: the bundle of this version, else the sources of
// the version before it (an update meets those in {app} until the copy has run), else '' (nothing installed to stop). The one
// guard of every launcher run on an installed folder: without the second choice an update over an old install would never stop
// its running stack, and the copy would meet a locked bun.exe.
function InstalledLauncherScript(): String;
begin
  Result := '';
  if not FileExists(ExpandConstant('{app}\bun.exe')) then
    Exit;
  if FileExists(ExpandConstant('{app}\{#LauncherScript}')) then
    Result := ExpandConstant('{app}\{#LauncherScript}')
  else if FileExists(ExpandConstant('{app}\{#SourceLauncherScript}')) then
    Result := ExpandConstant('{app}\{#SourceLauncherScript}');
end;

// The callback of a launcher run outside the wizard's steps (PrepareToInstall and the uninstaller have no progress bar): logs each
// line and keeps the last ones for the message. It touches no wizard control: OnLauncherLine writes ActiveGauge and ActiveStatus,
// which are nil here. Probe (Inno Setup 6.7.3, 2026-11-01): ExecAndLogOutput works in the uninstaller the same way.
procedure OnLauncherLogLine(const Line: String; const Error, FirstLine: Boolean);
var
  Text: String;
begin
  Text := Trim(Line);
  if Text = '' then
    Exit;
  Log('launcher: ' + Text);
  KeepLauncherLine(Text);
end;

// A launcher run outside the wizard's steps: stopping the stack before an update or an uninstall, and the uninstaller's removals.
// Returns the exit code (LAUNCHER_NOT_STARTED when the launcher is not there or Windows cannot start it) and, in Lines, the last
// lines it said (or why it did not start). Every caller logs both with LogLauncherResult.
function RunLauncherAndWait(const Args: String; var Lines: String): Integer;
var
  ResultCode: Integer;
  App, Script: String;
begin
  Lines := '';
  App := ExpandConstant('{app}');
  Script := InstalledLauncherScript();
  if Script = '' then
  begin
    Lines := 'The launcher is not in ' + App + '.';
    Result := LAUNCHER_NOT_STARTED;
    Exit;
  end;
  LastLogTail := '';
  if not ExecAndLogOutput(App + '\bun.exe', Quoted(Script) + ' ' + Args, App, SW_HIDE, ewWaitUntilTerminated, ResultCode, @OnLauncherLogLine) then
  begin
    Lines := BunNotStartedText(App, ResultCode);
    Result := LAUNCHER_NOT_STARTED;
    Exit;
  end;
  Lines := Trim(LastLogTail);
  Result := ResultCode;
end;

// The setup or uninstall log line of a RunLauncherAndWait: what was asked, the exit code and, when the launcher did not start, why
// (the lines it said are already logged one by one by OnLauncherLogLine).
procedure LogLauncherResult(const What: String; Code: Integer; const Lines: String);
begin
  Log('Launcher ' + What + ': exit code ' + IntToStr(Code));
  if Code = LAUNCHER_NOT_STARTED then
    Log('Launcher ' + What + ': ' + Lines);
end;

// ---------- the StepResult JSON the launcher writes: {"ok":true,"detail":...} or {"ok":false,"error":...,"hint":...} ----------

function JsonValueStart(const Json, Key: String): Integer;
var
  P: Integer;
  Done: Boolean;
begin
  Result := 0;
  P := Pos('"' + Key + '"', Json);
  if P = 0 then
    Exit;
  P := P + Length(Key) + 2;
  Done := False;
  while (not Done) and (P <= Length(Json)) do
  begin
    if (Json[P] = ' ') or (Json[P] = ':') or (Json[P] = #9) or (Json[P] = #13) or (Json[P] = #10) then
      P := P + 1
    else
      Done := True;
  end;
  Result := P;
end;

// A string value; \n and \t read as a space, other escapes as the escaped character (\uXXXX is not decoded).
function JsonString(const Json, Key: String): String;
var
  P: Integer;
  C: Char;
begin
  Result := '';
  P := JsonValueStart(Json, Key);
  if P = 0 then
    Exit;
  if P > Length(Json) then
    Exit;
  if Json[P] <> '"' then
    Exit;
  P := P + 1;
  while (P <= Length(Json)) and (Json[P] <> '"') do
  begin
    C := Json[P];
    if (C = '\') and (P < Length(Json)) then
    begin
      P := P + 1;
      C := Json[P];
      if (C = 'n') or (C = 't') then
        C := ' ';
    end;
    Result := Result + C;
    P := P + 1;
  end;
end;

// The digits of a number value.
function JsonNumber(const Json, Key: String): String;
var
  P: Integer;
begin
  Result := '';
  P := JsonValueStart(Json, Key);
  if P = 0 then
    Exit;
  while (P <= Length(Json)) and (Json[P] >= '0') and (Json[P] <= '9') do
  begin
    Result := Result + Json[P];
    P := P + 1;
  end;
end;

function JsonIsTrue(const Json, Key: String): Boolean;
var
  P: Integer;
begin
  P := JsonValueStart(Json, Key);
  Result := (P > 0) and (Copy(Json, P, 4) = 'true');
end;

// The text from a key's value to the end: the keys searched in it are the first ones of that object.
function JsonSection(const Json, Key: String): String;
var
  P: Integer;
begin
  Result := '';
  P := JsonValueStart(Json, Key);
  if P > 0 then
    Result := Copy(Json, P, Length(Json));
end;

function StepSucceeded(ExitCode: Integer; const Json: String): Boolean;
begin
  Result := (ExitCode = 0) and JsonIsTrue(Json, 'ok');
end;

// Runs an `install` step and says whether it succeeded; JsonText holds its StepResult afterwards. Never write
// `StepSucceeded(RunLauncher(..., Json), Json)`: Pascal Script reads the outer `Json` before the run has filled it, so every
// step looked failed (W4c; iss-launcher-calls.test.ts refuses a launcher run inside another call).
function RunStepSucceeded(const Args: String; Gauge: TNewProgressBar; Status: TNewStaticText; var JsonText: String): Boolean;
var
  ExitCode: Integer;
begin
  ExitCode := RunLauncher(Args, True, Gauge, Status, JsonText);
  Result := StepSucceeded(ExitCode, JsonText);
end;

// What went wrong and what to do, from the step's own error and hint; the launcher's last lines when it left none.
function StepFailureText(const Json: String): String;
begin
  Result := JsonString(Json, 'error');
  if Result = '' then
    Result := 'The step stopped without an answer.' + #13#10 + LastLogTail
  else if JsonString(Json, 'hint') <> '' then
    Result := Result + #13#10 + JsonString(Json, 'hint');
end;

// Runs an `install` step; on failure shows error and hint and offers Retry. False when the user gives up.
// Silent: no box (SuppressibleMsgBox shows unless /SUPPRESSMSGBOXES is given), the caller reports the failure.
function RunInstallStepWithRetry(const Step: String; Gauge: TNewProgressBar; Status: TNewStaticText; var Json: String): Boolean;
var
  Again: Boolean;
begin
  repeat
    Again := False;
    Result := RunStepSucceeded('install ' + Step, Gauge, Status, Json);
    if (not Result) and (not WizardSilent) then
      Again := SuppressibleMsgBox('The step "' + Step + '" failed.' + #13#10#13#10 + StepFailureText(Json), mbError, MB_RETRYCANCEL, IDCANCEL) = IDRETRY;
  until not Again;
end;

// install-state.json as written (JSON: a path's backslashes are doubled); '' when there is none.
function InstallStateText(): String;
var
  Raw: AnsiString;
begin
  Result := '';
  if LoadStringFromFile(DataDir('') + '\install-state.json', Raw) then
    Result := UTF8Decode(Raw);
end;

function InstallStateHas(const Fragment: String): Boolean;
var
  State: String;
begin
  State := InstallStateText();
  StringChangeEx(State, ' ', '', True);
  StringChangeEx(State, #13, '', True);
  StringChangeEx(State, #10, '', True);
  Result := Pos(Fragment, State) > 0;
end;

// The folder of the Ollama this setup installed (the state's "ollamaPath" is its ollama.exe); '' when the state records none
// (an install made before the Ollama folder was a choice).
function OllamaInstalledFolder(): String;
begin
  Result := ExtractFileDir(JsonString(InstallStateText(), 'ollamaPath'));
end;

// For the progress log: where Ollama is, as far as the install state says.
function OllamaFolderText(): String;
begin
  if OllamaInstalledFolder() <> '' then
    Result := OllamaInstalledFolder()
  else if InstallStateHas('"ollama":"installed"') then
    Result := 'installed by Mine AI (Ollama''s default folder)'
  else if InstallStateHas('"ollama":"preexisting"') then
    Result := 'was already on this PC (not touched)'
  else
    Result := 'not used';
end;

// ---------- page building ----------

function AddText(Page: TWizardPage; const Text: String; Top, Height: Integer): TNewStaticText;
begin
  Result := TNewStaticText.Create(Page);
  Result.Parent := Page.Surface;
  Result.AutoSize := False;
  Result.WordWrap := True;
  Result.Caption := Text;
  Result.Left := 0;
  Result.Top := ScaleY(Top);
  Result.Width := Page.SurfaceWidth;
  Result.Height := ScaleY(Height);
end;

function AddRadio(Page: TWizardPage; const Text: String; Top: Integer): TNewRadioButton;
begin
  Result := TNewRadioButton.Create(Page);
  Result.Parent := Page.Surface;
  Result.Caption := Text;
  Result.Left := 0;
  Result.Top := ScaleY(Top);
  Result.Width := Page.SurfaceWidth;
  Result.Height := ScaleY(17);
end;

function AddEdit(Page: TWizardPage; Top, Left, Width: Integer): TEdit;
begin
  Result := TEdit.Create(Page);
  Result.Parent := Page.Surface;
  Result.Left := Left;
  Result.Top := ScaleY(Top);
  Result.Width := Width;
end;

function AddGauge(Page: TWizardPage; Top: Integer): TNewProgressBar;
begin
  Result := TNewProgressBar.Create(Page);
  Result.Parent := Page.Surface;
  Result.Left := 0;
  Result.Top := ScaleY(Top);
  Result.Width := Page.SurfaceWidth;
  Result.Height := ScaleY(17);
  Result.Min := 0;
  Result.Max := PROGRESS_STEPS;
end;

function AddButton(Page: TWizardPage; const Caption: String; Top, Left, Width: Integer): TButton;
begin
  Result := TButton.Create(Page);
  Result.Parent := Page.Surface;
  Result.Caption := Caption;
  Result.Left := ScaleX(Left);
  Result.Top := ScaleY(Top);
  Result.Width := ScaleX(Width);
  Result.Height := ScaleY(23);
end;

// The Ollama folder is asked only when this setup is going to install Ollama: the local model is chosen and `install gpu`
// found no Ollama (OllamaFolderNeeded). Ollama that is already there stays where it is.
procedure ModelChoiceChanged(Sender: TObject);
var
  AskOllamaFolder: Boolean;
begin
  AskOllamaFolder := ModelLocalRadio.Checked and OllamaFolderNeeded;
  OllamaDirLabel.Visible := AskOllamaFolder;
  OllamaDirEdit.Visible := AskOllamaFolder;
  OllamaBrowseButton.Visible := AskOllamaFolder;
end;

procedure BrowseOllamaFolder(Sender: TObject);
var
  Folder: String;
begin
  Folder := OllamaDirEdit.Text;
  if BrowseForFolder('Choose the folder Ollama is installed in', Folder, True) then
    OllamaDirEdit.Text := Folder;
end;

procedure ServerChoiceChanged(Sender: TObject);
begin
  ServerHostEdit.Enabled := ServerRemoteRadio.Checked;
  ServerPortEdit.Enabled := ServerRemoteRadio.Checked;
end;

procedure EulaCheckChanged(Sender: TObject);
begin
  WizardForm.NextButton.Enabled := EulaCheck.Checked;
end;

procedure OpenEulaLink(Sender: TObject);
var
  ResultCode: Integer;
begin
  ShellExec('open', MINECRAFT_EULA_URL, '', '', SW_SHOWNORMAL, ewNoWait, ResultCode);
end;

#include "endpoint-page.iss"

// ---------- page creation ----------

procedure CreateModelPage();
begin
  ModelPage := CreateCustomPage(wpInfoAfter, 'AI model', 'Where should the bots'' AI model run?');
  ModelStatus := AddText(ModelPage, '', 0, 46);
  // The free space of the drives the local model needs (ShowDiskSpace, wizard only).
  // Room for about four lines: a short drive adds a warning sentence to the drive lines (disk-report.ts).
  DiskStatus := AddText(ModelPage, '', 48, 60);
  // What the local choice does is set by CheckGpuOnce once it knows whether Ollama is already installed.
  ModelLocalRadio := AddRadio(ModelPage, 'On this PC', 112);
  // One row: the label, the folder and Browse; shown only when this setup will install Ollama (ModelChoiceChanged).
  OllamaDirLabel := AddText(ModelPage, 'Install Ollama in', 138, 14);
  OllamaDirLabel.Left := ScaleX(16);
  OllamaDirLabel.Width := ScaleX(90);
  OllamaBrowseButton := AddButton(ModelPage, 'Browse...', 134, 0, 75);
  OllamaBrowseButton.Left := ModelPage.SurfaceWidth - OllamaBrowseButton.Width;
  OllamaBrowseButton.OnClick := @BrowseOllamaFolder;
  OllamaDirEdit := AddEdit(ModelPage, 135, ScaleX(110), OllamaBrowseButton.Left - ScaleX(110) - ScaleX(8));
  OllamaDirEdit.Text := ExpandConstant('{localappdata}\Programs\Ollama');
  // The endpoint's URL, key and model are asked on the next page (CreateEndpointPage), which a local choice skips.
  ModelRemoteRadio := AddRadio(ModelPage, 'On a remote OpenAI-compatible API (OpenRouter, your own server...)', 166);
  // What the disk text above does not count (T11): three lines with a line to spare; the step status and the gauge sit below, within the endpoint page's depth.
  AddText(ModelPage, ROOM_WARNING_TEXT, 190, 44);
  ModelStepStatus := AddText(ModelPage, '', 236, 28);
  ModelGauge := AddGauge(ModelPage, 266);
  ModelLocalRadio.OnClick := @ModelChoiceChanged;
  ModelRemoteRadio.OnClick := @ModelChoiceChanged;
  ModelLocalRadio.Enabled := False;
  ModelRemoteRadio.Checked := True;
  ModelChoiceChanged(nil);
end;

procedure CreateServerPage();
var
  PortLeft: Integer;
begin
  ServerPage := CreateCustomPage(EndpointPage.ID, 'Minecraft server', 'Which Minecraft server should the bots join?');
  ServerNoneRadio := AddRadio(ServerPage, 'No server for now (I will set one in settings.json)', 0);
  ServerLocalRadio := AddRadio(ServerPage, 'Install a Minecraft server on this PC (only this PC can join, by default)', 24);
  ServerRemoteRadio := AddRadio(ServerPage, 'Use an existing server', 48);
  PortLeft := (ServerPage.SurfaceWidth * 3) div 4;
  AddText(ServerPage, 'Address', 72, 14);
  ServerHostEdit := AddEdit(ServerPage, 86, 0, PortLeft - ScaleX(8));
  ServerPortEdit := AddEdit(ServerPage, 86, PortLeft, ServerPage.SurfaceWidth - PortLeft);
  ServerPortEdit.Text := IntToStr(DEFAULT_SERVER_PORT);
  AddText(ServerPage, 'An existing server must be vanilla Minecraft 1.21.4 with online-mode=false (the bots join without a Minecraft account). Mine AI checks it before starting any bot.', 124, 60);
  ServerNoneRadio.Checked := True;
  ServerNoneRadio.OnClick := @ServerChoiceChanged;
  ServerLocalRadio.OnClick := @ServerChoiceChanged;
  ServerRemoteRadio.OnClick := @ServerChoiceChanged;
  // What a local server downloads and where, filled by CurPageChanged once the data folder is known.
  ServerDownloadText := AddText(ServerPage, '', 190, 44);
  ServerChoiceChanged(nil);
end;

// After the program folder page (a first install only) and before the files are copied: the data folder is chosen first, so the
// personas go straight into it. An update skips it (ShouldSkipPage) and keeps the folder of the first install.
procedure CreateDataPage();
begin
  DataPage := CreateInputDirPage(wpSelectDir, 'Data folder', 'Where should Mine AI keep your data?',
    'Settings, personas, bot memories, the Minecraft server with its worlds and the logs go here, and so does the AI model when Mine AI installs Ollama. About 10 GB with the local model.', False, 'MineAI');
  DataPage.Add('Data folder:');
  if PreviousDataDir() <> '' then
    DataPage.Values[0] := PreviousDataDir()
  else
    DataPage.Values[0] := DefaultDataDir();
end;

// Back from here returns to the server page: not accepting the EULA means picking another server choice.
procedure CreateEulaPage();
var
  Link: TNewStaticText;
begin
  EulaPage := CreateCustomPage(ServerPage.ID, 'Minecraft EULA', 'A Minecraft server needs you to accept the Minecraft End User License Agreement.');
  AddText(EulaPage, 'Mine AI downloads the server from Mojang only after you accept the agreement. Read it here (Back returns to the server choice):', 0, 34);
  Link := AddText(EulaPage, MINECRAFT_EULA_URL, 38, 16);
  Link.Font.Color := clBlue;
  Link.Font.Style := [fsUnderline];
  Link.Cursor := crHand;
  Link.OnClick := @OpenEulaLink;
  EulaCheck := TNewCheckBox.Create(EulaPage);
  EulaCheck.Parent := EulaPage.Surface;
  // 16 px below the link (the link ends at 54): the box sat 16 px higher and its text touched the link (W5 re-check, 6d).
  // Nothing sits under it.
  EulaCheck.Top := ScaleY(86);
  EulaCheck.Height := ScaleY(24);
  EulaCheck.Width := EulaPage.SurfaceWidth;
  EulaCheck.Caption := 'I have read and accept the Minecraft EULA';
  EulaCheck.OnClick := @EulaCheckChanged;
end;

procedure CreateStepsPage();
begin
  StepsPage := CreateCustomPage(EulaPage.ID, 'Setting up', 'Mine AI is saving your choices and downloading what it needs.');
  StepsStatus := AddText(StepsPage, '', 0, 32);
  StepsGauge := AddGauge(StepsPage, 36);
  StepsLog := TNewMemo.Create(StepsPage);
  StepsLog.Parent := StepsPage.Surface;
  StepsLog.Top := ScaleY(64);
  StepsLog.Width := StepsPage.SurfaceWidth;
  StepsLog.Height := ScaleY(190);
  StepsLog.ReadOnly := True;
  StepsLog.ScrollBars := ssVertical;
end;

// The `llm` and `server` objects of the data folder's settings.json (the text from each key on); False when there is no file.
// The only reader of that file's two objects: the Ready summary and the pages' prefill both ask it.
function ReadSettingsSections(var Llm, Server: String): Boolean;
var
  Raw: AnsiString;
  Settings: String;
begin
  Llm := '';
  Server := '';
  Result := LoadStringFromFile(DataDir('') + '\settings.json', Raw);
  if not Result then
    Exit;
  Settings := UTF8Decode(Raw);
  Llm := JsonSection(Settings, 'llm');
  Server := JsonSection(Settings, 'server');
end;

// The model and the server of the saved settings.json in words, for the Ready page of an update; False when there is no file.
// The API key is never part of it.
function SettingsSummary(var Model, Server: String): Boolean;
var
  Llm, ServerSection, Kind: String;
begin
  Result := ReadSettingsSections(Llm, ServerSection);
  Model := '';
  Server := '';
  if not Result then
    Exit;
  if JsonString(Llm, 'kind') = 'remote' then
    Model := JsonString(Llm, 'model') + ' on the remote endpoint ' + JsonString(Llm, 'baseUrl')
  else
    Model := JsonString(Llm, 'model') + ' on this PC';
  Kind := JsonString(ServerSection, 'kind');
  if Kind = 'local' then
    Server := 'on this PC (port ' + JsonNumber(ServerSection, 'port') + ')'
  else if Kind = 'remote' then
    Server := JsonString(ServerSection, 'host') + ':' + JsonNumber(ServerSection, 'port')
  else
    Server := 'none (set one in settings.json)';
end;

// The update check of the saved settings.json: False only when the file says `"checkUpdates": false`. A missing file, key or
// unreadable value is True, the launcher's own default (settings.ts).
function SavedCheckUpdatesValue(): Boolean;
var
  Raw: AnsiString;
  Settings: String;
  P: Integer;
begin
  Result := True;
  if not LoadStringFromFile(DataDir('') + '\settings.json', Raw) then
    Exit;
  Settings := UTF8Decode(Raw);
  P := JsonValueStart(Settings, 'checkUpdates');
  if (P > 0) and (Copy(Settings, P, 5) = 'false') then
    Result := False;
end;

// An update (or a second run) starts from the settings.json of the data folder, so it never resets a server or an endpoint.
// The key: an encrypted one (apiKeyProtected) is never decrypted here; the box shows the mark and the launcher keeps the key
// (KeySaved). A clear one (an install before the encryption) fills the box as before and is encrypted by the first save.
// This also runs on the data page's Next: everything the file may set (the key box and its flags, the endpoint, the server choice,
// host and port, PreviousLlmWasRemote) goes back to the creation values first, so a Back to another data folder, or a missing file,
// keeps nothing of the last file.
procedure PrefillFromSettings();
var
  Llm, Server, Kind: String;
begin
  RemoteKeyEdit.Text := '';
  KeySaved := False;
  KeyWasSaved := False;
  ClearKeyMigrated := False;
  SavedBaseUrl := '';
  KeyUrlChangeTold := '';
  // What the file may not set goes back to the pages' creation values: a second prefill (Back to another data folder) or a missing
  // file must not keep the last file's remote kind, endpoint or server (F1: PreviousLlmWasRemote was a latch that never reset).
  PreviousLlmWasRemote := False;
  RemoteUrlEdit.Text := '';
  RemoteModelCombo.Text := '';
  ServerNoneRadio.Checked := True;
  ServerHostEdit.Text := '';
  ServerPortEdit.Text := IntToStr(DEFAULT_SERVER_PORT);
  SavedCheckUpdates := True;
  if ReadSettingsSections(Llm, Server) then
  begin
    SavedCheckUpdates := SavedCheckUpdatesValue();
    if JsonString(Llm, 'kind') = 'remote' then
    begin
      PreviousLlmWasRemote := True;
      SavedBaseUrl := JsonString(Llm, 'baseUrl');
      RemoteUrlEdit.Text := SavedBaseUrl;
      if JsonString(Llm, 'apiKeyProtected') <> '' then
      begin
        // The mark first, the flag after: an OnChange fired by the assignment cannot leave the flag cleared.
        RemoteKeyEdit.Text := SAVED_KEY_MARK;
        KeySaved := True;
        KeyWasSaved := True;
      end
      else if JsonString(Llm, 'apiKey') <> '' then
      begin
        RemoteKeyEdit.Text := JsonString(Llm, 'apiKey');
        ClearKeyMigrated := True;
      end;
      RemoteModelCombo.Text := JsonString(Llm, 'model');
    end;
    Kind := JsonString(Server, 'kind');
    if Kind = 'local' then
      ServerLocalRadio.Checked := True
    else if Kind = 'remote' then
    begin
      ServerRemoteRadio.Checked := True;
      ServerHostEdit.Text := JsonString(Server, 'host');
      if JsonNumber(Server, 'port') <> '' then
        ServerPortEdit.Text := JsonNumber(Server, 'port');
    end;
  end;
  // On every path, a missing file included: the server boxes match the radio, and the key caption matches the box.
  ServerChoiceChanged(nil);
  ShowKeyLabel();
end;

// A second run over an install: Ready is then the first page (DisableDirPage=auto), and the folders are the first install's.
function IsUpdate(): Boolean;
begin
  Result := WizardForm.PrevAppDir <> '';
end;

// Whether Mine AI checks for a newer release at each start: /CHECKUPDATES= when given in a silent setup (like every other parameter,
// it is read only there: a wizard shows its box and reports that box), else the tasks-page box at a first install, else the value
// the settings.json of the update holds (Inno's own stored task value is never used at an update: it would switch back on a check
// the player turned off in settings.json).
function CheckUpdatesWanted(): Boolean;
begin
  if WizardSilent and ParamGiven('CHECKUPDATES') then
    Result := Param('CHECKUPDATES', '') = '1'
  else if not IsUpdate() then
    Result := WizardIsTaskSelected('checkupdates')
  else
    Result := SavedCheckUpdates;
end;

// The Ready page's list (Inno's default shows the destination only). The model and server pages come after the copy, because
// they run the launcher, so a first install cannot list them yet and says why; an update lists the saved ones.
function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
var
  Model, Server, CheckAnswer: String;
begin
  Result := MemoDirInfo + NewLine + NewLine + 'Data folder:' + NewLine + Space + DataDir('');
  if IsUpdate() and SettingsSummary(Model, Server) then
    Result := Result + NewLine + NewLine + 'AI model:' + NewLine + Space + Model + NewLine + NewLine + 'Minecraft server:' + NewLine + Space + Server
  else
    // A first install, or an update that finds no settings.json: the pages after the copy still ask both.
    Result := Result + NewLine + NewLine + 'AI model and Minecraft server: chosen on the next pages, after the files are copied (the setup checks this PC''s graphics card there).';
  Result := Result + NewLine + NewLine + 'Disk room:' + NewLine + Space + ROOM_WARNING_TEXT;
  if CheckUpdatesWanted() then
    CheckAnswer := 'yes'
  else
    CheckAnswer := 'no';
  Result := Result + NewLine + NewLine + 'Check for updates at each start: ' + CheckAnswer + ' (privacy: {#PrivacyUrl})';
end;

// ---------- silent install: the wizard's choices from command-line parameters ----------

// Silent: sets the pages' controls from /LLM= /LLMURL= ... A parameter not given leaves what PrefillFromSettings set.
procedure ApplySilentParameters();
var
  Server: String;
begin
  // No page is shown: the room warning of the model page and the Ready list goes to the log.
  Log('Disk room: ' + ROOM_WARNING_TEXT);
  // At a first install only: an update keeps its data folder, and a different /DATADIR= is refused (SilentFolderProblem).
  if ParamGiven('DATADIR') and (PreviousDataDir() = '') then
    DataPage.Values[0] := Param('DATADIR', '');
  PrefillFromSettings();
  SilentWantsLocalModel := Param('LLM', 'local') = 'local';
  if PreviousLlmWasRemote and (not ParamGiven('LLM')) then
    SilentWantsLocalModel := False;
  if ParamGiven('LLMURL') then
    RemoteUrlEdit.Text := Param('LLMURL', '');
  if ParamGiven('LLMKEY') then
  begin
    RemoteKeyEdit.Text := Param('LLMKEY', '');
    KeySaved := False;
    KeyWasSaved := False;
  end;
  if ParamGiven('LLMMODEL') then
    RemoteModelCombo.Text := Param('LLMMODEL', '');
  Server := Param('SERVER', PARAM_UNSET);
  if Server = 'none' then
    ServerNoneRadio.Checked := True
  else if Server = 'local' then
    ServerLocalRadio.Checked := True
  else if Server = 'remote' then
    ServerRemoteRadio.Checked := True;
  if ParamGiven('SERVERHOST') then
    ServerHostEdit.Text := Param('SERVERHOST', '');
  if ParamGiven('SERVERPORT') then
    ServerPortEdit.Text := Param('SERVERPORT', '');
  EulaCheck.Checked := Param('EULA', '') = 'accept';
end;

procedure InitializeWizard();
begin
  // The Ready list's long lines (the disk room warning) wrapped to the right under a horizontal scroll bar (F3).
  WizardForm.ReadyMemo.WordWrap := True;
  WizardForm.ReadyMemo.ScrollBars := ssVertical;
  CreateDataPage();
  CreateModelPage();
  CreateEndpointPage();
  CreateServerPage();
  CreateEulaPage();
  CreateStepsPage();
  if WizardSilent then
    ApplySilentParameters()
  else
    PrefillFromSettings();
  // After the first prefill: its own assignments are not edits by the player. A silent /LLMKEY= clears KeySaved itself.
  RemoteKeyEdit.OnChange := @RemoteKeyChanged;
end;

// Silent Setup still clicks through every page that is not skipped once the files are copied (measured with a probe
// installer on Inno Setup 6.7.3, 2026-10-30), which would run the pages' steps a second time and may show a MsgBox.
// The data page shows at a first install only: an update keeps the first folder.
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := WizardSilent and ((PageID = DataPage.ID) or (PageID = ModelPage.ID) or (PageID = EndpointPage.ID) or (PageID = ServerPage.ID) or (PageID = EulaPage.ID) or (PageID = StepsPage.ID));
  if PageID = DataPage.ID then
    Result := Result or (PreviousDataDir() <> '');
  // The endpoint is asked only for the remote choice (the local model needs no URL, key or model name).
  if PageID = EndpointPage.ID then
    Result := Result or (not ModelRemoteRadio.Checked);
  if PageID = EulaPage.ID then
    Result := Result or (not ServerLocalRadio.Checked);
  // The update-check box is asked at a first install only: an update opens on Ready and keeps what settings.json says.
  if PageID = wpSelectTasks then
    Result := Result or IsUpdate();
end;

// ---------- AI model page ----------

// `install disk` (spec D2): the free space of each drive the downloads go to and what they need, under the GPU text. The local model's
// needs are left out when the local choice is not offered (--no-model). A run that failed (an older launcher, a crash) shows nothing:
// the steps' own guards still hold. Wizard only: nobody reads it in a silent install, and it asks the network.
procedure ShowDiskSpace();
var
  Json, Args: String;
  Succeeded: Boolean;
begin
  DiskStatus.Caption := 'Checking disk space...';
  Args := 'install disk';
  if not ModelLocalRadio.Enabled then
    Args := Args + ' --no-model';
  Succeeded := RunStepSucceeded(Args, ModelGauge, ModelStepStatus, Json);
  if Succeeded and (JsonString(Json, 'detail') <> '') then
    DiskStatus.Caption := JsonString(Json, 'detail')
  else
    DiskStatus.Caption := '';
end;

// Moves the focus to the radio of the group that is already checked, when Page is the page on screen. It never writes a .Checked: a
// radio checked from code while another radio of its group keeps the focus is re-checked by the focused one when the window gets
// its focus back (F1), so the checked one must hold the focus. Third is nil for a group of two.
procedure FocusCheckedRadio(Page: TWizardPage; First, Second, Third: TNewRadioButton);
var
  Checked: TNewRadioButton;
begin
  if WizardForm.CurPageID <> Page.ID then
    Exit;
  Checked := nil;
  if First.Checked then
    Checked := First
  else if Second.Checked then
    Checked := Second
  else if (Third <> nil) and Third.Checked then
    Checked := Third;
  // A disabled control cannot take the focus (the local radio is disabled when the verdict is remote).
  if (Checked <> nil) and Checked.Enabled then
    WizardForm.ActiveControl := Checked;
end;

// The one place the model page's choice is written from the gpu verdict, once (CheckGpuOnce runs once): local when this PC can run
// the model and the saved settings are not a remote endpoint, remote otherwise. Both radios are set, so the group never holds two
// or none. A later visit to the page does not call it: a pick of the player (remote, then Back from the endpoint page) stays.
procedure ApplyModelChoice();
var
  Local: Boolean;
begin
  Local := ModelLocalRadio.Enabled and (not PreviousLlmWasRemote);
  ModelLocalRadio.Checked := Local;
  ModelRemoteRadio.Checked := not Local;
  FocusCheckedRadio(ModelPage, ModelLocalRadio, ModelRemoteRadio, nil);
  ModelChoiceChanged(nil);
end;

// `install gpu`: ok means this PC can run the model; not ok means remote only, with the reason on the page.
procedure CheckGpuOnce();
var
  Json: String;
begin
  if GpuChecked then
    Exit;
  GpuChecked := True;
  WizardForm.NextButton.Enabled := False;
  ModelStatus.Caption := 'Checking your graphics card...';
  if RunStepSucceeded('install gpu', ModelGauge, ModelStepStatus, Json) then
  begin
    ModelStatus.Caption := JsonString(Json, 'detail');
    ModelLocalRadio.Enabled := True;
    // `install gpu` also says where an Ollama is already installed ("ollamaExe", null when there is none): the choice's
    // caption says what the local choice will really do, and the Ollama folder is asked only when it will install one.
    OllamaFolderNeeded := JsonString(Json, 'ollamaExe') = '';
    if OllamaFolderNeeded then
      ModelLocalRadio.Caption := 'On this PC (downloads Ollama and the AI model)'
    else
    begin
      // `modelInstalled` and `model` come from a launcher that knows them; an older one omits them and reads as not installed.
      ModelStatus.Caption := ModelStatus.Caption + #13#10 + 'Ollama is already installed: ' + JsonString(Json, 'ollamaExe');
      if JsonIsTrue(Json, 'modelInstalled') then
      begin
        ModelLocalRadio.Caption := 'On this PC (uses the Ollama and the AI model already installed)';
        ModelStatus.Caption := ModelStatus.Caption + #13#10 + 'The AI model ' + JsonString(Json, 'model') + ' is already installed.';
      end
      else
        ModelLocalRadio.Caption := 'On this PC (uses the Ollama already installed; downloads the AI model if it is missing)';
    end;
    ApplyModelChoice();
  end
  else
  begin
    // The launcher's error states the facts and its hint the next action: nothing is added here.
    GpuProblem := StepFailureText(Json);
    GpuReason := JsonString(Json, 'error');
    if GpuReason = '' then
      GpuReason := GpuProblem;
    GpuVerdictIsRemote := JsonIsTrue(Json, 'remote');
    ModelStatus.Caption := GpuProblem;
    ApplyModelChoice();
  end;
  // After the choice: ShowDiskSpace keeps the window answering clicks, and a click on remote during it must stand.
  if not WizardSilent then
    ShowDiskSpace();
  ModelStepStatus.Caption := '';
  ModelGauge.Position := 0;
  WizardForm.NextButton.Enabled := True;
end;

function RemoteFieldProblem(): String;
begin
  Result := RemoteUrlProblem();
  if Result <> '' then
    Exit;
  if Trim(RemoteModelCombo.Text) = '' then
    Result := 'Enter the model name the endpoint serves.'
  else if Pos('"', RemoteModelCombo.Text) > 0 then
    Result := 'The URL has no spaces and no field contains a double quote.';
end;

// Why a `configure` of the remote endpoint failed (Lead says what did not happen). When the key is the saved one and the launcher ended with
// its usage code, the saved key is what it could not use: its own text names the usage line and "run the setup again", which is no help
// inside the setup, so the setup says what to do here.
function ConfigureFailure(const Lead: String; Code: Integer): String;
begin
  if KeySaved and ModelRemoteRadio.Checked and (Code = USAGE_EXIT_CODE) then
  begin
    if WizardSilent then
      Result := Lead + #13#10 + SAVED_KEY_UNUSABLE_SILENT_TEXT
    else
      Result := Lead + #13#10 + SAVED_KEY_UNUSABLE_TEXT;
  end
  else
    Result := Lead + #13#10 + LastLogTail;
end;

// Saves the endpoint, then makes one test call with the brain's own parameters (`install endpoint-test`); Failure says why not.
// A URL the test corrected (it added /v1) is put in the URL box and told once; the failure text then leaves the notice out.
function SaveAndTestEndpoint(var Failure: String): Boolean;
var
  Json: String;
  Code: Integer;
begin
  Result := False;
  NoteSavedKeyKeptForOtherUrl();
  Code := RunLauncher('configure ' + RemoteLlmArguments(), False, EndpointGauge, EndpointStepStatus, Json);
  if Code <> 0 then
    Failure := ConfigureFailure('Mine AI could not save the endpoint.', Code)
  else
  begin
    NoteClearKeyMigrated();
    Result := RunStepSucceeded('install endpoint-test', EndpointGauge, EndpointStepStatus, Json);
    ApplyEndpointCorrection(Json);
    if Result then
      Log('Endpoint test: ' + WithoutNotice(JsonString(Json, 'detail'), JsonString(Json, 'notice')))
    else
      Failure := 'The endpoint did not accept the test call.' + #13#10#13#10 + WithoutNotice(StepFailureText(Json), JsonString(Json, 'notice'));
  end;
end;

function AcceptRemoteEndpoint(): Boolean;
var
  Problem, Failure: String;
begin
  Result := False;
  Problem := RemoteFieldProblem();
  if Problem <> '' then
  begin
    MsgBox(Problem, mbError, MB_OK);
    Exit;
  end;
  WizardForm.NextButton.Enabled := False;
  SetEndpointControlsEnabled(False);
  EndpointStepStatus.Caption := 'Testing the endpoint...';
  Result := SaveAndTestEndpoint(Failure);
  if not Result then
    MsgBox(Failure, mbError, MB_OK);
  EndpointStepStatus.Caption := '';
  EndpointGauge.Position := 0;
  SetEndpointControlsEnabled(True);
  WizardForm.NextButton.Enabled := True;
end;

// The Ollama step ended "this PC cannot run the model": switch to the remote fields and offer to remove what we installed.
procedure SwitchToRemoteAfterOllama(const Json: String);
var
  Ignored: String;
begin
  ModelLocalRadio.Enabled := False;
  ModelRemoteRadio.Checked := True;
  ModelChoiceChanged(nil);
  ModelStatus.Caption := StepFailureText(Json);
  // The disk text listed the local model's needs, which this PC no longer has.
  DiskStatus.Caption := '';
  if InstallStateHas('"ollama":"installed"') then
  begin
    if SuppressibleMsgBox('This PC cannot run the model, so the Ollama that was just installed is not needed. Remove it now?', mbConfirmation, MB_YESNO, IDNO) = IDYES then
      RunInstallStepWithRetry('ollama-remove', ModelGauge, ModelStepStatus, Ignored);
  end;
  ModelStepStatus.Caption := '';
  ModelGauge.Position := 0;
end;

// The folder for Ollama's own setup: the wizard's field, or /OLLAMADIR= (silent; not given: Ollama's default folder).
function OllamaDirChosen(): String;
begin
  if WizardSilent then
    Result := Param('OLLAMADIR', '')
  else
    Result := Trim(OllamaDirEdit.Text);
end;

// Only a folder Ollama's setup will really get is checked: an Ollama that is already there keeps its folder, so a repeated
// command line naming the folder Mine AI installed it in is no problem. '' when all is well.
function OllamaFolderProblem(): String;
begin
  Result := '';
  if OllamaFolderNeeded and ((not WizardSilent) or ParamGiven('OLLAMADIR')) and (OllamaFolderChecked <> NormalFolder(OllamaDirChosen())) then
  begin
    Result := FolderProblem(OllamaDirChosen(), 'ollama');
    // A folder that passed once is not asked again: after a failed Ollama step (Retry, Cancel, Next) it holds what that step put
    // there, and the check would call Ollama's own files foreign (review of W7b).
    if Result = '' then
      OllamaFolderChecked := NormalFolder(OllamaDirChosen());
  end;
end;

// `install ollama`, with `--dir <folder>` when this setup is going to install Ollama into a chosen folder.
function OllamaStepArguments(): String;
begin
  Result := 'install ollama';
  if OllamaFolderNeeded and (OllamaDirChosen() <> '') then
    Result := Result + ' --dir ' + Quoted(NormalFolder(OllamaDirChosen()));
end;

// Installs (or finds) Ollama and checks what it will really run; the model itself is pulled on the last page.
function AcceptLocalModel(): Boolean;
var
  Json, Problem: String;
  Again: Boolean;
begin
  Result := OllamaReady;
  if Result then
    Exit;
  Problem := OllamaFolderProblem();
  if Problem <> '' then
  begin
    MsgBox(Problem, mbError, MB_OK);
    Exit;
  end;
  WizardForm.NextButton.Enabled := False;
  repeat
    Again := False;
    Result := RunStepSucceeded(OllamaStepArguments(), ModelGauge, ModelStepStatus, Json);
    if (not Result) and JsonIsTrue(Json, 'remote') then
      SwitchToRemoteAfterOllama(Json)
    else if not Result then
      Again := SuppressibleMsgBox('The Ollama step failed.' + #13#10#13#10 + StepFailureText(Json), mbError, MB_RETRYCANCEL, IDCANCEL) = IDRETRY;
  until not Again;
  OllamaReady := Result;
  ModelStepStatus.Caption := '';
  WizardForm.NextButton.Enabled := True;
end;

// ---------- server page ----------

function ServerFieldProblem(): String;
var
  Port: Integer;
begin
  Result := '';
  if not ServerRemoteRadio.Checked then
    Exit;
  Port := StrToIntDef(Trim(ServerPortEdit.Text), 0);
  if (Trim(ServerHostEdit.Text) = '') or (Pos(' ', Trim(ServerHostEdit.Text)) > 0) or (Pos('"', ServerHostEdit.Text) > 0) then
    Result := 'Enter the server address, without spaces.'
  else if (Port < 1) or (Port > 65535) then
    Result := 'The port is a number from 1 to 65535.';
end;

// ---------- steps page: configure, then the chosen downloads ----------

function ConfigureArguments(): String;
begin
  if ModelRemoteRadio.Checked then
    Result := 'configure ' + RemoteLlmArguments()
  else
    Result := 'configure --llm-local';
  if ServerLocalRadio.Checked then
    Result := Result + ' --server-local'
  else if ServerRemoteRadio.Checked then
    Result := Result + ' --server-remote ' + Quoted(Trim(ServerHostEdit.Text)) + ' ' + IntToStr(StrToIntDef(Trim(ServerPortEdit.Text), DEFAULT_SERVER_PORT))
  else
    Result := Result + ' --server-none';
  // The update check goes with the final configure only, never the endpoint-only one of the endpoint page.
  if CheckUpdatesWanted() then
    Result := Result + ' --check-updates on'
  else
    Result := Result + ' --check-updates off';
end;

// One line on the progress page and in the setup log (/LOG=).
procedure NoteSetup(const Line: String);
begin
  StepsLog.Lines.Add(Line);
  Log(Line);
end;

function RunSetupStep(const Step: String): Boolean;
var
  Json: String;
begin
  StepsStatus.Caption := 'Running: ' + Step;
  Result := RunInstallStepWithRetry(Step, StepsGauge, StepsStatus, Json);
  if Result then
    NoteSetup('OK   ' + Step + ': ' + JsonString(Json, 'detail'))
  else
  begin
    SetupFailure := 'The step "' + Step + '" failed. ' + StepFailureText(Json);
    NoteSetup('FAIL ' + Step + ': ' + StepFailureText(Json));
  end;
end;

function RunConfigure(): Boolean;
var
  Ignored: String;
  Code: Integer;
begin
  StepsStatus.Caption := 'Saving your choices...';
  Code := RunLauncher(ConfigureArguments(), False, StepsGauge, StepsStatus, Ignored);
  Result := Code = 0;
  if Result then
    NoteSetup('OK   settings saved in ' + DataDir('') + '\settings.json')
  else
  begin
    SetupFailure := ConfigureFailure('Mine AI could not save your choices in settings.json.', Code);
    NoteSetup('FAIL settings: ' + SetupFailure);
  end;
end;

function AllSetupStepsSucceed(): Boolean;
begin
  Result := False;
  if DataFolderFailure <> '' then
  begin
    SetupFailure := DataFolderFailure;
    NoteSetup('FAIL data folder: ' + DataFolderFailure);
    Exit;
  end;
  NoteSetup('Folders: program ' + ExpandConstant('{app}') + '; data ' + DataDir('') + '; Ollama ' + OllamaFolderText());
  if not RunConfigure() then
    Exit;
  if ModelLocalRadio.Checked and (not RunSetupStep('model')) then
    Exit;
  if ServerLocalRadio.Checked then
  begin
    if not RunSetupStep('java') then
      Exit;
    if not RunSetupStep('server --accept-eula') then
      Exit;
  end;
  Result := True;
end;

// The progress page runs its steps once per set of choices: Back and Next again over a finished page showed the same
// "settings saved" and "model" lines three times in the W5 host run (CurPageChanged ran the steps on every entry). A failed run
// has no signature, so Back and Next again is the retry; changed choices run the steps again.
procedure RunSetupSteps();
var
  Signature: String;
begin
  Signature := ConfigureArguments() + '|' + IntToStr(Ord(ModelLocalRadio.Checked)) + IntToStr(Ord(ServerLocalRadio.Checked));
  if SetupDone and (StepsDoneFor = Signature) then
    Exit;
  WizardForm.NextButton.Enabled := False;
  SetupDone := AllSetupStepsSucceed();
  if SetupDone then
    StepsDoneFor := Signature;
  if SetupDone then
    StepsStatus.Caption := 'Everything is ready.'
  else
    StepsStatus.Caption := 'Setup is incomplete. Run the installer again to finish: the steps that are done are not repeated.';
  StepsGauge.Position := 0;
  WizardForm.NextButton.Enabled := True;
end;

// ---------- silent install: the checks the pages make, then the progress page's steps ----------

// The folders of a silent setup, checked like the wizard's pages do: the program folder (Inno's /DIR=) and the data folder
// (/DATADIR=, checked as typed) of a first install; an update keeps the folders of the first install and refuses a /DATADIR= that moves the data.
// The Ollama folder is checked in full only when Ollama's setup is going to get it (OllamaFolderProblem), here only its shape.
function SilentFolderProblem(): String;
var
  Previous, Typed: String;
begin
  Result := '';
  Previous := PreviousDataDir();
  // The parameter as given: the data page expands a relative value the moment it is set (measured, Inno Setup 6.7.3: /DATADIR=data
  // came back as <Setup's current folder>\data), so the page's value can no longer show that it was relative.
  Typed := DataPage.Values[0];
  if ParamGiven('DATADIR') then
    Typed := Param('DATADIR', '');
  if (Previous <> '') and ParamGiven('DATADIR') and ((not IsFullFolder(Typed)) or (not SameFolder(Typed, Previous))) then
    Result := 'Mine AI keeps its data in ' + Previous + '; moving it is not supported: uninstall keeping the data, move the folder, then install with /DATADIR=' + Typed + '.'
  else if WizardForm.PrevAppDir = '' then
    Result := FolderProblem(WizardDirValue, 'app');
  if (Result = '') and (Previous = '') then
    Result := FolderProblem(Typed, 'data');
  if (Result = '') and SilentWantsLocalModel and ParamGiven('OLLAMADIR') and (not IsFullFolder(Param('OLLAMADIR', ''))) then
    Result := FolderKindName('ollama') + ' must be a full path such as D:\Apps\Ollama (/OLLAMADIR= was "' + Param('OLLAMADIR', '') + '").';
end;

// The launcher calls a silent setup makes, in order, per parameter set. launcher/src/build/iss-launcher-calls.test.ts
// runs every call on the launcher's CLI and checks these lines against this code and docs/install/windows.md;
// <url> <key> <model> <host> <port> <ollamadir> stand for the values given. Each `install` call also gets `--json <file>`.
// `install ollama` gets `--dir` only when /OLLAMADIR= is given and `install gpu` found no Ollama (the wizard: its folder field).
// Every final `configure` ends with `--check-updates on` (the default when /CHECKUPDATES= is not given) or `off`.
//   CALLS /LLM=local /SERVER=none: install gpu; install ollama; configure --llm-local --server-none --check-updates on; install model
//   CALLS /LLM=local /SERVER=none /CHECKUPDATES=0: install gpu; install ollama; configure --llm-local --server-none --check-updates off; install model
//   CALLS /LLM=local /SERVER=none /OLLAMADIR=<ollamadir>: install gpu; install ollama --dir <ollamadir>; configure --llm-local --server-none --check-updates on; install model
//   CALLS /LLM=remote /SERVER=remote: configure --llm-remote <url> <key> <model>; install endpoint-test; configure --llm-remote <url> <key> <model> --server-remote <host> <port> --check-updates on
//   CALLS /LLM=remote /SERVER=remote (key-saved): configure --llm-remote-saved-key <url> <model>; install endpoint-test; configure --llm-remote-saved-key <url> <model> --server-remote <host> <port> --check-updates on
//   CALLS /LLM=local /SERVER=local /EULA=accept: install gpu; install ollama; configure --llm-local --server-local --check-updates on; install model; install java; install server --accept-eula
//   CALLS /LLM=remote /SERVER=none: configure --llm-remote <url> <key> <model>; install endpoint-test; configure --llm-remote <url> <key> <model> --server-none --check-updates on
//   CALLS /DELETEDATA=1 (uninstall): stop; install model-remove; install ollama-remove
// What is wrong with the silent parameters, before any file is copied (Setup then exits with code 7); '' when all is well.
function SilentParameterProblem(): String;
var
  Llm, Server, StartNow, CheckUpdates: String;
begin
  Result := '';
  Llm := Param('LLM', 'local');
  Server := Param('SERVER', 'none');
  StartNow := Param('STARTNOW', '0');
  CheckUpdates := Param('CHECKUPDATES', '1');
  if (Llm <> 'local') and (Llm <> 'remote') then
    Result := '/LLM= must be local or remote.'
  else if (Server <> 'none') and (Server <> 'local') and (Server <> 'remote') then
    Result := '/SERVER= must be none, local or remote.'
  else if (StartNow <> '0') and (StartNow <> '1') then
    Result := '/STARTNOW= must be 0 or 1.'
  else if (CheckUpdates <> '0') and (CheckUpdates <> '1') then
    Result := '/CHECKUPDATES= must be 0 or 1.'
  else if (not SilentWantsLocalModel) and (RemoteFieldProblem() <> '') then
    Result := 'With /LLM=remote: ' + RemoteFieldProblem() + ' Give /LLMURL=, /LLMKEY= (may be empty) and /LLMMODEL=.'
  else if ServerFieldProblem() <> '' then
    Result := ServerFieldProblem() + ' Give /SERVERHOST= and /SERVERPORT= with /SERVER=remote.'
  else if ServerLocalRadio.Checked and (not EulaCheck.Checked) then
    Result := 'A local Minecraft server needs the Minecraft EULA (' + MINECRAFT_EULA_URL + '): add /EULA=accept to accept it, or use /SERVER=none.'
  else
    Result := SilentFolderProblem();
end;

// Silent, local model: the GPU check, then Ollama. No fallback: a PC that cannot run the model fails the setup instead of
// switching to an endpoint nobody gave; the message names the parameters that would have worked.
function SilentLocalModelFailure(): String;
var
  Json: String;
begin
  Result := '';
  CheckGpuOnce();
  if not ModelLocalRadio.Enabled then
  begin
    if GpuVerdictIsRemote then
      Result := 'This PC cannot run the local model: ' + GpuReason + ' Use /LLM=remote with /LLMURL=, /LLMKEY= and /LLMMODEL= instead.'
    else
      Result := 'The graphics card check did not finish: ' + GpuProblem;
    Exit;
  end;
  ModelLocalRadio.Checked := True;
  Result := OllamaFolderProblem();
  if Result <> '' then
    Exit;
  if RunStepSucceeded(OllamaStepArguments(), ModelGauge, ModelStepStatus, Json) then
    Exit;
  // A remote verdict: the launcher's error states the facts; its hint (the endpoint advice) is replaced by the parameters.
  if JsonIsTrue(Json, 'remote') then
    Result := 'This PC cannot run the local model: ' + JsonString(Json, 'error') + ' Use /LLM=remote with /LLMURL=, /LLMKEY= and /LLMMODEL= instead.'
  else
    Result := 'The Ollama step failed: ' + StepFailureText(Json);
  if InstallStateHas('"ollama":"installed"') then
    Result := Result + ' The Ollama this setup installed stays; remove it with: "' + ExpandConstant('{app}\bun.exe') + '" {#LauncherScript} install ollama-remove';
end;

// Silent: the model page's work (local model or the endpoint test), then the same steps as the progress page.
function SilentSetupFailure(): String;
var
  Failure: String;
begin
  Result := DataFolderFailure;
  if Result <> '' then
    Exit;
  if SilentWantsLocalModel then
    Result := SilentLocalModelFailure()
  else
  begin
    ModelRemoteRadio.Checked := True;
    if not SaveAndTestEndpoint(Failure) then
      Result := Failure;
  end;
  if (Result = '') and (not AllSetupStepsSucceed()) then
    Result := SetupFailure;
  SetupDone := Result = '';
end;

// ---------- finish page ----------

function JoinText(): String;
begin
  if ServerLocalRadio.Checked then
    Result := 'Join from Minecraft Java 1.21.4 on this PC at localhost (the console shows the port, normally 25565).'
  else if ServerRemoteRadio.Checked then
    Result := 'The bots join ' + Trim(ServerHostEdit.Text) + ':' + Trim(ServerPortEdit.Text) + '. That server must be vanilla Minecraft 1.21.4 with online-mode=false.'
  else
    Result := 'No Minecraft server is set: put one in settings.json ("server") before the bots can start.';
end;

procedure ShowFinishText();
var
  I: Integer;
  Line: String;
begin
  if not SetupDone then
  begin
    WizardForm.FinishedLabel.Caption := 'Setup did not finish. Run the installer again to resume: the steps that are done are not repeated.' + #13#10#13#10 + 'Details are on the previous page.';
    for I := 0 to WizardForm.RunList.Items.Count - 1 do
      WizardForm.RunList.Checked[I] := False;
    WizardForm.RunList.Visible := False;
    Exit;
  end;
  // "Up to date", not "updated": IsUpdate() is also true for a first install run again after its steps failed, where nothing was updated.
  if IsUpdate() then
    Line := 'Mine AI is up to date.'
  else
    Line := 'Mine AI is installed.';
  WizardForm.FinishedLabel.Caption := Line + #13#10#13#10 +
    JoinText() + #13#10#13#10 +
    'Program: ' + ExpandConstant('{app}') + #13#10 +
    'Settings: ' + DataDir('') + '\settings.json' + #13#10 +
    'Logs: ' + DataDir('') + '\logs';
  if InstallStateHas('"ollama":"installed"') then
  begin
    WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + #13#10#13#10 + 'Ollama was installed for you';
    if OllamaInstalledFolder() <> '' then
      WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + ' in ' + OllamaInstalledFolder();
    WizardForm.FinishedLabel.Caption := WizardForm.FinishedLabel.Caption + ' and starts with Windows.';
  end;
end;

// ---------- wizard events ----------

// An update says what it does (the owner said "repair": it also restores a file that is missing). A first install keeps Inno's texts.
procedure SayUpdateOnPage(CurPageID: Integer);
begin
  if not IsUpdate() then
    Exit;
  if CurPageID = wpReady then
  begin
    WizardForm.PageNameLabel.Caption := 'Ready to update or repair';
    WizardForm.PageDescriptionLabel.Caption := 'Setup will update Mine AI and repair any missing file. Your data folder, worlds and bots stay as they are; the AI model and server settings are set again on the next pages.';
    WizardForm.NextButton.Caption := 'Update';
    // Inno's line says "Click Install ... or click Back", and Ready is the first page of an update: there is no Back to name.
    WizardForm.ReadyLabel.Caption := 'Click Update to continue.';
  end
  else if CurPageID = wpInstalling then
  begin
    WizardForm.PageNameLabel.Caption := 'Updating';
    WizardForm.PageDescriptionLabel.Caption := 'Please wait while Setup updates Mine AI on your computer.';
  end
  else if CurPageID = wpPreparing then
  begin
    // Shown only when the stop of a running Mine AI is refused (PrepareToInstall returns the reason and the update is cancelled).
    WizardForm.PageNameLabel.Caption := 'Preparing to update';
    WizardForm.PageDescriptionLabel.Caption := 'Setup is preparing to update Mine AI on your computer.';
  end;
end;

// Inno's exit box says "the program will not be installed": false on an update, where the old install stays. Only before the copy is
// "stays as it was" true (Ready, Preparing; Cancel is off while copying): the model, server, EULA and steps pages come after it. A first
// install and those later pages keep Inno's box (Confirm untouched).
procedure CancelButtonClick(CurPageID: Integer; var Cancel, Confirm: Boolean);
begin
  if IsUpdate() and ((CurPageID = wpReady) or (CurPageID = wpPreparing)) then
  begin
    Confirm := False;
    Cancel := SuppressibleMsgBox('Stop the update? Mine AI stays as it was before this update; run the setup again to update it.', mbConfirmation, MB_YESNO, IDNO) = IDYES;
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  SayUpdateOnPage(CurPageID);
  if CurPageID = ModelPage.ID then
  begin
    CheckGpuOnce();
    FocusCheckedRadio(ModelPage, ModelLocalRadio, ModelRemoteRadio, nil);
  end
  else if CurPageID = ServerPage.ID then
  begin
    ServerDownloadText.Caption := 'A server on this PC downloads Java (from Adoptium) and the Minecraft server (from Mojang, after you accept the EULA) into your data folder, ' + DataDir('') + '. Nothing else is installed.';
    FocusCheckedRadio(ServerPage, ServerNoneRadio, ServerLocalRadio, ServerRemoteRadio);
  end
  else if CurPageID = EulaPage.ID then
    WizardForm.NextButton.Enabled := EulaCheck.Checked
  else if CurPageID = StepsPage.ID then
    RunSetupSteps()
  else if CurPageID = wpFinished then
    ShowFinishText();
end;

// The folder pages say what is wrong and stay: a folder the uninstaller deletes must hold nothing of anybody else's.
// Silent Setup still clicks through the program folder page: a MsgBox there would wait for a click nobody makes (measured,
// 11 minutes), so its folders are left to SilentFolderProblem, which ends the setup with exit code 7 and the reason in /LOG=.
function AcceptFolder(const Folder, Kind: String): Boolean;
var
  Problem: String;
begin
  if WizardSilent then
  begin
    Result := True;
    Exit;
  end;
  Problem := FolderProblem(Folder, Kind);
  Result := Problem = '';
  if not Result then
    MsgBox(Problem, mbError, MB_OK);
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  Problem: String;
begin
  Result := True;
  if CurPageID = wpSelectDir then
    Result := AcceptFolder(WizardDirValue, 'app')
  else if CurPageID = DataPage.ID then
  begin
    Result := AcceptFolder(DataPage.Values[0], 'data');
    // The settings of an earlier install in this folder start the model and server pages.
    if Result then
      PrefillFromSettings();
  end
  else if CurPageID = ModelPage.ID then
  begin
    // Without data-root.txt the launcher steps of this page would work in the default folder.
    if DataFolderFailure <> '' then
    begin
      MsgBox(DataFolderFailure, mbError, MB_OK);
      Result := False;
    end
    // The remote choice goes on to the endpoint page, which saves and tests the endpoint on its own Next.
    else if not ModelRemoteRadio.Checked then
      Result := AcceptLocalModel();
  end
  else if CurPageID = EndpointPage.ID then
    Result := AcceptRemoteEndpoint()
  else if CurPageID = ServerPage.ID then
  begin
    Problem := ServerFieldProblem();
    if Problem <> '' then
    begin
      MsgBox(Problem, mbError, MB_OK);
      Result := False;
    end;
  end;
end;

// An update stops the running stack first, so no file of the old version is in use. Silent: wrong parameters stop here. A launcher
// that is running but will not stop cancels the update here, before any file is copied: the message is the launcher's own words
// (which program to end). Any other result of the stop goes on: a launcher that cannot start is what the copy repairs.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Code: Integer;
  Lines: String;
begin
  Result := '';
  if WizardSilent then
    Result := SilentParameterProblem();
  // The two lines bound the stop in the setup log, so the copy's time is read from the first file line after them (W5 re-check,
  // finding 2: the time on the Ready page had been counted as copy time).
  if (Result = '') and (InstalledLauncherScript() <> '') then
  begin
    Log('Stopping a running Mine AI before the copy');
    Code := RunLauncherAndWait('stop', Lines);
    LogLauncherResult('stop', Code, Lines);
    Log('Stopping a running Mine AI before the copy: done');
    if Code = STOP_REFUSED_EXIT_CODE then
      Result := 'Mine AI is running and did not stop, so the update was cancelled before any file was copied.' + #13#10#13#10 + Lines;
    if Result <> '' then
      Log('Update cancelled: ' + Result);
  end;
end;

// Silent: the steps run once the files are copied (the launcher is on disk). A failure is logged with its error and hint
// to /LOG= and ends Setup with SILENT_FAILURE_EXIT_CODE (GetCustomSetupExitCode); an exception raised here would be caught
// by Setup and exit 0 (measured with a probe installer, Inno Setup 6.7.3, 2026-10-30). The copied files stay.
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
    WriteDataFolderFiles();
  if (CurStep = ssPostInstall) and WizardSilent then
  begin
    SilentFailure := SilentSetupFailure();
    if SilentFailure <> '' then
      Log('Silent setup failed: ' + SilentFailure);
  end;
end;

function GetCustomSetupExitCode(): Integer;
begin
  Result := 0;
  if WizardSilent and (SilentFailure <> '') then
    Result := SILENT_FAILURE_EXIT_CODE;
end;

// ---------- uninstall: ask before deleting anything of the user's ----------

// Silent: no question, /DELETEDATA=1 answers yes to all three (the data, the model and Ollama when ours), the default 0 to none.
function AskDefaultNo(const Question: String): Boolean;
begin
  if UninstallSilent then
    Result := Param('DELETEDATA', '0') = '1'
  else
    Result := SuppressibleMsgBox(Question, mbConfirmation, MB_YESNO or MB_DEFBUTTON2, IDNO) = IDYES;
end;

// The data folder the install chose, from the value Setup saved in the uninstall key (SetPreviousData); the default folder
// when there is none (an install made before the folders were a choice). Registry strings are Unicode, so a folder with an
// accent comes back exact.
function SavedDataDir(): String;
var
  Value: String;
begin
  Result := DefaultDataDir();
  if RegQueryStringValue(HKCU, UNINSTALL_KEY, UNINSTALL_DATA_DIR_VALUE, Value) and (Trim(Value) <> '') then
    Result := NormalFolder(Value);
end;

// Inno saves what Setup registers here, into the uninstall key, so a later install and the uninstaller find the folder.
procedure RegisterPreviousData(PreviousDataKey: Integer);
begin
  SetPreviousData(PreviousDataKey, DATA_DIR_KEY, DataDir(''));
end;

// The uninstaller's questions. The data folder is read here once and every later use takes UninstallDataDir: by usPostUninstall
// Inno has removed the uninstall key it comes from, and a late read would fall back to the default folder.
function InitializeUninstall(): Boolean;
begin
  Result := True;
  UninstallDataDir := SavedDataDir();
  Log('Uninstall: data folder ' + UninstallDataDir);
  DeleteDataOnUninstall := AskDefaultNo('Also delete your Mine AI data (worlds, bot memories, personas, settings and logs in ' + UninstallDataDir + ')?');
  if InstallStateHas('"modelPulledByUs":true') then
  begin
    // The store we made for our own Ollama (ollamaModels is always <data folder>\models) goes with the folder: no question,
    // but the launcher is still told (model-remove) so it deletes the model through Ollama before the folder goes.
    if DeleteDataOnUninstall and InstallStateHas('"ollamaModels":') then
      RemoveModelOnUninstall := True
    else
      RemoveModelOnUninstall := AskDefaultNo('Mine AI downloaded the AI model. Delete it too?');
  end;
  if InstallStateHas('"ollama":"installed"') then
    RemoveOllamaOnUninstall := AskDefaultNo('Mine AI installed Ollama. Remove Ollama too?');
end;

// usPostUninstall: the data folder goes only when it holds the marker Setup wrote (never a folder that was merely chosen, and
// never a whole drive). The result is in the uninstall log (/LOG=); a folder that could not be emptied (a file in use) is
// said, with what to do, instead of leaving the player to find it.
procedure DeleteDataFolder();
begin
  if (Length(UninstallDataDir) <= 3) or (not FileExists(UninstallDataDir + '\' + DATA_MARKER_FILE)) then
  begin
    Log('Data folder kept: no Mine AI marker (' + DATA_MARKER_FILE + ') in ' + UninstallDataDir);
    Exit;
  end;
  if DelTree(UninstallDataDir, True, True, True) then
    Log('Data folder deleted: ' + UninstallDataDir)
  else
  begin
    Log('Data folder NOT fully deleted: ' + UninstallDataDir);
    if not UninstallSilent then
      SuppressibleMsgBox('Mine AI could not delete all of your data folder ' + UninstallDataDir + ': a file in it is probably in use. Close the programs that use it, then delete the folder yourself.', mbError, MB_OK, IDOK);
  end;
end;

// What the player is told about a removal that did not happen or not as asked: in the uninstall log at once, in one box at the end.
procedure NoteUninstall(const Text: String);
begin
  Log('Uninstall: ' + Text);
  if UninstallNotes <> '' then
    UninstallNotes := UninstallNotes + #13#10#13#10;
  UninstallNotes := UninstallNotes + Text;
end;

procedure ShowUninstallNotes();
begin
  if (UninstallNotes <> '') and (not UninstallSilent) then
    SuppressibleMsgBox(UninstallNotes, mbInformation, MB_OK, IDOK);
end;

// "Model X removed." and "Ollama removed." say nothing the player did not ask for. Every other detail ("kept", "already removed", "was
// not pulled by Mine AI") is shown. A launcher wording that stops matching only shows one line more.
function IsPlainRemoval(const Detail: String): Boolean;
begin
  Result := (Length(Detail) >= 9) and (Pos(' already ', Detail) = 0) and (Copy(Detail, Length(Detail) - 8, 9) = ' removed.');
end;

// How to remove the model by hand. Our own Ollama keeps it alone in <data folder>\models (see InitializeUninstall): the folder is
// named, and goes with the data folder when the player chose to delete it. Any other Ollama's models folder (OLLAMA_MODELS or
// <home>\.ollama\models, as model.ts reads it) holds the player's other models too, so no folder is named there: Ollama's own command.
function ModelRemoveByHand(): String;
var
  Store: String;
begin
  if InstallStateHas('"ollama":"installed"') and InstallStateHas('"ollamaModels":') then
  begin
    Store := UninstallDataDir + '\models';
    if DeleteDataOnUninstall then
      Result := 'The AI model is in ' + Store + ', which goes with your data folder.'
    else
      Result := 'Delete the AI model yourself: its files are in ' + Store + '.';
  end
  else
    Result := 'Delete the AI model yourself: run "ollama list" to see its name, then "ollama rm <name>". Do not delete Ollama''s models folder: it holds your other models too.';
end;

// Runs a removal step the player asked for, with its result in a file: a success says its detail unless it is a plain removal, a
// failure says the error and what to do by hand. The step's hint is not used: it says "run this step again" and {app} goes next.
procedure RemoveStepOnUninstall(const Args, Subject, ByHand: String);
var
  JsonFile, Json, Lines, Detail, Failure: String;
  Raw: AnsiString;
  Code: Integer;
begin
  JsonFile := ExpandConstant('{tmp}\mine-ai-removal.json');
  DeleteFile(JsonFile);
  Json := '';
  Code := RunLauncherAndWait(Args + ' --json ' + Quoted(JsonFile), Lines);
  LogLauncherResult(Args, Code, Lines);
  if LoadStringFromFile(JsonFile, Raw) then
    Json := UTF8Decode(Raw);
  if StepSucceeded(Code, Json) then
  begin
    Detail := JsonString(Json, 'detail');
    if (Detail <> '') and (not IsPlainRemoval(Detail)) then
      NoteUninstall(Subject + ': ' + Detail)
    else
      Log('Uninstall: ' + Subject + ': ' + Detail);
    Exit;
  end;
  Failure := JsonString(Json, 'error');
  if Failure = '' then
    Failure := Lines;
  if Failure = '' then
    Failure := 'the launcher ended with code ' + IntToStr(Code) + ' and said nothing';
  NoteUninstall(Subject + ' was not removed: ' + Failure + #13#10 + ByHand);
end;

// The launcher is running and will not stop: what to end, then what to remove by hand (the removals asked for are named, not run).
function StopRefusedNote(): String;
begin
  Result := 'Mine AI did not stop, so some of its files may be left. End bun.exe and java.exe in Task Manager, then delete the folder ' + ExpandConstant('{app}') + ' and the rest by hand.';
  if RemoveModelOnUninstall then
    Result := Result + #13#10 + ModelRemoveByHand();
  if RemoveOllamaOnUninstall then
    Result := Result + #13#10 + OLLAMA_REMOVE_BY_HAND;
end;

// Done here, not in [UninstallRun]: that section's Check functions run when the installer runs, before these answers exist.
// Order: stop the stack, the model through our Ollama, then Ollama; the launcher itself refuses what is not ours. A launcher that
// is running and will not stop skips both removals (a running Ollama or model server would make them fail or hurt) and the player
// is told what to end and what to remove by hand.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Code: Integer;
  Lines: String;
begin
  if CurUninstallStep = usUninstall then
  begin
    Code := RunLauncherAndWait('stop', Lines);
    LogLauncherResult('stop', Code, Lines);
    if Code = STOP_REFUSED_EXIT_CODE then
      NoteUninstall(StopRefusedNote())
    else
    begin
      if RemoveModelOnUninstall then
        RemoveStepOnUninstall('install model-remove', 'The AI model', ModelRemoveByHand());
      if RemoveOllamaOnUninstall then
        RemoveStepOnUninstall('install ollama-remove', 'Ollama', OLLAMA_REMOVE_BY_HAND);
    end;
    ShowUninstallNotes();
  end;
  if CurUninstallStep = usPostUninstall then
  begin
    if DeleteDataOnUninstall then
      DeleteDataFolder()
    else
      Log('Data folder kept: ' + UninstallDataDir + ' (not asked to delete it).');
  end;
end;
