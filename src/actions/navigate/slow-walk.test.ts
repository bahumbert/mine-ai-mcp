import assert from "node:assert/strict";
import test from "node:test";
import { reportNavigationDig } from "../../navigation/index.js";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { digCounter, digCounterOf, slowWalkText, toolFamiliesOf, type DigFacts } from "./slow-walk.js";

const NO_DIGS: DigFacts = { count: 0, ms: 0, byHand: 0, byHandMs: 0, byHandBlocks: [], fasterWith: [] };
const STONE_PICKAXE_TYPE = 700; // any item type: the counter only tests it against null

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
  left: 41,
  feet: { x: -534, y: -21, z: 121 },
  digs,
  carried,
});

test("slowWalkText names the blocks dug by hand and the tool that would be faster", () => {
  const { bot } = createFakeBot();
  const counter = digCounter(bot);
  reportTheSlowCorridor(bot);
  assert.equal(
    slowWalkText(sampleFacts(counter.facts(), () => false)),
    "[NAVIGATION_SLOW] Got 5 blocks nearer in 120 s (2.5 blocks a minute); 41 blocks left. On the way: 14 blocks broken " +
      "in 96 s, 12 of them by hand (stone 8, deepslate 4: mined faster with a pickaxe, none carried). Feet at -534,-21,121.",
  );
  counter.close();
});

test("slowWalkText does not say none carried when the tool is carried", () => {
  const { bot } = createFakeBot();
  const counter = digCounter(bot);
  reportTheSlowCorridor(bot);
  const text = slowWalkText(sampleFacts(counter.facts(), (family) => family === "pickaxe"));
  assert.ok(text.includes("(stone 8, deepslate 4: mined faster with a pickaxe)"), text);
  assert.ok(!text.includes("none carried"), text);
  counter.close();
});

test("slowWalkText with no digs says the way itself is slow", () => {
  assert.equal(
    slowWalkText(sampleFacts(NO_DIGS, () => false)),
    "[NAVIGATION_SLOW] Got 5 blocks nearer in 120 s (2.5 blocks a minute); 41 blocks left. On the way: no blocks broken: " +
      "the way itself is slow (water, climbing, detours). Feet at -534,-21,121.",
  );
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

test("slowWalkText with every dig made with a tool says none by hand", () => {
  const facts: DigFacts = { ...NO_DIGS, count: 3, ms: 9000 };
  const text = slowWalkText(sampleFacts(facts, () => true));
  assert.ok(text.includes("On the way: 3 blocks broken in 9 s, none by hand. Feet at"), text);
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
