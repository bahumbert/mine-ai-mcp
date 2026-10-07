/**
 * Lets a vanilla Mineflayer client join a NeoForge server whose mods are mostly server-side (trial, first used
 * live on 2026-10-05 against a NeoForge 1.21.1 server). It answers NeoForge's channel negotiation with the
 * channels the server expects (learnt from the server's own failure replies and kept per server in a JSON file,
 * outside the repository), acknowledges NeoForge's configuration checks, skips play packets the vanilla protocol
 * data cannot read, and maps block states the vanilla data does not know (modded blocks) to stone.
 */
import { readFileSync } from "node:fs";
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
  tolerateUnparsed(client);
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
 * declare_recipes with farmersdelight:cutting recipes).
 */
function tolerateUnparsed(client: ProtocolClient): void {
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
