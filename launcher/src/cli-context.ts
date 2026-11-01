// What every `mine-ai` command gets: the data root, the app root and the two output lines.
import { appRoot } from "./paths.ts";
import { loadManifest, type Manifest } from "./manifest.ts";

export interface CliContext {
  readonly root: string;
  readonly appRoot: string;
  /** Standard output: what the installer and the player read. */
  out(line: string): void;
  err(line: string): void;
  loadManifest(): Manifest;
}

export function realCliContext(root: string): CliContext {
  return { root, appRoot: appRoot(), out: (line) => console.log(line), err: (line) => console.error(line), loadManifest: () => loadManifest() };
}

/** A command that was called with arguments it does not take: `main.ts` prints the message and the usage, exit code 2. */
export class UsageError extends Error {}
