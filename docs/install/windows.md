# Mine AI on Windows

Mine AI puts one or more AI players (bots) into a Minecraft Java 1.21.4 server. The installer sets up everything the
bots need; you do not need a terminal, WSL, Git or administrator rights.

## Requirements

- Windows 10 or 11, 64-bit.
- Minecraft Java Edition 1.21.4, to join the same server as the bots.
- To run the AI model **on your PC**: a graphics card and memory big enough for it. The installer checks both and
  tells you when your PC falls short (the minimums are `ollama.minVramGiB`, graphics memory, and `ollama.minRamGiB`,
  RAM, in `packaging/manifest.json` of the source).
- Otherwise, a **remote endpoint**: any OpenAI-compatible service (a URL, an API key, a model name). The installer
  sends one test request before it accepts it.

## What the installer downloads, and from where

Each download is pinned to an exact version and checked against a SHA-256 hash (Mojang's SHA-1 for the server
file) before anything runs. A file that fails the check is deleted and the step stops with a message.

| What | When | From |
|---|---|---|
| Ollama | local model chosen, and Ollama not already installed | Ollama's official release (`ollama.url` in the manifest) |
| The AI model | local model chosen | Ollama's model library, through Ollama |
| Java (Temurin JRE 21) | local Minecraft server chosen | Adoptium (`java.url`) |
| Minecraft server 1.21.4 | local Minecraft server chosen, after you accept the Minecraft EULA | Mojang (`minecraft.jar.url`) |

Bun, the bots and their AI code come inside the installer. The installer never ships the Minecraft server.

## The Minecraft server

The installer asks which server the bots join:

- **None for now.** The bots do not start until you set a server (see "Settings" below).
- **A server on this PC.** Mine AI installs a vanilla server for you after you accept the
  [Minecraft EULA](https://aka.ms/MinecraftEULA). It listens on this PC only (`127.0.0.1`), with `online-mode=false`
  so the bots can join without Minecraft accounts. Join it from Minecraft at `localhost`; the console shows the port
(25565, or the next free one).
- **An existing server.** Give its address and port. It must be a **vanilla Minecraft 1.21.4** server with
  **`online-mode=false`**. At every start Mine AI checks the server and, when it is down, is another version or has
  online mode on, prints one clear line and starts no bot.

## Starting and stopping

Start **Mine AI** from the Start menu. A console window opens and shows what is running. Close the window (or press
Ctrl+C) to stop everything: the bots, the Minecraft server (the world is saved first) and the AI model. Nothing is
left running in the background.

## Commands in the game

Type these in the Minecraft chat (the prefix is `!` unless you change `commands.prefix` in `settings.json`):

- `!bots` lists the bots you can start and the ones playing.
- `!bot start <name>` starts a bot (its persona name or file name, any case).
- `!bot stop <name>` stops it.

Mine AI answers by whisper, only to the player who typed. No bot ever sees the command line.

Who may type them:

- **Server on this PC** (it listens on `127.0.0.1` only): every player.
- **Any other server**, or a local server that listens on more than this PC: only the names in `commands.players`.
  Add them with `mine-ai configure --command-players Tom,Dara` (an empty value clears the list). Anyone else is
  told once that they may not, then ignored.
- With no names listed on such a server the commands are off, and the start window says so.

On a server where no bot of yours is playing, Mine AI joins with a plain client named by `commands.listenerName`
(default `MineAI`) only to read chat and answer. It leaves as soon as one of your bots is on the server, and joins
again when the last one stops. If that name is already taken by another player, it says so in the console and stops
trying: set another `commands.listenerName`. A whitelisted server must whitelist that name too.

On an offline server (`online-mode=false`) a player name is no proof of who is typing: anyone can type any name. Use
the server's own whitelist to decide who may join. `commands.enabled: false` turns the commands off.

## Folders

The installer asks for three folders. The defaults are fine for most people.

| Folder | Default | Asked |
|---|---|---|
| Program (Mine AI itself) | `%LOCALAPPDATA%\Programs\MineAI\` | on the folder page, at a first install |
| Data (settings, personas, bot memories, the Minecraft server and its worlds, logs, and the AI model when Mine AI installs Ollama) | `%LOCALAPPDATA%\MineAI\` | on the data folder page, at a first install |
| Ollama | Ollama's own folder, `%LOCALAPPDATA%\Programs\Ollama\` | on the AI model page, only when Mine AI is going to install Ollama |

The installer refuses a folder that already holds files that are not Mine AI's (the uninstaller deletes the folders you
choose, so it must not be your `Documents`), a whole drive, a folder it cannot write in, a data folder inside the
program folder, and an Ollama folder inside either of the others.

**An update keeps the folders of the first install**: the folder pages do not show again. To move your data, uninstall
and keep the data, move the folder yourself, then install again and choose the new place.

## Settings, data and logs

Everything of yours is in your data folder, `%LOCALAPPDATA%\MineAI\` unless you chose another (the launcher reads its
place from `data-root.txt` in the program folder, or from the `MINE_AI_DATA_ROOT` environment variable):

| Path | Holds |
|---|---|
| `settings.json` | the AI model, the Minecraft server and the bots to start |
| `personas\` | one `.json` file per bot; your edits survive updates |
| `bot-data\` | what the bots remember |
| `server\` | the local Minecraft server and its world |
| `logs\` | logs for bug reports (`mine-ai doctor` lists the last errors) |

The program itself is in the program folder (`%LOCALAPPDATA%\Programs\MineAI\` by default). Updating or removing it never
touches your data folder. Mine AI puts a small file, `mine-ai-data.txt`, in the data folder: the uninstaller deletes the
folder only when that file is there. To change the server or the AI model later, edit `settings.json` and start Mine AI again, or run the installer again.

## Ollama you already have

If Ollama is already installed, Mine AI uses it and keeps it. It starts its own Ollama server on port 11435, so your
own Ollama (port 11434) and your models are never started, stopped, reinstalled or removed. The AI model stays in your
own Ollama's store, so nothing is downloaded twice. When Mine AI installs Ollama itself, Ollama's tray app also starts
with Windows, and **the AI model lives in your data folder** (`models\`, about 8 GB), so it goes with that folder.

## Updating

Run a newer installer: it installs over the old version, in the same folders, and keeps your data. Its first page,
"Ready to update or repair", lists the program folder, the data folder, and the AI model and Minecraft server you chose
before; the button is **Update**. Running the same version again repairs: any missing file comes back, and your data
folder, worlds and bots stay as they are (the AI model and server settings are set again on the pages after the copy). At a first install the Ready page lists the two folders and says that the AI model
and the server are chosen on the next pages, after the files are copied (the graphics card check happens there). Mine AI checks once at start whether a
newer release exists and tells you; it never downloads one by itself. Switch the check off with
`"checkUpdates": false` in `settings.json`.

## Uninstalling

Use **Apps > Installed apps > Mine AI**. The uninstaller asks, one question each (the default answer is No):

- whether to delete your data folder (the one you chose; worlds, bot memories, personas, settings, logs);
- whether to delete the AI model, only if Mine AI downloaded it, and not asked when it lives in the data folder and you
  said yes to the first question (it goes with the folder);
- whether to remove Ollama, only if Mine AI installed it.

It then stops the bots and removes what you chose. The data folder is deleted only when it holds `mine-ai-data.txt`;
otherwise it is kept (run the uninstaller with `/LOG="C:\path\uninstall.log"` to see why). An Ollama or a model you had before is never touched.

## Silent install (scripts, Windows Sandbox)

Run the installer with `/SILENT` (progress window only) or `/VERYSILENT` (no window), always with `/SUPPRESSMSGBOXES`
(without it Setup's own error boxes still wait for a click), and one parameter per choice the wizard asks. A parameter
you leave out keeps the choice saved by an earlier install, else the first value listed.

| Parameter | Value | Meaning |
|---|---|---|
| `/LLM=` | `local` or `remote` | Where the AI model runs. `local` fails the install when this PC cannot run it (no fallback to a remote endpoint). |
| `/LLMURL=` | URL | The remote endpoint, for example `https://host/v1`. |
| `/LLMKEY=` | text | Its API key; may be empty. |
| `/LLMMODEL=` | name | The model name the endpoint serves. |
| `/SERVER=` | `none`, `local` or `remote` | Which Minecraft server the bots join. |
| `/SERVERHOST=` | address | The existing server (`/SERVER=remote`). |
| `/SERVERPORT=` | number | Its port (default 25565). |
| `/EULA=` | `accept` | Accepts the [Minecraft EULA](https://aka.ms/MinecraftEULA). A local server (`/SERVER=local`) fails the install without it. |
| `/STARTNOW=` | `0` or `1` | Start Mine AI when the install ends (default `0`). |
| `/DATADIR=` | folder | Where Mine AI keeps your data (default `%LOCALAPPDATA%\MineAI`). |
| `/OLLAMADIR=` | folder | Where Ollama is installed when this setup installs it (default: Ollama's own folder). |
| `/DELETEDATA=` | `0` or `1` | Uninstall only; see below (default `0`). |

The program folder is Inno Setup's own `/DIR=`, not in the table. Folders are full paths (`D:\Games\Mine AI`); an update
refuses a `/DATADIR=` that differs from the folder of the first install (exit code 7, with the folder it keeps in the log).
Put a value with spaces in quotes: `/LLMKEY="my key"`. Add `/LOG="C:\path\setup.log"` to get a log file.

Example, a remote model, a local server and chosen folders:

```
MineAI-Setup-0.1.0.exe /VERYSILENT /SUPPRESSMSGBOXES /LOG="%TEMP%\mine-ai-setup.log" /LLM=remote /LLMURL=https://api.example.test/v1 /LLMKEY=sk-123 /LLMMODEL=big-model /SERVER=local /EULA=accept /DIR="D:\Games\Mine AI" /DATADIR="D:\Games\Mine AI data"
```

The installer runs the same steps as the wizard's progress page. A wrong parameter, or a folder the installer refuses
(see "Folders"), ends it with exit code 7 before any file is copied. An `/OLLAMADIR=` that is not a full path also ends
with exit code 7; the other checks of that folder (other people's files in it, inside the program or data folder) are made
only when Ollama is really about to be installed, so a refused one ends the setup with exit code 100, before anything is
downloaded. A failed step ends it with exit code 100 and writes the step's error and what to do about it to the
log; the program files stay in place. Run the same command again once the cause is fixed: each download step skips
what is already done and verified. `/LLM=local` never falls back to a remote endpoint: on a PC that cannot run the
model it fails, and an Ollama that this setup installed stays (the log gives the command that removes it).

To uninstall silently: `"%LOCALAPPDATA%\Programs\MineAI\unins000.exe" /VERYSILENT /DELETEDATA=1`. The `/DELETEDATA=` parameter
(`0` or `1`, default `0`) answers all three uninstall questions: `1` also deletes your data folder, and the AI model
and Ollama when Mine AI installed them; `0` keeps everything.

## If the installer stops

A failed download or step shows what failed and what to do, with a Retry button. If you close the installer in the
middle, run it again: each step skips what is already done and verified.
