import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { IpcChannel } from "./ipc-transport.js";
import { LinkHub } from "./runtime-supervisor-links.js";

/** A connected channel that records what is written to it. */
class RecordingChannel extends EventEmitter implements IpcChannel {
  connected = true;
  readonly written: { kind: string }[] = [];
  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    this.written.push(message as { kind: string });
    setImmediate(() => callback?.(null));
    return true;
  }
}

const call = (id: number): JSONRPCMessage => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "echo" } });
const failureFor = (id: string | number): JSONRPCMessage => ({ jsonrpc: "2.0", id, error: { code: -32603, message: "[RUNTIME_EXITED] gone" } });

function hubOver(channel: RecordingChannel, accepts: () => boolean) {
  const hub = new LinkHub({ accepts, log: () => {} });
  hub.attach(channel);
  return hub;
}

test("a request the runtime cannot take now is kept for the failure and not written", async () => {
  const channel = new RecordingChannel();
  let accepting = true;
  const hub = hubOver(channel, () => accepting);
  const link = hub.open()!;
  const replies: JSONRPCMessage[] = [];
  link.onmessage = (message) => replies.push(message);
  accepting = false; // The runtime is failing: its channel still looks connected.
  await link.send(call(7));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(channel.written.map((frame) => frame.kind), ["mcp-open"], "only the open frame was written");
  assert.deepEqual(hub.pendingRequests(), [{ id: 7, method: "tools/call", tool: "echo", path: "link", httpMethod: null }]);
  hub.failAll(failureFor);
  assert.deepEqual(replies, [failureFor(7)]);
  assert.deepEqual(hub.pendingRequests(), []);
});

test("failAll answers every waiting request of every link, then closes them, and a send on a closed link is refused", async () => {
  const channel = new RecordingChannel();
  const hub = hubOver(channel, () => true);
  const [first, second] = [hub.open()!, hub.open()!];
  const replies: [string, JSONRPCMessage][] = [];
  let closes = 0;
  for (const [name, link] of [["first", first], ["second", second]] as const) {
    link.onmessage = (message) => replies.push([name, message]);
    link.onclose = () => closes++;
  }
  await first.send(call(1));
  await first.send(call(2));
  await second.send(call(3));
  hub.failAll(failureFor);
  assert.deepEqual(replies, [["first", failureFor(1)], ["first", failureFor(2)], ["second", failureFor(3)]]);
  assert.equal(closes, 2);
  await assert.rejects(first.send(call(4)), /LINK_CLOSED/u);
});

test("failAll reaches every link and the child's sender even when a client's callback throws", async () => {
  const channel = new RecordingChannel();
  const lines: string[] = [];
  const hub = new LinkHub({ accepts: () => true, log: (line) => lines.push(line) });
  hub.attach(channel);
  const [first, second] = [hub.open()!, hub.open()!];
  const replies: JSONRPCMessage[] = [];
  first.onmessage = () => {
    throw new Error("client callback broke");
  };
  second.onmessage = (message) => replies.push(message);
  await first.send(call(1));
  await second.send(call(2));
  hub.failAll(failureFor);
  assert.deepEqual(replies, [failureFor(2)], "the second link is still answered");
  assert.equal(second.closed, true);
  assert.equal(first.closed, true);
  assert.equal(lines.some((line) => line.includes("client callback broke")), true, "the throw is logged");
});

test("a reply ends the wait for its request, and a frame for another session reaches only its link", async () => {
  const channel = new RecordingChannel();
  const hub = hubOver(channel, () => true);
  const [first, second] = [hub.open()!, hub.open()!];
  const heard: [string, JSONRPCMessage][] = [];
  first.onmessage = (message) => heard.push(["first", message]);
  second.onmessage = (message) => heard.push(["second", message]);
  await first.send(call(1));
  const reply: JSONRPCMessage = { jsonrpc: "2.0", id: 1, result: {} };
  assert.equal(hub.route({ kind: "mcp", session: first.session, message: reply }), true);
  assert.deepEqual(heard, [["first", reply]]);
  assert.deepEqual(hub.pendingRequests(), []);
  assert.equal(hub.route({ kind: "heartbeat" }), false, "a runtime report is not a link frame");
});

test("a session the runtime closes ends that link only", async () => {
  const channel = new RecordingChannel();
  const hub = hubOver(channel, () => true);
  const [first, second] = [hub.open()!, hub.open()!];
  let firstClosed = false;
  let secondClosed = false;
  first.onclose = () => (firstClosed = true);
  second.onclose = () => (secondClosed = true);
  hub.route({ kind: "mcp-close", session: first.session });
  assert.deepEqual([firstClosed, secondClosed], [true, false]);
  assert.equal(channel.written.filter((frame) => frame.kind === "mcp-close").length, 0, "the runtime that closed it is not told back");
});

test("a link refused by a closed channel is not opened", () => {
  const channel = new RecordingChannel();
  channel.connected = false;
  const hub = hubOver(channel, () => true);
  assert.equal(hub.open(), null);
});
