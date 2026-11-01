/** Remote server check before any bot starts: a status ping (up, version) and a login probe (online-mode), on `node:net`. */
import minecraftData from "minecraft-data";
import { connect, type Socket } from "node:net";
import { z } from "zod";
import { monotonicNow } from "../clocks.ts";

export interface ProbeResult {
  readonly up: boolean;
  /** Undefined when the server did not answer. */
  readonly versionOk?: boolean;
  /** `false` only when the login probe saw an offline server; undefined when it was not run (down, wrong version) or was refused: callers start no bot then. */
  readonly onlineMode?: boolean;
  /** One line for the player, true on every path. */
  readonly detail: string;
}

/** A name for the login probe; the Login Start packet carries it and a server in offline mode may log it. */
const PROBE_PLAYER_NAME = "MineAIProbe";
/** The largest packet a status or login answer can be: a status JSON is under 32 KiB. */
const MAX_PACKET_BYTES = 1 << 20;
const STATUS_NEXT_STATE = 1;
const LOGIN_NEXT_STATE = 2;
const LOGIN_DISCONNECT = 0x00;
const LOGIN_ENCRYPTION_REQUEST = 0x01;
const LOGIN_SUCCESS = 0x02;
const LOGIN_SET_COMPRESSION = 0x03;

const statusSchema = z.object({ version: z.object({ name: z.string(), protocol: z.number() }) });

function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    const low = value & 0x7f;
    value >>>= 7;
    bytes.push(value === 0 ? low : low | 0x80);
  } while (value !== 0);
  return Buffer.from(bytes);
}

/** A serverbound packet: length, id, payload. */
function packet(id: number, ...payload: Buffer[]): Buffer {
  const body = Buffer.concat([varint(id), ...payload]);
  return Buffer.concat([varint(body.length), body]);
}

function mcString(text: string): Buffer {
  return Buffer.concat([varint(Buffer.byteLength(text)), Buffer.from(text)]);
}

function handshake(protocol: number, host: string, port: number, nextState: number): Buffer {
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  return packet(0x00, varint(protocol), mcString(host), portBytes, varint(nextState));
}

/** `{ value, end }` of the varint at `at`, or null while its bytes have not all arrived. */
function readVarint(buffer: Buffer, at: number): { value: number; end: number } | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    const byte = buffer[at + i];
    if (byte === undefined) return null;
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return { value, end: at + i + 1 };
  }
  throw new NotMinecraft("a number in the answer is longer than a Minecraft number can be");
}

/** The peer answered, but not in the Minecraft protocol. */
class NotMinecraft extends Error {}
/** The deadline of the whole probe passed. */
class Deadline extends Error {}

/** One TCP connection read packet by packet; every wait ends at `deadlineAt`, and `close` always releases socket and timer. */
class PacketConnection {
  private buffer: Buffer = Buffer.alloc(0);
  private failure: Error | null = null;
  private waiting: (() => void) | null = null;
  /** Rejects `open` while the socket is still connecting. */
  private failureWaiter: ((error: Error) => void) | null = null;
  private readonly timer: ReturnType<typeof setTimeout>;

  private constructor(private readonly socket: Socket, deadlineAt: number) {
    this.timer = setTimeout(() => this.fail(new Deadline()), Math.max(deadlineAt - monotonicNow(), 0));
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.wake();
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new Error("the server closed the connection without answering")));
  }

  static async open(host: string, port: number, deadlineAt: number): Promise<PacketConnection> {
    const socket = connect({ host, port });
    const connection = new PacketConnection(socket, deadlineAt);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        connection.failureWaiter = reject;
      });
    } catch (error) {
      connection.close();
      throw error;
    }
    connection.failureWaiter = null;
    return connection;
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.failureWaiter?.(this.failure);
    this.wake();
  }

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.();
  }

  write(bytes: Buffer): void {
    this.socket.write(bytes);
  }

  /** The next packet's id and payload (the length prefix removed). */
  async readPacket(): Promise<{ id: number; payload: Buffer }> {
    for (;;) {
      const length = readVarint(this.buffer, 0);
      if (length !== null) {
        if (length.value < 1 || length.value > MAX_PACKET_BYTES) throw new NotMinecraft(`a packet length of ${length.value} is not a Minecraft packet`);
        if (this.buffer.length >= length.end + length.value) {
          const body = this.buffer.subarray(length.end, length.end + length.value);
          this.buffer = this.buffer.subarray(length.end + length.value);
          const id = readVarint(body, 0);
          if (id === null) throw new NotMinecraft("a packet without an id");
          return { id: id.value, payload: body.subarray(id.end) };
        }
      }
      if (this.failure !== null) throw this.failure;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }

  close(): void {
    clearTimeout(this.timer);
    this.socket.destroy();
  }
}

/** The text of a login Disconnect packet (a JSON text component), as plain a line as the component allows. */
function disconnectReason(payload: Buffer): string {
  try {
    const length = readVarint(payload, 0)!;
    const json = payload.subarray(length.end, length.end + length.value).toString();
    const component: unknown = JSON.parse(json);
    if (typeof component === "string") return component;
    if (typeof component === "object" && component !== null && "text" in component && typeof component.text === "string") return component.text;
    return json.slice(0, 200);
  } catch {
    return "no reason given";
  }
}

/** The protocol number minecraft-data knows for `version`, or null for a version it does not know. */
function expectedProtocol(version: string): number | null {
  return minecraftData(version)?.version.version ?? null;
}

/** Status ping with the handshake of a client of `protocol`: proxies and ViaVersion servers answer by the client's protocol. */
async function pingStatus(host: string, port: number, protocol: number, deadlineAt: number): Promise<z.infer<typeof statusSchema>> {
  const connection = await PacketConnection.open(host, port, deadlineAt);
  try {
    connection.write(Buffer.concat([handshake(protocol, host, port, STATUS_NEXT_STATE), packet(0x00)]));
    const answer = await connection.readPacket();
    if (answer.id !== 0x00) throw new NotMinecraft(`the answer to a status request had packet id ${answer.id}`);
    const length = readVarint(answer.payload, 0);
    if (length === null) throw new NotMinecraft("the status answer is empty");
    return statusSchema.parse(JSON.parse(answer.payload.subarray(length.end, length.end + length.value).toString()));
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof z.ZodError) throw new NotMinecraft("the status answer is not a Minecraft status");
    throw error;
  } finally {
    connection.close();
  }
}

/** First answer to a Login Start (1.21.4 form: name, then a zero UUID) as an `onlineMode` verdict, or a refusal reason. */
async function probeLogin(host: string, port: number, protocol: number, deadlineAt: number): Promise<{ onlineMode: boolean } | { refusal: string }> {
  const connection = await PacketConnection.open(host, port, deadlineAt);
  try {
    connection.write(Buffer.concat([handshake(protocol, host, port, LOGIN_NEXT_STATE), packet(0x00, mcString(PROBE_PLAYER_NAME), Buffer.alloc(16))]));
    const answer = await connection.readPacket();
    if (answer.id === LOGIN_ENCRYPTION_REQUEST) return { onlineMode: true };
    if (answer.id === LOGIN_SET_COMPRESSION || answer.id === LOGIN_SUCCESS) return { onlineMode: false };
    if (answer.id === LOGIN_DISCONNECT) return { refusal: `the server refused the probe login: ${disconnectReason(answer.payload)}` };
    throw new NotMinecraft(`the answer to a login had packet id ${answer.id}`);
  } finally {
    connection.close();
  }
}

/** A one-line cause for a failed connection, naming the address. */
function describeFailure(error: unknown, address: string, timeoutMs: number): string {
  if (error instanceof Deadline) return `${address} did not answer within ${timeoutMs} ms. Is it a Minecraft server, and is the port right?`;
  if (error instanceof NotMinecraft) return `${address} answered, but not as a Minecraft server does (${error.message}). Check the address and the port.`;
  const code = (error as { code?: string }).code;
  if (code === "ECONNREFUSED") return `Nothing is listening at ${address} (connection refused). Is the server running, and are the address and port right?`;
  if (code === "ENOTFOUND") return `The address ${address} cannot be found. Check the host name.`;
  return `Cannot reach ${address}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * Pings `host:port`, then (right version only) logs in as a probe player to see whether the server wants an account:
 * an Encryption Request is online-mode, which the status answer does not say. The whole probe ends within `timeoutMs`.
 */
export async function probeServer(host: string, port: number, version: string, timeoutMs: number): Promise<ProbeResult> {
  const address = `${host}:${port}`;
  const deadlineAt = monotonicNow() + timeoutMs;
  try {
    const wanted = expectedProtocol(version);
    const status = (await pingStatus(host, port, wanted ?? 0, deadlineAt)).version;
    const versionOk = wanted === null ? status.name === version : status.protocol === wanted;
    if (!versionOk) {
      return { up: true, versionOk: false, detail: `The server at ${address} runs ${status.name} (protocol ${status.protocol}); the bots need Minecraft ${version}${wanted === null ? "" : ` (protocol ${wanted})`}. Use a vanilla ${version} server, or the server's owner must allow ${version} clients.` };
    }
    const login = await probeLogin(host, port, status.protocol, deadlineAt);
    if ("refusal" in login) return { up: true, versionOk: true, detail: `The server at ${address} is up (${status.name}), but ${login.refusal}. Check that the server accepts new players (whitelist, bans): the bots join the same way.` };
    if (login.onlineMode) {
      return { up: true, versionOk: true, onlineMode: true, detail: `The server at ${address} has online-mode on: the bots have no Minecraft account and would be refused. Set online-mode=false in its server.properties and restart it.` };
    }
    return { up: true, versionOk: true, onlineMode: false, detail: `Minecraft ${status.name} server at ${address}, online-mode off.` };
  } catch (error) {
    return { up: false, detail: describeFailure(error, address, timeoutMs) };
  }
}
