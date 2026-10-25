import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createFakeBot } from "./fake-bot.js";
import { listenerCounts, listenersAddedSince } from "./listener-counts.js";

test("listenerCounts lists each event with its listener count and leaves out an event nobody listens to any more", () => {
  const emitter = new EventEmitter();
  const onTick = () => {};
  emitter.on("tick", onTick);
  emitter.on("tick", () => {});
  emitter.on("end", () => {});
  assert.deepEqual(listenerCounts(emitter), { tick: 2, end: 1 });
  emitter.removeListener("tick", onTick);
  assert.deepEqual(listenerCounts(emitter), { tick: 1, end: 1 });
  emitter.removeAllListeners("end");
  assert.deepEqual(listenerCounts(emitter), { tick: 1 });
});

test("listenerCounts reads a symbol-named event under its text", () => {
  const emitter = new EventEmitter();
  emitter.on(Symbol("hidden"), () => {});
  assert.deepEqual(listenerCounts(emitter), { "Symbol(hidden)": 1 });
});

test("listenersAddedSince counts only the listeners attached after its baseline, per event", () => {
  const emitter = new EventEmitter();
  emitter.on("tick", () => {});
  const added = listenersAddedSince(emitter);
  assert.equal(added("tick"), 0, "the listener of the baseline is the idle one");
  assert.equal(added("end"), 0, "an event nobody listens to has none added");
  const onTick = () => {};
  emitter.on("tick", onTick);
  emitter.on("end", () => {});
  assert.equal(added("tick"), 1);
  assert.equal(added("end"), 1);
  emitter.removeListener("tick", onTick);
  assert.equal(added("tick"), 0, "a removed listener is no longer added");
});

test("listenersAddedSince takes the shared fake bot's own listeners as idle", () => {
  const { bot } = createFakeBot();
  assert.ok(bot.listenerCount("death") > 0, "the harness bot listens to death itself (digging and physics)");
  const added = listenersAddedSince(bot);
  assert.equal(added("death"), 0);
  const onDeath = () => {};
  bot.on("death", onDeath);
  assert.equal(added("death"), 1);
  bot.off("death", onDeath);
  assert.equal(added("death"), 0);
});
