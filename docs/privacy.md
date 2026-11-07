# Privacy

This page lists every network contact of Mine AI and who chooses it. The downloads are described in
[docs/install/windows.md](install/windows.md#what-the-installer-downloads-and-from-where).

## Update check: GitHub

- **What is sent:** one GET request to `api.github.com` for the latest release. It carries no data about the player,
  no name, no settings and no account. As with any web request, GitHub sees the IP address of the PC.
- **When:** at each start of Mine AI, unless it is off.
- **Who chose it:** at a first install, the setup asks with a box, "Check for a newer Mine AI at each start", checked
  by default unless the data folder's settings already turned the check off. `/CHECKUPDATES=0` turns it off for a silent install. `"checkUpdates": false` in `settings.json` turns it off afterwards.

## Size checks on the AI model page (wizard only)

When the setup shows its AI model page, it asks how large the downloads it may make would be, so the page can show
the sizes. Each check is skipped when that part is already on the PC:

- a HEAD request to the Ollama setup's URL, on GitHub, when Ollama is not installed yet;
- a HEAD request to Adoptium's Java URL (it redirects to GitHub), when Java is not installed yet;
- a HEAD request to Mojang's server file, when the server file is not on the PC yet;
- a GET of the AI model's manifest from Ollama's model registry, when the model is not on the PC yet.

Only the PC's address is seen. Nothing is downloaded by these checks.

## Downloads chosen during setup

Each download happens only for a choice made on the setup pages (the size checks above are not downloads). Each is
checked against its hash (SHA-256; Mojang's SHA-1 for the server file) before it runs.

- **Ollama**, from its official release, when a local AI model is chosen and Ollama is not installed yet.
- **The AI model**, from Ollama's model library, through Ollama, when a local AI model is chosen.
- **Java (Temurin JRE 21)**, from Adoptium, when a Minecraft server on this PC is chosen.
- **Minecraft server 1.21.4**, from Mojang, when a Minecraft server on this PC is chosen and the Minecraft EULA is
  accepted.

## The AI endpoint

- **What is sent:** the bots' prompts, which hold the chat and the game state the bots see. They go to the AI endpoint
  the player typed in, and the endpoint's own privacy policy applies to them.
- **Local Ollama:** when the endpoint is Ollama on this PC, the prompts stay on this PC.
- **The setup's own calls:** on the AI endpoint page, the setup asks the endpoint for its model list and sends one test chat
  request to check the endpoint (a second request when the address needs `/v1`). Both carry the API key when one is set.
- **Who chose it:** the player, on the AI endpoint page of the setup or in `settings.json`.

## The Minecraft server

- **What is sent:** the bots connect to the Minecraft server the player names, as any Minecraft client does: their
  moves, chat and actions in the game.
- **Who chose it:** the player, on the server page of the setup or in `settings.json`.

## No telemetry, no account

Mine AI sends no telemetry and has no account.

## Privacy policies of the services involved

- Ollama: https://ollama.com/privacy
- Eclipse Foundation (Adoptium, Temurin): https://www.eclipse.org/legal/privacy/
- Microsoft, which owns Mojang (Minecraft): https://privacy.microsoft.com/privacystatement
- GitHub: https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement
