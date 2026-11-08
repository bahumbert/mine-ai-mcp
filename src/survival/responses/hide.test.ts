import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { attackedIds, combatTestContext, onAttack } from "../../test-support/combat.js";
import {
  type FakeBot,
  type FakeBotOptions,
  type FakeCell,
  type FakeEntitySpec,
  type FakeServer,
  createFakeBot,
  createFakeClock,
} from "../../test-support/fake-bot/index.js";
import { regionRefusalText, setProtectedRegionsProvider, type ProtectedRegion } from "../../world/protected-regions.js";
import { observeHostileResponse } from "../control/combat/observation.js";
import { addItemsToServerTag } from "../../test-support/datapack-tags.js";
import { DEFAULT_COMBAT_POLICY } from "../policy/combat/contract.js";
import { hideInPlace } from "./hide.js";
import { capBlock, countCapBlocks, DRAGON_PROTECTION_BLOCKS } from "../positioning/combat/hide-blocks.js";

type Range = readonly [number, number];

/** Every cell of the box from `x`, `y`, `z` (inclusive) as `cell`. */
function boxOf(cell: FakeCell, x: Range, y: Range, z: Range): Record<string, FakeCell> {
  const cells: Record<string, FakeCell> = {};
  for (let cx = x[0]; cx <= x[1]; cx++)
    for (let cy = y[0]; cy <= y[1]; cy++) for (let cz = z[0]; cz <= z[1]; cz++) cells[`${cx},${cy},${cz}`] = cell;
  return cells;
}

/** The eight wall cells (feet and head height) and the cap around a bot standing at (0, 64, 0): the box the hide closes. */
const SEALED_BOX: Record<string, FakeCell> = Object.fromEntries([
  ...[[1, 0], [-1, 0], [0, 1], [0, -1]].flatMap(([x, z]) => [64, 65].map((y) => [`${x},${y},${z}`, "stone"])),
  ["0,66,0", "stone"],
]);

type SceneOptions = Omit<FakeBotOptions, "clock" | "overrides"> & {
  readonly overrides?: FakeBotOptions["overrides"];
  /** The hide reads `monotonicNow` and `setTimeout` for its deadline: a test about that installs this clock (`using`). */
  readonly mockedClock?: boolean;
};

/**
 * A bot on the shared fake, standing on stone with the sky above it (stone at y 63 and below) unless the test says
 * otherwise.
 */
function scene(options: SceneOptions = {}) {
  const { overrides, mockedClock, ...bot } = options;
  return createFakeBot({
    ...bot,
    clock: createFakeClock({ mode: mockedClock ? "mocked" : "manual" }),
    overrides,
  });
}

/** An `equip` the server refuses: the first thing a placement does, so the hide stops at its placement boundary. */
function refuseEquip(message: string): Pick<NonNullable<FakeBotOptions["overrides"]>, "equip"> {
  return {
    equip: async () => {
      throw new Error(message);
    },
  };
}

/** The clock a hide may take before the test calls it stuck. */
const HIDE_LIMIT_MS = 150_000;
/** The deadline of a hide a test expects to withhold every swing, so only the deadline ends it. */
const SHORT_HIDE_MS = 2_000;

function hide(bot: FakeBot, resolvedIds: Set<number> = new Set(), maximumMs: number = DEFAULT_COMBAT_POLICY.recovery_timeout_ms): ReturnType<typeof hideInPlace> {
  return hideInPlace(bot, {
    threatContext: {
      ...combatTestContext(bot),
      resolvedIds,
      attackerIds: new Set(),
      unreachableIds: new Set(),
    },
    signal: new AbortController().signal,
    recoverTo: 18,
    maximumMs,
  });
}

test("soul-sand support uses the observed lower surface when centering a shelter", async () => {
  const { bot, clock } = scene({
    health: 20,
    position: new Vec3(0.5, 63.875, 0.5),
    groundY: null,
    cells: boxOf("soul_sand", [-4, 4], [58, 63], [-4, 4]),
    carried: { cobblestone: 32 },
    overrides: refuseEquip("placement reached after valid soul-sand support"),
  });
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /placement reached after valid soul-sand support/);
  assert.doesNotMatch(result.error ?? "", /solid floor/);
});

test("same-cell knockback into a planned wall recenters before continuing construction", async () => {
  let equips = 0;
  let recentered = false;
  const { bot, clock } = scene({
    health: 20,
    carried: { cobblestone: 32 },
    overrides: {
      equip: async () => {
        if (++equips === 1) bot.entity.position.x = 0.15;
        throw new Error("placement boundary");
      },
      // Scripted: pressing a control while overlapping the west wall moves the body back to the cell's middle.
      setControlState: (_control, state) => {
        if (state && bot.entity.position.x === 0.15) {
          bot.entity.position.x = 0.5;
          recentered = true;
        }
      },
    },
  });
  await clock.settle(hide(bot), HIDE_LIMIT_MS);
  assert.equal(recentered, true, "the body still occupies the same cell but overlaps its west wall");
});

/**
 * A successful hide guaranteed a failing one thirty seconds later: every side
 * of the box already solid, nothing left to place, and the runtime reporting
 * its safety net broken from inside a working shelter. On 2026-09-04 the model
 * could not walk the bot out of that box because the failing hide reclaimed
 * the body every second.
 */
test("a bot already sealed in is hidden, not failed", async () => {
  const { bot, clock } = scene({ health: 18, cells: SEALED_BOX });
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);

  assert.equal(result.kind, "recovered");
  assert.equal(result.enclosed, true);
  assert.equal(result.dug, 0);
  assert.equal(result.walled, 0);
  assert.equal(result.error, undefined);
});

test("dragon shelter counts and selects resistant blocks and rejects an ordinary stone enclosure", async () => {
  const { bot, clock } = scene({ health: 18, cells: SEALED_BOX, carried: { cobblestone: 64, end_stone: 10 } });
  assert.equal(countCapBlocks(bot, DRAGON_PROTECTION_BLOCKS), 10);
  assert.equal(capBlock(bot, DRAGON_PROTECTION_BLOCKS)?.name, "end_stone");
  const result = await clock.settle(hideInPlace(bot, {
      threatContext: combatTestContext(bot), signal: new AbortController().signal,
      recoverTo: 18, maximumMs: 90_000, blockNames: DRAGON_PROTECTION_BLOCKS,
    }), HIDE_LIMIT_MS);
  assert.equal(result.kind, "failed");
  assert.equal(result.enclosed, false, "ordinary stone can be destroyed by the dragon");
});

/**
 * The open-ground failure of 2026-09-04: nothing dug, nothing walled, not
 * capped, on ordinary ground with forty-seven blocks carried, and a record
 * that named no cause. The refusal now travels with the failure.
 */
test("a failed hide reports the first refused placement, with the cell and the face it chose", async () => {
  const { bot, clock } = scene({
    health: 7,
    // Enough to wall in rather than dig, which is the live failure's shape.
    carried: { cobblestone: 47 },
    overrides: refuseEquip("the server would not equip cobblestone"),
  });
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);

  assert.equal(result.kind, "failed");
  // Ground below and open air at head height is not a box.
  assert.equal(result.enclosed, false);
  assert.match(result.error ?? "", /1,64,0/, "the cell the block was meant for");
  // The only solid neighbour of that cell is the ground beneath it, so the
  // block is placed on its upper face.
  assert.match(result.error ?? "", /cobblestone against stone face 0,1,0/, "the support face it chose");
  assert.match(result.error ?? "", /the server would not equip cobblestone/, "what the placement said");
});

test("with nothing to dig and nothing to place, the failure says the bot carried nothing", async () => {
  // Every cell around the bot is in a chunk that is not loaded.
  const { bot, clock } = scene({ health: 7, groundY: null, cells: boxOf("void", [-4, 4], [58, 70], [-4, 4]) });
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);

  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /no block worth placing is carried/);
});

test("a wall-in that cannot clear the body's overlap refuses before placing walls", async () => {
  let equips = 0;
  const { bot, clock } = scene({
    health: 20,
    position: new Vec3(0.5, 64, 0.146),
    carried: { cobblestone: 32 },
    overrides: {
      // Counts the equips: no wall may be started.
      equip: async () => {
        equips += 1;
      },
    },
  });
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /could not centre inside/);
  assert.equal(equips, 0);
  assert.equal(result.walled, 0);
});

test("wall centering does not walk off adjacent lip support into an unsupported origin cell", async () => {
  let presses = 0;
  const { bot, clock } = scene({
    health: 20,
    position: new Vec3(0.5, 64, 0.146),
    groundY: null,
    carried: { cobblestone: 32 },
    overrides: {
      // Counts the controls pressed; the fake's clearControlStates releases each control through this too.
      setControlState: (_control, state) => {
        if (state) presses += 1;
      },
    },
  });
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /no solid floor/);
  assert.equal(presses, 0);
});

test("a partial collision block without center-height footing is not a wall-in floor", async () => {
  const { bot, clock } = scene({
    health: 20,
    groundY: null,
    cells: boxOf("stone_slab", [-4, 4], [58, 63], [-4, 4]),
    carried: { cobblestone: 32 },
  });
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /no solid floor/);
});

test("breaking a block without falling into its cell is a failed hide, even at full health", async () => {
  // The fake's own dig (bare hand on stone) turns the cell to air; no physics runs, so the body stays where it was.
  const { bot, clock } = scene({ health: 20 });
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);
  assert.equal(result.kind, "failed");
  assert.equal(result.dug, 1);
  assert.match(result.error ?? "", /did not land/);
});

/** A hostile mob inside the bot's cell column, the shelter shell's near side. */
function closeMob(name: string): FakeEntitySpec {
  return { name, kind: "Hostile mobs", metadata: [], position: new Vec3(0.5, 64, 0.9) };
}

/**
 * The wither skeleton `id` has `health` left, so the bot's one hit kills it; the hostile observer, absent in these tests, files
 * the dead among the resolved threats (without it the hide goes on swinging at the corpse for its 19 ticks). Returns that record.
 */
function killableIntruder(bot: FakeBot, id: number, health: number): Set<number> {
  Reflect.set(bot.entities[id]!.metadata, bot.registry.entitiesByName.wither_skeleton!.metadataKeys!.indexOf("health"), health);
  const resolvedIds = new Set<number>();
  bot.on("entityDead", (dead) => void resolvedIds.add(dead.id));
  return resolvedIds;
}

test("hide repels an authorized intruder before building and uses the observed landing cell", async () => {
  let attacks = 0;
  const { bot, clock, combat, server } = scene({
    health: 20,
    carried: { cobblestone: 32 },
    entities: { 2: closeMob("wither_skeleton") },
    overrides: refuseEquip("placement boundary"),
    simulatePhysics: true,
  });
  const resolvedIds = killableIntruder(bot, 2, 1); // the bot's bare hand kills it
  // The bot's own hit moves her nowhere (`attack-mob-knockback`); the intruder's hit back pushes her away from it, and her own physics carry her on.
  onAttack(server, () => {
    attacks++;
    combat.hurtBot(2, 2);
  });
  const result = await clock.settle(hide(bot, resolvedIds), HIDE_LIMIT_MS);
  assert.equal(attacks, 1);
  assert.equal(result.swings, 1);
  // Before (the test teleported her to x 3.5): the first placement at 4,64,0. After (the measured push, 0.4 away and 0.36 up, then her own fall): at 1,64,-2, east of the cell she landed in.
  assert.match(result.error ?? "", /placement was refused at 1,64,-2/);
});

test("a neutral piglin sharing the construction space is not permission to attack", async () => {
  const { bot, clock, server } = scene({
    health: 20,
    carried: { cobblestone: 32 },
    entities: { 2: closeMob("piglin") },
    overrides: refuseEquip("placement boundary"),
  });
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);
  assert.deepEqual(attackedIds(server), [], "the neutral mob was not attacked");
  assert.equal(result.swings, 0);
  assert.equal(result.kind, "failed");
});

test("shelter contact uses a ready shield and a non-sweeping tool beside a neutral Enderman", async () => {
  let ticks = 0;
  let raisedAt: number | undefined;
  const { bot, clock, server } = scene({
    health: 20,
    carried: { iron_sword: 1, iron_pickaxe: 1, shield: 1, cobblestone: 32 },
    entities: {
      2: closeMob("wither_skeleton"),
      3: { ...closeMob("enderman"), position: new Vec3(2, 64, 0.5) },
    },
  });
  const intruder = bot.entities[2]!;
  const bystander = bot.entities[3]!;
  const resolvedIds = killableIntruder(bot, intruder.id, 3); // the pickaxe's one hit is 4 at a full swing (`weapon-damage-pickaxes`)
  // The first use request the server receives is the shield's.
  server.onPacket("use_item", () => {
    raisedAt ??= ticks;
  });
  onAttack(server, (target) => {
    assert.equal(target, intruder.id);
    assert.equal(bot.heldItem?.name, "iron_pickaxe");
    assert.equal(bot.usingHeldItem, true);
    assert.ok(raisedAt !== undefined && ticks - raisedAt >= 5);
  });
  bot.on("physicsTick", () => {
    ticks++;
  });
  // The tools equip as the game does; only the construction's block is refused, so the hide ends after the contact.
  const equip = bot.equip;
  bot.equip = async (item, destination) => {
    if (typeof item === "number") throw new Error("Fixture expects a resolved item.");
    if (item.name === "cobblestone") throw new Error("construction boundary");
    return equip(item, destination);
  };
  const result = await clock.settle(hide(bot, resolvedIds), HIDE_LIMIT_MS);
  assert.equal(result.swings, 1);
  assert.deepEqual([...resolvedIds], [intruder.id], "the pickaxe's hit killed the intruder");
  assert.equal(bystander.isValid, true);
  assert.equal(bot.usingHeldItem, false, "the construction owner releases its shield on settlement");
});

/**
 * A shelter intruder with an Enderman beside it, the bot holding `held` as its only weapon. The unequip is a no-op: which
 * item the loadout puts in the hand is the loadout's rule (survival/weapons/equipment.ts), this test pins the swing
 * check on what is held when the bystander is in sweep range.
 */
function heldWeaponBesideBystander(held: string, datapackSwords: readonly string[]) {
  const harness = scene({
    health: 20,
    carried: { [held]: 1, cobblestone: 32 },
    entities: { 2: closeMob("wither_skeleton"), 3: { ...closeMob("enderman"), position: new Vec3(2, 64, 0.5) } },
    overrides: { unequip: async () => {} },
    mockedClock: true, // the hide never ends by itself when it withholds the swing: its 2 s deadline does
  });
  const { bot } = harness;
  if (datapackSwords.length > 0) addItemsToServerTag(harness, "swords", datapackSwords);
  const resolvedIds = killableIntruder(bot, 2, 1);
  const equip = bot.equip;
  bot.equip = async (item, destination) => {
    if (typeof item === "number") throw new Error("Fixture expects a resolved item.");
    if (item.name === "cobblestone") throw new Error("construction boundary");
    return equip(item, destination);
  };
  return { ...harness, resolvedIds };
}

test("shelter contact does not swing any held vanilla sword beside a neutral Enderman", async () => {
  for (const held of ["wooden_sword", "stone_sword", "golden_sword", "iron_sword", "diamond_sword", "netherite_sword"]) {
    const { bot, clock, server, resolvedIds } = heldWeaponBesideBystander(held, []);
    using _installed = clock.install();
    assert.equal(bot.heldItem?.name, held);
    const result = await clock.settle(hide(bot, resolvedIds, SHORT_HIDE_MS), HIDE_LIMIT_MS);
    assert.deepEqual(attackedIds(server), [], `the ${held}'s sweep would have hit the Enderman`);
    assert.equal(result.swings, 0, held);
  }
});

test("shelter contact does not swing a held item a datapack adds to swords beside a neutral Enderman", async () => {
  const { bot, clock, server, resolvedIds } = heldWeaponBesideBystander("stick", ["stick"]);
  using _installed = clock.install();
  assert.equal(bot.heldItem?.name, "stick");
  const result = await clock.settle(hide(bot, resolvedIds, SHORT_HIDE_MS), HIDE_LIMIT_MS);
  assert.deepEqual(attackedIds(server), [], "the sweep would have hit the Enderman");
  assert.equal(result.swings, 0);
});

test("shelter contact swings a held item outside the swords family beside a neutral Enderman", async () => {
  const { bot, clock, server, resolvedIds } = heldWeaponBesideBystander("stick", []);
  using _installed = clock.install();
  const result = await clock.settle(hide(bot, resolvedIds, SHORT_HIDE_MS), HIDE_LIMIT_MS);
  assert.deepEqual(attackedIds(server), [2]);
  assert.equal(result.swings, 1);
});

test("a stopped physics stream does not prevent hide cancellation", async () => {
  const { bot } = scene({ health: 20, groundY: null });
  bot.entity.onGround = false;
  bot.physicsEnabled = false; // the client runs no tick
  const listening = bot.listenerCount("physicsTick");
  const abort = new AbortController();
  const pending = hideInPlace(bot, {
    signal: abort.signal,
    recoverTo: 18,
    maximumMs: 1000,
    threatContext: {
      ...combatTestContext(bot),
      resolvedIds: new Set(),
      attackerIds: new Set(),
      unreachableIds: new Set(),
    },
  });
  abort.abort(new Error("hide cancelled"));
  await assert.rejects(pending, /hide cancelled/);
  assert.equal(bot.listenerCount("physicsTick"), listening);
});

test("an intruder arriving during centering interrupts steering before construction", async () => {
  let arrived = false;
  const { bot, clock, combat, server } = scene({
    health: 20,
    position: new Vec3(0.5, 64, 0.146),
    carried: { cobblestone: 32 },
    // Starts well outside the shell; the first tick brings it in.
    entities: { 2: { ...closeMob("wither_skeleton"), position: new Vec3(20, 64, 20) } },
    overrides: refuseEquip("placement boundary"),
    simulatePhysics: true,
  });
  const resolvedIds = killableIntruder(bot, 2, 1); // the bot's bare hand kills it; its hit back pushes her away from it (her own hit moves her nowhere)
  onAttack(server, () => combat.hurtBot(1, 2));
  bot.on("physicsTick", () => {
    if (arrived) return;
    arrived = true;
    bot.entities[2]!.position = new Vec3(0.5, 64, 0.9);
  });
  const result = await clock.settle(hide(bot, resolvedIds), HIDE_LIMIT_MS);
  assert.equal(result.swings, 1);
  assert.match(result.error ?? "", /placement boundary/);
});

test("crossing into the dug cell while airborne does not complete shaft descent", async () => {
  let digs = 0;
  const { bot, clock } = scene({
    health: 20,
    overrides: {
      // Scripted: the dig drops the body into the cell, still falling.
      dig: async () => {
        digs++;
        bot.entity.position.y = 63.2;
        bot.entity.onGround = false;
      },
    },
  });
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);
  assert.equal(digs, 1);
  assert.equal(result.kind, "failed");
  assert.equal(result.capped, false);
  assert.match(result.error ?? "", /did not land/);
});

/**
 * Run 14 ended on a fortress walkway: the hide refused its first wall because
 * the cell beside the bot had no solid neighbour, stood down, and the next
 * fireball knocked the bot twenty-two blocks down. The block the bot stands
 * on always has a free side face there, so the floor is extended by one
 * before the wall goes up from it.
 */
test("a wall over a drop is built on a floor extension placed against the bot's own floor block", async () => {
  const { bot, clock } = scene({
    health: 7,
    // A one-wide bridge: the only solid block is the one underfoot.
    groundY: null,
    cells: { "0,63,0": "stone" },
    carried: { cobblestone: 32 },
    overrides: refuseEquip("placement boundary"),
  });
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);

  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /1,63,0/, "the extension cell beside the floor block, not the wall cell above it");
  assert.match(result.error ?? "", /cobblestone against stone face 1,0,0/, "placed against the floor block's side");
});

/**
 * The 2026-09-09 hold: two health, hunger thirteen, nothing to eat, and a
 * ninety-second wait in which the health bar could not move. The hold now says
 * so at once and hands the body back sealed in.
 */
test("a sealed-in bot with nothing to eat and hunger below the regeneration bar is held at once, and says why", async () => {
  const { bot, clock } = scene({ health: 2, food: 13, cells: SEALED_BOX });
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);

  assert.equal(result.kind, "held");
  assert.equal(result.enclosed, true);
  assert.equal(result.ate, null);
  assert.match(result.error ?? "", /no food, and hunger 13 is below the regeneration bar/);
});

const LIQUID_BODIES = [
  ["water", "isInWater"],
  ["lava", "isInLava"],
] as const;

function hideBounded(bot: FakeBot, options: { readonly signal?: AbortSignal; readonly maximumMs: number }) {
  return hideInPlace(bot, {
    threatContext: {
      ...combatTestContext(bot),
      resolvedIds: new Set(),
      attackerIds: new Set(),
      unreachableIds: new Set(),
    },
    signal: options.signal ?? new AbortController().signal,
    recoverTo: 18,
    maximumMs: options.maximumMs,
  });
}

for (const [liquid, flag] of LIQUID_BODIES) {
  test(`hideInPlace in ${liquid} fails at once with [SHELTER]`, async () => {
    let equips = 0;
    const { bot, clock } = scene({
      health: 7,
      carried: { cobblestone: 32 },
      overrides: {
        // Counts the equips: nothing may be dug or placed in a liquid.
        equip: async () => {
          equips += 1;
        },
      },
    });
    Reflect.set(bot.entity, flag, true);
    const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);
    assert.equal(result.kind, "failed");
    assert.match(result.error ?? "", /^\[SHELTER\].*liquid/);
    assert.equal(equips, 0, "nothing is dug or placed in a liquid");
    assert.equal(result.dug + result.walled, 0);
  });
}

test("a sealed-in bot in water is not held in its shelter", async () => {
  const { bot, clock } = scene({ health: 18, cells: SEALED_BOX });
  Reflect.set(bot.entity, "isInWater", true);
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /^\[SHELTER\]/);
});

test("a hide whose body is pushed into water while it waits to land stops at the next pass", async () => {
  const { bot, clock } = scene({ health: 7, carried: { cobblestone: 32 } });
  bot.entity.onGround = false;
  bot.on("physicsTick", () => {
    Reflect.set(bot.entity, "isInWater", true);
  });
  const result = await clock.settle(hideBounded(bot, { maximumMs: 60_000 }), HIDE_LIMIT_MS);
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /^\[SHELTER\]/);
});

test("an intruder that cannot be struck does not starve the event loop", async () => {
  const abort = new AbortController();
  let looks = 0;
  let ticks = 0;
  const { bot, clock } = scene({
    health: 20,
    carried: { cobblestone: 32 },
    // Standing in the shell, inside the stone of its east wall, so the bot's eye cannot see it: shelter contact the bot cannot answer.
    cells: { "1,64,0": "stone", "1,65,0": "stone" },
    entities: { 2: { ...closeMob("wither_skeleton"), position: new Vec3(1.5, 64, 0.5) } },
    overrides: {
      lookAt: async () => {
        // A hide that spins without awaiting a tick never lets the clock below run; stop it so the test fails, not hangs.
        if (++looks > 2_000) abort.abort(new Error("the hide spun without yielding"));
      },
    },
  });
  bot.on("physicsTick", () => {
    ticks += 1;
  });
  let timerFired = false;
  clock.after(100, () => {
    timerFired = true;
    abort.abort(new Error("stopped by the test"));
  });
  const rejected = assert.rejects(hideBounded(bot, { signal: abort.signal, maximumMs: 60_000 }), /stopped by the test/);
  await clock.advance(100);
  await rejected;
  assert.equal(timerFired, true);
  assert.ok(looks <= 5, `${looks} passes ran before the timer at 100 ms`);
  assert.ok(ticks >= 1, "every pass awaits a physics tick");
});

test("an intruder that leaves while the bot turns to it does not stop the shelter being built", async () => {
  const { bot, clock, entities, server } = scene({
    health: 20,
    carried: { cobblestone: 32 },
    entities: { 2: closeMob("wither_skeleton") },
    overrides: {
      ...refuseEquip("placement boundary"),
      // Scripted: the server drops the intruder from her view by the time the look ends.
      lookAt: async () => {
        if (bot.entities[2] !== undefined) entities.remove(2);
      },
    },
  });
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);
  assert.deepEqual(attackedIds(server), [], "nothing was left to attack");
  assert.equal(result.swings, 0);
  assert.match(result.error ?? "", /placement boundary/);
});

test("the construction deadline ends a hide whose body never lands", async () => {
  const { bot, clock } = scene({ health: 7, mockedClock: true });
  using _installed = clock.install();
  bot.entity.onGround = false;
  const started = Date.now();
  const result = await clock.settle(hideBounded(bot, { maximumMs: 40 }), HIDE_LIMIT_MS);
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /The shelter was not finished within \d+ s/);
  assert.ok(Date.now() - started < 500);
});

for (const [direction, wallStepMs] of [["back", -800], ["forward", 1_200]] as const) {
  test(`the construction deadline counts monotonic time: a 3 s hide ends at 3 s though the wall clock stepped ${direction}`, async () => {
    const { bot, clock } = scene({ health: 7, mockedClock: true });
    using _installed = clock.install();
    // Live the two clocks read unrelated values (uptime vs epoch): a deadline taken on the wrong one cannot pass.
    clock.stepWallClock(5_000);
    bot.entity.onGround = false;
    clock.after(1_000, () => clock.stepWallClock(wallStepMs));
    const started = clock.now();
    const result = await clock.settle(hideBounded(bot, { maximumMs: 3_000 }), HIDE_LIMIT_MS);
    assert.equal(result.kind, "failed");
    assert.match(result.error ?? "", /The shelter was not finished within 3 s/);
    const tookMs = clock.now() - started;
    assert.ok(tookMs >= 3_000 && tookMs < 3_200, `the hide ended after ${tookMs} ms of clock, not at its 3000 ms deadline`);
  });
}

test("a hide held while the threat stays keeps its partial shell until the monotonic deadline, though the wall clock is 5 s ahead", async () => {
  const { bot, clock } = scene({ health: 18, cells: SEALED_BOX, carried: { cobblestone: 64, end_stone: 10 }, mockedClock: true });
  using _installed = clock.install();
  // Ordinary stone is no dragon shelter: the walls placed in it never close, so only the hold or the deadline ends the pass.
  clock.stepWallClock(5_000);
  const started = clock.now();
  const result = await clock.settle(hideInPlace(bot, {
    threatContext: combatTestContext(bot), signal: new AbortController().signal,
    recoverTo: 18, maximumMs: 3_000, blockNames: DRAGON_PROTECTION_BLOCKS, holdWhile: () => true,
  }), HIDE_LIMIT_MS);
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /The shelter was not finished within 3 s/);
  const tookMs = clock.now() - started;
  assert.ok(tookMs >= 3_000 && tookMs < 3_200, `the hold ended after ${tookMs} ms of clock, not at its 3000 ms deadline`);
});

test("a stopped physics stream bounds a wait by the monotonic deadline, though the wall clock is 5 s behind", async () => {
  const { bot, clock } = scene({ health: 7, mockedClock: true });
  using _installed = clock.install();
  clock.stepWallClock(-5_000);
  bot.entity.onGround = false;
  bot.physicsEnabled = false; // the client runs no tick
  const started = clock.now();
  const result = await clock.settle(hideBounded(bot, { maximumMs: 3_000 }), HIDE_LIMIT_MS);
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /The shelter was not finished within 3 s/);
  const tookMs = clock.now() - started;
  assert.ok(tookMs >= 3_000 && tookMs < 3_200, `the hide ended after ${tookMs} ms of clock, not at its 3000 ms deadline`);
});

/**
 * The clock moves in slices shorter than a tick: a 0 ms timer (a bound already past) then fires before the next tick, as it
 * does live (a slice of a whole tick delivers the tick first and hides a wait that ended early).
 */
const GUARD_SLICE_MS = 10;

/** A bot with an iron sword and a shield beside a live wither skeleton in its cell column; the hide has `maximumMs` of construction. */
function guardedHide(maximumMs: number) {
  const harness = scene({
    health: 20,
    carried: { iron_sword: 1, shield: 1, cobblestone: 32 },
    entities: { 2: closeMob("wither_skeleton") },
    mockedClock: true,
  });
  const { bot, server } = harness;
  const equip = bot.equip;
  // The tools equip as the game does; only the construction's block is refused, so the hide ends after the contact.
  bot.equip = async (item, destination) => {
    if (typeof item === "number") throw new Error("Fixture expects a resolved item.");
    if (item.name === "cobblestone") throw new Error("construction boundary");
    return equip(item, destination);
  };
  const ticks = { count: 0, shieldRaisedAt: undefined as number | undefined, attackedAt: undefined as number | undefined };
  bot.on("physicsTick", () => void (ticks.count += 1));
  server.onPacket("use_item", () => void (ticks.shieldRaisedAt ??= ticks.count));
  onAttack(server, () => void (ticks.attackedAt ??= ticks.count));
  return { ...harness, ticks, result: () => hide(bot, new Set(), maximumMs) };
}

test("past the construction deadline a shield is still held SHIELD_READY_TICKS before it counts, and the repel swing waits its cooldown", async () => {
  // 1 ms of construction: the first pass starts inside it and the repel's waits all fall after it.
  const { clock, ticks, result } = guardedHide(1);
  using _installed = clock.install();
  await clock.settle(result(), HIDE_LIMIT_MS, GUARD_SLICE_MS);
  assert.ok(ticks.shieldRaisedAt !== undefined && ticks.attackedAt !== undefined, "the shield went up and the swing came");
  assert.ok(ticks.attackedAt - ticks.shieldRaisedAt >= 5, `the swing came ${ticks.attackedAt - ticks.shieldRaisedAt} ticks after the shield went up`);
  // The swing's own cooldown is held before the pass hands back (an iron sword recharges in 12.5 ticks).
  assert.ok(ticks.count - ticks.attackedAt >= 12, `${ticks.count - ticks.attackedAt} ticks after the swing`);
});

test("a guard hold ends at its wall twin when physics stops, not at the construction deadline", async () => {
  const { bot, clock, result } = guardedHide(1);
  using _installed = clock.install();
  bot.physicsEnabled = false; // the client runs no tick
  const started = clock.now();
  await clock.settle(result(), HIDE_LIMIT_MS, GUARD_SLICE_MS);
  const tookMs = clock.now() - started;
  // The shield hold (5 ticks) and the cooldown hold (13) each end at 2 x ticks x 50 ms: 0.5 s and 1.3 s.
  assert.ok(tookMs >= 500 && tookMs <= 2_500, `the hide took ${tookMs} ms of clock with physics stopped`);
});

test("an abort mid-dig stops digging", async () => {
  const abort = new AbortController();
  const { bot, clock, server } = scene({ health: 20 });
  const pending = hideInPlace(bot, {
    threatContext: { ...combatTestContext(bot), resolvedIds: new Set(), attackerIds: new Set(), unreachableIds: new Set() },
    signal: abort.signal,
    recoverTo: 18,
    maximumMs: 60_000,
  });
  const rejected = assert.rejects(pending, /hide cancelled/);
  await clock.advance(1_000);
  assert.ok(bot.targetDigBlock, "the dig is under way (bare hand on stone takes seconds)");
  abort.abort(new Error("hide cancelled"));
  await rejected;
  assert.equal(bot.targetDigBlock, null, "the pending dig ended");
  assert.ok(
    server.packets.some(({ name, data }) => name === "block_dig" && (data as { status: number }).status === 1),
    "the server was told the dig stopped",
  );
});

test("an abort during the look before the dig starts no dig", async () => {
  const abort = new AbortController();
  const { bot, clock, server } = scene({
    health: 20,
    // Scripted: the cancel lands while the bot turns to the shaft cell (the first look of a hide with no intruder).
    overrides: { lookAt: async () => abort.abort(new Error("hide cancelled")) },
  });
  const pending = hideInPlace(bot, {
    threatContext: { ...combatTestContext(bot), resolvedIds: new Set(), attackerIds: new Set(), unreachableIds: new Set() },
    signal: abort.signal,
    recoverTo: 18,
    maximumMs: 60_000,
  });
  await clock.settle(assert.rejects(pending, /hide cancelled/), HIDE_LIMIT_MS);
  assert.equal(
    server.packets.some(({ name, data }) => name === "block_dig" && (data as { status: number }).status === 0),
    false,
    "no dig was started",
  );
});

/** A shaft of `cells` (top first) under a bot standing at (0.5, 64, 0.5) on stone. */
function shaftOf(...cells: FakeCell[]): Record<string, FakeCell> {
  return Object.fromEntries(cells.map((cell, index) => [`0,${63 - index},0`, cell]));
}

test("a first shaft cell that digs slower than the time left fails the hide naming the block and both times", async () => {
  const { bot, clock, server } = scene({ health: 20, cells: shaftOf("deepslate"), mockedClock: true });
  using _installed = clock.install();
  const slow = bot.blockAt(new Vec3(0, 63, 0))!;
  assert.equal(slow.name, "deepslate");
  const digMs = bot.digTime(slow);
  assert.ok(digMs > 2_000, `by hand a deepslate cell takes ${digMs} ms, more than the 2 s left`);
  const result = await clock.settle(hide(bot, new Set(), 2_000), HIDE_LIMIT_MS);
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", new RegExp(`shaft cell deepslate digs in ${(digMs / 1000).toFixed(1)} s, [0-2]\\.\\d s left`));
  assert.equal(result.dug, 0);
  // Status 0 starts a dig; the hide's own item releases are status 5.
  assert.equal(
    server.packets.some(({ name, data }) => name === "block_dig" && (data as { status: number }).status === 0),
    false,
    "no dig was started",
  );
  assert.equal(bot.blockAt(new Vec3(0, 63, 0))!.name, "deepslate");
});

/** A region of `owner` holding the shaft cells from y 60 to 63 under the bot (plan 2026-11-07-p4-06a-threat T5b). */
const shaftRegionOf = (owner: string, topY = 63): ProtectedRegion => ({
  regionId: 4, dimension: "overworld", owner, label: "Tom's cellar", min: { x: -1, y: 58, z: -1 }, max: { x: 1, y: topY, z: 1 },
});
const digsStarted = (server: FakeServer) =>
  server.packets.filter(({ name, data }) => name === "block_dig" && (data as { status: number }).status === 0).length;

test("a foreign-region shaft cell fails the hide and the decision evades", async () => {
  const { bot, clock, server } = scene({ health: 20, cells: shaftOf("dirt"), mockedClock: true });
  setProtectedRegionsProvider(bot, () => [shaftRegionOf("Tom")]);
  using _installed = clock.install();
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);
  assert.equal(result.kind, "failed");
  assert.ok(result.error?.includes(regionRefusalText(shaftRegionOf("Tom"))), result.error);
  assert.match(result.error ?? "", /\(0, 63, 0\)/u, "names the cell");
  assert.equal(result.dug, 0);
  assert.equal(digsStarted(server), 0, "no dig was started");
  assert.equal(bot.blockAt(new Vec3(0, 63, 0))!.name, "dirt");
  // The failed hide is on record (`blocked`): the wounded bot's next answer is to evade.
  const wounded = scene({ health: DEFAULT_COMBAT_POLICY.engage_min_health - 1, entities: { 7: { name: "zombie", kind: "Hostile mobs", metadata: [], position: new Vec3(3.5, 64, 0.5) } } }).bot;
  const directive = observeHostileResponse(wounded, {
    resolvedIds: new Set(), attackerIds: new Set([7]), unreachableIds: new Set(), blockedResponses: new Set(["hide"]),
  });
  assert.equal(directive.kind === "evade" ? directive.reason : directive.kind, "hurt");
});

test("a foreign-region third shaft cell leaves the dug part whole, names the region and the cells already dug", async () => {
  const { bot, clock } = scene({ health: 20, cells: shaftOf("dirt", "dirt", "stone", "stone"), mockedClock: true, simulatePhysics: true });
  setProtectedRegionsProvider(bot, () => [{ ...shaftRegionOf("Tom"), min: { x: -1, y: 58, z: -1 }, max: { x: 1, y: 61, z: 1 } }]);
  using _installed = clock.install();
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);
  assert.equal(result.kind, "failed");
  assert.equal(result.dug, 2, "the two cells outside the region were dug");
  assert.ok(result.error?.includes("inside protected region #4 'Tom's cellar' (owner Tom)"), result.error);
  assert.match(result.error ?? "", /2 shaft cells already dug/);
  assert.equal(bot.blockAt(new Vec3(0, 61, 0))!.name, "stone", "the foreign cell was left whole");
});

test("a shaft in the bot's own region is dug", async () => {
  const { bot, clock } = scene({ health: 20, cells: shaftOf("dirt", "dirt", "dirt"), mockedClock: true, simulatePhysics: true });
  setProtectedRegionsProvider(bot, () => [shaftRegionOf(bot.username)]);
  using _installed = clock.install();
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);
  assert.ok(result.dug >= 1, `dug ${result.dug}: ${result.error ?? ""}`);
});

test("a slow third cell leaves the dug part and names it", async () => {
  const { bot, clock } = scene({
    health: 20,
    cells: shaftOf("dirt", "dirt", "deepslate", "stone"),
    mockedClock: true,
    simulatePhysics: true,
  });
  using _installed = clock.install();
  const result = await clock.settle(hide(bot, new Set(), 6_000), HIDE_LIMIT_MS);
  assert.equal(result.kind, "failed");
  assert.equal(result.dug, 2, "the two quick cells were dug");
  assert.match(result.error ?? "", /shaft cell deepslate digs in \d+\.\d s, \d\.\d s left/);
  assert.match(result.error ?? "", /2 shaft cells already dug/);
  assert.equal(bot.blockAt(new Vec3(0, 61, 0))!.name, "deepslate", "the slow cell was left whole");
});
