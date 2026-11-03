// Who may give chat commands on this install (spec 2026-10-30-in-game-bot-commands D3, D5, D7); the sources and the start banner read it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Settings } from "../settings.ts";

/** `everyone`: a local server on loopback. `listed-players`: only `commands.players`. `needs-players`: that list is empty, so nobody may. `disabled`: `commands.enabled` is false. */
export type ChatAudience = "everyone" | "listed-players" | "needs-players" | "disabled";

/** The `server-ip` values that keep a Minecraft server on this PC (the installer writes `127.0.0.1`). */
const LOOPBACK_SERVER_IPS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost"]);

/** True when `<root>/server/server.properties` binds the local server to loopback; a missing file or an empty `server-ip` (all interfaces) is false. */
export function localServerIsLoopbackOnly(root: string): boolean {
  try {
    const line = readFileSync(join(root, "server", "server.properties"), "utf8").split(/\r?\n/u).find((entry) => entry.startsWith("server-ip="));
    return line !== undefined && LOOPBACK_SERVER_IPS.has(line.slice("server-ip=".length).trim());
  } catch {
    return false;
  }
}

export function chatAudience(settings: Settings, root: string): ChatAudience {
  if (!settings.commands.enabled) return "disabled";
  if (settings.server.kind === "local" && localServerIsLoopbackOnly(root)) return "everyone";
  return settings.commands.players.length > 0 ? "listed-players" : "needs-players";
}
