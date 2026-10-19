import { HORIZONTAL_TICKS_PER_BLOCK } from "../goals/index.js";
import { createMovements } from "../runtime.js";
import { BREAK_OPENS_INTO_LIQUID } from "../movements/policy.js";
import { MemoryWorld } from "../world/memory-world.js";
import { type LoadedBlock, loadedObservation } from "../world/world.js";
import { DEEP_WATER_REASON, TERRAIN_BREAK_PENALTY, fallbackScaffoldItem } from "./movement-policy.js";
import { Vec3 } from "vec3";
import { blockClass, observeMineflayerBlock } from "./world.js";
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { botFixture, type FakeBot, type FakeStack } from "../../test-support/bot.js";
import { flatWorld } from "../../test-support/navigation.js";
import { siteBreakRequest } from "../../actions/build-structure/build-structure.js";
import { parseBuildStructureRequest } from "../../actions/build-structure/contract.js";
import { setProtectedRegionsProvider, type ProtectedRegion } from "../../world/protected-regions.js";

/** Air around the origin: no liquid beside any cell these tests break. */
const world = flatWorld();

function loadedBlock(stateId: number): LoadedBlock {
  return loadedObservation(stateId, [], {
    empty: false,
    liquid: null,
    liquidSource: false,
    waterlogged: false,
    waterloggable: false,
    climbable: false,
    openable: false,
    open: false,
    activationGroup: null,
    upperHalf: false,
    falling: false,
    yielding: false,
    damaging: false,
    interactive: false,
    parkourTakeoff: "normal",
    safeToBreak: true,
  });
}

/** A bot carrying `items`, whose every world block digs in half a second, as `name` does. */
function diggingBot(name: string, items: FakeStack[] = []): FakeBot {
  const bot = botFixture({ items });
  const block = bot.registry.blocksByName[name]!;
  bot.blockAt = () =>
    ({ type: block.id, digTime: () => 500, canHarvest: () => true }) as unknown as NonNullable<
      ReturnType<Bot["blockAt"]>
    >;
  return bot;
}

/** One block as Prismarine reports it at its default state. */
function observed(bot: FakeBot, name: string) {
  return observeMineflayerBlock(blockClass(bot).fromStateId(bot.registry.blocksByName[name]!.defaultState, 0));
}

test("builds an immutable Mineflayer-backed movement policy without a legacy Pathfinder", () => {
  const registry = minecraftData("1.21.4");
  const dirt = { type: registry.itemsByName.dirt.id, name: "dirt", count: 3 };
  const bot = diggingBot("wheat", [dirt]);

  const policy = createMovements(bot);

  assert.equal(Object.isFrozen(policy), true);
  assert.equal(policy.allowDigging, true);
  assert.equal(policy.allowDoors, true);
  assert.equal(policy.allowParkour, true);
  assert.equal(policy.allowSprinting, true);
  assert.equal(policy.maximumDrop, 3);
  assert.equal(policy.placementPenalty, 20);
  assert.equal(policy.scaffold?.itemType, dirt.type);
  assert.deepEqual(
    policy.evaluateBreak(loadedBlock(registry.blocksByName.wheat.defaultState), { x: 1, y: 64, z: 1 }, world).decision,
    { kind: "prohibited", reason: "movement policy prohibits breaking this block" },
  );
});

test("a caller's option changes only what it names", () => {
  assert.equal(createMovements(botFixture(), { allowSprinting: false }).allowSprinting, false);
  const priced = createMovements(botFixture(), { placementPenalty: 80 });
  assert.equal(priced.placementPenalty, 80);
  assert.equal(priced.allowPlacing, true, "pricing scaffold use does not disable necessary placement");
  const walking = createMovements(botFixture(), { allowDigging: false });
  assert.equal(walking.allowDigging, false);
  assert.equal(walking.allowDoors, true, "forbidding excavation does not disable door interaction");
});

test("the scaffold is whatever the inventory holds when it is read, and names the state each face gives", () => {
  const registry = minecraftData("1.21.4");
  const netherrack = { type: registry.itemsByName.netherrack.id, name: "netherrack", count: 32 };
  const nether = botFixture({ items: [netherrack] });
  assert.deepEqual(createMovements(nether).scaffold, {
    itemType: netherrack.type,
    stateId: registry.blocksByName.netherrack.defaultState,
  });
  assert.equal(createMovements(nether, { protectedScaffoldNames: ["netherrack"] }).scaffold, null);
  assert.equal(createMovements(nether, { scaffolding: false }).scaffold, null);

  // An axis block such as basalt is a different state per placement face.
  const basalt = registry.blocksByName.basalt;
  const axis = createMovements(
    botFixture({ items: [{ type: registry.itemsByName.basalt.id, name: "basalt", count: 9 }] }),
  );
  assert.deepEqual(axis.scaffold, {
    itemType: registry.itemsByName.basalt.id,
    stateId: basalt.defaultState,
    stateIdByAxis: { x: basalt.minStateId, y: basalt.defaultState, z: basalt.maxStateId },
  });
  const cobblestone = { type: registry.itemsByName.cobblestone.id, name: "cobblestone", count: 16 };
  assert.equal("stateIdByAxis" in (createMovements(botFixture({ items: [cobblestone] })).scaffold ?? {}), false);

  const carried = [
    { ...netherrack, count: 35 },
    cobblestone,
    { type: registry.itemsByName.basalt.id, name: "basalt", count: 3 },
  ];
  const policy = createMovements(botFixture({ items: carried }));
  assert.equal(policy.scaffold?.itemType, cobblestone.type, "policy order wins over the largest stack");
  carried.splice(1, 1);
  assert.equal(policy.scaffold?.itemType, netherrack.type);
  carried.shift();
  assert.equal(policy.scaffold?.itemType, registry.itemsByName.basalt.id);
  carried.length = 0;
  assert.equal(policy.scaffold, null);
  assert.equal(policy.allowPlacing, true);
});

test("prices a walking route's terrain damage well above a tie-break", () => {
  // Baritone's `blockBreakAdditionalPenalty` is two, about half a block of
  // sprinting, which only settles ties between equally fast routes. A bot told
  // to walk somewhere took that as licence to open a hole in a house wall
  // rather than use the door beside it, so the walking default is the price of
  // several blocks of travel instead.
  const bot = diggingBot("stone");
  const breaking = createMovements(bot).evaluateBreak(
    loadedBlock(bot.registry.blocksByName.stone.defaultState),
    { x: 1, y: 64, z: 1 },
    world,
  ).decision;

  assert.equal(breaking.kind, "penalized");
  if (breaking.kind !== "penalized") return;
  assert.equal(breaking.cost, TERRAIN_BREAK_PENALTY);
  assert.ok(breaking.cost > HORIZONTAL_TICKS_PER_BLOCK * 4);
});

/**
 * The refusal is named, and it comes with the tool the break would have used.
 * A route break stays refused; a caller that owns a *target* break tells this
 * prohibition apart from an unbreakable block and seals the cell first, which
 * is what makes obsidian beside lava obtainable at all.
 */
test("a break is refused exactly when it would open a path into liquid", () => {
  const bot = botFixture();
  const policy = createMovements(bot);
  const stone = loadedBlock(bot.registry.blocksByName.stone.defaultState);
  const water = bot.registry.blocksByName.water;
  const position = { x: 2, y: 40, z: 3 };
  const opensIntoLiquid = { kind: "prohibited", cause: "opens_into_liquid", reason: BREAK_OPENS_INTO_LIQUID };

  const source = new MemoryWorld();
  source.load({ x: 3, y: 40, z: 3 }, { stateId: water.minStateId, traits: { liquid: "water", liquidSource: true } });
  const evaluation = policy.evaluateBreak(stone, position, source);
  assert.deepEqual(evaluation.decision, opensIntoLiquid);
  assert.ok(evaluation.tool.expectedTicks > 1);

  // Stable downward-flowing water is not a source, and Baritone mines beside it.
  const flowing = { stateId: water.minStateId + 1, traits: { liquid: "water" as const, liquidSource: false } };
  const falling = new MemoryWorld();
  falling.load({ x: 3, y: 40, z: 3 }, flowing);
  falling.load({ x: 3, y: 39, z: 3 }, flowing);
  assert.equal(policy.evaluateBreak(stone, position, falling).decision.kind, "penalized");

  // The new downward path is refused for any liquid, at any level, on any side
  // of the cell above it, whether or not that cell is walkable.
  const nylium = loadedBlock(bot.registry.blocksByName.warped_nylium.defaultState);
  for (const aboveName of ["air", "nether_sprouts"])
    for (const liquidName of ["water", "lava"])
      for (const level of [0, 3, 8])
        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const beside = new MemoryWorld();
          beside.load({ x: 2, y: 41, z: 3 }, observed(bot, aboveName));
          beside.load(
            { x: 2 + dx, y: 41, z: 3 + dz },
            observeMineflayerBlock(
              blockClass(bot).fromStateId(bot.registry.blocksByName[liquidName]!.minStateId + level, 0),
            ),
          );
          assert.deepEqual(
            policy.evaluateBreak(nylium, position, beside).decision,
            opensIntoLiquid,
            `${aboveName}, ${liquidName}[level=${level}], offset ${dx},${dz}`,
          );
        }

  // A solid cell above still separates the upper liquid, so nothing opens.
  const separated = new MemoryWorld();
  separated.load({ x: 2, y: 41, z: 3 }, observed(bot, "stone"));
  separated.load(
    { x: 3, y: 41, z: 3 },
    observeMineflayerBlock(blockClass(bot).fromStateId(bot.registry.blocksByName.lava.minStateId + 3, 0)),
  );
  assert.equal(policy.evaluateBreak(stone, position, separated).decision.kind, "penalized");
});

test("uses the production world policy to reject lava steps", () => {
  const bot = botFixture();
  const lava = loadedBlock(bot.registry.blocksByName.lava.defaultState);
  const observation = { ...lava, traits: { ...lava.traits, liquid: "lava" as const } };
  const lavaWorld = { blockAt: () => observation, subscribe: () => () => {}, revision: 0 };

  assert.equal(createMovements(bot).decideStep(1, 64, 1, lavaWorld).kind, "prohibited");
});

test("routes preserve what a player built or uses, while terrain stays diggable", () => {
  const bot = botFixture();
  const policy = createMovements(bot);
  const position = { x: 0, y: 64, z: 0 };
  for (const name of ["chest", "crafting_table", "barrel", "furnace", "shulker_box"]) {
    const block = observed(bot, name);
    assert.equal(block.traits.interactive, true, name);
    assert.equal(policy.evaluateBreak(block, position, world).decision.kind, "prohibited", name);
  }
  assert.equal(policy.evaluateBreak(observed(bot, "stone"), position, world).decision.kind, "penalized");

  // A spawner is preserved too, until removing it is what was asked for.
  const spawner = observed(bot, "spawner");
  assert.equal(policy.evaluateBreak(spawner, position, world).decision.kind, "prohibited");
  assert.equal(
    createMovements(bot, { isRequestedBreak: () => true }).evaluateBreak(spawner, position, world).decision.kind,
    "penalized",
  );
});

test("a build clears a workstation standing in its own site, and no other one (live 2026-10-14: Oskar's house, 4 times)", () => {
  const bot = botFixture();
  const request = parseBuildStructureRequest({ blocks: [{ x: 0, y: 64, z: 0, block_name: "cobblestone" }], remove_wrong_blocks: true });
  const policy = createMovements(bot, { isRequestedBreak: siteBreakRequest(request) });
  const table = observed(bot, "crafting_table");
  assert.equal(policy.evaluateBreak(table, { x: 0, y: 64, z: 0 }, world).decision.kind, "penalized", "inside the site");
  assert.equal(policy.evaluateBreak(table, { x: 5, y: 64, z: 0 }, world).decision.kind, "prohibited", "a route keeps other workstations");
  const keeping = parseBuildStructureRequest({ blocks: [{ x: 0, y: 64, z: 0, block_name: "cobblestone" }] });
  assert.equal(
    createMovements(bot, { isRequestedBreak: siteBreakRequest(keeping) }).evaluateBreak(table, { x: 0, y: 64, z: 0 }, world).decision.kind,
    "prohibited",
    "a build that keeps wrong blocks digs nothing",
  );
});

test("scaffold admission follows other mobs moving into and out of a placement cell", () => {
  const bot = botFixture();
  const target = { x: 1, y: 64, z: 0 };
  const mob = Object.assign({}, bot.entity, { id: 77, name: "enderman", type: "mob", isValid: true,
    width: 0.6, height: 2.9, position: bot.entity.position.clone().set(1.1, 64, 0.5) });
  bot.entities[mob.id] = mob;
  const policy = createMovements(bot);
  const occupied = policy.decidePlace(target.x, target.y, target.z, world);
  assert.equal(occupied.kind, "prohibited");
  if (occupied.kind === "prohibited") assert.match(occupied.reason, /enderman #77/);
  mob.position.x = 3;
  assert.equal(policy.decidePlace(target.x, target.y, target.z, world).kind, "allowed");
  mob.position.x = 1.1;
  assert.equal(policy.decidePlace(target.x, target.y, target.z, world).kind, "prohibited");
});

test("a protected region refuses route digging and scaffolding in it, but not walking, other dimensions or its owner's build", () => {
  const bot = botFixture({ username: "Ayla" });
  let regions: readonly ProtectedRegion[] = [];
  setProtectedRegionsProvider(bot, () => regions);
  const policy = createMovements(bot);
  const stone = observed(bot, "stone");
  const inside = { x: 1, y: 64, z: 1 };
  assert.equal(policy.evaluateBreak(stone, inside, world).decision.kind, "penalized", "nothing protected yet");

  // Read live: a region added after the policy was made applies to its next check.
  regions = [{ regionId: 1, dimension: "overworld", min: { x: 0, y: 64, z: 0 }, max: { x: 2, y: 66, z: 2 }, owner: "Ayla", label: "small medieval house" }];
  const refusal = { kind: "prohibited", reason: "inside protected region #1 'small medieval house' (owner Ayla)" };
  assert.deepEqual(policy.evaluateBreak(stone, inside, world).decision, refusal);
  assert.deepEqual(policy.confirmBreak(stone, { x: 2, y: 66, z: 2 }, world), refusal);
  assert.equal(policy.evaluateBreak(stone, { x: 3, y: 64, z: 1 }, world).decision.kind, "penalized", "just outside");
  assert.deepEqual(policy.decidePlace(1, 65, 1, world), refusal);
  assert.equal(policy.decideStep(1, 65, 1, world).kind, "allowed", "walking through stays allowed");

  const ownBuild = createMovements(bot, { ignoreRegionsOwnedBy: "ayla" });
  assert.equal(ownBuild.evaluateBreak(stone, inside, world).decision.kind, "penalized");
  assert.equal(ownBuild.decidePlace(1, 65, 1, world).kind, "allowed");

  bot.game.dimension = "the_nether";
  assert.equal(policy.evaluateBreak(stone, inside, world).decision.kind, "penalized", "an overworld region stays in the overworld");
});

test("routes never set off across deep open water, but a bot already out on it swims back", () => {
  const bot = botFixture();
  const water = loadedBlock(bot.registry.blocksByName.water.defaultState);
  const observation = { ...water, traits: { ...water.traits, empty: true, liquid: "water" as const, liquidSource: true } };
  const air = loadedBlock(bot.registry.blocksByName.air.defaultState);
  // An ocean from x 10 to 60, z -30 to 30, down to y 50; land elsewhere.
  const inOcean = (x: number, y: number, z: number) => x >= 10 && x <= 60 && z >= -30 && z <= 30 && y >= 50 && y <= 62;
  const oceanWorld = { blockAt: (x: number, y: number, z: number) => (inOcean(x, y, z) ? observation : air), subscribe: () => () => {}, revision: 0 };
  const policy = createMovements(bot);

  bot.entity.position = new Vec3(0.5, 64, 0.5);
  assert.deepEqual(policy.decideStep(30, 62, 0, oceanWorld), { kind: "prohibited", reason: DEEP_WATER_REASON });
  assert.equal(policy.decideStep(0, 64, 0, oceanWorld).kind, "allowed", "land stays open");

  bot.entity.position = new Vec3(30.5, 62.2, 0.5);
  assert.equal(policy.decideStep(25, 62, 0, oceanWorld).kind, "allowed", "out at sea, the way back is open");
});

type SeaCell = "stone" | "water" | "air";

/** The step into deep open water at 10 61 0, from a body at `standing`, over a stone floor at y 58 with `fill` above it. */
function stepIntoSea(standing: { x: number; y: number; z: number }, fill: (x: number, y: number, z: number) => SeaCell) {
  const bot = botFixture();
  bot.entity.position = new Vec3(standing.x + 0.5, standing.y, standing.z + 0.5);
  const sea = new MemoryWorld();
  for (let x = -3; x <= 24; x++) for (let z = -8; z <= 8; z++) for (let y = 58; y <= 64; y++) {
    const block = observed(bot, y === 58 ? "stone" : fill(x, y, z));
    if (block.kind !== "loaded") throw new Error("unloaded test block");
    sea.load({ x, y, z }, { stateId: block.stateId, collisionShapes: block.collisionShapes, traits: block.traits });
  }
  return createMovements(bot).decideStep(10, 61, 0, sea);
}

/** A wading shelf (water at y 59 only) for x 0-4, deep open water (y 59-61) from x 5 east, and a one-wide roofed pocket at x 22. */
const shelfAndSea = (x: number, y: number, z: number): SeaCell =>
  x === 22 && ((Math.abs(z) === 1 && y >= 59) || (z === 0 && y === 62)) ? "stone"
    : x >= 0 && (y === 59 || (x >= 5 && y <= 61)) ? "water" : "air";

test("a bot dry on the bank or wading with its head dry is refused deep open water; one submerged in a roofed pocket is not", () => {
  assert.equal(stepIntoSea({ x: -1, y: 59, z: 0 }, shelfAndSea).kind, "prohibited");
  assert.equal(stepIntoSea({ x: 3, y: 59, z: 0 }, shelfAndSea).kind, "prohibited");
  assert.equal(stepIntoSea({ x: 22, y: 60, z: 0 }, shelfAndSea).kind, "allowed");
});

/** A 2-deep channel (water y 59-60) at x 0-4 beside deep open water (y 59-61) from x 5 east; `roofAt` puts stone over the channel there. */
const channelAndSea = (roofAt?: number) => (x: number, y: number, z: number): SeaCell =>
  x === roofAt && z === 0 && y === 61 ? "stone" : x >= 0 && (y <= 60 || (x >= 5 && y <= 61)) ? "water" : "air";

test("a bot swimming in an open channel is refused deep open water (a river mouth is not the sea), but not under a roof", () => {
  assert.equal(stepIntoSea({ x: 4, y: 59, z: 0 }, channelAndSea()).kind, "prohibited");
  assert.equal(stepIntoSea({ x: 4, y: 59, z: 0 }, channelAndSea(4)).kind, "allowed");
});

/** A bot carrying `items`, on the version whose block data the fallback reads. */
const versioned = (items: FakeStack[]) => botFixture({ items }, { version: "1.21.4" });

test("the scaffold fallback spends the plentiful common block it carries, never a valuable, a workstation or a falling block", () => {
  const stack = (name: string, count: number) => ({ name, count });
  const choice = (...items: Array<[string, number]>) =>
    fallbackScaffoldItem(versioned(items.map(([name, count]) => stack(name, count))))?.name ?? null;
  assert.equal(choice(["stone", 80]), "stone");
  assert.equal(choice(["oak_planks", 74]), "oak_planks");
  assert.equal(choice(["furnace", 1]), null, "a workstation answers a right-click");
  assert.equal(choice(["sand", 64]), null, "a falling block buries the cell it is placed in");
  assert.equal(choice(["oak_log", 64]), null);
  assert.equal(choice(["diamond_block", 9]), null);
  assert.equal(choice(["stone", 5], ["oak_planks", 40], ["furnace", 1], ["diamond_block", 99]), "oak_planks", "the one carried most of");
  assert.equal(fallbackScaffoldItem(versioned([stack("stone", 80)]), new Set(["stone"])), null, "a fetched material stays");
});

test("only a bot asked for the fallback may scaffold with a block outside the survival policy's list", () => {
  const bot = versioned([{ name: "stone", count: 80 }]);
  assert.equal(createMovements(bot).scaffold, null);
  assert.equal(createMovements(bot, { scaffoldFallback: true }).scaffold?.itemType, bot.registry.itemsByName.stone!.id);
  const withCobble = versioned([{ name: "stone", count: 80 }, { name: "cobblestone", count: 2 }]);
  assert.equal(createMovements(withCobble, { scaffoldFallback: true }).scaffold?.itemType, withCobble.registry.itemsByName.cobblestone!.id);
});

test("a cobweb is a block to break at the best carried tool's time, no longer a wall", () => {
  const registry = minecraftData("1.21.4");
  const web = observed(botFixture(), "cobweb");
  assert.equal(web.traits.entangling, true);
  assert.equal(web.geometry.passable, false);
  const ticksWith = (...items: string[]) => {
    const bot = botFixture({ items: items.map((name) => ({ name, count: 1, type: registry.itemsByName[name]!.id })) });
    const policy = createMovements(bot);
    const verdict = policy.evaluateBreak(web, { x: 1, y: 64, z: 0 }, world);
    assert.equal(verdict.decision.kind, "allowed", "webs are not terrain to preserve");
    assert.equal(policy.decideStep(1, 64, 0, { ...world, blockAt: () => web } as never).kind, "allowed");
    return verdict.tool.expectedTicks;
  };
  const byHand = ticksWith();
  const withSword = ticksWith("wooden_sword");
  assert.ok(withSword < byHand, `a sword (${withSword} ticks) is faster than a hand (${byHand})`);
  assert.equal(ticksWith("wooden_sword", "stick"), withSword);
});

test("an escape may open into flowing water only: a source or lava beside the break keeps the refusal", () => {
  const bot = botFixture();
  const policy = createMovements(bot);
  const water = bot.registry.blocksByName.water;
  const lava = bot.registry.blocksByName.lava;
  const at = { x: 2, y: 40, z: 3 };
  const beside = (block: { minStateId: number }, liquidSource: boolean, liquid: "water" | "lava") => {
    const world = new MemoryWorld();
    world.load({ x: 3, y: 40, z: 3 }, { stateId: block.minStateId + (liquidSource ? 0 : 1), traits: { liquid, liquidSource } });
    // Flowing water that falls on is stable; one with no column under it spreads, which the rule counts as opening in.
    return policy.opensOnlyIntoFlowingWater!(at.x, at.y, at.z, world);
  };
  assert.equal(beside(water, true, "water"), false, "a source stays refused");
  assert.equal(beside(lava, false, "lava"), false, "lava stays refused");
  assert.equal(beside(water, false, "water"), true, "flowing water with nothing under it is let through in an escape");
  assert.equal(policy.opensOnlyIntoFlowingWater!(at.x, at.y, at.z, new MemoryWorld()), false, "nothing opened: no exception needed");
});
