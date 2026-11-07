// The endpoint page of the Mine AI installer: the URL, the API key, the list of the endpoint's models and the model name of a remote
// OpenAI-compatible endpoint (spec D4). Included by mine-ai.iss inside its [Code] section, where this text used to stand, so Pascal
// Script sees it as one script. Needs from mine-ai.iss, above the #include: the page helpers (AddText, AddEdit, AddButton, AddGauge),
// the launcher runs (RunLauncher, RunStepSucceeded, StepFailureText), the JSON readers (JsonString), Quoted and ModelPage.
// Holds: the page's variables; the URL and key checks (RemoteUrlProblem); the key box (RemoteKeyChanged, ListKeyArguments,
// RemoteLlmArguments, NoteClearKeyMigrated, UrlForComparison, NoteSavedKeyKeptForOtherUrl); the /v1 correction (ApplyEndpointCorrection); the model list (ListModels, the combo
// box filter); the "Ollama on another PC" buttons; and CreateEndpointPage, which builds the page.
// The save and test of the endpoint (SaveAndTestEndpoint, AcceptRemoteEndpoint), the prefill and the silent parameters stay in mine-ai.iss
// and use this file's variables and routines; iss-endpoint-page.test.ts pins both sides.

var
  EndpointPage: TWizardPage;
  ListModelsButton, OllamaOtherPcButton: TButton;
  RemoteUrlEdit, ModelFilterEdit: TEdit;
  RemoteKeyEdit: TPasswordEdit;
  RemoteModelCombo: TNewComboBox;
  // The endpoint page's own step status and gauge (the model page keeps ModelStepStatus and ModelGauge), the list's status and
  // the info and count texts of the model list.
  EndpointStepStatus, ListStatus, FilterCountText, ModelInfoText: TNewStaticText;
  // The label above the key box: ShowKeyLabel says there whether the box holds the mark of a saved key.
  KeyLabel: TNewStaticText;
  EndpointGauge: TNewProgressBar;
  // The lines `<id>#9<info>` of the last `install endpoint-models` list (empty before one, and after a list that failed).
  ModelListLines: TArrayOfString;
  // KeySaved: the key box holds the mark of an encrypted key the player has not touched (the launcher keeps that key). KeyWasSaved: the
  // prefill found such a key, so the mark in the box means it (a typed mark with no saved key is just text). ClearKeyMigrated: the settings
  // held the key in clear; the first save encrypts it and the player is told once (NoteClearKeyMigrated).
  KeySaved, KeyWasSaved, ClearKeyMigrated: Boolean;
  // SavedBaseUrl: the URL the settings held when the prefill found them (the one the saved key was made for). KeyUrlChangeTold: the
  // URL (compared form) NoteSavedKeyKeptForOtherUrl last warned about, so a retry after a failed test does not repeat the box.
  SavedBaseUrl, KeyUrlChangeTold: String;

// ---------- endpoint page: URL, key, model list and model name of a remote endpoint (spec D4) ----------

// What the player reads before the first press of List models; the list itself generates no text, the test on Next does (D4b).
const
  LIST_COST_TEXT = 'Listing generates no text. Next sends one short test message to the model (a few tens of tokens).';

// The one place the list file's name is spelled: `install endpoint-models --list` writes it, LoadModelList reads it.
function ModelListFile(): String;
begin
  Result := ExpandConstant('{tmp}\mine-ai-models.txt');
end;

// What is wrong with the URL (and with a typed key, which the launcher gets on its command line); '' when the endpoint can be called.
// A URL the launcher's `configure` would refuse (configure-command.ts checkEndpoint: a scheme and something after it) is refused here: a
// refusal by the launcher with a saved key is read by ConfigureFailure as "the saved key cannot be used".
function RemoteUrlProblem(): String;
begin
  Result := '';
  if (Pos('http://', RemoteUrlEdit.Text) <> 1) and (Pos('https://', RemoteUrlEdit.Text) <> 1) then
    Result := 'The endpoint URL must start with http:// or https://.'
  else if (Trim(RemoteUrlEdit.Text) = 'http://') or (Trim(RemoteUrlEdit.Text) = 'https://') then
    Result := 'The endpoint URL needs an address after http:// or https:// (for example https://openrouter.ai/api/v1).'
  else if (Pos('<', RemoteUrlEdit.Text) > 0) or (Pos('>', RemoteUrlEdit.Text) > 0) then
    Result := 'Replace <IP> with the address of the PC that runs Ollama (for example 192.168.1.20).'
  else if (Pos('"', RemoteUrlEdit.Text + RemoteKeyEdit.Text) > 0) or (Pos(' ', Trim(RemoteUrlEdit.Text)) > 0) then
    Result := 'The URL has no spaces and no field contains a double quote.';
end;

// The caption above the key box says a saved key is kept while the box holds its mark (19 dots look like a typed key). "Replace the
// dots" is the wording of SAVED_KEY_UNUSABLE_TEXT and NoteSavedKeyKeptForOtherUrl: a character typed after a click inside the dots is
// added to the mark and sent as is. At most as long as the page's longest one-line label (55 characters): a second line would hide
// under the box (iss-endpoint-page.test.ts holds the length). The text is a fixed caption: the box's text is never put in a Log line.
procedure ShowKeyLabel();
begin
  if KeyWasSaved and (RemoteKeyEdit.Text = SAVED_KEY_MARK) then
    KeyLabel.Caption := 'API key: saved key kept (replace the dots to change it)'
  else
    KeyLabel.Caption := 'API key (empty for an endpoint that needs none)';
end;

// Any edit of the key box (a typed key, a cleared box, a fill button) means the saved key is no longer the one to keep, unless the edits
// brought the box back to the mark (a typed character, then Backspace): then the saved key is the one to keep, and the mark of a saved key is never sent as a key.
procedure RemoteKeyChanged(Sender: TObject);
begin
  KeySaved := KeyWasSaved and (RemoteKeyEdit.Text = SAVED_KEY_MARK);
  ShowKeyLabel();
end;

// The key part of `install endpoint-models`: the saved key stays in the settings (`--saved-key`), a typed one is given (`--key`, empty
// included: without a key option the launcher falls back to the settings' key, so an empty box must say so).
function ListKeyArguments(): String;
begin
  if KeySaved then
    Result := ' --saved-key'
  else
    Result := ' --key ' + Quoted(RemoteKeyEdit.Text);
end;

// The LLM part of `configure`, for the endpoint page's save and the progress page's save: the saved key is kept by the launcher and never
// travels on a command line; a typed key (or a clear key an older install saved) is given as before.
function RemoteLlmArguments(): String;
begin
  if KeySaved then
    Result := '--llm-remote-saved-key ' + Quoted(Trim(RemoteUrlEdit.Text)) + ' ' + Quoted(Trim(RemoteModelCombo.Text))
  else
    Result := '--llm-remote ' + Quoted(Trim(RemoteUrlEdit.Text)) + ' ' + Quoted(RemoteKeyEdit.Text) + ' ' + Quoted(Trim(RemoteModelCombo.Text));
end;

// After the first successful `configure` over a key the settings held in clear: the launcher encrypted it, and the setup throws
// configure's words away, so it says so itself, once (owner rule: an automatic change is always told). Not told when the box was emptied
// (no key was saved) or the local model was chosen.
procedure NoteClearKeyMigrated();
begin
  if (not ClearKeyMigrated) or (RemoteKeyEdit.Text = '') then
    Exit;
  ClearKeyMigrated := False;
  Log('API key: ' + KEY_ENCRYPTED_NOTICE);
  if not WizardSilent then
    SuppressibleMsgBox(KEY_ENCRYPTED_NOTICE, mbInformation, MB_OK, IDOK);
end;

// The form in which two endpoint URLs are compared: trimmed, without trailing slashes.
function UrlForComparison(const Url: String): String;
begin
  Result := Trim(Url);
  while (Result <> '') and (Copy(Result, Length(Result), 1) = '/') do
    Result := Copy(Result, 1, Length(Result) - 1);
end;

// Before the save: the saved key is kept (the launcher uses it for whatever URL is in the box) and the player is told once when that URL
// is not the one the key was saved for (owner 2026-11-07: a warning to change the key, no automation). It only reads: the key, its flags
// and the URL stay as they are, and OK goes on. The wizard shows a box; a silent install has no key box, so its log line names /LLMKEY=.
procedure NoteSavedKeyKeptForOtherUrl();
var
  NewUrl, Shown: String;
begin
  NewUrl := UrlForComparison(RemoteUrlEdit.Text);
  if (not KeySaved) or (SavedBaseUrl = '') or (NewUrl = UrlForComparison(SavedBaseUrl)) or (NewUrl = KeyUrlChangeTold) then
    Exit;
  KeyUrlChangeTold := NewUrl;
  Shown := Trim(RemoteUrlEdit.Text);
  Log('API key: the saved key was made for ' + SavedBaseUrl + ' and is kept for ' + Shown + '. If that is another provider, run the setup again with /LLMKEY=<its key>.');
  if not WizardSilent then
    SuppressibleMsgBox('The saved API key was made for ' + SavedBaseUrl + '. Setup keeps it and sends it to ' + Shown + ' when it tests the endpoint.' + #13#10#13#10 + 'If ' + Shown + ' is another provider, replace the dots in the API key box with that provider''s key (if the test refuses the saved key, you stay on this page to do it).', mbInformation, MB_OK, IDOK);
end;

// The text without the notice that starts it: the launcher's error and detail start with the /v1 notice, which is shown on its own.
function WithoutNotice(const Text, Notice: String): String;
begin
  Result := Text;
  if (Notice <> '') and (Copy(Text, 1, Length(Notice)) = Notice) then
    Result := Trim(Copy(Text, Length(Notice) + 1, Length(Text)));
end;

// After `install endpoint-test` and `install endpoint-models`: a URL the launcher corrected (it added /v1) goes in the URL box, so
// ConfigureArguments saves it and the next run asks it at once, and the notice is logged and shown once. Silent: the log only.
procedure ApplyEndpointCorrection(const Json: String);
var
  Corrected, Notice: String;
begin
  Corrected := JsonString(Json, 'correctedUrl');
  Notice := JsonString(Json, 'notice');
  if Corrected <> '' then
    RemoteUrlEdit.Text := Corrected;
  if Notice = '' then
    Exit;
  Log('Endpoint URL: ' + Notice);
  if not WizardSilent then
    SuppressibleMsgBox(Notice, mbInformation, MB_OK, IDOK);
end;

function ModelLineId(const Line: String): String;
var
  Tab: Integer;
begin
  Tab := Pos(#9, Line);
  if Tab = 0 then
    Result := Line
  else
    Result := Copy(Line, 1, Tab - 1);
end;

function ModelLineInfo(const Line: String): String;
var
  Tab: Integer;
begin
  Tab := Pos(#9, Line);
  if Tab = 0 then
    Result := ''
  else
    Result := Copy(Line, Tab + 1, Length(Line));
end;

procedure AddModelLine(const Line: String);
var
  Count: Integer;
begin
  if Trim(Line) = '' then
    Exit;
  Count := GetArrayLength(ModelListLines);
  SetArrayLength(ModelListLines, Count + 1);
  ModelListLines[Count] := Line;
end;

// Reads the list file the launcher wrote (UTF-8, one `<id>#9<info>` per line) into ModelListLines; False when it is unreadable or empty.
function LoadModelList(): Boolean;
var
  Raw: AnsiString;
  Text, Line: String;
  I: Integer;
begin
  Result := False;
  SetArrayLength(ModelListLines, 0);
  if not LoadStringFromFile(ModelListFile(), Raw) then
    Exit;
  Text := UTF8Decode(Raw);
  Line := '';
  for I := 1 to Length(Text) do
  begin
    if Text[I] = #10 then
    begin
      AddModelLine(Line);
      Line := '';
    end
    else if Text[I] <> #13 then
      Line := Line + Text[I];
  end;
  AddModelLine(Line);
  Result := GetArrayLength(ModelListLines) > 0;
end;

// The combo's items are the listed ids that contain the filter (case ignored). What the player typed in the combo stays: a refill of a
// drop-down combo may clear its edit text (unprobed), so it is saved and put back.
procedure FillModelCombo();
var
  Typed, Filter, Id: String;
  I, Shown: Integer;
begin
  Typed := RemoteModelCombo.Text;
  Filter := Lowercase(Trim(ModelFilterEdit.Text));
  RemoteModelCombo.Items.Clear;
  Shown := 0;
  for I := 0 to GetArrayLength(ModelListLines) - 1 do
  begin
    Id := ModelLineId(ModelListLines[I]);
    if (Filter = '') or (Pos(Filter, Lowercase(Id)) > 0) then
    begin
      RemoteModelCombo.Items.Add(Id);
      Shown := Shown + 1;
    end;
  end;
  RemoteModelCombo.Text := Typed;
  if GetArrayLength(ModelListLines) = 0 then
    FilterCountText.Caption := ''
  else
    FilterCountText.Caption := IntToStr(Shown) + ' of ' + IntToStr(GetArrayLength(ModelListLines)) + ' models';
end;

procedure FilterChanged(Sender: TObject);
begin
  FillModelCombo();
end;

// The info of the listed model whose id is in the combo (context, prices, parameters it does not list); nothing for a typed name.
procedure ModelComboChanged(Sender: TObject);
var
  I: Integer;
begin
  ModelInfoText.Caption := '';
  for I := 0 to GetArrayLength(ModelListLines) - 1 do
    if ModelLineId(ModelListLines[I]) = Trim(RemoteModelCombo.Text) then
      ModelInfoText.Caption := ModelLineInfo(ModelListLines[I]);
end;

// `Ollama on another PC`: a URL to complete, no key (Ollama has none), and <IP> selected so typing replaces it.
procedure FillOllamaOnAnotherPc(Sender: TObject);
begin
  RemoteUrlEdit.Text := 'http://<IP>:11434/v1';
  RemoteKeyEdit.Text := '';
  WizardForm.ActiveControl := RemoteUrlEdit;
  RemoteUrlEdit.SelStart := Pos('<IP>', RemoteUrlEdit.Text) - 1;
  RemoteUrlEdit.SelLength := 4;
end;

procedure ShowOllamaHelp(Sender: TObject);
begin
  MsgBox('Ollama on another PC: on that PC set OLLAMA_HOST=0.0.0.0:11434 (Windows Settings > System > About > Advanced system settings > Environment Variables), restart Ollama, and allow TCP port 11434 in Windows Firewall for Private networks only.' + #13#10#13#10 + 'Ollama has no password: use this only on a network you trust. Leave the key empty.', mbInformation, MB_OK);
end;

// The page's inputs and buttons are off while a launcher run is in progress (the list or the endpoint test): the run keeps the window
// answering, and a click on List models inside the test would start a second run over the same step-result file.
procedure SetEndpointControlsEnabled(Enabled: Boolean);
begin
  ListModelsButton.Enabled := Enabled;
  OllamaOtherPcButton.Enabled := Enabled;
  RemoteUrlEdit.Enabled := Enabled;
  RemoteKeyEdit.Enabled := Enabled;
  ModelFilterEdit.Enabled := Enabled;
  RemoteModelCombo.Enabled := Enabled;
end;

// `List models`: asks the endpoint for its models (`install endpoint-models`) and fills the combo. A failure is told in the list status
// (the model name can still be typed); the model name is not demanded, since finding it is the point.
procedure ListModels(Sender: TObject);
var
  Json, Problem: String;
  Listed: Boolean;
begin
  Problem := RemoteUrlProblem();
  if Problem <> '' then
  begin
    MsgBox(Problem, mbError, MB_OK);
    Exit;
  end;
  SetEndpointControlsEnabled(False);
  WizardForm.NextButton.Enabled := False;
  ListStatus.Caption := 'Asking the endpoint for its models...';
  SetArrayLength(ModelListLines, 0);
  // A list file of an earlier press must never be read as this press's answer: the step writes none on a failure.
  DeleteFile(ModelListFile());
  Listed := RunStepSucceeded('install endpoint-models --url ' + Quoted(Trim(RemoteUrlEdit.Text)) + ListKeyArguments() + ' --list ' + Quoted(ModelListFile()), EndpointGauge, EndpointStepStatus, Json);
  ApplyEndpointCorrection(Json);
  if Listed and LoadModelList() then
    ListStatus.Caption := WithoutNotice(JsonString(Json, 'detail'), JsonString(Json, 'notice'))
  else if Listed then
    ListStatus.Caption := 'The endpoint answered, but its model list could not be read. Type the model name.'
  else if JsonString(Json, 'error') = '' then
    ListStatus.Caption := 'The model list could not be fetched (the step gave no answer). Type the model name.'
  else
    ListStatus.Caption := WithoutNotice(StepFailureText(Json), JsonString(Json, 'notice'));
  FillModelCombo();
  ModelComboChanged(nil);
  EndpointStepStatus.Caption := '';
  EndpointGauge.Position := 0;
  SetEndpointControlsEnabled(True);
  WizardForm.NextButton.Enabled := True;
end;

// The remote choice's page: URL, key, a model list the player can fetch and filter, the model name, and the page's own status and
// gauge for the endpoint test (Next) and the list. Units are the .iss's (ScaleY applied by the helpers).
procedure CreateEndpointPage();
var
  OllamaHelpButton: TButton;
  FilterLabel: TNewStaticText;
begin
  EndpointPage := CreateCustomPage(ModelPage.ID, 'AI endpoint', 'Which OpenAI-compatible API should the bots use?');
  AddText(EndpointPage, 'Endpoint URL (for example https://openrouter.ai/api/v1)', 0, 14);
  RemoteUrlEdit := AddEdit(EndpointPage, 15, 0, EndpointPage.SurfaceWidth);
  OllamaOtherPcButton := AddButton(EndpointPage, 'Ollama on another PC', 46, 0, 140);
  OllamaOtherPcButton.OnClick := @FillOllamaOnAnotherPc;
  OllamaHelpButton := AddButton(EndpointPage, 'Help...', 46, 148, 75);
  OllamaHelpButton.OnClick := @ShowOllamaHelp;
  KeyLabel := AddText(EndpointPage, 'API key (empty for an endpoint that needs none)', 76, 14);
  RemoteKeyEdit := TPasswordEdit.Create(EndpointPage);
  RemoteKeyEdit.Parent := EndpointPage.Surface;
  RemoteKeyEdit.Left := 0;
  RemoteKeyEdit.Top := ScaleY(91);
  RemoteKeyEdit.Width := EndpointPage.SurfaceWidth;
  ListModelsButton := AddButton(EndpointPage, 'List models', 116, 0, 90);
  ListModelsButton.OnClick := @ListModels;
  ListStatus := AddText(EndpointPage, LIST_COST_TEXT, 114, 28);
  ListStatus.Left := ScaleX(98);
  ListStatus.Width := EndpointPage.SurfaceWidth - ScaleX(98);
  FilterLabel := AddText(EndpointPage, 'Filter', 150, 14);
  FilterLabel.Width := ScaleX(40);
  ModelFilterEdit := AddEdit(EndpointPage, 146, ScaleX(44), ScaleX(150));
  FilterCountText := AddText(EndpointPage, '', 150, 14);
  FilterCountText.Left := ScaleX(204);
  FilterCountText.Width := EndpointPage.SurfaceWidth - ScaleX(204);
  AddText(EndpointPage, 'Model name (type it, or list the models and pick one)', 172, 14);
  ModelInfoText := AddText(EndpointPage, '', 210, 28);
  RemoteModelCombo := TNewComboBox.Create(EndpointPage);
  RemoteModelCombo.Parent := EndpointPage.Surface;
  RemoteModelCombo.Left := 0;
  RemoteModelCombo.Top := ScaleY(187);
  RemoteModelCombo.Width := EndpointPage.SurfaceWidth;
  // A drop-down you can type in. Inno's TNewComboBox does not expose AutoComplete (ISCC 6.7.3: Unknown identifier), so a typed id that
  // starts a longer listed id may be completed by the control (unprobed). What is saved is the combo's text as the player sees it
  // when pressing Next, and the endpoint test's detail, which names the model that answered, goes to the setup log.
  RemoteModelCombo.Style := csDropDown;
  ModelFilterEdit.OnChange := @FilterChanged;
  RemoteModelCombo.OnChange := @ModelComboChanged;
  EndpointStepStatus := AddText(EndpointPage, '', 240, 28);
  EndpointGauge := AddGauge(EndpointPage, 270);
end;
