import { spawn } from 'node:child_process';
import { readFile, appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

// Vanilla writes `[hh:mm:ss] [Server thread/INFO]: <name> joined the game`; Paper's console file writes
// `[hh:mm:ss INFO]: ESC[38;2;255;255;85m<name> joined the gameESC[0m` (colour codes even into a file).
// The name must follow the line's own prefix, so a chat line cannot imitate a join.
const colourCodes = /\x1b\[[0-9;]*m/g;
const joinLine = /^\[[^\]]+\](?: \[[^\]]+\])?: ([A-Za-z0-9_]{1,16}) joined the game\s*$/;

/** The player name of a join line of either server program, else undefined. */
export function joinedPlayer(line) {
  return line.replace(colourCodes, '').match(joinLine)?.[1];
}

async function followJoins() {
  const observers = JSON.parse(await readFile('/config/observers.json', 'utf8'));
  // Follow the Java console without owning the Java process itself.
  const tail = spawn('tail', ['-n', '0', '-F', process.env.MINECRAFT_LOG]);
  process.once('SIGTERM', () => tail.kill());
  process.once('SIGINT', () => tail.kill());
  for await (const line of createInterface({ input: tail.stdout })) {
    const name = joinedPlayer(line);
    if (name && observers.includes(name)) await appendFile('/tmp/minecraft-input', `gamemode spectator ${name}\n`);
  }
}

if (import.meta.main) await followJoins();
