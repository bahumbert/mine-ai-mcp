// Where a client's source tree starts, and whether it sits on a 9P mount: the scenario daemon judges "our client host" and mirrors a tree by its root, not by an absolute path.
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const ROOT_MARKER_FILE = "bun.lock";
const NINE_P_TYPES: ReadonlySet<string> = new Set(["9p", "v9fs"]);

/** The nearest ancestor directory of `startPath` (itself when a directory) holding `bun.lock`: the worktree's root; null when none up to `/`. */
export function sourceRootOf(startPath: string): string | null {
  let directory = path.resolve(startPath);
  if (!isDirectory(directory)) directory = path.dirname(directory);
  for (;;) {
    if (existsSync(path.join(directory, ROOT_MARKER_FILE))) return directory;
    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/** `/proc/mounts` writes a space, tab, newline or backslash in a mount point as a three-digit octal escape. */
function decodeMountEscapes(field: string): string {
  return field.replace(/\\([0-7]{3})/gu, (_escape, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function isUnderMountPoint(target: string, mountPoint: string): boolean {
  return mountPoint === "/" || target === mountPoint || target.startsWith(`${mountPoint}/`);
}

/** Whether `target` lies on a 9P mount: `mounts` is `/proc/mounts` text, and the mount point with the longest prefix of `target` decides. */
export function ninePMountOf(target: string, mounts: string): boolean {
  let longest = -1;
  let type = "";
  for (const line of mounts.split("\n")) {
    const [, mountField, typeField] = line.trim().split(/\s+/u);
    if (mountField === undefined || typeField === undefined) continue;
    const mountPoint = decodeMountEscapes(mountField);
    // `>=`: /proc/mounts is in mount order, so a later mount on the same point hides the earlier one.
    if (isUnderMountPoint(target, mountPoint) && mountPoint.length >= longest) {
      longest = mountPoint.length;
      type = typeField;
    }
  }
  return NINE_P_TYPES.has(type);
}

/** A directory name for a root: its last segment plus 12 hex of the SHA-256 of the whole path, so it reads well and two roots never collide. */
export function rootSlug(root: string): string {
  return `${path.basename(root)}-${createHash("sha256").update(root).digest("hex").slice(0, 12)}`;
}
