import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { handleStopSignals } from "./runtime-stop-signals.js";

const SIGNALS = ["SIGINT", "SIGTERM"] as const;

test("a standalone runtime stops on the first SIGINT or SIGTERM, as it always did", () => {
  for (const signal of SIGNALS) {
    const source = new EventEmitter();
    let stops = 0;
    handleStopSignals(source, { embedded: false, isConnected: () => true, requestStop: () => stops++ });
    source.emit(signal);
    source.emit(signal);
    assert.equal(stops, 1, `${signal}: the listener is a once, the host closes once`);
  }
});

test("an embedded runtime keeps a listener that does nothing while its parent is connected", () => {
  const source = new EventEmitter();
  let stops = 0;
  handleStopSignals(source, { embedded: true, isConnected: () => true, requestStop: () => stops++ });
  for (const signal of SIGNALS) {
    assert.ok(source.listenerCount(signal) > 0, `${signal} has a listener, so the default (exit) does not run`);
    source.emit(signal);
    source.emit(signal);
  }
  assert.equal(stops, 0, "the parent stops it: a group signal does not");
});

test("an embedded runtime whose parent is gone stops on a signal", () => {
  const source = new EventEmitter();
  let connected = true;
  let stops = 0;
  handleStopSignals(source, { embedded: true, isConnected: () => connected, requestStop: () => stops++ });
  source.emit("SIGTERM");
  assert.equal(stops, 0);
  connected = false;
  source.emit("SIGTERM");
  assert.equal(stops, 1);
});
