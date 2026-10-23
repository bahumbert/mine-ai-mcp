import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { attackedIds, combatTestContext, onAttack } from "../../test-support/combat.js";
import {
  type FakeBot,
  type FakeBotOptions,
  type FakeCell,
  type FakeEntitySpec,
  createFakeBot,
  createFakeClock,
} from "../../test-support/fake-bot/index.js";
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
  /** The hide reads `Date.now` and `setTimeout` for its deadline: a test about that installs this clock (`using`). */
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

function hide(bot: FakeBot): ReturnType<typeof hideInPlace> {
  return hideInPlace(bot, {
    threatContext: {
      ...combatTestContext(bot),
      resolvedIds: new Set(),
      attackerIds: new Set(),
      unreachableIds: new Set(),
    },
    signal: new AbortController().signal,
    recoverTo: 18,
    maximumMs: DEFAULT_COMBAT_POLICY.recovery_timeout_ms,
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

test("hide repels an authorized intruder before building and uses the observed landing cell", async () => {
  let attacks = 0;
  const { bot, clock, server } = scene({
    health: 20,
    carried: { cobblestone: 32 },
    entities: { 2: closeMob("wither_skeleton") },
    overrides: refuseEquip("placement boundary"),
  });
  // The fake models no knockback (runtime-pitfalls "Fights"): as the strike is written, the test moves the mob away and the bot into the next cell, as the server's velocity would.
  onAttack(server, () => {
    attacks++;
    bot.entities[2]!.position.x = 10;
    bot.entity.position.x = 3.5;
  });
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);
  assert.equal(attacks, 1);
  assert.equal(result.swings, 1);
  assert.match(result.error ?? "", /4,64,0/);
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
  const { bot, clock, server, entities } = scene({
    health: 20,
    carried: { iron_sword: 1, iron_pickaxe: 1, shield: 1, cobblestone: 32 },
    entities: {
      2: closeMob("wither_skeleton"),
      3: { ...closeMob("enderman"), position: new Vec3(2, 64, 0.5) },
    },
  });
  const intruder = bot.entities[2]!;
  const bystander = bot.entities[3]!;
  // The first use request the server receives is the shield's.
  server.onPacket("use_item", () => {
    raisedAt ??= ticks;
  });
  // Not on the shared fake: the damage of an iron pickaxe (no check measured it; the fake throws for it). The intruder is gone as the strike is written. Asked of the master: a contract check for the pickaxe.
  onAttack(server, (target) => {
    assert.equal(target, intruder.id);
    assert.equal(bot.heldItem?.name, "iron_pickaxe");
    assert.equal(bot.usingHeldItem, true);
    assert.ok(raisedAt !== undefined && ticks - raisedAt >= 5);
    entities.remove(intruder.id);
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
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);
  assert.equal(result.swings, 1);
  assert.equal(bystander.isValid, true);
  assert.equal(bot.usingHeldItem, false, "the construction owner releases its shield on settlement");
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
  const { bot, clock, server, entities } = scene({
    health: 20,
    position: new Vec3(0.5, 64, 0.146),
    carried: { cobblestone: 32 },
    // Starts well outside the shell; the first tick brings it in.
    entities: { 2: { ...closeMob("wither_skeleton"), position: new Vec3(20, 64, 20) } },
    overrides: refuseEquip("placement boundary"),
  });
  // The strike drives the intruder off and the bot back to the middle of its cell, as the server's velocity would.
  onAttack(server, () => {
    entities.remove(2);
    bot.entity.position.z = 0.5;
  });
  bot.on("physicsTick", () => {
    if (arrived) return;
    arrived = true;
    bot.entities[2]!.position = new Vec3(0.5, 64, 0.9);
  });
  const result = await clock.settle(hide(bot), HIDE_LIMIT_MS);
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
  const { bot, clock, server } = scene({
    health: 20,
    carried: { cobblestone: 32 },
    entities: { 2: closeMob("wither_skeleton") },
    overrides: {
      ...refuseEquip("placement boundary"),
      // Scripted: the intruder is gone by the time the look ends.
      lookAt: async () => {
        delete bot.entities[2];
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

test("the construction deadline runs on the wall clock when the physics stream has stopped", async () => {
  const { bot, clock } = scene({ health: 7, mockedClock: true });
  using _installed = clock.install();
  bot.entity.onGround = false;
  bot.physicsEnabled = false; // the client runs no tick
  const started = Date.now();
  const result = await clock.settle(hideBounded(bot, { maximumMs: 40 }), HIDE_LIMIT_MS);
  assert.equal(result.kind, "failed");
  assert.match(result.error ?? "", /The shelter was not finished within \d+ s/);
  assert.ok(Date.now() - started < 500);
});
