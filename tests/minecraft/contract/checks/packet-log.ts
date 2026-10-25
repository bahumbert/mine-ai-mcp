/** A log of the packets the client heard from one moment on, with when: what the knockback and flight checks read. */
import type { ContractSubject } from "../subject.ts";
import { type Mark, markNow } from "./server-tick-marks.ts";

export interface LoggedPacket {
  /** Milliseconds since the log started, on the subject's clock. */
  readonly atMs: number;
  readonly name: string;
  readonly packet: Record<string, unknown>;
  /** The server's tick asked when the client heard the packet, for the names the log was asked to mark: never earlier than the packet's own tick, and later by the client's lag. */
  readonly heardAt?: Mark;
}

export interface PacketLog {
  readonly packets: LoggedPacket[];
  /** Milliseconds since the log started: the clock `atMs` of each packet is read on. */
  sinceStartMs(): number;
  /** The packets named `name` for `entityId` (a packet with no `entityId` field is left out). */
  of(name: string, entityId: number): LoggedPacket[];
  stop(): void;
}

type RawClient = { on(event: string, listener: (packet: never) => void): void; off(event: string, listener: (packet: never) => void): void };

/** Log every packet of the named kinds until `stop`; each packet of a kind in `markedNames` carries the server's tick as of its hearing (`heardAt`). */
export function logPackets(subject: ContractSubject, names: readonly string[], markedNames: readonly string[] = []): PacketLog {
  const client = subject.bot._client as unknown as RawClient;
  const startedAt = subject.now();
  const packets: LoggedPacket[] = [];
  const listeners = names.map((name) => {
    const marked = markedNames.includes(name);
    const listener = (packet: never) => void packets.push({ atMs: subject.now() - startedAt, name, packet: packet as Record<string, unknown>, ...(marked && { heardAt: markNow(subject) }) });
    client.on(name, listener);
    return { name, listener };
  });
  return {
    packets,
    sinceStartMs: () => subject.now() - startedAt,
    of: (name, entityId) => packets.filter((logged) => logged.name === name && logged.packet.entityId === entityId),
    stop: () => listeners.forEach(({ name, listener }) => client.off(name, listener)),
  };
}
