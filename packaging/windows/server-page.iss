// The local server's program and the server page of the Mine AI installer: the Minecraft server choice (none, on this PC, an existing
// one) and, under the local radio, Paper (recommended) or vanilla (plan 2026-11-14-p4-31-paper-server, Task 9b). Included by mine-ai.iss
// inside its [Code] section, after endpoint-page.iss (the page comes after the endpoint page), so Pascal Script sees one script.
// Needs from mine-ai.iss, above the #include: the page helpers (AddText, AddRadio, AddEdit), DataDir, the variables of the server
// page (ServerPage, ServerNoneRadio ... ServerPaperRadio, ServerVanillaRadio, ServerProgramPanel, ServerDownloadText) and EndpointPage.
// Holds: AddProgramRadio; ProgramWords (the Ready list); ServerDownloadCaption, ShowServerDownloadText, ServerChoiceChanged;
// ServerProgramArgument (the `configure` flag); CreateServerPage. iss-server-page.test.ts pins it.

// A radio and the text under it, both on Panel (not on the page's surface): Windows groups the radios of one parent, so the program
// choice is a group of its own beside the server radios, and a disabled panel greys the radio and its text together.
// Top is the radio's row in the panel, TextHeight the room of the text (it starts 18 below the radio).
function AddProgramRadio(Panel: TPanel; Page: TWizardPage; const Text, Description: String; Top, TextHeight: Integer): TNewRadioButton;
var
  Words: TNewStaticText;
begin
  Result := TNewRadioButton.Create(Page);
  Result.Parent := Panel;
  Result.Caption := Text;
  Result.Left := 0;
  Result.Top := ScaleY(Top);
  Result.Width := Panel.Width;
  Result.Height := ScaleY(17);
  Words := TNewStaticText.Create(Page);
  Words.Parent := Panel;
  Words.AutoSize := False;
  Words.WordWrap := True;
  Words.Caption := Description;
  Words.Left := ScaleX(18);
  Words.Top := ScaleY(Top + 18);
  Words.Width := Panel.Width - ScaleX(18);
  Words.Height := ScaleY(TextHeight);
end;

// The saved `server.program` in words: a settings.json without the key (an install from before Paper) runs vanilla, as the launcher reads it.
function ProgramWords(const Saved: String): String;
begin
  if Saved = 'paper' then
    Result := 'Paper'
  else
    Result := 'vanilla';
end;

// What a local server downloads and from where, for the program chosen; the data folder is the one DataDir('') names.
function ServerDownloadCaption(): String;
begin
  if ServerPaperRadio.Checked then
    Result := 'A server on this PC downloads Java (from Adoptium), the Paper server (from PaperMC) and the Minecraft server file Paper builds on (from Mojang, after you accept the EULA) into your data folder, ' + DataDir('') + '. Nothing else is installed.'
  else
    Result := 'A server on this PC downloads Java (from Adoptium) and the Minecraft server (from Mojang, after you accept the EULA) into your data folder, ' + DataDir('') + '. Nothing else is installed.';
end;

// Written when the server page shows (the data folder is known by then) and again when a radio changes the program.
procedure ShowServerDownloadText();
begin
  ServerDownloadText.Caption := ServerDownloadCaption();
end;

procedure ServerChoiceChanged(Sender: TObject);
begin
  ServerHostEdit.Enabled := ServerRemoteRadio.Checked;
  ServerPortEdit.Enabled := ServerRemoteRadio.Checked;
  // The program is the local server's: the panel, its radios and their texts are off for no server and for an existing one.
  ServerProgramPanel.Enabled := ServerLocalRadio.Checked;
  ServerPaperRadio.Enabled := ServerLocalRadio.Checked;
  ServerVanillaRadio.Enabled := ServerLocalRadio.Checked;
  // Not before the page is on screen: the data folder is chosen on an earlier page.
  if WizardForm.CurPageID = ServerPage.ID then
    ShowServerDownloadText();
end;

// The program of a local server for `configure`: the radio checked on the server page (or /SERVERPROGRAM=, or the saved one).
function ServerProgramArgument(): String;
begin
  if ServerVanillaRadio.Checked then
    Result := ' --server-program vanilla'
  else
    Result := ' --server-program paper';
end;

procedure CreateServerPage();
var
  PortLeft: Integer;
begin
  ServerPage := CreateCustomPage(EndpointPage.ID, 'Minecraft server', 'Which Minecraft server should the bots join?');
  ServerNoneRadio := AddRadio(ServerPage, 'No server for now (I will set one in settings.json)', 0);
  ServerLocalRadio := AddRadio(ServerPage, 'Install a Minecraft server on this PC (only this PC can join, by default)', 24);
  // The program of the local server, indented under its radio: vanilla first, Paper second and checked (owner 2026-11-15), the
  // text of each under its radio. 42 to 138: room for two lines of each text, 26 for vanilla's, 32 for Paper's (26 cut its
  // second line on the T14 walk); every row below is that height further down.
  // Inno does not scroll a custom page: the modern wizard's surface ends near row 305 (T14 walk, 2026-11-15).
  ServerProgramPanel := TPanel.Create(ServerPage);
  ServerProgramPanel.Parent := ServerPage.Surface;
  ServerProgramPanel.BevelOuter := bvNone;
  ServerProgramPanel.Left := ScaleX(16);
  ServerProgramPanel.Top := ScaleY(42);
  ServerProgramPanel.Width := ServerPage.SurfaceWidth - ScaleX(16);
  ServerProgramPanel.Height := ScaleY(96);
  ServerVanillaRadio := AddProgramRadio(ServerProgramPanel, ServerPage, 'Vanilla (Mojang''s own server)',
    'The standard server program. It may slow down with many companions.', 0, 26);
  ServerPaperRadio := AddProgramRadio(ServerProgramPanel, ServerPage, 'Paper (recommended)',
    'The same game, run by a faster server program. The better choice if you plan to run many companions (more than 5, for example). Animals and monsters far from every player move less.', 46, 32);
  ServerPaperRadio.Checked := True;
  ServerRemoteRadio := AddRadio(ServerPage, 'Use an existing server', 140);
  PortLeft := (ServerPage.SurfaceWidth * 3) div 4;
  AddText(ServerPage, 'Address', 164, 14);
  ServerHostEdit := AddEdit(ServerPage, 178, 0, PortLeft - ScaleX(8));
  ServerPortEdit := AddEdit(ServerPage, 178, PortLeft, ServerPage.SurfaceWidth - PortLeft);
  ServerPortEdit.Text := IntToStr(DEFAULT_SERVER_PORT);
  AddText(ServerPage, 'An existing server must be vanilla or Paper Minecraft 1.21.4 with online-mode=false (the bots join without a Minecraft account). Mine AI checks it before starting any bot.', 206, 44);
  ServerNoneRadio.Checked := True;
  ServerNoneRadio.OnClick := @ServerChoiceChanged;
  ServerLocalRadio.OnClick := @ServerChoiceChanged;
  ServerRemoteRadio.OnClick := @ServerChoiceChanged;
  ServerPaperRadio.OnClick := @ServerChoiceChanged;
  ServerVanillaRadio.OnClick := @ServerChoiceChanged;
  // What a local server downloads and where, filled by ShowServerDownloadText once the data folder is known.
  ServerDownloadText := AddText(ServerPage, '', 252, 44);
  ServerChoiceChanged(nil);
end;
