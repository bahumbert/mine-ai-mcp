import assert from "node:assert/strict";
import test from "node:test";
import { reportNavigationDig } from "../../navigation/index.js";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { digCounter, digCounterOf, slowWalkText, toolFamiliesOf, type DigFacts } from "./slow-walk.js";
import * as slowWalk from "./slow-walk.js";
import type { StallClock } from "../stall-watch.js";
import type { NavigationRuntime } from "../../navigation/index.js";

const NO_DIGS: DigFacts = { count: 0, ms: 0, byHand: 0, byHandMs: 0, byHandBlocks: [], fasterWith: [] };
const STONE_PICKAXE_TYPE = 700; // any item type: the counter only tests it against null

function steppedClock(): StallClock & { advance: (ms: number) => void } {
  let now = 0;
  let tick = () => {};
  return { now: () => now, every: (fn) => { tick = fn; return () => { tick = () => {}; }; },
    advance: (ms) => { for (let i = 0; i < ms; i += 1000) { now += 1000; tick(); } } };
}

test("under the progress floor stops a leg at the window", () => {
  const clock = steppedClock();
  const { bot } = createFakeBot();
  let distance = 46;
  const lifetime = new AbortController();
  const window = slowWalk.slowWalkWindowOf(lifetime.signal, { bot, distance: () => distance, clock });
  window.resetLeg(distance, 1);
  clock.advance(60_000);
  distance = 41;
  clock.advance(60_000);
  assert.equal(window.signal.aborted, true);
  assert.match(window.reason() ?? "", /^\[NAVIGATION_SLOW\] Got 5 blocks nearer in 120 s \(2\.5 blocks a minute\); 41 blocks left/u);
  assert.match(window.reason() ?? "", /needed 12 blocks.*[Tt]ry/u);
  window.close();
});

test("a short stalled leg reports its own smaller floor", () => {
  const f = windowFixture(1.5);
  f.clock.advance(120_000);
  assert.match(f.window.reason() ?? "", /needed 1 block\b/u);
  f.window.close();
});

function windowFixture(initial: number | null, range = 1) {
  const clock = steppedClock();
  const { bot } = createFakeBot();
  let distance = initial;
  let listener: Parameters<NavigationRuntime["onEvent"]>[0] = () => {};
  const events: Pick<NavigationRuntime, "onEvent"> = { onEvent: (fn) => { listener = fn; return () => { listener = () => {}; }; } };
  const lifetime = new AbortController();
  const window = slowWalk.slowWalkWindowOf(lifetime.signal, { bot, distance: () => distance, clock, events });
  window.resetLeg(distance, range);
  return { clock, window, setDistance: (value: number | null) => { distance = value; },
    emit: (kind: "escape_relaxed" | "own_regions_opened") => listener(kind === "escape_relaxed"
      ? { kind, runId: "test", atMs: 0, relaxed: [] }
      : { kind, runId: "test", atMs: 0, start: { x: 0, y: 0, z: 0 } }) };
}

test("steady progress and a detour that comes back do not trip the window", () => {
  const f = windowFixture(100);
  for (let i = 1; i <= 60; i++) { f.setDistance(100 - i); f.clock.advance(10_000); }
  assert.equal(f.window.reason(), null);
  f.window.resetLeg(100, 1);
  f.setDistance(110); f.clock.advance(60_000);
  f.setDistance(90); f.clock.advance(50_000);
  assert.equal(f.window.reason(), null);
  f.window.close();
});

test("short legs require only their available distance, with a one-block minimum", () => {
  for (const [initial, gain] of [[3, 2], [1.5, 1]] as const) {
    const f = windowFixture(initial);
    f.clock.advance(100_000); f.setDistance(initial - gain); f.clock.advance(20_000);
    assert.equal(f.window.reason(), null);
    f.window.close();
  }
});

test("unknown distance starts the window only when it becomes known", () => {
  const f = windowFixture(null);
  f.clock.advance(100_000); f.setDistance(40); f.clock.advance(120_000);
  assert.equal(f.window.reason(), null);
  f.clock.advance(1000); assert.ok(f.window.signal.aborted);
  f.window.close();
});

test("pause excludes elapsed time and ignores escape events", () => {
  const f = windowFixture(40);
  f.clock.advance(100_000); f.window.pause(); f.emit("escape_relaxed");
  f.clock.advance(150_000); f.window.resume(); f.clock.advance(100_000);
  assert.equal(f.window.reason(), null);
  f.clock.advance(20_000); assert.ok(f.window.signal.aborted);
  f.window.close();
});

test("an escape and a sufficiently fast onward route do not trip", () => {
  for (const kind of ["escape_relaxed", "own_regions_opened"] as const) {
    const f = windowFixture(1.5);
    f.window.resetLeg(100, 4); f.setDistance(100); f.clock.advance(60_000);
    f.emit(kind); f.setDistance(106); f.clock.advance(40_000);
    // G=12: in the 80 s left, 20 blocks repay the six-block escape debt and clear the floor.
    for (let i = 1; i <= 75; i++) { f.setDistance(106 - i); f.clock.advance(4_000); }
    assert.equal(f.window.reason(), null, kind);
    f.window.close();
  }
});

test("an escape and an onward route below the floor trip at the event window", () => {
  for (const kind of ["escape_relaxed", "own_regions_opened"] as const) {
    const f = windowFixture(100, 4);
    f.clock.advance(60_000); f.emit(kind); f.setDistance(106); f.clock.advance(40_000);
    for (let i = 1; i <= 7; i++) { f.setDistance(106 - i); f.clock.advance(10_000); }
    assert.equal(f.window.reason(), null, kind);
    f.setDistance(98); f.clock.advance(10_000);
    assert.match(f.window.reason() ?? "", /^\[NAVIGATION_SLOW\]/u, kind);
    f.window.close();
  }
});

/** 12 blocks by hand (stone 8, deepslate 4, 7 s each) and 2 with a tool (6 s each): 96 s in all. */
function reportTheSlowCorridor(bot: Parameters<typeof reportNavigationDig>[0]) {
  for (let dug = 0; dug < 8; dug++) reportNavigationDig(bot, { block: "stone", toolType: null, ms: 7000 });
  for (let dug = 0; dug < 4; dug++) reportNavigationDig(bot, { block: "deepslate", toolType: null, ms: 7000 });
  for (let dug = 0; dug < 2; dug++) reportNavigationDig(bot, { block: "stone", toolType: STONE_PICKAXE_TYPE, ms: 6000 });
}

// minecraft-data 1.21.4 (printed in WSL for plan 2026-11-07-p4-02c T4a Step 0): stone and deepslate are
// "mineable/pickaxe"; a composite is "plant;mineable/axe" (oak_sapling), 63 blocks have a ";" in their material.
test("toolFamiliesOf reads the families from the registry material", () => {
  assert.deepEqual(toolFamiliesOf("mineable/pickaxe"), ["pickaxe"]);
  assert.deepEqual(toolFamiliesOf("plant;mineable/axe"), ["axe"]);
  assert.deepEqual(toolFamiliesOf("plant"), []);
  assert.deepEqual(toolFamiliesOf(undefined), []);
});

test("digCounter counts the digs reported while it is open, by hand and with a tool", () => {
  const { bot } = createFakeBot();
  const counter = digCounter(bot);
  reportTheSlowCorridor(bot);
  const facts = counter.facts();
  assert.equal(facts.count, 14);
  assert.equal(facts.ms, 96_000);
  assert.equal(facts.byHand, 12);
  assert.equal(facts.byHandMs, 84_000);
  assert.deepEqual(facts.byHandBlocks, [{ block: "stone", count: 8 }, { block: "deepslate", count: 4 }]);
  assert.deepEqual(facts.fasterWith, [{ family: "pickaxe", count: 12 }]);
  counter.close();
});

test("a block the registry does not know is counted, and speeds no family", () => {
  const { bot } = createFakeBot();
  const counter = digCounter(bot);
  reportNavigationDig(bot, { block: "not_a_block", toolType: null, ms: 1000 });
  assert.equal(counter.facts().byHand, 1);
  assert.deepEqual(counter.facts().fasterWith, []);
  counter.close();
});

test("digCounterOf gives one counter per lifetime and stops with it", () => {
  const { bot } = createFakeBot();
  const lifetime = new AbortController();
  const counter = digCounterOf(bot, lifetime.signal);
  assert.equal(digCounterOf(bot, lifetime.signal), counter);
  reportNavigationDig(bot, { block: "stone", toolType: null, ms: 1000 });
  lifetime.abort("settled");
  reportNavigationDig(bot, { block: "stone", toolType: null, ms: 1000 });
  assert.equal(counter.facts().count, 1);
});

const sampleFacts = (digs: DigFacts, carried: (family: string) => boolean) => ({
  gained: 5,
  seconds: 120,
  required: 12,
  windowSeconds: 120,
  left: 41,
  feet: { x: -534, y: -21, z: 121 },
  digs,
  carried,
});

test("slowWalkText names the hand-dug blocks and whether the faster tool is carried", () => {
  const { bot } = createFakeBot();
  const counter = digCounter(bot);
  reportTheSlowCorridor(bot);
  for (const hasPickaxe of [false, true]) {
    const text = slowWalkText(sampleFacts(counter.facts(), (family) => hasPickaxe && family === "pickaxe"));
    assert.ok(text.includes("14 dig attempts in 96 s, 12 of them by hand (stone 8, deepslate 4: mined faster with a pickaxe"), text);
    assert.equal(text.includes("none carried"), !hasPickaxe);
    assert.ok(text.includes("Feet at -534,-21,121."), text);
  }
  counter.close();
});

test("slowWalkText distinguishes no recorded digs from tool-only attempts", () => {
  for (const [facts, expected] of [
    [NO_DIGS, "no navigation dig attempts recorded"],
    [{ ...NO_DIGS, count: 3, ms: 9000 }, "3 dig attempts in 9 s, none by hand"],
  ] as const) {
    const text = slowWalkText(sampleFacts(facts, () => true));
    assert.ok(text.includes(`On the way: ${expected}. Feet at`), text);
  }
});

test("slowWalkText says an axe, not a axe, and joins two families", () => {
  const facts: DigFacts = {
    count: 3, ms: 3000, byHand: 3, byHandMs: 3000,
    byHandBlocks: [{ block: "oak_sapling", count: 2 }, { block: "stone", count: 1 }],
    fasterWith: [{ family: "axe", count: 2 }, { family: "pickaxe", count: 1 }],
  };
  const text = slowWalkText(sampleFacts(facts, () => false));
  assert.ok(text.includes("mined faster with an axe or a pickaxe, none carried)"), text);
});

test("slowWalkText with an unknown distance left says so, and lists at most 5 hand-dug blocks", () => {
  const names = ["a", "b", "c", "d", "e", "f", "g"];
  const facts: DigFacts = {
    count: 7,
    ms: 7000,
    byHand: 7,
    byHandMs: 7000,
    byHandBlocks: names.map((block) => ({ block, count: 1 })),
    fasterWith: [],
  };
  const text = slowWalkText({ ...sampleFacts(facts, () => false), left: null });
  assert.ok(text.includes("; the distance left is unknown."), text);
  assert.ok(text.includes("(a 1, b 1, c 1, d 1, e 1 and 2 more kinds)"), text);
});
