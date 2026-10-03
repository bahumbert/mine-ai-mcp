/**
 * Game data generated per Minecraft version from its server jar (`data/<kind>/<version>.json`) is served for the
 * server's own version, else for the nearest older shipped one: such data rarely changes between patch versions.
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

/** The shipped file for `version`, else the nearest older one, else null when every shipped file is newer. */
export function nearestShipped<T extends { readonly version: string }>(version: string, shipped: readonly T[]): T | null {
  const older = shipped.filter((data) => compareVersions(data.version, version) <= 0);
  return older.sort((a, b) => compareVersions(b.version, a.version))[0] ?? null;
}
