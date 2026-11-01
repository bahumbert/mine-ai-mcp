/** The once-per-start look for a newer release (GitHub releases API, one GET). It only tells; it never downloads. */
import { z } from "zod";

/** A slow or blocked network must not hold up the start banner. */
const UPDATE_CHECK_TIMEOUT_MS = 5_000;

const releaseSchema = z.object({ tag_name: z.string(), html_url: z.string().optional() });

export interface AvailableUpdate {
  readonly latest: string;
  /** The release page, when the answer named one. */
  readonly url?: string;
}

/** `v1.3.0` and `1.3.0` both become `[1, 3, 0]`; null for a tag that is not dotted numbers (`nightly`). */
function versionParts(tag: string): number[] | null {
  const match = /^v?(\d+(?:\.\d+)*)$/u.exec(tag.trim());
  return match ? match[1]!.split(".").map(Number) : null;
}

/** True when `candidate` is a higher version than `current`, compared number by number (1.10 is newer than 1.9). */
export function isNewerVersion(candidate: string, current: string): boolean {
  const [a, b] = [versionParts(candidate), versionParts(current)];
  if (a === null || b === null) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const [x, y] = [a[i] ?? 0, b[i] ?? 0];
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * The newer release `latestUrl` names, or null: same or older version, offline, an error status, a body that is not a
 * release. Never throws, so a start never fails because of it. `enabled` is `settings.checkUpdates`: off sends nothing.
 */
export async function checkUpdate(current: string, latestUrl: string, fetchImpl: typeof fetch = fetch, enabled = true): Promise<AvailableUpdate | null> {
  if (!enabled) return null;
  try {
    const response = await fetchImpl(latestUrl, { headers: { accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS) });
    if (!response.ok) return null;
    const release = releaseSchema.parse(await response.json());
    if (!isNewerVersion(release.tag_name, current)) return null;
    return { latest: release.tag_name.replace(/^v/u, ""), ...(release.html_url ? { url: release.html_url } : {}) };
  } catch {
    return null;
  }
}
