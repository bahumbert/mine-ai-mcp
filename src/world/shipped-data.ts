/**
 * Game data generated per Minecraft version from its server jar (`data/<kind>/<version>.json`) is served for the
 * server's own version, else for the nearest older shipped one, else for the nearest newer one of the same minor
 * version (1.21.4 for 1.21.1): such data rarely changes between patch versions (live 2026-10-07: on a 1.21.1 server no
 * block was a source of anything, and `get_items` could gather nothing).
 */

function versionParts(version: string): number[] {
  return version.split(".").map((part) => Number.parseInt(part, 10) || 0);
}

function compareVersions(a: string, b: string): number {
  const [left, right] = [versionParts(a), versionParts(b)];
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The shipped file for `version`, else the nearest older one, else the nearest newer one of the same minor version,
 * else null.
 */
export function nearestShipped<T extends { readonly version: string }>(version: string, shipped: readonly T[]): T | null {
  const older = shipped.filter((data) => compareVersions(data.version, version) <= 0);
  const nearestOlder = older.sort((a, b) => compareVersions(b.version, a.version))[0];
  if (nearestOlder !== undefined) return nearestOlder;
  const minor = versionParts(version).slice(0, 2).join(".");
  const sameMinor = shipped.filter((data) => versionParts(data.version).slice(0, 2).join(".") === minor);
  return sameMinor.sort((a, b) => compareVersions(a.version, b.version))[0] ?? null;
}
