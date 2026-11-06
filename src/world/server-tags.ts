/** Per-bot server tag lookups. */
import type { Bot } from "mineflayer";

export type TagRegistry = "item" | "block" | "entity_type";
export interface ServerTags {
  readonly revision: number;
  tagsOf(registry: TagRegistry, name: string): readonly string[];
  readonly unknownEntries: number;
}

interface PacketTag { readonly tagName: string; readonly entries: readonly number[] }
interface PacketRegistry { readonly tagType: string; readonly tags: readonly PacketTag[] }
interface TagsPacket { readonly tags: readonly PacketRegistry[] }
interface TagState { packet: TagsPacket | null; index: ServerTags | null }
type Index = Record<TagRegistry, Map<string, string[]>>;

/** The packet's registry ids (protocol names) of the three registries the code reads. */
const REGISTRY_KINDS: ReadonlyMap<string, TagRegistry> = new Map([
  ["minecraft:item", "item"], ["minecraft:block", "block"], ["minecraft:entity_type", "entity_type"],
]);

const states = new WeakMap<Bot, TagState>();

/** Install the listener before the server sends configuration-state tags. */
export function watchServerTags(bot: Bot): void {
  if (states.has(bot)) return;
  const state: TagState = { packet: null, index: null };
  states.set(bot, state);
  bot._client.on("tags", (packet: TagsPacket) => {
    if (!Array.isArray(packet?.tags)) return;
    state.packet = packet;
    state.index = buildIndex(bot, packet, state.index);
  });
}

/** Return the most recent complete index, or null before the first packet. */
export function serverTagsOf(bot: Bot): ServerTags | null { return states.get(bot)?.index ?? null; }

/** Re-resolve the most recently received IDs against the current registry. */
export function rebuildServerTags(bot: Bot): void {
  const state = states.get(bot);
  if (!state?.packet) return;
  state.index = buildIndex(bot, state.packet, state.index);
}

/** The whole index of a packet, built aside and handed back to be assigned in one statement (a lookup never sees half of it). */
function buildIndex(bot: Bot, packet: TagsPacket, previous: ServerTags | null): ServerTags {
  const index: Index = { item: new Map(), block: new Map(), entity_type: new Map() };
  let unknownEntries = 0;
  for (const group of packet.tags) {
    const kind = registryKind(group?.tagType);
    if (kind === null || !Array.isArray(group.tags)) continue;
    const entries = kind === "item" ? bot.registry.items : kind === "block" ? bot.registry.blocks : bot.registry.entities;
    unknownEntries += indexRegistryTags(index[kind], group.tags, entries);
  }
  for (const registry of Object.values(index)) for (const tags of registry.values()) tags.sort();
  return { revision: (previous?.revision ?? 0) + 1, unknownEntries, tagsOf: (registry, name) => index[registry].get(name) ?? [] };
}

/** Add the registry's tag members, counting IDs absent from the bot's data. */
function indexRegistryTags(index: Map<string, string[]>, tags: readonly PacketTag[], entries: Record<number, { name: string }>): number {
  let unknown = 0;
  for (const tag of tags) {
    if (typeof tag?.tagName !== "string" || !Array.isArray(tag.entries)) continue;
    const name = tag.tagName.replace(/^minecraft:/, "");
    for (const id of tag.entries) {
      const member = entries[id]?.name;
      if (member === undefined) { unknown++; continue; }
      const names = index.get(member) ?? [];
      if (!names.includes(name)) names.push(name);
      index.set(member, names);
    }
  }
  return unknown;
}

/** Recognize only registries whose IDs this index resolves. */
function registryKind(tagType: string | undefined): TagRegistry | null {
  return (tagType === undefined ? undefined : REGISTRY_KINDS.get(tagType)) ?? null;
}
