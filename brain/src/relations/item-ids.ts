// Minecraft's item registry for the trade checks: whether an id exists and how many of it fit in one slot.
import minecraftData from "minecraft-data";

interface Registry {
  readonly itemsByName: Readonly<Record<string, { readonly stackSize?: number } | undefined>>;
}

const REGISTRY_VERSION = (minecraftData as unknown as { readonly supportedVersions: { readonly pc: readonly string[] } }).supportedVersions.pc.at(-1) ?? "";
export const DEFAULT_STACK = 64;

/** The slot size of an item id from the newest registry minecraft-data ships; null when no such item. */
export function stackSizeOf(item: string): number | null {
  const found = (minecraftData(REGISTRY_VERSION) as unknown as Registry | undefined)?.itemsByName[item];
  return found === undefined ? null : found.stackSize ?? DEFAULT_STACK;
}
