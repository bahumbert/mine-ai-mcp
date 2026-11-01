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
;   /DATADIR= /OLLAMADIR= /EULA=accept /STARTNOW=0|1; uninstall: /DELETEDATA=0|1.
; The app folder is Inno's own /DIR=; the data folder (/DATADIR=) and the Ollama folder (/OLLAMADIR=) are asked by pages of
; this script. The folders chosen at the first install are kept by every update; the uninstaller removes them.
; A parameter not given keeps the choice saved in settings.json by an earlier install, else the first value listed.
; Setup runs the same code as the progress page (AllSetupStepsSucceed); a failed step ends the setup with a non-zero exit
; code (7 for a wrong parameter, 100 for a failed step) and the error and hint in the /LOG= file. Pass /SUPPRESSMSGBOXES
; too: Setup's own error boxes are not silent without it.
; Not compiled by tests: ISCC compiles it in the master's build, W5 walks every page.

#ifndef StageDir
  #error StageDir is not defined: build with launcher/src/build/build-windows.ts.
#endif
; The launcher's entry in the built app (build-windows.ts bundles the sources into a few .js files that keep the source paths), and
; the same file in the version before the bundle, which an update meets in {app} until its copy has run.
#define LauncherScript "launcher\src\main.js"
#define SourceLauncherScript "launcher\src\main.ts"
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
  // The default of a silent parameter that was not given; no real value looks like it.
  PARAM_UNSET = '(not given)';
  // Setup's own exit codes are 0-8; a silent setup whose steps failed returns this one.
  SILENT_FAILURE_EXIT_CODE = 100;
  // Setup stores the data folder under this name (GetPreviousData/SetPreviousData); the uninstaller reads it back from the
  // uninstall key of this script's AppId (the test in iss-launcher-calls.test.ts keeps the two in step) as the value
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
  ModelPage, ServerPage, EulaPage, StepsPage: TWizardPage;
  ModelStatus, ModelStepStatus, OllamaDirLabel, ServerDownloadText: TNewStaticText;
  ModelLocalRadio, ModelRemoteRadio: TNewRadioButton;
  OllamaDirEdit, RemoteUrlEdit, RemoteModelEdit: TEdit;
  OllamaBrowseButton: TButton;
  RemoteKeyEdit: TPasswordEdit;
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
  LastLogTail, GpuProblem, GpuReason, SetupFailure, SilentFailure, StepsDoneFor, DataFolderFailure, OllamaFolderChecked: String;
  DeleteDataOnUninstall, RemoveModelOnUninstall, RemoveOllamaOnUninstall: Boolean;
  // Read once in InitializeUninstall: by usPostUninstall Inno has removed the uninstall key it comes from.
  UninstallDataDir: String;

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
  LastLogTail := LastLogTail + Text + #13#10;
  if Length(LastLogTail) > 600 then
    LastLogTail := Copy(LastLogTail, Length(LastLogTail) - 599, 600);
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
    LastLogTail := 'Windows could not start ' + App + '\bun.exe (error ' + IntToStr(ResultCode) + ').';
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

// A launcher run whose output nobody reads: stopping the stack before an update or an uninstall.
procedure RunLauncherAndWait(const Args: String);
var
  ResultCode: Integer;
  Script: String;
begin
  Script := InstalledLauncherScript();
  if Script <> '' then
    Exec(ExpandConstant('{app}\bun.exe'), Quoted(Script) + ' ' + Args, ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ResultCode);
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

// The Ollama folder is asked only when this setup is going to install Ollama: the local model is chosen and `install gpu`
// found no Ollama (OllamaFolderNeeded). Ollama that is already there stays where it is.
procedure ModelChoiceChanged(Sender: TObject);
var
  AskOllamaFolder: Boolean;
begin
  RemoteUrlEdit.Enabled := ModelRemoteRadio.Checked;
  RemoteKeyEdit.Enabled := ModelRemoteRadio.Checked;
  RemoteModelEdit.Enabled := ModelRemoteRadio.Checked;
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

procedure CreateModelPage();
begin
  ModelPage := CreateCustomPage(wpInfoAfter, 'AI model', 'Where should the bots'' AI model run?');
  ModelStatus := AddText(ModelPage, '', 0, 46);
  // What the local choice does is set by CheckGpuOnce once it knows whether Ollama is already installed.
  ModelLocalRadio := AddRadio(ModelPage, 'On this PC', 50);
  // One row: the label, the folder and Browse; shown only when this setup will install Ollama (ModelChoiceChanged).
  OllamaDirLabel := AddText(ModelPage, 'Install Ollama in', 76, 14);
  OllamaDirLabel.Left := ScaleX(16);
  OllamaDirLabel.Width := ScaleX(90);
  OllamaBrowseButton := TButton.Create(ModelPage);
  OllamaBrowseButton.Parent := ModelPage.Surface;
  OllamaBrowseButton.Caption := 'Browse...';
  OllamaBrowseButton.Width := ScaleX(75);
  OllamaBrowseButton.Left := ModelPage.SurfaceWidth - OllamaBrowseButton.Width;
  OllamaBrowseButton.Top := ScaleY(72);
  OllamaBrowseButton.Height := ScaleY(23);
  OllamaBrowseButton.OnClick := @BrowseOllamaFolder;
  OllamaDirEdit := AddEdit(ModelPage, 73, ScaleX(110), OllamaBrowseButton.Left - ScaleX(110) - ScaleX(8));
  OllamaDirEdit.Text := ExpandConstant('{localappdata}\Programs\Ollama');
  ModelRemoteRadio := AddRadio(ModelPage, 'On a remote OpenAI-compatible API (OpenRouter, your own server...)', 102);
  AddText(ModelPage, 'Endpoint URL (for example https://openrouter.ai/api/v1)', 126, 14);
  RemoteUrlEdit := AddEdit(ModelPage, 140, 0, ModelPage.SurfaceWidth);
  AddText(ModelPage, 'API key', 166, 14);
  RemoteKeyEdit := TPasswordEdit.Create(ModelPage);
  RemoteKeyEdit.Parent := ModelPage.Surface;
  RemoteKeyEdit.Left := 0;
  RemoteKeyEdit.Top := ScaleY(180);
  RemoteKeyEdit.Width := ModelPage.SurfaceWidth;
  AddText(ModelPage, 'Model name', 206, 14);
  RemoteModelEdit := AddEdit(ModelPage, 220, 0, ModelPage.SurfaceWidth);
  ModelStepStatus := AddText(ModelPage, '', 250, 28);
  ModelGauge := AddGauge(ModelPage, 280);
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
  ServerPage := CreateCustomPage(ModelPage.ID, 'Minecraft server', 'Which Minecraft server should the bots join?');
  ServerNoneRadio := AddRadio(ServerPage, 'No server for now (I will set one in settings.json)', 0);
  ServerLocalRadio := AddRadio(ServerPage, 'Install a Minecraft server on this PC (only this PC can join, by default)', 24);
  ServerRemoteRadio := AddRadio(ServerPage, 'Use an existing server', 48);
  PortLeft := (ServerPage.SurfaceWidth * 3) div 4;
  AddText(ServerPage, 'Address', 72, 14);
  ServerHostEdit := AddEdit(ServerPage, 86, 0, PortLeft - ScaleX(8));
  ServerPortEdit := AddEdit(ServerPage, 86, PortLeft, ServerPage.SurfaceWidth - PortLeft);
  ServerPortEdit.Text := '25565';
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

// An update (or a second run) starts from the settings.json of the data folder, so it never resets a server or an endpoint.
procedure PrefillFromSettings();
var
  Llm, Server, Kind: String;
begin
  if not ReadSettingsSections(Llm, Server) then
    Exit;
  if JsonString(Llm, 'kind') = 'remote' then
  begin
    PreviousLlmWasRemote := True;
    RemoteUrlEdit.Text := JsonString(Llm, 'baseUrl');
    RemoteKeyEdit.Text := JsonString(Llm, 'apiKey');
    RemoteModelEdit.Text := JsonString(Llm, 'model');
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
  ServerChoiceChanged(nil);
end;

// A second run over an install: Ready is then the first page (DisableDirPage=auto), and the folders are the first install's.
function IsUpdate(): Boolean;
begin
  Result := WizardForm.PrevAppDir <> '';
end;

// The Ready page's list (Inno's default shows the destination only). The model and server pages come after the copy, because
// they run the launcher, so a first install cannot list them yet and says why; an update lists the saved ones.
function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
var
  Model, Server: String;
begin
  Result := MemoDirInfo + NewLine + NewLine + 'Data folder:' + NewLine + Space + DataDir('');
  if IsUpdate() and SettingsSummary(Model, Server) then
    Result := Result + NewLine + NewLine + 'AI model:' + NewLine + Space + Model + NewLine + NewLine + 'Minecraft server:' + NewLine + Space + Server
  else
    // A first install, or an update that finds no settings.json: the pages after the copy still ask both.
    Result := Result + NewLine + NewLine + 'AI model and Minecraft server: chosen on the next pages, after the files are copied (the setup checks this PC''s graphics card there).';
end;

// ---------- silent install: the wizard's choices from command-line parameters ----------

// Silent: sets the pages' controls from /LLM= /LLMURL= ... A parameter not given leaves what PrefillFromSettings set.
procedure ApplySilentParameters();
var
  Server: String;
begin
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
    RemoteKeyEdit.Text := Param('LLMKEY', '');
  if ParamGiven('LLMMODEL') then
    RemoteModelEdit.Text := Param('LLMMODEL', '');
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
  CreateDataPage();
  CreateModelPage();
  CreateServerPage();
  CreateEulaPage();
  CreateStepsPage();
  if WizardSilent then
    ApplySilentParameters()
  else
    PrefillFromSettings();
end;

// Silent Setup still clicks through every page that is not skipped once the files are copied (measured with a probe
// installer on Inno Setup 6.7.3, 2026-10-30), which would run the pages' steps a second time and may show a MsgBox.
// The data page shows at a first install only: an update keeps the first folder.
function ShouldSkipPage(PageID: Integer): Boolean;
begin
  Result := WizardSilent and ((PageID = DataPage.ID) or (PageID = ModelPage.ID) or (PageID = ServerPage.ID) or (PageID = EulaPage.ID) or (PageID = StepsPage.ID));
  if PageID = DataPage.ID then
    Result := Result or (PreviousDataDir() <> '');
  if PageID = EulaPage.ID then
    Result := Result or (not ServerLocalRadio.Checked);
end;

// ---------- AI model page ----------

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
    if not PreviousLlmWasRemote then
      ModelLocalRadio.Checked := True;
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
    ModelRemoteRadio.Checked := True;
  end;
  ModelChoiceChanged(nil);
  ModelStepStatus.Caption := '';
  ModelGauge.Position := 0;
  WizardForm.NextButton.Enabled := True;
end;

function RemoteFieldProblem(): String;
begin
  Result := '';
  if (Pos('http://', RemoteUrlEdit.Text) <> 1) and (Pos('https://', RemoteUrlEdit.Text) <> 1) then
    Result := 'The endpoint URL must start with http:// or https://.'
  else if Trim(RemoteModelEdit.Text) = '' then
    Result := 'Enter the model name the endpoint serves.'
  else if (Pos('"', RemoteUrlEdit.Text + RemoteKeyEdit.Text + RemoteModelEdit.Text) > 0) or (Pos(' ', Trim(RemoteUrlEdit.Text)) > 0) then
    Result := 'The URL has no spaces and no field contains a double quote.';
end;

// Saves the endpoint, then makes one test call with the brain's own parameters (`install endpoint-test`); Failure says why not.
function SaveAndTestEndpoint(var Failure: String): Boolean;
var
  Json: String;
begin
  Result := False;
  if RunLauncher('configure --llm-remote ' + Quoted(Trim(RemoteUrlEdit.Text)) + ' ' + Quoted(RemoteKeyEdit.Text) + ' ' + Quoted(Trim(RemoteModelEdit.Text)), False, ModelGauge, ModelStepStatus, Json) <> 0 then
    Failure := 'Mine AI could not save the endpoint.' + #13#10 + LastLogTail
  else if RunStepSucceeded('install endpoint-test', ModelGauge, ModelStepStatus, Json) then
    Result := True
  else
    Failure := 'The endpoint did not accept the test call.' + #13#10#13#10 + StepFailureText(Json);
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
  ModelStepStatus.Caption := 'Testing the endpoint...';
  Result := SaveAndTestEndpoint(Failure);
  if not Result then
    MsgBox(Failure, mbError, MB_OK);
  ModelStepStatus.Caption := '';
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
    Result := 'configure --llm-remote ' + Quoted(Trim(RemoteUrlEdit.Text)) + ' ' + Quoted(RemoteKeyEdit.Text) + ' ' + Quoted(Trim(RemoteModelEdit.Text))
  else
    Result := 'configure --llm-local';
  if ServerLocalRadio.Checked then
    Result := Result + ' --server-local'
  else if ServerRemoteRadio.Checked then
    Result := Result + ' --server-remote ' + Quoted(Trim(ServerHostEdit.Text)) + ' ' + IntToStr(StrToIntDef(Trim(ServerPortEdit.Text), 25565))
  else
    Result := Result + ' --server-none';
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
begin
  StepsStatus.Caption := 'Saving your choices...';
  Result := RunLauncher(ConfigureArguments(), False, StepsGauge, StepsStatus, Ignored) = 0;
  if Result then
    NoteSetup('OK   settings saved in ' + DataDir('') + '\settings.json')
  else
  begin
    SetupFailure := 'Mine AI could not save your choices in settings.json. ' + LastLogTail;
    NoteSetup('FAIL settings: ' + LastLogTail);
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
//   CALLS /LLM=local /SERVER=none: install gpu; install ollama; configure --llm-local --server-none; install model
//   CALLS /LLM=local /SERVER=none /OLLAMADIR=<ollamadir>: install gpu; install ollama --dir <ollamadir>; configure --llm-local --server-none; install model
//   CALLS /LLM=remote /SERVER=remote: configure --llm-remote <url> <key> <model>; install endpoint-test; configure --llm-remote <url> <key> <model> --server-remote <host> <port>
//   CALLS /LLM=local /SERVER=local /EULA=accept: install gpu; install ollama; configure --llm-local --server-local; install model; install java; install server --accept-eula
//   CALLS /LLM=remote /SERVER=none: configure --llm-remote <url> <key> <model>; install endpoint-test; configure --llm-remote <url> <key> <model> --server-none
//   CALLS /DELETEDATA=1 (uninstall): stop; install model-remove; install ollama-remove
// What is wrong with the silent parameters, before any file is copied (Setup then exits with code 7); '' when all is well.
function SilentParameterProblem(): String;
var
  Llm, Server, StartNow: String;
begin
  Result := '';
  Llm := Param('LLM', 'local');
  Server := Param('SERVER', 'none');
  StartNow := Param('STARTNOW', '0');
  if (Llm <> 'local') and (Llm <> 'remote') then
    Result := '/LLM= must be local or remote.'
  else if (Server <> 'none') and (Server <> 'local') and (Server <> 'remote') then
    Result := '/SERVER= must be none, local or remote.'
  else if (StartNow <> '0') and (StartNow <> '1') then
    Result := '/STARTNOW= must be 0 or 1.'
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
begin
  if not SetupDone then
  begin
    WizardForm.FinishedLabel.Caption := 'Setup did not finish. Run the installer again to resume: the steps that are done are not repeated.' + #13#10#13#10 + 'Details are on the previous page.';
    for I := 0 to WizardForm.RunList.Items.Count - 1 do
      WizardForm.RunList.Checked[I] := False;
    WizardForm.RunList.Visible := False;
    Exit;
  end;
  WizardForm.FinishedLabel.Caption := 'Mine AI is installed.' + #13#10#13#10 +
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
  end
  else if CurPageID = wpInstalling then
    WizardForm.PageNameLabel.Caption := 'Updating';
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  SayUpdateOnPage(CurPageID);
  if CurPageID = ModelPage.ID then
    CheckGpuOnce()
  else if CurPageID = ServerPage.ID then
    ServerDownloadText.Caption := 'A server on this PC downloads Java (from Adoptium) and the Minecraft server (from Mojang, after you accept the EULA) into your data folder, ' + DataDir('') + '. Nothing else is installed.'
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
    else if ModelRemoteRadio.Checked then
      Result := AcceptRemoteEndpoint()
    else
      Result := AcceptLocalModel();
  end
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

// An update stops the running stack first, so no file of the old version is in use. Silent: wrong parameters stop here.
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  Result := '';
  if WizardSilent then
    Result := SilentParameterProblem();
  // The two lines bound the stop in the setup log, so the copy's time is read from the first file line after them (W5 re-check,
  // finding 2: the time on the Ready page had been counted as copy time).
  if (Result = '') and (InstalledLauncherScript() <> '') then
  begin
    Log('Stopping a running Mine AI before the copy');
    RunLauncherAndWait('stop');
    Log('Stopping a running Mine AI before the copy: done');
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

// Done here, not in [UninstallRun]: that section's Check functions run when the installer runs, before these answers exist.
// Order: stop the stack, the model through our Ollama, then Ollama; the launcher itself refuses what is not ours.
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    RunLauncherAndWait('stop');
    if RemoveModelOnUninstall then
      RunLauncherAndWait('install model-remove');
    if RemoveOllamaOnUninstall then
      RunLauncherAndWait('install ollama-remove');
  end;
  if CurUninstallStep = usPostUninstall then
  begin
    if DeleteDataOnUninstall then
      DeleteDataFolder()
    else
      Log('Data folder kept: ' + UninstallDataDir + ' (not asked to delete it).');
  end;
end;
