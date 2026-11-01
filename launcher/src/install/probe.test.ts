import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import test from "node:test";
import { probeServer } from "./probe.ts";

/** Packets recorded from real 1.21.4 servers by the W1 spike (`knowledge/facts/packaging.md` "Minecraft login answers"). */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
const offlineStatus = fixture("status.bin");
const onlineStatus = fixture("status-online.bin");
const offlineLogin = fixture("login-offline.bin");
const onlineLogin = fixture("login-online.bin");

function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    const low = value & 0x7f;
    value >>>= 7;
    bytes.push(value === 0 ? low : low | 0x80);
  } while (value !== 0);
  return Buffer.from(bytes);
}

/** A whole clientbound packet: length, id, payload. */
const packet = (id: number, payload: Buffer = Buffer.alloc(0)) => Buffer.concat([varint(1 + payload.length), varint(id), payload]);
const mcString = (text: string) => Buffer.concat([varint(Buffer.byteLength(text)), Buffer.from(text)]);
const statusJson = (name: string, protocol: number) => packet(0, mcString(JSON.stringify({ version: { name, protocol }, players: { max: 10, online: 0 } })));

interface Received {
  readonly nextState: number;
  readonly protocol: number;
  readonly address: string;
  readonly port: number;
  /** Id and payload length of the packet that followed the handshake. */
  readonly next?: { id: number; payloadLength: number; name?: string };
}

interface Answers {
  readonly status?: Buffer;
  readonly login?: Buffer;
  /** Accept connections and never answer. */
  readonly silent?: boolean;
  /** Write answers one byte at a time. */
  readonly dribble?: boolean;
}

interface FakeServer {
  readonly port: number;
  readonly received: Received[];
  close(): Promise<void>;
}

function readVarint(buffer: Buffer, at: number): { value: number; end: number } | null {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (at + i >= buffer.length) return null;
    const byte = buffer[at + i]!;
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return { value, end: at + i + 1 };
  }
  throw new Error("varint too long");
}

/** A Minecraft server that records the handshake and the packet after it, and replays recorded answers. */
async function fakeServer(answers: Answers): Promise<FakeServer> {
  const received: Received[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    if (answers.silent) return;
    let buffer = Buffer.alloc(0);
    let handshake: Omit<Received, "next"> | null = null;
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const length = readVarint(buffer, 0);
        if (length === null || buffer.length < length.end + length.value) return;
        const body = buffer.subarray(length.end, length.end + length.value);
        buffer = buffer.subarray(length.end + length.value);
        const id = readVarint(body, 0)!;
        if (handshake === null) {
          const protocol = readVarint(body, id.end)!;
          const addressLength = readVarint(body, protocol.end)!;
          const address = body.subarray(addressLength.end, addressLength.end + addressLength.value).toString();
          const at = addressLength.end + addressLength.value;
          handshake = { protocol: protocol.value, address, port: body.readUInt16BE(at), nextState: readVarint(body, at + 2)!.value };
          continue;
        }
        const payload = body.subarray(id.end);
        const name = handshake.nextState === 2 ? payload.subarray(1, 1 + payload[0]!).toString() : undefined;
        received.push({ ...handshake, next: { id: id.value, payloadLength: payload.length, name } });
        const answer = handshake.nextState === 1 ? answers.status : answers.login;
        if (answer === undefined) return;
        if (answers.dribble) for (const byte of answer) socket.write(Buffer.from([byte]));
        else socket.write(answer);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    received,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function withServer<T>(answers: Answers, body: (server: FakeServer) => Promise<T>): Promise<T> {
  const server = await fakeServer(answers);
  try {
    return await body(server);
  } finally {
    await server.close();
  }
}

test("an offline 1.21.4 server: up, right version, online-mode off; the probe sends a status request, then a login start with a probe name", async () => {
  await withServer({ status: offlineStatus, login: offlineLogin }, async (server) => {
    const result = await probeServer("127.0.0.1", server.port, "1.21.4", 3_000);
    assert.deepEqual({ up: result.up, versionOk: result.versionOk, onlineMode: result.onlineMode }, { up: true, versionOk: true, onlineMode: false });
    assert.match(result.detail, /1\.21\.4/u);
    const [status, login] = server.received;
    // A real 1.21.4 client names its own protocol in the status handshake: proxies and ViaVersion servers answer by it.
    assert.deepEqual({ nextState: status!.nextState, protocol: status!.protocol, address: status!.address, port: status!.port, id: status!.next!.id, payloadLength: status!.next!.payloadLength }, { nextState: 1, protocol: 769, address: "127.0.0.1", port: server.port, id: 0, payloadLength: 0 });
    assert.equal(login!.nextState, 2);
    assert.equal(login!.protocol, 769);
    assert.equal(login!.next!.id, 0);
    assert.match(login!.next!.name!, /^[A-Za-z0-9_]{3,16}$/u);
    // 1.21.4 Login Start: the name (length byte + bytes) then a 16-byte UUID.
    assert.equal(login!.next!.payloadLength, 1 + login!.next!.name!.length + 16);
  });
});

test("an online-mode server answers the login probe with an Encryption Request: onlineMode true", async () => {
  await withServer({ status: onlineStatus, login: onlineLogin }, async (server) => {
    const result = await probeServer("127.0.0.1", server.port, "1.21.4", 3_000);
    assert.deepEqual({ up: result.up, versionOk: result.versionOk, onlineMode: result.onlineMode }, { up: true, versionOk: true, onlineMode: true });
    assert.match(result.detail, /online-mode=false/u);
  });
});

test("packets that arrive one byte at a time are still read", async () => {
  await withServer({ status: offlineStatus, login: offlineLogin, dribble: true }, async (server) => {
    const result = await probeServer("127.0.0.1", server.port, "1.21.4", 5_000);
    assert.deepEqual({ up: result.up, versionOk: result.versionOk, onlineMode: result.onlineMode }, { up: true, versionOk: true, onlineMode: false });
  });
});

test("another version is reported with both versions, and no login probe is sent", async () => {
  await withServer({ status: statusJson("1.20.4", 765), login: offlineLogin }, async (server) => {
    const result = await probeServer("127.0.0.1", server.port, "1.21.4", 3_000);
    assert.equal(result.up, true);
    assert.equal(result.versionOk, false);
    assert.equal(result.onlineMode, undefined);
    assert.match(result.detail, /1\.20\.4/u);
    assert.match(result.detail, /1\.21\.4/u);
    assert.match(result.detail, /Use a .*1\.21\.4 server/u);
    assert.equal(server.received.length, 1);
  });
});

test("a server of another name on the right protocol is accepted (Paper reports 'Paper 1.21.4')", async () => {
  await withServer({ status: statusJson("Paper 1.21.4", 769), login: offlineLogin }, async (server) => {
    const result = await probeServer("127.0.0.1", server.port, "1.21.4", 3_000);
    assert.equal(result.versionOk, true);
    assert.equal(result.onlineMode, false);
  });
});

test("a refused login probe is reported with the server's reason, not as online-mode", async () => {
  const whitelist = packet(0, mcString(JSON.stringify({ text: "You are not white-listed on this server!" })));
  await withServer({ status: offlineStatus, login: whitelist }, async (server) => {
    const result = await probeServer("127.0.0.1", server.port, "1.21.4", 3_000);
    assert.equal(result.up, true);
    assert.equal(result.versionOk, true);
    assert.equal(result.onlineMode, undefined);
    assert.match(result.detail, /not white-listed/u);
    assert.match(result.detail, /accepts new players/u);
  });
});

test("a closed port is down with one line naming the address", async () => {
  const free = await fakeServer({});
  const port = free.port;
  await free.close();
  const result = await probeServer("127.0.0.1", port, "1.21.4", 3_000);
  assert.equal(result.up, false);
  assert.match(result.detail, new RegExp(`127\\.0\\.0\\.1:${port}`, "u"));
});

test("a server that accepts and never answers times out within the limit", async () => {
  await withServer({ silent: true }, async (server) => {
    const started = Date.now();
    const result = await probeServer("127.0.0.1", server.port, "1.21.4", 400);
    assert.equal(result.up, false);
    assert.match(result.detail, /400 ms/u);
    assert.ok(Date.now() - started < 2_000, "the probe respects its timeout");
  });
});

test("something that is not a Minecraft server is down with a line saying so", async () => {
  await withServer({ status: Buffer.from("HTTP/1.1 400 Bad Request\r\n\r\n") }, async (server) => {
    const result = await probeServer("127.0.0.1", server.port, "1.21.4", 1_000);
    assert.equal(result.up, false);
    assert.match(result.detail, /Minecraft/u);
  });
});
