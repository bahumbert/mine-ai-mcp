// Where bot-data and world-data files live under a data root: one folder per world, a file-safe name per identity.
import { createHash } from "node:crypto";
import path from "node:path";
import type { BotDataScope } from "./bot-data-identity.js";

/** The folder of one world: `bots/`, `shared/` and `world/` sit inside it. */
export function worldDirectoryFor(root: string, worldId: string): string {
  return path.join(path.resolve(root), identitySegment("world", worldId));
}

/** The folder of one bot file: a bot's own, or the shared one of the world. */
export function botDataDirectoryFor(root: string, worldId: string, scope: BotDataScope): string {
  const worldDirectory = worldDirectoryFor(root, worldId);
  if (scope.kind === "shared") return path.join(worldDirectory, "shared");
  return path.join(worldDirectory, "bots", identitySegment("bot", scope.botId));
}

/** The world file's path: the chunk scans every bot of the world shares. */
export function worldDataFileFor(root: string, worldId: string): string {
  return path.join(worldDirectoryFor(root, worldId), "world", "world-data.sqlite");
}

function identitySegment(fallback: string, identity: string): string {
  const readable = identity
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 12);
  return `${readable || fallback}-${digest}`;
}
