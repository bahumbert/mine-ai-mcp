// The listener child process: `bun launcher/src/listener/main.ts --host <h> --port <n> --version <v> --username <name> --prefix <p>`.
// stdout: one JSON object per line (`joined`, `command`, `ended`); stdin: one JSON object per line (`whisper`). The
// launcher's `ListenerSupervisor` is the other end. Exits 0 after `ended`, or when the launcher closes stdin.
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import mineflayer from "mineflayer";
import { z } from "zod";
import { runListener, type ListenerBot, type ListenerEvent } from "./listener.ts";

const stdinLineSchema = z.object({ kind: z.literal("whisper"), to: z.string(), message: z.string() });

function parseListenerArgs(argv: readonly string[]) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      host: { type: "string" },
      port: { type: "string" },
      version: { type: "string" },
      username: { type: "string" },
      prefix: { type: "string" },
    },
  });
  const { host, port, version, username, prefix } = values;
  const portNumber = Number(port);
  if (!host || !version || !username || !prefix || !Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65_535) {
    throw new Error("Usage: listener --host <host> --port <1-65535> --version <version> --username <name> --prefix <prefix>");
  }
  return { host, port: portNumber, version, username, prefix };
}

function writeEvent(event: ListenerEvent): void {
  process.stdout.write(`${JSON.stringify(event)}\n`, () => {
    if (event.kind === "ended") process.exit(0);
  });
}

function main(): void {
  const options = parseListenerArgs(process.argv.slice(2));
  const bot = mineflayer.createBot({
    host: options.host,
    port: options.port,
    username: options.username,
    version: options.version,
    auth: "offline",
    hideErrors: true,
  });
  // mineflayer's `Bot` types its events more narrowly than `ListenerBot` (its `kicked` says `string`, the wire gives NBT too).
  const listener = runListener(bot as unknown as ListenerBot, { emit: writeEvent, prefix: options.prefix });

  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (line.trim() === "") return;
    try {
      const request = stdinLineSchema.safeParse(JSON.parse(line));
      if (request.success) listener.whisper(request.data.to, request.data.message);
    } catch {
      // Not JSON: nothing the launcher sends; skip it.
    }
  });
  // The launcher is gone (or closed our stdin): leave the server; `end` follows and exits the process.
  input.on("close", () => bot.end("launcher closed stdin"));
}

main();
