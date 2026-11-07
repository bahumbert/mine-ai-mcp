# Privacy

This page lists every network contact of Mine AI and who chooses it. The downloads are described in
[docs/install/windows.md](install/windows.md#what-the-installer-downloads-and-from-where).

## Update check: GitHub

- **What is sent:** one GET request to `api.github.com` for the latest release. It carries no data about the player,
  no name, no settings and no account. As with any web request, GitHub sees the IP address of the PC.
- **When:** at each start of Mine AI, unless it is off.
- **Who chose it:** at a first install, the setup asks with a box, "Check for a newer Mine AI at each start", checked
  by default. `/CHECKUPDATES=0` turns it off for a silent install. `"checkUpdates": false` in `settings.json` turns it off
  afterwards.

## Downloads chosen during setup

Each download happens only for a choice made on the setup pages. Each is checked against its hash (SHA-256; Mojang's
SHA-1 for the server file) before it runs.

- **Ollama**, from its official release, when a local AI model is chosen and Ollama is not installed yet.
- **The AI model**, from Ollama's model library, through Ollama, when a local AI model is chosen.
- **Java (Temurin JRE 21)**, from Adoptium, when a Minecraft server on this PC is chosen.
- **Minecraft server 1.21.4**, from Mojang, when a Minecraft server on this PC is chosen and the Minecraft EULA is
  accepted.

## The AI endpoint

- **What is sent:** the bots' prompts, which hold the chat and the game state the bots see. They go to the AI endpoint
  the player typed in, and the endpoint's own privacy policy applies to them.
- **Local Ollama:** when the endpoint is Ollama on this PC, the prompts stay on this PC.
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
