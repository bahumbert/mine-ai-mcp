import test from "node:test";
import assert from "node:assert/strict";
import { decodeClientMessage, decodeDaemonMessage, encodeMessage, LineReader, type ClientMessage, type DaemonMessage } from "./protocol.ts";

test("a submit message survives a round trip through one line", () => {
  const message: ClientMessage = { type: "submit", paths: ["/a/b.yaml"], out: "/tmp/out", repeat: 2, lanes: null, lock: false, env: {} };
  const line = encodeMessage(message);
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.trimEnd().includes("\n"), false);
  assert.deepEqual(decodeClientMessage(line.trimEnd()), message);
});

test("a result message keeps its error and run directory", () => {
  const message: DaemonMessage = { type: "result", name: "x", outcome: "fail", elapsedMs: 1200, detail: "goal failed", error: "boom", runDir: "/tmp/r" };
  assert.deepEqual(decodeDaemonMessage(encodeMessage(message).trimEnd()), message);
});

test("a message of an unknown type is refused with the type named", () => {
  assert.throws(() => decodeClientMessage('{"type":"reboot"}'), /reboot|type/u);
});

test("a submit with a relative path is refused: the daemon does not know the submitter's cwd", () => {
  assert.throws(() => decodeClientMessage('{"type":"submit","paths":["a.yaml"],"out":"/o","repeat":1,"lanes":null,"lock":false,"env":{}}'), /absolute/u);
});

test("a submit with repeat 0 or lanes 0 is refused", () => {
  assert.throws(() => decodeClientMessage('{"type":"submit","paths":["/a.yaml"],"out":"/o","repeat":0,"lanes":null,"lock":false,"env":{}}'));
  assert.throws(() => decodeClientMessage('{"type":"submit","paths":["/a.yaml"],"out":"/o","repeat":1,"lanes":0,"lock":false,"env":{}}'));
});

test("garbage that is not JSON is refused", () => {
  assert.throws(() => decodeClientMessage("not json"));
});

test("the line reader joins chunks split anywhere and yields whole lines", () => {
  const reader = new LineReader();
  assert.deepEqual(reader.push('{"type":"sta'), []);
  assert.deepEqual(reader.push('tus"}\n{"type":"stop"}\n{"ty'), ['{"type":"status"}', '{"type":"stop"}']);
  assert.deepEqual(reader.push('pe":"stop"}\n'), ['{"type":"stop"}']);
});
