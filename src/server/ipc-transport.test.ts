import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  LINK_PART_BYTES,
  createLinkReceiver,
  createLinkSender,
  serveLinkSessions,
  type IpcChannel,
  type LinkStats,
} from "./ipc-transport.js";
import { linkMessageSchema } from "./runtime-liveness.js";

/**
 * One end of an in-memory channel pair. Like `child_process` IPC with the default `json` serialization (measured:
 * `.agent/reports/2026-11-18-in-process-baseline.md`, "IPC probe"): a message arrives as a JSON copy, in send order,
 * on a later turn of the event loop, and the send's callback comes after the write.
 */
class MemoryChannel extends EventEmitter implements IpcChannel {
  peer!: MemoryChannel;
  connected = true;
  readonly sent: unknown[] = [];
  constructor(private readonly callbackDelayMs: number) {
    super();
  }
  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message);
    const copy: unknown = JSON.parse(JSON.stringify(message));
    setImmediate(() => this.peer.emit("message", copy));
    if (callback) setTimeout(() => callback(null), this.callbackDelayMs);
    return true;
  }
}

function channelPair(callbackDelayMs = 0): [MemoryChannel, MemoryChannel] {
  const a = new MemoryChannel(callbackDelayMs);
  const b = new MemoryChannel(callbackDelayMs);
  a.peer = b;
  b.peer = a;
  return [a, b];
}

/** A server with one tool, `echo`, which returns its text. */
function echoServer() {
  const server = new McpServer({ name: "echo-test", version: "1.0.0" });
  server.registerTool("echo", { inputSchema: { text: z.string() } }, ({ text }) => ({
    content: [{ type: "text" as const, text }],
  }));
  return server.server;
}

/** The test's client side of a link session: the transport T3's brain client will be (open, messages, close). */
class LinkClientTransport implements Transport {
  onclose?: () => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly sender;
  private readonly receiver;
  private closed = false;
  private readonly listener = (raw: unknown) => {
    const parsed = linkMessageSchema.safeParse(raw);
    if (!parsed.success || !("session" in parsed.data) || parsed.data.session !== this.session) return;
    if (parsed.data.kind === "mcp-close") this.finish();
    else if (parsed.data.kind === "mcp" || parsed.data.kind === "mcp-part") this.receiver.receive(parsed.data);
  };
  constructor(
    private readonly channel: IpcChannel,
    private readonly session: string,
  ) {
    this.sender = createLinkSender(channel);
    this.receiver = createLinkReceiver((_session, message) => this.onmessage?.(message), () => {});
  }
  async start(): Promise<void> {
    this.channel.on("message", this.listener);
    this.sender.open(this.session);
  }
  async send(message: JSONRPCMessage): Promise<void> {
    this.sender.send(this.session, message);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.sender.close(this.session);
    this.finish();
  }
  // A close the server sent (`mcp-close`) and our own both end here, once.
  private finish(): void {
    if (this.closed) return;
    this.closed = true;
    this.channel.off("message", this.listener);
    this.onclose?.();
  }
}

async function connectedClient(channel: IpcChannel, session: string): Promise<Client> {
  const client = new Client({ name: "link-test", version: "1.0.0" });
  await client.connect(new LinkClientTransport(channel, session));
  return client;
}

const request = (id: number): JSONRPCMessage => ({ jsonrpc: "2.0", id, method: "ping" });

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text: string }[];
  return content[0]!.text;
}

test("a client calls a tool over a link session, and two sessions are independent", async () => {
  const [parent, child] = channelPair();
  const stats: LinkStats = { open: 0, pushed: 0 };
  using _served = serveLinkSessions(child, echoServer, () => {}, stats);
  const first = await connectedClient(parent, "first");
  const second = await connectedClient(parent, "second");
  assert.equal(textOf(await first.callTool({ name: "echo", arguments: { text: "1" } })), "1");
  assert.equal(stats.open, 2);
  await first.close();
  assert.equal(textOf(await second.callTool({ name: "echo", arguments: { text: "2" } })), "2");
  assert.equal(stats.open, 1, "a closed session frees the server's session; the other stays");
  await second.close();
});

test("a message for an unknown session is dropped and logged once", async () => {
  const [parent, child] = channelPair();
  const lines: string[] = [];
  using _served = serveLinkSessions(child, echoServer, (line) => lines.push(line), { open: 0, pushed: 0 });
  parent.send({ kind: "mcp", session: "nope", message: request(1) });
  parent.send({ kind: "mcp", session: "nope", message: request(2) });
  // The channel keeps send order: once this other session answers, both messages above were handled.
  const client = await connectedClient(parent, "real");
  await client.callTool({ name: "echo", arguments: { text: "x" } });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /nope/);
  await client.close();
});

test("dispose closes every session", async () => {
  const [parent, child] = channelPair();
  const stats: LinkStats = { open: 0, pushed: 0 };
  const served = serveLinkSessions(child, echoServer, () => {}, stats);
  const client = await connectedClient(parent, "s1");
  await client.callTool({ name: "echo", arguments: { text: "a" } });
  const closed = new Promise<void>((resolve) => (client.onclose = resolve));
  served[Symbol.dispose]();
  await closed;
  await assert.rejects(client.callTool({ name: "echo", arguments: { text: "b" } }), /Not connected|Connection closed/);
  assert.equal(stats.open, 0);
});

test("a message over 256 KB arrives whole", async () => {
  const [parent, child] = channelPair();
  using _served = serveLinkSessions(child, echoServer, () => {}, { open: 0, pushed: 0 });
  const client = await connectedClient(parent, "big");
  const text = "x".repeat(1_000_000);
  const result = await client.callTool({ name: "echo", arguments: { text } });
  assert.equal(textOf(result), text);
  const parts = child.sent.filter((frame) => (frame as { kind: string }).kind === "mcp-part");
  assert.equal(parts.length, 4, "a 1 MB reply goes in 4 parts of at most 256 KB");
  assert.ok(parts.every((frame) => JSON.stringify(frame).length < LINK_PART_BYTES + 1_000));
  await client.close();
});

test("a message of exactly LINK_PART_BYTES goes whole and one character more goes in two parts", () => {
  const [a] = channelPair();
  const sender = createLinkSender(a);
  const withText = (length: number): JSONRPCMessage => ({ jsonrpc: "2.0", id: 1, result: { text: "x".repeat(length) } });
  const overhead = JSON.stringify(withText(0)).length;
  sender.send("s", withText(LINK_PART_BYTES - overhead));
  const framesAtBound = a.sent.map((frame) => (frame as { kind: string }).kind);
  assert.deepEqual(framesAtBound, ["mcp"]);
  sender.send("s", withText(LINK_PART_BYTES - overhead + 1)); // queued behind the first until its callback: still counted
  return sleep(10).then(() => {
    assert.deepEqual(a.sent.map((frame) => (frame as { kind: string }).kind), ["mcp", "mcp-part", "mcp-part"]);
  });
});

test("no part ends inside a surrogate pair, and the emoji text arrives whole", async () => {
  const [child, parent] = channelPair();
  const received: JSONRPCMessage[] = [];
  const parts: string[] = [];
  const receiver = createLinkReceiver((_session, message) => received.push(message), () => {});
  parent.on("message", (raw) => {
    const frame = linkMessageSchema.parse(raw);
    if (frame.kind === "mcp-part") parts.push(frame.data);
    if (frame.kind === "mcp" || frame.kind === "mcp-part") receiver.receive(frame);
  });
  // The JSON before the text is 42 characters: with lead 0 the first pair sits at the cut's last character and the next
  // one (lead 1: the same pair one character later) at the first after it, so both alignments are tried.
  for (const lead of [0, 1]) {
    const text = "x".repeat(LINK_PART_BYTES - 43 + lead) + "😀".repeat(100);
    const message: JSONRPCMessage = { jsonrpc: "2.0", id: lead, result: { text } };
    createLinkSender(child).send("s", message);
    await sleep(30);
    assert.deepEqual(received.at(-1), message);
  }
  assert.ok(parts.length >= 4);
  // A lone surrogate does not survive UTF-8: it comes back as U+FFFD.
  const survivesUtf8 = (data: string) => new TextDecoder().decode(new TextEncoder().encode(data)) === data;
  assert.ok(parts.every(survivesUtf8), "no part holds half of a pair");
});

test("a heartbeat is not held behind a large reply", async () => {
  const [child, parent] = channelPair(5); // every send's callback comes 5 ms after the write
  const arrivals: { kind: string; index?: number; count?: number }[] = [];
  parent.on("message", (raw) => arrivals.push(raw as (typeof arrivals)[number]));
  const sender = createLinkSender(child);
  const reply: JSONRPCMessage = { jsonrpc: "2.0", id: 1, result: { text: "x".repeat(4_000_000) } };
  sender.send("s", reply);
  child.send({ kind: "heartbeat" }); // what reportRuntimeLiveness does: no queue, straight to the channel
  await sleep(150);
  const heartbeatAt = arrivals.findIndex((frame) => frame.kind === "heartbeat");
  const lastPartAt = arrivals.findIndex((frame) => frame.kind === "mcp-part" && frame.index === frame.count! - 1);
  assert.ok(heartbeatAt >= 0 && lastPartAt >= 0, "both the heartbeat and the last part arrived");
  assert.ok(heartbeatAt < lastPartAt, `heartbeat at ${heartbeatAt} before the last part at ${lastPartAt}`);
  assert.equal(heartbeatAt, 1, "the heartbeat waits for the one part in flight, not for the reply");
});

test("a failed write is reported once and the queued pieces are dropped", async () => {
  const errors: Error[] = [];
  const written: unknown[] = [];
  const failing: IpcChannel = {
    send: (message, callback) => {
      written.push(message);
      setImmediate(() => callback?.(new Error("Subprocess.send() cannot be used after the process has exited.")));
      return false;
    },
    on: () => {},
    off: () => {},
  };
  const sender = createLinkSender(failing, { onSendError: (error) => errors.push(error) });
  sender.send("s", { jsonrpc: "2.0", id: 1, result: { text: "x".repeat(LINK_PART_BYTES * 3) } });
  await sleep(20);
  assert.equal(written.length, 1, "the pieces behind the failed one are not written");
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /cannot be used after the process has exited/);
});

test("a sender refuses and writes nothing once its channel is not connected or it is disposed", async () => {
  const [gone] = channelPair();
  gone.connected = false;
  assert.equal(createLinkSender(gone).send("s", request(1)), false);
  assert.equal(gone.sent.length, 0);
  const [child] = channelPair(5);
  const sender = createLinkSender(child);
  sender.send("s", { jsonrpc: "2.0", id: 1, result: { text: "x".repeat(LINK_PART_BYTES * 3) } });
  sender.dispose();
  await sleep(30);
  assert.equal(child.sent.length, 1, "the pieces behind the one in flight are not written");
  assert.equal(sender.send("s", request(2)), false);
});

test("parts of a closed session are dropped and logged once", () => {
  const delivered: JSONRPCMessage[] = [];
  const lines: string[] = [];
  const receiver = createLinkReceiver((_session, message) => delivered.push(message), (line) => lines.push(line));
  receiver.receive({ kind: "mcp-part", session: "s", id: "m1", index: 0, count: 2, data: '{"jsonrpc":"2.0",' });
  receiver.discardSession("s");
  receiver.receive({ kind: "mcp-part", session: "s", id: "m1", index: 1, count: 2, data: '"id":1,"method":"ping"}' });
  receiver.receive({ kind: "mcp-part", session: "s", id: "m2", index: 0, count: 1, data: '{"jsonrpc":"2.0","id":2,"method":"ping"}' });
  assert.deepEqual(delivered, []);
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /closed/);
});

test("parts of two messages arrive interleaved and each is joined whole", () => {
  const delivered: unknown[] = [];
  const receiver = createLinkReceiver((session, message) => delivered.push([session, message]), () => {});
  const one = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "one" });
  const two = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "two" });
  const cut = (id: string, json: string) => [
    { kind: "mcp-part" as const, session: "s", id, index: 0, count: 2, data: json.slice(0, 10) },
    { kind: "mcp-part" as const, session: "s", id, index: 1, count: 2, data: json.slice(10) },
  ];
  const [one0, one1] = cut("a", one);
  const [two0, two1] = cut("b", two);
  receiver.receive(one0!);
  receiver.receive(two0!);
  receiver.receive(two1!);
  receiver.receive(one1!);
  assert.deepEqual(delivered, [
    ["s", JSON.parse(two)],
    ["s", JSON.parse(one)],
  ]);
});

test("a part whose count or index does not fit is dropped and logged once", () => {
  const delivered: JSONRPCMessage[] = [];
  const lines: string[] = [];
  const receiver = createLinkReceiver((_session, message) => delivered.push(message), (line) => lines.push(line));
  const part = (index: number, count: number) => ({ kind: "mcp-part" as const, session: "s", id: "m", index, count, data: "{}" });
  receiver.receive(part(2, 2)); // index past the count
  receiver.receive(part(-1, 2));
  receiver.receive(part(0, 2));
  receiver.receive(part(1, 3)); // count differs from the first part's
  assert.deepEqual(delivered, []);
  assert.equal(lines.length, 1, "one line for the session, not one per bad part");
});

test("a joined message that is not JSON-RPC is dropped and logged", () => {
  const delivered: JSONRPCMessage[] = [];
  const lines: string[] = [];
  const receiver = createLinkReceiver((_session, message) => delivered.push(message), (line) => lines.push(line));
  receiver.receive({ kind: "mcp-part", session: "s", id: "m", index: 0, count: 1, data: "not json" });
  assert.deepEqual(delivered, []);
  assert.equal(lines.length, 1);
});
