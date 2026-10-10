import assert from "node:assert/strict";
import test from "node:test";
import type { KnownFarm } from "./memory.ts";
import { describeOpportunities, findOpportunities, MAX_OPPORTUNITIES, type OpportunityFacts } from "./opportunities.ts";
import type { BotSnapshot } from "./runtime-client.ts";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const snapshot = (overrides: Partial<BotSnapshot> = {}): BotSnapshot => ({
  position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: [], foods: [], mobs: [], players: [], policy: null, ...overrides,
});

const farm = (overrides: Partial<KnownFarm> = {}): KnownFarm => ({
  crop: "wheat_seeds", size: 9, centre: { x: 10, y: 63, z: -5 }, madeAt: minutesAgo(120), tendedAt: minutesAgo(40),
  state: { planted: 80, ripe: 0, empty: 0 }, ...overrides,
});

/** A sword, a pickaxe and an axe: no tool missing. */
const TOOLS = [{ name: "iron_sword", count: 1 }, { name: "iron_pickaxe", count: 1 }, { name: "iron_axe", count: 1 }];

/** A character with everything in order: a home, a bed, food, tools, no farm, nothing worn out. */
const settled = (overrides: Partial<OpportunityFacts> = {}): OpportunityFacts => ({
  now: NOW,
  snapshot: snapshot({
    inventory: [{ name: "bread", count: 8 }, { name: "red_bed", count: 1 }, ...TOOLS],
    foods: [{ name: "bread", count: 8, points: 5, saturation: 6 }],
  }),
  farms: [],
  unfinished: null,
  ownHome: true,
  houseShortfall: [],
  smallHouse: [],
  carriedBlocks: [],
  temporaryHouse: null,
  ...overrides,
});

const texts = (facts: OpportunityFacts) => findOpportunities(facts).map((found) => `(${found.activities.join(", ")}) ${found.text}`);

test("nothing to do when everything is in order", () => {
  assert.deepEqual(findOpportunities(settled()), []);
});

test("a tool nearly worn out is a crafting opportunity; a fresh one is not", () => {
  const inventory = [
    { name: "stone_pickaxe", count: 1, durability: { remaining: 12, maximum: 131 } },
    { name: "iron_axe", count: 1, durability: { remaining: 200, maximum: 250 } },
    { name: "bread", count: 8 }, { name: "red_bed", count: 1 }, { name: "wooden_sword", count: 1 },
  ];
  const facts = settled();
  assert.deepEqual(texts({ ...facts, snapshot: { ...facts.snapshot, inventory } }), ["(crafting) your stone_pickaxe has 12 uses left"]);
});

test("food carried for less than a day is an opportunity to farm, hunt or cook", () => {
  const facts = settled({ snapshot: snapshot({ food: 14, inventory: [{ name: "bread", count: 2 }, { name: "red_bed", count: 1 }, ...TOOLS], foods: [{ name: "bread", count: 2, points: 5, saturation: 6 }] }) });
  assert.deepEqual(texts(facts), ["(farming, hunting, cooking) you carry food for 10 hunger points (2 bread); your hunger is 14/20"]);
  const none = settled({ snapshot: snapshot({ inventory: [{ name: "red_bed", count: 1 }, ...TOOLS] }) });
  assert.deepEqual(texts(none), ["(farming, hunting, cooking) you carry no food; your hunger is 20/20"]);
  // Starving, with animals in sight (live 2026-10-04: Ayla tried to eat seeds and to farm, never to hunt).
  const mobs = [{ name: "cow", hostile: false, count: 2, distance: 18.4 }, { name: "zombie", hostile: true, count: 1, distance: 9 }];
  const starving = settled({ snapshot: snapshot({ food: 4, mobs, inventory: [{ name: "red_bed", count: 1 }, ...TOOLS] }) });
  assert.deepEqual(texts(starving), ["(farming, hunting, cooking) you carry no food; your hunger is 4/20: you are starving, food comes before anything else; a new crop takes many minutes to grow, an animal near is quicker; animals in sight: 2 cow 18 blocks away"]);
});

test("a farm tended a while ago, or left with ripe crops, could be harvested; one tended just now not yet", () => {
  assert.deepEqual(texts(settled({ farms: [farm()] })), ["(farming) your wheat_seeds farm around 10 63 -5, 11 blocks away, was tended 40 min ago (0 ripe then)"]);
  assert.deepEqual(texts(settled({ farms: [farm({ tendedAt: minutesAgo(5), state: { planted: 70, ripe: 10, empty: 0 } })] })), ["(farming) your wheat_seeds farm around 10 63 -5, 11 blocks away, was tended 5 min ago (10 ripe then)"]);
  assert.deepEqual(texts(settled({ farms: [farm({ tendedAt: minutesAgo(5) })] })), []);
});

test("empty farmland with no crop item carried is a foraging opportunity", () => {
  const found = texts(settled({ farms: [farm({ tendedAt: minutesAgo(5), state: { planted: 60, ripe: 0, empty: 20 } })] }));
  assert.deepEqual(found, ["(foraging) your wheat_seeds farm around 10 63 -5, 11 blocks away, has 20 empty farmland and you carry no wheat_seeds"]);
});

test("an unfinished house comes before having no home; the materials a home needs are grouped by the work that gets them", () => {
  const unfinished = { kind: "small medieval house", site: { door: { x: 4, y: 64, z: 2 }, facing: "north" as const }, part: 3 };
  assert.deepEqual(texts(settled({ ownHome: false, unfinished })), ["(building) your unfinished small medieval house, door at 4 64 2"]);
  const shortfall = [
    { item: "oak_log", count: 22, activity: "woodcutting" as const },
    { item: "cobblestone", count: 16, activity: "mining" as const },
    { item: "spruce_stairs", count: 42, activity: "crafting" as const },
    { item: "glass_pane", count: 3, activity: "crafting" as const },
  ];
  assert.deepEqual(texts(settled({ ownHome: false, houseShortfall: shortfall })), [
    "(building) you have no house of your own yet",
    "(woodcutting) a house of your own needs 22 more oak_log",
    "(mining) a house of your own needs 16 more cobblestone",
    "(crafting) a house of your own needs 42 more spruce_stairs, 3 more glass_pane",
  ]);
});

test("no bed carried is a crafting opportunity", () => {
  assert.deepEqual(texts(settled({ snapshot: snapshot({ inventory: [{ name: "bread", count: 8 }, ...TOOLS], foods: [{ name: "bread", count: 8, points: 5, saturation: 6 }] }) })), ["(crafting) you carry no bed"]);
});

test("no sword, pickaxe or axe carried is a crafting opportunity, in stone once she carries cobblestone", () => {
  // Owner, real world 2026-10-07: Ayla did everything with her hands.
  const inventory = [{ name: "bread", count: 8 }, { name: "red_bed", count: 1 }, { name: "wooden_pickaxe", count: 1 }];
  assert.deepEqual(texts(settled({ snapshot: snapshot({ inventory, foods: [{ name: "bread", count: 8, points: 5, saturation: 6 }] }) })), [
    "(crafting) you carry no sword, no axe: you fight and work bare-handed, slow and in danger; get_items wooden_sword, wooden_axe makes them in a few minutes",
  ]);
  const stone = [...inventory, { name: "cobblestone", count: 12 }];
  assert.match(texts(settled({ snapshot: snapshot({ inventory: stone, foods: [{ name: "bread", count: 8, points: 5, saturation: 6 }] }) }))[0]!, /get_items stone_sword, stone_axe /u);
});

test("with tools, her gear is said, so better gear can be thought of; with none, the missing tools say it", () => {
  // Owner, 2026-10-07: Vex carried 100 raw iron and a stone sword, never thinking of better gear.
  const gear = {
    tools: [{ class: "pickaxe", item: "stone_pickaxe" }, { class: "axe", item: null }, { class: "sword", item: "stone_sword" }, { class: "shovel", item: null }],
    armour: [{ class: "helmet", item: null }, { class: "chestplate", item: "leather_chestplate" }, { class: "leggings", item: null }, { class: "boots", item: null }],
  };
  assert.deepEqual(texts(settled({ snapshot: { ...settled().snapshot, gear } })), [
    "(crafting) your gear: stone_pickaxe, no axe, stone_sword; armour: no helmet, leather_chestplate, no leggings, no boots (better tools and armour are crafted from what you mine and smelt)",
  ]);
  const bare = { ...gear, tools: gear.tools.map((entry) => ({ ...entry, item: null })) };
  assert.equal(texts(settled({ snapshot: { ...settled().snapshot, gear: bare } })).length, 0);
});

test("at most six, the most pressing first: worn tools, missing tools and food before the rest", () => {
  const found = findOpportunities({
    now: NOW,
    snapshot: snapshot({ inventory: [{ name: "stone_pickaxe", count: 1, durability: { remaining: 3, maximum: 131 } }] }),
    farms: [farm(), farm({ centre: { x: 30, y: 63, z: 0 }, state: { planted: 60, ripe: 0, empty: 20 } })],
    unfinished: null,
    ownHome: false,
    houseShortfall: [{ item: "oak_log", count: 22, activity: "woodcutting" }, { item: "cobblestone", count: 16, activity: "mining" }],
    smallHouse: [],
    carriedBlocks: [],
    temporaryHouse: null,
  });
  assert.equal(found.length, MAX_OPPORTUNITIES);
  assert.deepEqual(found.slice(0, 3).map((opportunity) => opportunity.activities[0]), ["crafting", "crafting", "farming"]);
  assert.match(found[0]!.text, /stone_pickaxe/u);
  assert.match(found[1]!.text, /no sword, no axe/u);
  assert.match(found[2]!.text, /no food/u);
});

test("opportunities read as one line each for the goal tier", () => {
  assert.equal(describeOpportunities([]), "none that you know of");
  assert.equal(describeOpportunities([{ activities: ["crafting"], text: "you carry no bed" }, { activities: ["farming", "hunting"], text: "x" }]), "\n- (crafting) you carry no bed\n- (farming, hunting) x");
});

test("with no house, her style's cost and the full blocks she carries are said on the first line, shortfall lines unchanged", () => {
  const smallHouse = [{ role: "foundation" as const, count: 16 }, { role: "floor" as const, count: 25 }, { role: "wall" as const, count: 34 }];
  const carriedBlocks = [{ name: "dirt", count: 150 }, { name: "cobblestone", count: 64 }];
  const houseShortfall = [{ item: "oak_planks", count: 34, activity: "woodcutting" as const }];
  assert.deepEqual(texts(settled({ ownHome: false, smallHouse, carriedBlocks, houseShortfall })), [
    "(building) you have no house of your own yet; a small house takes 16 foundation, 25 floor, 34 wall blocks; build can use other blocks per role: you carry 150 dirt, 64 cobblestone",
    "(woodcutting) a house of your own needs 34 more oak_planks",
  ]);
  assert.deepEqual(texts(settled({ ownHome: false, smallHouse })), [
    "(building) you have no house of your own yet; a small house takes 16 foundation, 25 floor, 34 wall blocks",
  ]);
});

test("a temporary house is a home: its temporary parts and what improving it needs are said, by work", () => {
  const temporaryHouse = {
    door: { x: 4, y: 64, z: 2 },
    roles: [{ role: "wall" as const, block: "dirt", style: "oak_planks" }, { role: "roof" as const, block: "dirt", style: "spruce_planks" }],
    shortfall: [{ item: "oak_planks", count: 34, activity: "woodcutting" as const }, { item: "spruce_stairs", count: 42, activity: "crafting" as const }],
  };
  assert.deepEqual(texts(settled({ temporaryHouse })), [
    "(building) your house at door 4 64 2 is temporary: wall dirt, roof dirt (your style: oak_planks, spruce_planks)",
    "(woodcutting) improving your house needs 34 more oak_planks",
    "(crafting) improving your house needs 42 more spruce_stairs",
  ]);
  assert.deepEqual(texts(settled({ temporaryHouse: { ...temporaryHouse, roles: [] } })), []);
  assert.deepEqual(texts(settled()), []);
});
