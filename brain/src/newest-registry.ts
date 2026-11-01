// The newest minecraft-data registry version and the item facts the brain reads from it without knowing the server's version.
import minecraftData from "minecraft-data";

/**
 * The newest registry version minecraft-data ships. The brain is not told the server's version, and what it reads here
 * (creature names, boat recipes, stack sizes of buckets and boats) is the same in every version, new entries only
 * being added.
 */
export const NEWEST_REGISTRY_VERSION: string = (minecraftData as unknown as { readonly supportedVersions: { readonly pc: readonly string[] } }).supportedVersions.pc.at(-1) ?? "";

/**
 * How many of `item` one inventory slot holds, by the newest registry (null when the registry or the item is unknown).
 * A stack size of 1 marks an item kept for its use (a full bucket, a boat): the same in every version.
 */
export function stackSizeOf(item: string): number | null {
  const data = minecraftData(NEWEST_REGISTRY_VERSION) as unknown as { readonly itemsByName?: Readonly<Record<string, { readonly stackSize?: number } | undefined>> } | undefined;
  return data?.itemsByName?.[item]?.stackSize ?? null;
}
