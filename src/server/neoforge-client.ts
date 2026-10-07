/**
 * Lets a vanilla Mineflayer client join a NeoForge server whose mods are mostly server-side (trial, first used
 * live on 2026-10-05 against a NeoForge 1.21.1 server). It answers NeoForge's channel negotiation with the
 * channels the server expects (learnt from the server's own failure replies and kept per server in a JSON file,
 * outside the repository), acknowledges NeoForge's configuration checks, skips play packets the vanilla protocol
 * data cannot read, and maps block states the vanilla data does not know (modded blocks) to stone.
 */
import { readFileSync } from "node:fs";
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import { z } from "zod";

const componentSchema = z.strictObject({
  id: z.string(),
  version: z.string(),
  flow: z.number().int().nullable(),
  optional: z.boolean(),
});

/** Channels the server expects, per protocol ordinal ("4" configuration, "1" play). */
const componentsSchema = z.record(z.string().regex(/^\d+$/u), z.array(componentSchema));

export type NeoForgeComponents = z.infer<typeof componentsSchema>;

/** Reads a server's channel list (`--neoforge-components <file>`); a malformed file stops the host at start. */
export function readNeoForgeComponents(file: string): NeoForgeComponents {
  return componentsSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** The parts of minecraft-protocol's client this module touches (its typings omit `state` and the deserializer). */
interface ProtocolClient {
  readonly state: string;
  readonly deserializer: { parsePacketBuffer(buffer: Buffer): unknown };
  on(event: string, listener: (...args: never[]) => void): unknown;
  listenerCount(event: string): number;
  write(name: string, params: object): void;
}

interface BlockRegistry {
  blocksByStateId: Record<number, unknown>;
  readonly blocksByName: Record<string, unknown>;
}

/** Hooks a bot right after `createBot`, before it connects, so it passes as a NeoForge client. */
export function joinAsNeoForgeClient(bot: Bot, components: NeoForgeComponents): void {
  const client = bot._client as unknown as ProtocolClient;
  client.on("custom_payload", (packet: { channel: string; data?: Buffer }) => {
    const data = Buffer.from(packet.data ?? []);
    if (packet.channel === "neoforge:register") {
      client.write("custom_payload", { channel: "neoforge:register", data: encodeQuery(components) });
    }
    // NeoForge's own checks wait for an acknowledgement (a real client compares first; this one accepts).
    if (packet.channel === "neoforge:extensible_enum_data") {
      client.write("custom_payload", { channel: "neoforge:extensible_enum_ack", data: Buffer.alloc(0) });
    }
    if (packet.channel === "neoforge:feature_flags") {
      client.write("custom_payload", { channel: "neoforge:feature_flags_ack", data: Buffer.alloc(0) });
    }
    if (packet.channel === "neoforge:frozen_registry_sync_completed") {
      client.write("custom_payload", { channel: "neoforge:frozen_registry_sync_completed", data: Buffer.alloc(0) });
    }
    if (packet.channel === "neoforge:modded_network_setup_failed") {
      for (const failure of readFailures(data)) {
        console.error(`[neoforge] ${failure.id}: ${failure.key} ${JSON.stringify(failure.args)}`);
      }
    }
  });
  // The server pings during configuration and waits for the pong before its next task. Mineflayer answers pings
  // itself once its game plugin is in: a second pong upsets the server's task order.
  client.on("ping", (packet: { id: number }) => {
    if (client.state === "configuration" && client.listenerCount("ping") === 1) client.write("pong", { id: packet.id });
  });
  unknownStatesAsStone(bot.registry as unknown as BlockRegistry);
  const send = client.write.bind(client);
  const ids = { windowItems: packetId(bot.version, "window_items"), setSlot: packetId(bot.version, "set_slot") };
  const resent = new Map<number, number>();
  let dropped = false;
  tolerateUnparsed(client, ids, (windowId, stateId) => {
    if (windowId !== 0) mirrorInventoryInto(bot, windowId);
    // At login, once her slots are known: the modded items go (see `dropModdedItems`).
    if (windowId === 0 && !dropped) {
      dropped = true;
      setTimeout(() => void dropModdedItems(bot), MODDED_DROP_DELAY_MS);
    }
    // Once a second at most: a stale state id makes the server answer with the whole contents again.
    if (Date.now() - (resent.get(windowId) ?? 0) < 1000) return;
    resent.set(windowId, Date.now());
    setImmediate(() => askSlotBySlot(send, bot, windowId, stateId));
  });
  clickWithoutPrediction(client);
  if (process.env.MINE_AI_TRACE_WINDOWS === "1") traceWindows(client);
}

/** Diagnostics (env MINE_AI_TRACE_WINDOWS=1): every container click sent and slot update received, one line each. */
function traceWindows(client: ProtocolClient): void {
  const write = client.write.bind(client);
  client.write = (name, params) => {
    if (name === "window_click") {
      const click = params as { windowId: number; stateId: number; slot: number; mouseButton: number; mode: number; changedSlots: unknown[] };
      console.error(`[trace] click w${click.windowId} s${click.stateId} slot ${click.slot} b${click.mouseButton} m${click.mode} claimed ${click.changedSlots.length}`);
    }
    write(name, params);
  };
  const item = (raw: { itemCount?: number; itemId?: number } | undefined) => (raw?.itemCount ? `${raw.itemCount}x#${raw.itemId}` : "-");
  client.on("set_slot", (packet: { windowId: number; stateId: number; slot: number; item?: { itemCount?: number; itemId?: number } }) =>
    console.error(`[trace] set_slot w${packet.windowId} s${packet.stateId} slot ${packet.slot} ${item(packet.item)}`));
  client.on("window_items", (packet: { windowId: number; stateId: number; items: unknown[] }) =>
    console.error(`[trace] window_items w${packet.windowId} s${packet.stateId} ${packet.items.length} items`));
}

/** Time for the slot-by-slot answer to arrive after login before the modded items are dropped. */
const MODDED_DROP_DELAY_MS = 2_000;

/**
 * Drops the carried items the vanilla game data does not know (modded ones, named "unknown"), once, at login. Their
 * data is read wrongly (a modded data component), and with one in the inventory every whole-inventory packet is
 * unreadable (live 2026-10-07: 8 of item #10937; the server resends the whole inventory whenever a click's state id
 * is behind, so crafting results were lost and crafts failed "Server did not update crafting result"). She cannot
 * use them anyway; they land at her feet.
 */
async function dropModdedItems(bot: Bot): Promise<void> {
  const items = bot.registry.items as Record<number, unknown>;
  for (const item of bot.inventory.items().filter((stack) => items[stack.type] === undefined)) {
    if (bot.currentWindow !== null) return;
    await bot.tossStack(item).then(
      () => console.error(`[neoforge] dropped modded item #${item.type} x${item.count} (slot ${item.slot}): its data cannot be read`),
      (error: unknown) => console.error(`[neoforge] could not drop modded item #${item.type} (slot ${item.slot}): ${String(error)}`),
    );
  }
}

/**
 * Asks the server for a window's contents slot by slot, after its whole-contents packet could not be read (live
 * 2026-10-07: the player inventory's, at login, so every slot looked empty; she clicked slots that held something
 * else, and could neither put her boat in the water nor drop it): a click that does nothing (outside the window,
 * empty cursor) claiming every slot is empty, so the server sends each slot that is not, one update each, and an
 * unreadable one still tells its slot (see `tolerateUnparsed`).
 */
export function askSlotBySlot(send: ProtocolClient["write"], bot: Pick<Bot, "currentWindow">, windowId: number, stateId: number): void {
  const slots = windowId === 0 ? PLAYER_INVENTORY_SLOTS : bot.currentWindow?.id === windowId ? bot.currentWindow.slots.length : 0;
  if (slots === 0) return;
  const empty = { itemCount: 0, components: [], removeComponents: [] };
  const changedSlots = Array.from({ length: slots }, (_, location) => ({ location, item: empty }));
  send("window_click", { windowId, stateId, slot: -999, mouseButton: 0, mode: 0, changedSlots, cursorItem: empty });
}

/** The player inventory window's slots: crafting result and grid, armour, main, hotbar, off hand. */
const PLAYER_INVENTORY_SLOTS = 46;

/** The play-state id of a clientbound packet in `version`'s protocol data; null when it has none. */
export function packetId(version: string, name: string): number | null {
  type Mapper = { readonly type?: readonly [string, { readonly mappings?: Record<string, string> }] };
  type Protocol = { readonly play?: { readonly toClient?: { readonly types?: { readonly packet?: readonly [string, readonly Mapper[]] } } } };
  const protocol = (minecraftData(version) as unknown as { readonly protocol?: Protocol } | undefined)?.protocol;
  const mappings = protocol?.play?.toClient?.types?.packet?.[1]?.[0]?.type?.[1]?.mappings ?? {};
  const hex = Object.entries(mappings).find(([, value]) => value === name)?.[0];
  return hex === undefined ? null : Number.parseInt(hex, 16);
}

/**
 * After an unreadable window-contents packet was replaced by an empty one, the window's player-inventory part is
 * filled from the player inventory, which item-by-item updates keep (crafting at a table picks its ingredients there).
 */
function mirrorInventoryInto(bot: Bot, windowId: number): void {
  bot.once("windowOpen", (window) => {
    if (window.id !== windowId) return;
    for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot += 1) {
      const item = bot.inventory.slots[slot - window.inventoryStart + bot.inventory.inventoryStart];
      // A copy: a window renumbers the item it holds, and the inventory's own must keep its slot.
      if (item != null) window.updateSlot(slot, Object.assign(Object.create(Object.getPrototypeOf(item) as object) as typeof item, item));
    }
  });
}

/**
 * A container click carries the client's prediction of the slots it changed, as whole item stacks. An item with modded
 * data components is only half read by the vanilla protocol data, and written back it no longer decodes on the server
 * (live 2026-10-07, kicked twice: "Failed to decode packet 'serverbound/minecraft:container_click'", the second time
 * while dropping such an item). Sent without the prediction (no changed slots, an empty cursor), the click is still
 * done by the server, which then sends every slot it changed, and the cursor, as they really are.
 */
export function clickWithoutPrediction(client: Pick<ProtocolClient, "write">): void {
  const write = client.write.bind(client);
  client.write = (name, params) =>
    write(name, name === "window_click" ? { ...params, changedSlots: [], cursorItem: { itemCount: 0 } } : params);
}

/** Encodes NeoForge's channel query: protocols, then per protocol its channels (id, version, flow?, optional). */
export function encodeQuery(components: NeoForgeComponents): Buffer {
  const protocols = Object.entries(components).filter(([, list]) => list.length > 0);
  const parts = [varint(protocols.length)];
  for (const [protocol, list] of protocols) {
    parts.push(varint(Number(protocol)), varint(list.length));
    for (const component of list) {
      parts.push(
        string(component.id),
        string(component.version),
        component.flow === null ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), varint(component.flow)]),
        Buffer.from([component.optional ? 1 : 0]),
      );
    }
  }
  return Buffer.concat(parts);
}

const blockRegistriesAsStone = new WeakSet<BlockRegistry>();

/** Block states past the vanilla ones (modded blocks) read as stone, so routes treat them as solid ground. */
export function unknownStatesAsStone(registry: BlockRegistry): void {
  const stone = registry.blocksByName.stone;
  if (stone === undefined || blockRegistriesAsStone.has(registry)) return;
  registry.blocksByStateId = new Proxy(registry.blocksByStateId, {
    get: (target, key) =>
      typeof key !== "string" || key in target || !/^\d+$/u.test(key) ? Reflect.get(target, key) : stone,
  });
  blockRegistriesAsStone.add(registry);
}

/**
 * A play packet the vanilla protocol data cannot read (modded recipes, modded item or entity data) is skipped,
 * logged once per packet id (then every 100th), instead of closing the connection (live 2026-10-05: 0x77
 * declare_recipes with farmersdelight:cutting recipes). A window's contents (`windowItemsId`) holding a modded item
 * become an empty contents packet for that window instead (live 2026-10-07: skipped, a crafting table never "opened"
 * and every boat craft timed out): the window opens, and `unreadableWindow` fills what it can. A slot update
 * (`setSlot`) holding such an item becomes an update with that item's id and count, components left out: the slot
 * shows taken, by an item named "unknown" when its id is a modded one.
 */
export function tolerateUnparsed(
  client: Pick<ProtocolClient, "on" | "deserializer">,
  ids: { readonly windowItems: number | null; readonly setSlot: number | null },
  unreadableWindow: (windowId: number, stateId: number) => void,
): void {
  const seen = new Map<number, number>();
  client.on("state", (state: string) => {
    if (state !== "play") return;
    const parser = client.deserializer;
    const original = parser.parsePacketBuffer.bind(parser);
    parser.parsePacketBuffer = (buffer: Buffer) => {
      try {
        return original(buffer);
      } catch (error) {
        const id = buffer[0] ?? -1;
        const count = (seen.get(id) ?? 0) + 1;
        seen.set(id, count);
        if (count === 1 || count % 100 === 0) {
          console.error(`[neoforge] skipped play packet 0x${id.toString(16)} (${count}x): ${String(error).slice(0, 160)}`);
        }
        if (id === ids.windowItems && buffer.length > 2) {
          // Window ids stay below 128, one byte whether the id is a byte or a varint; the state id follows.
          const windowId = buffer[1]!;
          const [stateId] = readVarint(buffer, 2);
          unreadableWindow(windowId, stateId);
          const params = { windowId, stateId, items: [] };
          return { data: { name: "window_items", params }, metadata: { size: buffer.length }, buffer, fullBuffer: buffer };
        }
        const slotAt = id === ids.setSlot && buffer.length > 2 ? readVarint(buffer, 2)[1] : buffer.length;
        if (slotAt + 3 <= buffer.length) {
          // The window id (the cursor's, -1, a byte up to 1.21.1), the state id, the slot (a short), then the item:
          // its count and id come before its components.
          const windowId = buffer[1] === 0xff ? -1 : buffer[1]!;
          const [stateId] = readVarint(buffer, 2);
          const slot = buffer.readInt16BE(slotAt);
          const [itemCount, idAt] = readVarint(buffer, slotAt + 2);
          const [itemId] = idAt < buffer.length ? readVarint(buffer, idAt) : [-1];
          const item = { itemCount, itemId, addedComponentCount: 0, removedComponentCount: 0, components: [], removeComponents: [] };
          const params = { windowId, stateId, slot, item };
          return { data: { name: "set_slot", params }, metadata: { size: buffer.length }, buffer, fullBuffer: buffer };
        }
        return { data: { name: "neoforge_unparsed", params: { id } }, metadata: { size: buffer.length }, buffer, fullBuffer: buffer };
      }
    };
  });
}

/** `neoforge:modded_network_setup_failed`: channel id -> reason (a translatable text component). */
interface NeoForgeFailure {
  readonly id: string;
  readonly key: string;
  readonly args: unknown[];
}

function readFailures(buffer: Buffer): NeoForgeFailure[] {
  let [count, offset] = readVarint(buffer, 0);
  const failures: NeoForgeFailure[] = [];
  for (let index = 0; index < count; index++) {
    let length;
    [length, offset] = readVarint(buffer, offset);
    const id = buffer.toString("utf8", offset, offset + length);
    offset += length;
    let component;
    [component, offset] = readNbt(buffer, offset);
    // reason = translatable("...failure.mod", modName, inner) where inner = translatable(key, args...)
    const outer = component as { with?: unknown[] };
    const inner = (outer.with?.find((part) => typeof part === "object" && part !== null && "translate" in part) ??
      outer) as { translate: string; with?: unknown[] };
    failures.push({ id, key: inner.translate, args: inner.with ?? [] });
  }
  return failures;
}

/** Network NBT (anonymous root) reader, enough for text components. */
function readNbt(buffer: Buffer, start: number): [unknown, number] {
  let offset = start;
  const u8 = () => buffer[offset++]!;
  const i16 = () => {
    const value = buffer.readInt16BE(offset);
    offset += 2;
    return value;
  };
  const i32 = () => {
    const value = buffer.readInt32BE(offset);
    offset += 4;
    return value;
  };
  const text = () => {
    const length = buffer.readUInt16BE(offset);
    offset += 2;
    const value = buffer.toString("utf8", offset, offset + length);
    offset += length;
    return value;
  };
  const payload = (type: number): unknown => {
    switch (type) {
      case 1:
        return buffer.readInt8(offset++);
      case 2:
        return i16();
      case 3:
        return i32();
      case 4: {
        const value = buffer.readBigInt64BE(offset);
        offset += 8;
        return value;
      }
      case 5: {
        const value = buffer.readFloatBE(offset);
        offset += 4;
        return value;
      }
      case 6: {
        const value = buffer.readDoubleBE(offset);
        offset += 8;
        return value;
      }
      case 7: {
        const length = i32();
        const value = buffer.subarray(offset, offset + length);
        offset += length;
        return value;
      }
      case 8:
        return text();
      case 9: {
        const itemType = u8();
        const length = i32();
        return Array.from({ length }, () => payload(itemType));
      }
      case 10: {
        const compound: Record<string, unknown> = {};
        for (;;) {
          const fieldType = u8();
          if (fieldType === 0) return compound;
          const name = text();
          compound[name] = payload(fieldType);
        }
      }
      case 11: {
        const length = i32();
        return Array.from({ length }, () => i32());
      }
      case 12: {
        offset += i32() * 8;
        return [];
      }
      default:
        throw new Error(`[NEOFORGE_NBT] unknown NBT tag type ${type} at byte ${offset - 1}.`);
    }
  };
  return [payload(u8()), offset];
}

function varint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest !== 0);
  return Buffer.from(bytes);
}

function string(value: string): Buffer {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([varint(bytes.length), bytes]);
}

function readVarint(buffer: Buffer, start: number): [number, number] {
  let value = 0;
  let shift = 0;
  let offset = start;
  for (;;) {
    const byte = buffer[offset++]!;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [value, offset];
    shift += 7;
  }
}
