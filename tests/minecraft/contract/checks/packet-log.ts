/** A log of the packets the client heard from one moment on, with when: what the knockback and flight checks read. */
import type { ContractSubject } from "../subject.ts";

export interface LoggedPacket {
  /** Milliseconds since the log started, on the subject's clock. */
  readonly atMs: number;
  readonly name: string;
  readonly packet: Record<string, unknown>;
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

/** Log every packet of the named kinds until `stop`. */
export function logPackets(subject: ContractSubject, names: readonly string[]): PacketLog {
  const client = subject.bot._client as unknown as RawClient;
  const startedAt = subject.now();
  const packets: LoggedPacket[] = [];
  const listeners = names.map((name) => {
    const listener = (packet: never) => void packets.push({ atMs: subject.now() - startedAt, name, packet: packet as Record<string, unknown> });
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
