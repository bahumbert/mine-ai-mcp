// Tests of what the agent remembers: places, farms, notes of earlier runs, and the activity time the goal tier sees.
import assert from "node:assert/strict";
import test from "node:test";
import { Body, INSTANT_TYPING } from "../body.ts";
import { memoryNote, recall } from "../memory.ts";
import { FakeRuntime, SMALL_MEDIEVAL_HOUSE, testPersona, until } from "../testing.ts";
import { AgentMemory } from "./agent-memory.ts";
import { say, agentFor, journaledAgent } from "./agent-fixtures.test.ts";

test("a second shelter replaces the first: one hole is kept, and no place line names it", async () => {
  const runtime = new FakeRuntime();
  const log = () => undefined;
  const memory = new AgentMemory({ runtime, log, persona: testPersona() }, new Body(runtime, log, INSTANT_TYPING));
  memory.rememberShelter({ x: 0, y: 64, z: 0, depth: 3, roofed: true });
  memory.rememberShelter({ x: 9, y: 70, z: -4, depth: 2, roofed: false });
  const { at, ...kept } = memory.shelter!;
  assert.deepEqual(kept, { x: 9, y: 70, z: -4, depth: 2, roofed: false });
  assert.ok(Number.isFinite(Date.parse(at)), "stamped with a wall-clock time");
  await until(() => runtime.notes.length === 2);
  assert.ok(runtime.notes.every((note) => note.context.startsWith("brain memory: shelter ")), "saved as shelter notes");
  assert.deepEqual(memory.knownPlaces(), []);
  // One shelter note per bot: the older note is deleted once the newer one is saved, never the newer one.
  const deletes = () => runtime.submitted.filter((call) => call.tool === "note_delete").map((call) => call.input.note_ids);
  await until(() => deletes().length > 0);
  assert.ok(deletes().every((ids) => JSON.stringify(ids) === "[1]"), `deleted ${JSON.stringify(deletes())}`);
});

const BUILDER = { loves: "building", likes: "farming", dislikes: "mob_combat", hates: "mining" } as const;

test("a house the agent built becomes a known place, with its roof, for what comes next", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, position: { x: 0.5, y: 64, z: 0.5 }, inventory: SMALL_MEDIEVAL_HOUSE, players: [{ username: "Steve", position: { x: 8, y: 64, z: 1 } }] };
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Sure.", route: "act", request: "build Steve a small house" }, { say: "Done!" });
  action.reply({ step: { skill: "build" } }, { done: "built the house" });
  await agent.handle(say("Steve", "build me a house"));
  await until(() => runtime.said.length === 2);
  assert.match(action.requests[0]?.[1]?.content ?? "", /- Places you know: none\./u);

  chat.reply({ say: "Up I go.", route: "act", request: "go to the roof of the house" }, { say: "Nice view." });
  action.reply({ step: { skill: "go_to", x: -4, y: 70, z: 0 } }, { done: "on the roof" });
  await agent.handle(say("Steve", "go to the roof"));
  await until(() => runtime.said.length === 4);
  const places = "- Places you know: the small medieval house you built for Steve (door -2 64 0 facing east; stand on its roof at -4 70 0).";
  assert.ok((chat.requests[2]?.[1]?.content ?? "").includes(places), "the chat tier knows it");
  assert.ok((action.requests[2]?.[1]?.content ?? "").includes(places), "the work tier knows it");
  assert.deepEqual(runtime.submitted.filter((call) => call.tool === "navigate").at(-1)?.input, { x: -4, y: 70, z: 0, range: 1 });
  assert.ok(runtime.notes.some((note) => note.context.startsWith("brain memory: place ")), "saved as a memory note");
});

test("her farms are places she knows, as they were at their last tend", async (t) => {
  const runtime = new FakeRuntime();
  runtime.notes = [memoryNote({ kind: "farm", farm: { crop: "wheat_seeds", size: 9, centre: { x: 4, y: 63, z: 6 }, madeAt: "2026-10-02T20:00:00.000Z", tendedAt: "2026-10-02T20:00:00.000Z", state: { planted: 80, ripe: 0, empty: 0 } } })];
  const { planner } = agentFor(t, runtime, { goal: "live well" });
  planner.reply({ objective: "rest a while" });
  await until(() => planner.requests.length === 1);
  assert.match(planner.requests[0]?.[1]?.content ?? "", /your wheat_seeds farm \(9x9 around 4 63 6; 80 planted, 0 ripe, 0 empty when you last tended it, [^)]* ago; farming it again harvests what is ripe and replants it\)/u);
});

test("known farm says its stage and dry farmland", async (t) => {
  const runtime = new FakeRuntime();
  runtime.notes = [memoryNote({ kind: "farm", farm: { crop: "wheat_seeds", size: 9, centre: { x: 4, y: 63, z: 6 }, madeAt: "2026-10-02T20:00:00.000Z", tendedAt: "2026-10-02T20:00:00.000Z", state: { planted: 80, ripe: 0, empty: 0, stage: 3, ripeAge: 7, dry: 2 } } })];
  const { planner } = agentFor(t, runtime, { goal: "live well" });
  planner.reply({ objective: "rest a while" });
  await until(() => planner.requests.length === 1);
  assert.match(planner.requests[0]?.[1]?.content ?? "", /your wheat_seeds farm \(9x9 around 4 63 6; 80 planted, 0 ripe, 0 empty, at stage 3\.0 of 7, 2 dry farmland \(grows slower; water within 4 blocks hydrates it\) when you last tended it, [^)]* ago; farming it again/u);
});

test("memories an earlier run saved as notes come back: places, its own last objectives, an unfinished house", async (t) => {
  const runtime = new FakeRuntime();
  const house = { kind: "small medieval house", site: { door: { x: 5, y: 64, z: 5 }, facing: "north" as const }, part: 2 };
  runtime.notes = [
    memoryNote({ kind: "place", place: { name: "the old hut", detail: "door 1 64 1 facing south" } }),
    memoryNote({ kind: "place", place: { name: "the small medieval house you built for Steve", detail: "door -2 64 0 facing east" } }),
    memoryNote({ kind: "own_objective", outcome: "collect 16 oak_log: done (collected 16 oak_log)" }),
    memoryNote({ kind: "unfinished_house", house }),
    memoryNote({ kind: "unfinished_house", house: null }),
    memoryNote({ kind: "unfinished_house", house }),
  ];
  const { planner } = agentFor(t, runtime, { goal: "build yourself a base" });
  planner.reply({ objective: "rest a while" });
  await until(() => planner.requests.length === 1);
  const prompt = planner.requests[0]?.[1]?.content ?? "";
  assert.match(prompt, /the old hut \(door 1 64 1 facing south\); the small medieval house you built for Steve/u);
  assert.match(prompt, /collect 16 oak_log: done/u);
  // The memories, then its activity notes, to forget those older than its last hour of play.
  assert.equal(runtime.queries.length, 2);
  assert.deepEqual(recall(runtime.notes.map((note) => note.context).reverse(), { places: 1, lately: 5, farms: 4, times: 10 }).unfinished, house);
  assert.deepEqual(recall(runtime.notes.map((note) => note.context).reverse(), { places: 1, lately: 5, farms: 4, times: 10 }).places.map((place) => place.name), ["the small medieval house you built for Steve"]);
});

test("the goal tier sees what could use doing and how the last hour went, time recalled from an earlier run", async (t) => {
  const runtime = new FakeRuntime();
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  runtime.notes = [
    memoryNote({ kind: "activity_time", time: { activity: "mining", ended: minutesAgo(90), minutes: 30 } }),
    memoryNote({ kind: "activity_time", time: { activity: "farming", ended: minutesAgo(20), minutes: 12 } }),
    memoryNote({ kind: "activity_time", time: { activity: "building", ended: minutesAgo(5), minutes: 4 } }),
  ];
  runtime.snapshot = { ...runtime.snapshot, food: 15, inventory: [{ name: "oak_log", count: 4 }, { name: "stone_pickaxe", count: 1, durability: { remaining: 5, maximum: 131 } }, { name: "wooden_sword", count: 1 }, { name: "wooden_axe", count: 1 }, { name: "red_bed", count: 1 }] };
  runtime.recipes = { spruce_stairs: { makes: 4, needs: [{ item: "spruce_planks", count: 6 }] } };
  const { planner } = agentFor(t, runtime, { goal: "live well", style: "medieval", preferences: { loves: "farming", likes: "building", dislikes: "mob_combat", hates: "mining" } });
  planner.reply({ objective: "rest a while" });
  await until(() => planner.requests.length === 1);
  const [system, request] = [planner.requests[0]?.[0]?.content ?? "", planner.requests[0]?.[1]?.content ?? ""];
  assert.match(system, /You love farming and like building; you dislike fighting monsters and hate mining\./u);
  // The last hour of play, not of the clock: mining that ended 90 min ago is still in it (spec 2026-10-04).
  assert.match(request, /How you spent the last hour: mining 30 min, farming 12 min, building 4 min\./u);
  // The ones for the activities drawn come first (a random draw here), so the order is not asserted.
  assert.match(request, /Things that could use doing, by what they are for: \n- \(/u);
  assert.match(request, /- \(crafting\) your stone_pickaxe has 5 uses left/u);
  assert.match(request, /- \(farming, hunting, cooking\) you carry no food; your hunger is 15\/20/u);
  assert.match(request, /- \(building\) you have no house of your own yet/u);
  // A house's materials are for building; each says the work get_items would do for it: logs are cut, stairs crafted.
  assert.match(request, /- \(building\) a house of your own needs [^\n]*20 more oak_log \(cutting wood\)/u);
  assert.match(request, /- \(building\) a house of your own needs [^\n]*spruce_stairs[^\n]*\(crafting\)/u);
  assert.match(request, /- \(farming\) you have no farm yet/u);
});

test("each finished step counts towards its activity, for the next goal call", async (t) => {
  const runtime = new FakeRuntime();
  const { planner, action } = agentFor(t, runtime, { goal: "live well" });
  planner.reply({ objective: "get some stone" }, { objective: "rest a while" });
  action.reply({ step: { skill: "collect_block", block: "stone", count: 2 } }, { done: "got stone" });
  await until(() => planner.requests.length === 2);
  assert.match(planner.requests[1]?.[1]?.content ?? "", /How you spent the last hour: mining under a minute\./u);
  assert.match(planner.requests[0]?.[1]?.content ?? "", /How you spent the last hour: nothing yet\./u);
});

test("an own objective carries the purpose the goal tier gave; every step under it counts for it, its gathering included", async (t) => {
  const runtime = new FakeRuntime();
  const { events, planner, action } = journaledAgent(t, runtime, { goal: "live well" });
  planner.reply({ objective: "get logs for my house", for: "building" }, { objective: "rest", for: "none" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 2 } }, { done: "got logs" });
  await until(() => events.some((event) => event.kind === "objective" && event.event === "finished"));
  const own = events.find((event) => event.kind === "objective" && event.event === "own");
  assert.equal(own?.kind === "objective" ? own.purpose : "missing", "building");
  const step = events.find((event) => event.kind === "step");
  assert.ok(step?.kind === "step" && step.purpose === "building" && step.activity === "woodcutting", "cut for building");
});

test("an objective that runs a house or farm step is for that work from then on, whatever the goal tier labelled it (run 11)", async (t) => {
  const runtime = new FakeRuntime();
  const { events, planner, action } = journaledAgent(t, runtime, { goal: "live well" });
  planner.reply({ objective: "get stone for my house", for: "mining" }, { objective: "rest", for: "none" });
  action.reply(
    { step: { skill: "collect_block", block: "stone", count: 1 } },
    { step: { skill: "improve_house" } },
    { step: { skill: "collect_block", block: "stone", count: 2 } },
    { done: "got stone" },
  );
  await until(() => events.some((event) => event.kind === "objective" && event.event === "finished"));
  assert.deepEqual(events.flatMap((event) => event.kind === "step" ? [event.purpose] : []), ["mining", "building", "building"]);
});

test("a goal reply with no usable \"for\" has no purpose", async (t) => {
  const runtime = new FakeRuntime();
  const { events, planner, action } = journaledAgent(t, runtime, { goal: "live well" });
  planner.reply({ objective: "get stone", for: "knitting" }, { objective: "rest" });
  action.reply({ step: { skill: "collect_block", block: "stone", count: 1 } }, { done: "got stone" });
  await until(() => events.some((event) => event.kind === "objective" && event.event === "finished"));
  const own = events.find((event) => event.kind === "objective" && event.event === "own");
  assert.equal(own?.kind === "objective" ? own.purpose : "missing", null);
  const step = events.find((event) => event.kind === "step");
  assert.ok(step?.kind === "step" && step.purpose === null);
});

test("a request's purpose is the work the chat tier named; \"none\" is no purpose", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, events, chat, action } = journaledAgent(t, runtime, { preferences: { loves: "farming", likes: "building", dislikes: "mob_combat", hates: "mining" } });
  chat.reply({ work: "mining", say: "Ugh.", route: "act", request: "mine 2 stone" }, { say: "Done." }, { work: "none", say: "Sure.", route: "act", request: "say hi to Tom" }, { say: "Done." });
  action.reply({ step: { skill: "collect_block", block: "stone", count: 2 } }, { done: "2 stone" }, { done: "said hi" });
  await agent.handle(say("Steve", "mine me 2 stone"));
  await until(() => events.filter((event) => event.kind === "objective" && event.event === "finished").length === 1);
  await agent.handle(say("Steve", "say hi to Tom"));
  await until(() => events.filter((event) => event.kind === "objective" && event.event === "finished").length === 2);
  assert.deepEqual(events.flatMap((event) => event.kind === "objective" && event.event === "taken" ? [[event.text, event.purpose]] : []), [["mine 2 stone", "mining"], ["say hi to Tom", null]]);
  const step = events.find((event) => event.kind === "step");
  assert.ok(step?.kind === "step" && step.purpose === "mining");
});

test("the goal call draws two activities by their chances and tells the goal tier; the journal keeps the draw", async (t) => {
  const runtime = new FakeRuntime();
  const { events, planner } = journaledAgent(t, runtime, { goal: "live well", preferences: BUILDER }, { random: () => 0 });
  planner.reply({ objective: "build a house", for: "building" }, { objective: "rest" });
  await until(() => events.some((event) => event.kind === "objective" && event.event === "own"));
  assert.match(planner.requests[0]?.[1]?.content ?? "", /Right now you feel most like building, or else farming\./u);
  assert.match(planner.requests[0]?.[0]?.content ?? "", /one of building, reshaping ground, farming, mining, cutting wood, digging out a cellar, a pond or a tunnel, foraging, exploring, crafting, cooking/u);
  const own = events.find((event) => event.kind === "objective" && event.event === "own");
  assert.ok(own?.kind === "objective");
  assert.deepEqual(own.drawn, ["building", "farming"]);
  assert.equal(own.purpose, "building");
  assert.equal(own.chances?.length, 5, "the top five");
  assert.deepEqual(own.chances?.slice(0, 2).map((entry) => entry.activity), ["building", "farming"]);
  assert.ok(own.chances?.every((entry, index, all) => index === 0 || all[index - 1]!.chance >= entry.chance));
});

test("an activity the last hour went to for is less likely, by purpose: cutting logs for a house counts against building", async (t) => {
  const runtime = new FakeRuntime();
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  runtime.notes = [memoryNote({ kind: "activity_time", time: { activity: "woodcutting", purpose: "building", ended: minutesAgo(5), minutes: 30 } })];
  const { events, planner } = journaledAgent(t, runtime, { goal: "live well", preferences: BUILDER }, { random: () => 0 });
  planner.reply({ objective: "tend my farm", for: "farming" }, { objective: "rest" });
  await until(() => events.some((event) => event.kind === "objective" && event.event === "own"));
  const own = events.find((event) => event.kind === "objective" && event.event === "own");
  assert.ok(own?.kind === "objective");
  // Building: 2 × (1 − 30/60) = 1 against farming 1.5, so farming is now the likeliest; woodcutting itself was no choice.
  assert.deepEqual(own.drawn?.[0], "farming");
  const chance = (activity: string) => own.chances?.find((entry) => entry.activity === activity)?.chance ?? NaN;
  assert.ok(Math.abs(chance("building") / chance("farming") - 1 / 1.5) < 1e-9);
  // Ten available activities: building 1, farming 1.5, mining (hated) 0.3, seven neutral at 1 (woodcutting among them: the
  // logs were cut for building, so they did not count against it).
  assert.ok(Math.abs(chance("farming") - 1.5 / 9.8) < 1e-9);
});

test("only what a skill of the persona can do is drawn, and an animal in sight makes hunting available", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, mobs: [{ name: "cow", hostile: false, count: 2, distance: 9 }] };
  const { events, planner } = journaledAgent(t, runtime, { goal: "live well", skills: ["build", "hunt"] }, { random: () => 0 });
  planner.reply({ objective: "build" }, { objective: "rest" });
  await until(() => events.some((event) => event.kind === "objective" && event.event === "own"));
  const own = events.find((event) => event.kind === "objective" && event.event === "own");
  assert.ok(own?.kind === "objective");
  assert.deepEqual(own.chances?.map((entry) => entry.activity).sort(), ["building", "hunting"]);
});

test("with no house the goal tier is told what a small one takes and which full blocks she carries", async (t) => {
  const runtime = new FakeRuntime();
  runtime.notBlocks = new Set(["bread"]);
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "dirt", count: 150 }, { name: "cobblestone", count: 64 }, { name: "oak_door", count: 1 }, { name: "bread", count: 3 }] };
  runtime.recipes = { spruce_stairs: { makes: 4, needs: [{ item: "spruce_planks", count: 6 }] } };
  const { planner } = agentFor(t, runtime, { goal: "live well", style: "medieval" });
  planner.reply({ objective: "rest a while" });
  await until(() => planner.requests.length === 1);
  const request = planner.requests[0]?.[1]?.content ?? "";
  assert.match(request, /- \(building\) you have no house of your own yet; a small house takes 16 foundation, 9 floor, 27 wall, [^\n]*; build can use other blocks per role: you carry 150 dirt, 64 cobblestone\n/u);
});

test("a temporary own house is a home: the goal tier sees what is temporary and what improving it needs", async (t) => {
  const runtime = new FakeRuntime();
  const place = {
    name: "the small medieval house you built", detail: "door 0 64 2 facing north", own: true,
    house: { size: "small" as const, style: "medieval", door: { x: 0, y: 64, z: 2 }, facing: "north" as const, materials: { wall: "dirt" } },
  };
  runtime.notes = [memoryNote({ kind: "place", place })];
  const { planner } = agentFor(t, runtime, { goal: "live well", style: "medieval" });
  planner.reply({ objective: "rest a while" });
  await until(() => planner.requests.length === 1);
  const request = planner.requests[0]?.[1]?.content ?? "";
  assert.match(request, /- \(building\) your house at door 0 64 2 is temporary: wall dirt \(your style: oak_planks\)/u);
  assert.match(request, /improving your house needs \d+ more oak_planks/u);
  assert.doesNotMatch(request, /no house of your own/u);
});
