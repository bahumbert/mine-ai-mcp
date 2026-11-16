// Test inputs of the brain's prompts at measured sizes: the median fixtures (golden texts) and the worst case per tier.
import { SKILL_NAMES } from "./actions.ts";
import { situationView } from "./agent/situation-options.ts";
import type { SituationInfo } from "./agent/situations.ts";
import type { ChatLine, ChatInput, EarlierFailure, GoalInput, KnownPlace, NarrateInput, Objective, StepRecord, WorkInput } from "./mind.ts";
import { findOpportunities, type Opportunity } from "./opportunities.ts";
import { AgentMemory } from "./agent/agent-memory.ts";
import { Body, INSTANT_TYPING } from "./body.ts";
import type { BotSnapshot, ProtectedArea } from "./runtime-client.ts";
import { FakeRuntime, testPersona } from "./testing.ts";

/**
 * Inputs of the brain's prompts at the sizes the runs measured (spec 2026-11-06-p4-02a-prompt-budget, "Measured" and D5),
 * for the tests of the prompt budget: the golden texts of today's prompts, and the worst case of every tier. Test-only.
 */

/** A filler of exactly `length` characters made of words, so a cut text still reads as text. */
export function filler(length: number, seed = "detail"): string {
  let text = "";
  while (text.length < length) text += `${seed} ${text.length} `;
  return text.slice(0, length).trimEnd().padEnd(length, ".");
}

/** A snapshot with the given inventory stacks and players around the origin. */
export function snapshotWith(inventory: BotSnapshot["inventory"], players: BotSnapshot["players"] = []): BotSnapshot {
  return { ...new FakeRuntime().snapshot, inventory, players };
}

/** `count` players: the n-th at n * 10 blocks east of the origin, except every 7th, which is out of sight. */
export function players(count: number): BotSnapshot["players"] {
  return Array.from({ length: count }, (_, index) => ({
    username: `Player${index + 1}`,
    position: (index + 1) % 7 === 0 ? null : { x: (index + 1) * 10, y: 64, z: 5 },
  }));
}

/** `count` distinct items. */
export function distinctItems(count: number): BotSnapshot["inventory"] {
  return Array.from({ length: count }, (_, index) => ({ name: `item_number_${index + 1}`, count: index + 1 }));
}

/** A protected area, `size` blocks wide, whose corner is `east` blocks east of the origin. */
export function area(regionId: number, east: number, size = 8): ProtectedArea {
  return { regionId, label: `area ${regionId}`, owner: "Steve", min: { x: east, y: 60, z: 0 }, max: { x: east + size, y: 80, z: size } };
}

export function stepRecords(count: number, detailLength: number): StepRecord[] {
  return Array.from({ length: count }, (_, index) => ({
    step: `get ${index + 1} oak_log`,
    outcome: index % 3 === 2 ? "failed" as const : "done" as const,
    detail: filler(detailLength, `step${index + 1}`),
  }));
}

/** `count` earlier failures of the objective `objective`, the first `refused` of them failed twice (refused now). */
export function failures(count: number, refused: number, detailLength: number, objective: string): EarlierFailure[] {
  return Array.from({ length: count }, (_, index) => ({
    step: `craft ${index + 1} cooked_beef`,
    key: `craft:${index + 1}`,
    detail: filler(detailLength, `failure${index + 1}`),
    objective,
    minutesAgo: index + 1,
    count: index < refused ? 2 : 1,
    changed: false,
  }));
}

export function historyLines(count: number, textLength: number): ChatLine[] {
  return Array.from({ length: count }, (_, index) => ({
    speaker: index % 2 === 0 ? "Steve" : "Ayla",
    text: filler(textLength, `line${index + 1}`),
    ...(index % 2 === 1 && { to: ["Steve"] }),
  }));
}

const places: KnownPlace[] = [
  { name: "the small medieval house you built for yourself", detail: "door -1204 76 803 facing north", own: true },
  { name: "a farm of wheat", detail: "around 40 64 -20" },
  { name: "note: iron seen", detail: "at 300 20 -45" },
];

/** Opportunities as the goal tier prints them; the first `pressing` ones are marked pressing when the marker exists. */
export function hints(count: number, pressing: number, textLength: number): Opportunity[] {
  return Array.from({ length: count }, (_, index) => ({
    activities: [index % 2 === 0 ? "building" as const : "farming" as const],
    text: filler(textLength, `hint${index + 1}`),
    ...(index < pressing && { pressing: true }),
  }));
}

/** The work tier at the measured median: 4 steps, 2 earlier failures, 3 players, 1 area. */
export function workP50(): WorkInput {
  return {
    persona: testPersona(),
    objective: { text: "build a small house next to the river", requester: "Player2", purpose: null },
    snapshot: snapshotWith(distinctItems(3), players(3)),
    places,
    areas: [area(1, 20)],
    steps: stepRecords(4, 140),
    paused: [{ text: "feed the chickens", requester: null, purpose: null }],
    earlierFailures: failures(2, 1, 220, "build a small house next to the river"),
  };
}

/** The work tier large: 10 steps, 8 failures (2 refused), 20 players, 1 area. */
export function workLarge(): WorkInput {
  return {
    ...workP50(),
    snapshot: snapshotWith(distinctItems(20), players(20)),
    steps: stepRecords(10, 320),
    earlierFailures: failures(8, 2, 320, "build a small house next to the river"),
  };
}

/** The goal tier at the measured median: 5 lately lines, 4 hints, 3 players, 1 area. */
export function goalP50(): GoalInput {
  return {
    persona: testPersona({ goal: "build yourself a base" }),
    snapshot: snapshotWith(distinctItems(2), players(3)),
    places,
    areas: [area(1, 20)],
    lately: Array.from({ length: 5 }, (_, index) => filler(160, `lately${index + 1}`)),
    opportunities: hints(4, 1, 260),
    time: [{ activity: "building", minutes: 30 }, { activity: "farming", minutes: 12.4 }],
    drawn: ["building", "farming"],
    chances: [{ activity: "building", chance: 0.6 }, { activity: "farming", chance: 0.4 }],
  };
}

/** The persona of the worst cases: a description long enough for a `personaPrompt` of 1800 characters or more. */
function bigPersona() {
  return testPersona({ goal: "build yourself a base", description: filler(1900, "persona") });
}

/** Four farms through the real place and hint renderers; all six hints measure 567 chars (2026-11-09). */
export function farmPromptFacts() {
  const runtime = new FakeRuntime();
  const log = () => undefined;
  const memory = new AgentMemory({ runtime, log, persona: testPersona() }, new Body(runtime, log, INSTANT_TYPING));
  const now = new Date().toISOString();
  for (let index = 0; index < 4; index++) memory.learnFarm({
    crop: "wheat_seeds", size: 9, centre: { x: index * 30, y: 63, z: -20 }, madeAt: now,
    tendedAt: new Date(Date.parse(now) - 30 * 60_000).toISOString(), dimension: runtime.snapshot.dimension,
    state: { planted: 80, ripe: 0, empty: 0, stage: 2, ripeAge: 7, dry: 2 }, pace: 1,
  });
  // A fixture's known 6 near-minutes of 30; production samples are covered by agent-memory.test.ts.
  const nearMinutes = () => ({ near: 6, unknown: 0, since: 30 });
  memory.nearMinutes = nearMinutes;
  const opportunities = findOpportunities({
    now: Date.parse(now), snapshot: { ...runtime.snapshot, inventory: ["iron_sword", "iron_pickaxe", "iron_axe"].map((name) => ({ name, count: 1 })), foods: [{ name: "bread", count: 8, points: 5, saturation: 6 }] },
    farms: memory.farms, nearMinutes, unfinished: { kind: "small medieval house", site: { door: { x: 5, y: 64, z: 5 }, facing: "north" }, part: 1 }, ownHome: false,
    houseShortfall: [], smallHouse: [], carriedBlocks: [], temporaryHouse: null,
  }, ["farming"]);
  return { places: memory.knownPlaces(), opportunities };
}

/** 2 own places, 6 notes, 4 real farm descriptions and 1 unfinished house. */
function manyPlaces(): KnownPlace[] {
  return [
    { name: "own house", detail: "door 1 76 3 facing north", own: true },
    { name: "house for Tom", detail: "door 9 70 3 facing east" },
    ...Array.from({ length: 6 }, (_, index) => ({ name: `note ${index + 1}`, detail: `iron at ${index * 40} 20 -45` })),
    ...farmPromptFacts().places,
    { name: "unfinished house", detail: "door 5 64 5" },
  ];
}

/** 36 distinct items, 20 players with positions (Player4 is the requester, the 4th nearest), 30 areas, 13 places. */
function crowdedSnapshotAndAreas() {
  const item = (index: number) => `long_item_${index}`.padEnd(20, "x");
  const snapshot: BotSnapshot = {
    ...snapshotWith(distinctItems(36), players(20)),
    health: 2.7, food: 12, saturation: 0.5,
    foods: [{ name: "food", count: 3, points: 6, saturation: 1 }],
    armourPoints: 20, armourToughness: 8, burn: { ticks: 70, hp: 3 },
    armour: {
      worn: ["head", "torso", "legs", "feet"].map((slot, index) => ({ slot, item: item(index) })),
      carried: Array.from({ length: 12 }, (_, index) => ({ item: item(index), count: 2 })),
    },
    combat: { melee: item(0), bow: item(1), arrows: 128, shield: item(2) },
    clock: { phase: "day", minutesUntilChange: 4.2 },
    light: { sky: 0, block: 0, openSkyAbove: 85 },
    gear: { tools: Array.from({ length: 12 }, (_, index) => ({ class: `class_${index}`, item: item(index) })), armour: [] },
    respawn: { kind: "world_spawn", position: { x: 912, y: 64, z: 0 }, distance: 912 },
    lastDeath: { dimension: "the_nether", position: { x: -645, y: 53, z: -27 }, observedAt: "2026-11-07T10:00:00Z", minutesAgo: 12, cause: filler(120, "death") },
  };
  return { snapshot, areas: Array.from({ length: 30 }, (_, index) => area(index + 1, 30 + index * 50)), places: manyPlaces() };
}

/**
 * A night respawn's event at its longest (spec D5): a home 40 characters long, five facts (home, deaths, the Nether, the
 * things out of reach, beds), the gear at its longest, an order of 300 characters with commas and quotes, requested by
 * a 16-character name, that the running step works on (the order is on top, so the carry-on option names it and the
 * requester hears the answer).
 */
export function situationWorst(): NonNullable<WorkInput["situation"]> {
  const order: Objective = { text: `bring "the iron", the coal and the bread to the farm, ${filler(280, "order")}`, requester: "Requester".padEnd(16, "x"), purpose: null };
  const home: KnownPlace = { name: filler(40, "home"), detail: "", own: true, house: { size: "small", style: "medieval", door: { x: 3, y: 64, z: 0 }, facing: "north", materials: {} } };
  // The longest gear of spec D5: melee, bow and shield ids of 30 characters; exposure 1 gives the longest risk suffix (100%).
  const item30 = (index: number) => `long_gear_item_${index}`.padEnd(30, "x");
  const snapshot: BotSnapshot = { ...crowdedSnapshotAndAreas().snapshot, combat: { melee: item30(0), bow: item30(1), arrows: 128, shield: item30(2), exposure: 1 } };
  const info: SituationInfo = { kind: "respawn", cause: "It is night (day comes in 7.9 min). You died 12 min ago at -645 53 -27 (Zombie) and respawned at 912 64 0", raisedAt: 0 };
  const view = situationView({
    info, snapshot, places: [home], objective: order, pushed: false, skills: SKILL_NAMES, boldness: "cautious", ordinary: order,
    deaths: { total: 2, atNight: 1 }, night: true, timeOfDay: 12_100,
  });
  return { info, view, objective: order, running: "get_items", deciding: true };
}

/** The work tier's worst case (spec D5): 10 steps and 8 failures (2 refused) of 700 characters, 4 paused, a night event. */
export function workWorst(): WorkInput {
  const objective = "build a small house next to the river";
  return {
    persona: bigPersona(),
    objective: { text: objective, requester: "Player4", purpose: null },
    ...crowdedSnapshotAndAreas(),
    steps: stepRecords(10, 700),
    paused: ["a", "b", "c", "d"].map((name) => ({ text: `set aside objective ${name}: ${filler(80, name)}`, requester: null, purpose: null })),
    earlierFailures: failures(8, 2, 700, objective),
    ownsTemporaryHouse: true,
    situation: situationWorst(),
  };
}

/** The goal tier's worst case: 5 lately lines of 560 characters, 4 real farm hints plus a house and bed. */
export function goalWorst(): GoalInput {
  return {
    ...goalP50(),
    persona: bigPersona(),
    ...crowdedSnapshotAndAreas(),
    lately: Array.from({ length: 5 }, (_, index) => filler(560, `lately${index + 1}`)),
    opportunities: farmPromptFacts().opportunities,
  };
}

/** The chat tier's worst case: 12 history lines of 200 characters. */
export function chatWorst(): ChatInput {
  return { ...chatP50(), persona: bigPersona(), ...crowdedSnapshotAndAreas(), history: historyLines(12, 200) };
}

/** The narrate tier's worst case: 12 history lines of 200 characters and a long detail. */
export function narrateWorst(): NarrateInput {
  return { persona: bigPersona(), objective: "build a small house next to the river", outcome: "progress", detail: filler(300, "detail"), history: historyLines(12, 200) };
}

/** The chat tier: 12 history lines of 90 characters, 3 players, 1 area, a message that names a player. */
export function chatP50(): ChatInput {
  return {
    persona: testPersona(),
    message: { username: "Player2", channel: "chat", message: "Ayla, can you help Player3 with the fence?", addressed: true },
    history: historyLines(12, 90),
    snapshot: snapshotWith(distinctItems(2), players(3)),
    activity: "idle",
    places,
    areas: [area(1, 20)],
  };
}
