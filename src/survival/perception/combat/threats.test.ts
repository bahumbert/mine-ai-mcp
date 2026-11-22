import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { inDefensiveContact } from "./contact.js";
import { CombatPerception } from "./observations.js";
import { Vec3 } from "vec3";
import { DEFAULT_MINECRAFT_VERSION } from "../../../server/config.js";
import { type FakeWorld, createFakeBot, itemOf } from "../../../test-support/fake-bot/index.js";
import type { HostileContext } from "../../control/combat/context.js";
import { observeHostileResponse } from "../../control/combat/observation.js";
import { DEFAULT_COMBAT_POLICY } from "../../policy/combat/contract.js";
import { DEFAULT_SURVIVAL_POLICY } from "../../policy/contract.js";
import { survivalResources } from "../../state/resources.js";
import { responseScope } from "../../control/combat/scopes/response.js";
import { isThreat, observeHostileContact, shouldAvoidEntity, SPIDER_PASSIVE_SKY_LIGHT } from "./threats.js";

interface Mob {
  readonly id: number;
  readonly name: string;
  readonly x: number;
  /** minecraft-data category; defaults to a hostile. */
  readonly kind?: string;
  /** minecraft-data type, which the policy must not rely on. */
  readonly type?: string;
  readonly metadata?: unknown[];
}

test("waiting for contact is distinct from a response constrained by policy", () => {
  const waiting = botWith({ health: 20, mobs: [{ id: 7, name: "zombie", x: 5 }] });
  assert.equal(observeHostileResponse(waiting).kind, "none");
  const contact = botWith({ health: 20, mobs: [{ id: 7, name: "zombie", x: 2 }] });
  const result = observeHostileResponse(contact, context(), {
    ...DEFAULT_COMBAT_POLICY,
    melee: false,
    bow: false,
    shield: false,
    retreat: false,
    hide: "never",
  });
  assert.equal(result.kind, "constrained");
});

/** Midnight; the fixtures that care about the sun say so. */
const NIGHT_TICKS = 18_000;
const NOON_TICKS = 6_000;

const registry = minecraftData(DEFAULT_MINECRAFT_VERSION);
/** The enderman metadata layout of the game's version, as minecraft-data reports it. */
const ENDERMAN_METADATA_KEYS = registry.entitiesByName.enderman!.metadataKeys!;
const CREEPY = ENDERMAN_METADATA_KEYS.indexOf("creepy");

interface SceneOptions {
  readonly health?: number;
  readonly items?: readonly { readonly name: string; readonly count: number }[] | readonly string[];
  readonly mobs?: readonly Mob[];
  /** Defaults to midnight, so a spider is a threat unless a test says otherwise. */
  readonly timeOfDay?: number;
  /** Sky light every cell reports, for the daylight-spider rule. */
  readonly skyLight?: number;
  readonly position?: Vec3;
  /** A stone wall at x=1 between the bot and the mobs further along +x; a low one reaches y=1.5. */
  readonly covered?: boolean | "low_wall";
  /** No ground: every cell is air. */
  readonly air?: boolean;
}

function botWith(options: SceneOptions): Bot {
  return sceneWith(options).bot;
}

/** The bot at the origin on stone, the mobs along +x on its row, and the world to change under them. */
function sceneWith(options: SceneOptions): { bot: Bot; world: FakeWorld } {
  const carried: Record<string, number> = {};
  for (const item of options.items ?? []) {
    const { name, count } = typeof item === "string" ? { name: item, count: 1 } : item;
    carried[name] = (carried[name] ?? 0) + count;
  }
  const { bot, world } = createFakeBot({
    health: options.health ?? 20,
    position: options.position ?? new Vec3(0, 0, 0),
    groundY: options.air ? null : -1,
    carried,
    server: { timeOfDay: options.timeOfDay ?? NIGHT_TICKS },
    entities: Object.fromEntries(
      (options.mobs ?? []).map((mob) => [
        mob.id,
        {
          name: mob.name,
          ...("kind" in mob && { kind: mob.kind }),
          ...(mob.type && { type: mob.type }),
          metadata: mob.metadata ?? [],
          position: { x: mob.x, y: 0, z: 0 },
        },
      ]),
    ),
  });
  if (options.covered) raiseWall(world, options.covered === "low_wall" ? "low" : "full");
  if (options.skyLight !== undefined) lightBySky(bot, options.skyLight);
  return { bot, world };
}

/** A stone wall across x=1, three wide: full (three high) or low (a block and a bottom slab, top at y=1.5). */
function raiseWall(world: FakeWorld, height: "full" | "low" | "none"): void {
  const layers = height === "full" ? ["stone", "stone", "stone"] : height === "low" ? ["stone", "stone_slab", "air"] : ["air", "air", "air"];
  for (const z of [-1, 0, 1]) layers.forEach((block, y) => world.setCell(new Vec3(1, y, z), block));
}

/**
 * Every cell the bot reads reports this sky light. The shared fake answers sky light only for the measured shapes (15 in
 * open air, 0 in a closed box: `fake-world-light.ts`, contract check `light-in-cells`); the threshold levels of the
 * spider rule are between them and unmeasured, so a test sets the level it needs.
 */
function lightBySky(bot: Bot, skyLight: number): void {
  const read = bot.blockAt.bind(bot);
  bot.blockAt = (point, extraInfos) => {
    const block = read(point, extraInfos);
    if (block) block.skyLight = skyLight;
    return block;
  };
}

/** A mob held in a bow-drawing hand, as the server's equipment packet sets it. */
function holdBow(bot: Bot, mob: Bot["entity"]): void {
  mob.setEquipment(0, itemOf(bot.registry, "bow"));
}

/** A piglin's metadata with the named fields set at their 1.21.4 indices. */
function piglinMetadata(fields: Readonly<Record<string, unknown>>): unknown[] {
  const keys = registry.entitiesByName.piglin!.metadataKeys!;
  const metadata: unknown[] = [];
  for (const [key, value] of Object.entries(fields)) metadata[keys.indexOf(key)] = value;
  return metadata;
}

function context(
  options: {
    resolved?: number[];
    attackers?: number[];
    blocked?: string[];
  } = {},
): HostileContext {
  return {
    resolvedIds: new Set(options.resolved),
    attackerIds: new Set(options.attackers),
    blockedResponses: new Set(options.blocked),
  };
}

/** Use the live retained-answer path, not the former unwritten unreachable-id set. */
function observeAfterFailedFight(bot: Bot, options: Parameters<typeof context>[0] = {}) {
  const survival = survivalResources();
  survival.answered.remember(responseScope(bot, () => DEFAULT_SURVIVAL_POLICY, "fight", 7),
    { kind: "unreachable", why: "No route reached the target." });
  return observeHostileResponse(bot, { ...context(options), survival });
}

test("native husks are hostile and defend at melee contact", () => {
  const husk = registry.entitiesByName.husk!;
  const bot = botWith({ mobs: [{ id: 7, name: "husk", x: 2, kind: husk.category }], items: ["iron_sword"] });
  assert.equal(isThreat(bot, bot.entities[7], context()), true);
  assert.equal(observeHostileResponse(bot).kind, "fight");
});

for (const name of ["skeleton", "stray", "bogged"]) {
  test(`${name} bow draw activates defence before a distant first hit`, () => {
    const bot = botWith({ mobs: [{ id: 7, name, x: 13 }], items: ["iron_sword", "shield"] });
    const mob = bot.entities[7]!;
    holdBow(bot, mob);
    assert.equal(observeHostileResponse(bot).kind, "none");
    Reflect.set(mob.metadata, 8, 1);
    Reflect.set(mob, "headYaw", Math.PI / 2);
    mob.pitch = 0;
    assert.equal(observeHostileResponse(bot).kind, "fight");
    assert.equal(observeHostileResponse(bot, context(), { ...DEFAULT_COMBAT_POLICY, engagement: "defend_only" }).kind, "evade");
    const covered = botWith({ covered: true, mobs: [{ id: 7, name, x: 13, metadata: mob.metadata }] });
    holdBow(covered, covered.entities[7]!);
    Reflect.set(covered.entities[7]!, "headYaw", Math.PI / 2);
    covered.entities[7]!.pitch = 0;
    assert.equal(observeHostileResponse(covered).kind, "none");
  });
}

test("aimed bow draws bypass both observation radii, without treating other targets as contact", () => {
  const bot = botWith({ mobs: [{ id: 7, name: "zombie", x: 48 }], items: ["iron_sword", "shield"] });
  const mob = bot.entities[7]!;
  holdBow(bot, mob);
  Reflect.set(mob.metadata, 8, 1);
  Reflect.set(mob, "headYaw", Math.PI / 2);
  mob.pitch = 0;
  using perception = new CombatPerception(bot);
  const seen = { ...context(), perception };
  assert.equal(perception.read()[0]?.distance, 48);
  assert.equal(observeHostileResponse(bot, seen).kind, "fight");
  Reflect.set(mob, "headYaw", -Math.PI / 2);
  bot.emit("physicsTick");
  assert.equal(observeHostileResponse(bot, seen).kind, "none", "head toward another target");
  Reflect.set(mob, "headYaw", Math.PI / 2);
  mob.pitch = Math.PI / 4;
  bot.emit("physicsTick");
  assert.equal(observeHostileResponse(bot, seen).kind, "none", "aim above our body");
  Reflect.deleteProperty(mob, "headYaw");
  mob.pitch = 0;
  bot.emit("physicsTick");
  assert.equal(observeHostileResponse(bot, seen).kind, "none", "missing head direction is not a target observation");
});

for (const name of ["blaze", "skeleton"]) {
  test(`withdrawal evades an observed distant ${name} attacker even at full health`, () => {
    const bot = botWith({ mobs: [{ id: 7, name, x: 20 }], items: ["diamond_sword", "shield"] });
    const threats = context({ attackers: [7] });
    assert.equal(observeHostileResponse(bot, threats).kind, "fight");
    const directive = observeHostileResponse(bot, threats, { ...DEFAULT_COMBAT_POLICY, engagement: "defend_only" });
    assert.equal(directive.kind, "evade");
    if (directive.kind === "evade") assert.equal(directive.reason, "withdraw");
  });
}

test("withdrawal retains emergency shelter and does not invent contact with hidden attackers", () => {
  const options = { mobs: [{ id: 7, name: "blaze", x: 20 }], items: ["diamond_sword", "cobblestone"] };
  assert.equal(
    observeHostileResponse(botWith({ ...options, health: 6 }), context({ attackers: [7] }), {
      ...DEFAULT_COMBAT_POLICY,
      engagement: "defend_only",
    }).kind,
    "hide",
  );
  assert.equal(
    observeHostileResponse(botWith({ ...options, covered: true }), context({ attackers: [7] }), {
      ...DEFAULT_COMBAT_POLICY,
      engagement: "defend_only",
    }).kind,
    "none",
  );
});

test("a wooden sword fights a hostile in contact while above half health", () => {
  const directive = observeHostileResponse(botWith({ items: ["wooden_sword"], mobs: [{ id: 7, name: "zombie", x: 3 }] }));

  assert.equal(directive.kind, "fight");
  if (directive.kind === "fight") assert.equal(directive.targetId, 7);
});

test("a melee mob across a ledge cannot turn a journey into a hunt, even after an earlier hit", () => {
  const bot = botWith({ mobs: [{ id: 7, name: "magma_cube", x: 3 }] });
  bot.entities[7]!.position.y = -5;
  assert.deepEqual(observeHostileResponse(bot, context({ attackers: [7] })), { kind: "none" });
  bot.entities[7]!.position.y = 0;
  assert.equal(observeHostileResponse(bot).kind, "evade", "unmeasured cube damage refuses an automatic fight");
  bot.entities[7]!.position.x = 6;
  assert.equal(observeHostileResponse(bot).kind, "none");
  bot.health = 11;
  assert.equal(observeHostileResponse(bot).kind, "evade", "wounded avoidance retains its earlier warning range");
});

test("a jumping cube retains defensive contact before descending into swing reach", () => {
  const { bot, world } = sceneWith({ mobs: [{ id: 7, name: "magma_cube", x: 2 }], air: true });
  const cube = bot.entities[7]!;
  cube.position.y = 6;
  assert.equal(observeHostileResponse(bot).kind, "evade", "airborne contact still responds; unmeasured damage refuses a fight");
  world.setCell(cube.position.offset(0, -1, 0), "stone");
  assert.equal(
    observeHostileResponse(bot).kind,
    "none",
    "a mob standing on an overhead ledge must not lock out travel",
  );
});

test("a blaze hovering above reach is not in defensive contact where a jumping cube is (plan 2026-11-18-scenario-reds-part2-a10 T13z)", () => {
  // The hold under a hovering body is the melee turn's own; contact, and every decision that reads it, stays as it was.
  const { bot } = sceneWith({ mobs: [{ id: 7, name: "blaze", x: 1 }, { id: 8, name: "magma_cube", x: 1 }], air: true });
  const blaze = bot.entities[7]!, cube = bot.entities[8]!;
  blaze.position.y = cube.position.y = 6;
  assert.equal(inDefensiveContact(bot, cube), true, "the cube over open cells above reach: the pinned contact");
  assert.equal(inDefensiveContact(bot, blaze), false, "the same geometry for a blaze: not contact");
  blaze.position.y = 2;
  assert.equal(inDefensiveContact(bot, blaze), true, "a blaze within reach is contact");
});

test("closed cover prevents contact even with a previous attacker or critically low health", () => {
  for (const health of [20, 7]) {
    const bot = botWith({ health, covered: true, mobs: [{ id: 7, name: "blaze", x: 5 }] });
    assert.deepEqual(observeHostileResponse(bot, context({ attackers: [7] })), { kind: "none" });
    assert.equal(observeHostileContact(bot).length, 1, "status still reports the nearby hostile behind cover");
  }
});

test("opening cover makes the same nearby hostile eligible immediately", () => {
  const { bot, world } = sceneWith({ items: ["diamond_sword"], covered: true, mobs: [{ id: 7, name: "blaze", x: 5 }] });
  assert.deepEqual(observeHostileResponse(bot), { kind: "none" });
  raiseWall(world, "none");
  assert.equal(observeHostileResponse(bot).kind, "fight");
});

test("a low wall that leaves the hostile's head exposed does not prevent contact", () => {
  const bot = botWith({ items: ["wooden_sword"], covered: "low_wall", mobs: [{ id: 7, name: "skeleton", x: 5 }] });
  assert.equal(observeHostileResponse(bot).kind, "fight");
});

test("fights a crowd one body at a time, nearest first", () => {
  const directive = observeHostileResponse(
    botWith({
      mobs: [
        { id: 8, name: "zombie", x: 3 },
        { id: 7, name: "zombie", x: 2 },
        { id: 9, name: "zombie", x: 12 },
      ],
    }),
    context(), { ...DEFAULT_COMBAT_POLICY, fight_margin: 0 },
  );

  // Target ordering is independent of the policy's required advantage.
  assert.equal(directive.kind, "fight");
  if (directive.kind !== "fight") return;
  assert.equal(directive.targetId, 7);
  assert.deepEqual(
    directive.threats.map((threat) => threat.id),
    [7, 8, 9],
  );
});

test("names the next target once the first is resolved", () => {
  const bot = botWith({
    items: ["wooden_sword"],
    mobs: [
      { id: 7, name: "zombie", x: 2 },
      { id: 8, name: "zombie", x: 3 },
    ],
  });

  const directive = observeHostileResponse(bot, context({ resolved: [7] }));

  assert.equal(directive.kind === "fight" ? directive.targetId : directive.kind, 8);
});

test("recognises hostiles by minecraft-data category, not by the narrower entity type", () => {
  for (const [name, type, response] of [
    ["phantom", "mob", "fight"],
    ["slime", "mob", "evade"],
    ["ghast", "mob", "fight"],
    ["hoglin", "animal", "evade"],
    ["witch", "hostile", "fight"],
  ] as const) {
    const directive = observeHostileResponse(botWith({ items: ["diamond_sword"], mobs: [{ id: 7, name, type, x: 3 }] }));

    assert.equal(directive.kind, response, `expected a hostile response to ${name}`);
  }
});

test("leaves an enderman alone until it turns on the bot", () => {
  const calm = observeHostileResponse(botWith({ mobs: [{ id: 7, name: "enderman", x: 4 }] }));
  const angryMetadata: unknown[] = [];
  angryMetadata[CREEPY] = true;
  const angry = observeHostileResponse(botWith({ mobs: [{ id: 7, name: "enderman", x: 4, metadata: angryMetadata }] }));
  const struckBack = observeHostileResponse(
    botWith({ items: ["diamond_sword"], mobs: [{ id: 7, name: "zombified_piglin", x: 3 }] }),
    context({ attackers: [7] }),
  );

  assert.deepEqual(calm, { kind: "none" });
  assert.equal(angry.kind, "none");
  assert.equal(struckBack.kind, "fight");
});

/**
 * Piglins are filed as hostile mobs, but hitting one turns every piglin that
 * can see it, and a baby piglin never attacks anybody at all. Mineflayer names
 * adults and babies alike `piglin`, so the policy cannot tell them apart and
 * must not open the fight.
 *
 * Observed live on 2026-09-04: the bot walked into the Nether, closed on two
 * piglins that had not touched it, killed both without taking a scratch, and
 * angered a bastion holding forty-eight piglins and twelve brutes.
 */
test("leaves a piglin alone until it turns on the bot", () => {
  const calm = observeHostileResponse(botWith({ mobs: [{ id: 7, name: "piglin", x: 3 }] }));
  const struckBack = observeHostileResponse(
    botWith({ items: ["wooden_sword"], mobs: [{ id: 7, name: "piglin", x: 3 }] }),
    context({ attackers: [7] }),
  );

  assert.deepEqual(calm, { kind: "none" }, "a piglin minding its own business is not a target");
  assert.equal(struckBack.kind, "fight", "a piglin that attacks is fought");
});

test("leaves passive mobs and players alone", () => {
  const directive = observeHostileResponse(
    botWith({
      mobs: [
        { id: 7, name: "cow", kind: "Passive mobs", type: "animal", x: 3 },
        { id: 8, name: "player", kind: undefined, type: "player", x: 2 },
      ],
    }),
  );

  assert.deepEqual(directive, { kind: "none" });
});

test("a hostile that has hurt the bot is in contact from beyond the contact range", () => {
  const directive = observeHostileResponse(
    botWith({ items: ["wooden_sword"], mobs: [{ id: 7, name: "skeleton", x: 13 }] }),
    context({ attackers: [7] }),
  );

  assert.equal(directive.kind === "fight" ? directive.targetId : directive.kind, 7);
});

test("targets the nearest hostile in contact, not merely the nearest hostile", () => {
  const directive = observeHostileResponse(
    botWith({
      items: ["wooden_sword"],
      mobs: [
        { id: 7, name: "zombie", x: 10 },
        { id: 8, name: "skeleton", x: 14 },
      ],
    }),
    context({ attackers: [8] }),
  );

  assert.equal(directive.kind === "fight" ? directive.targetId : directive.kind, 8);
});

test("explosive equipment answers account for the crowd and observation range", () => {
  const creeper = { id: 8, name: "creeper", x: 6 };
  const pair = [creeper, { id: 9, name: "creeper", x: 7 }];
  const cases: { name: string; items: string[]; mobs: Mob[]; result: string; ids?: number[] }[] = [
    { name: "unarmed mixed crowd", items: [], mobs: [{ id: 7, name: "zombie", x: 2 }, creeper],
      result: "explosive", ids: [7, 8] },
    { name: "sword against one explosive", items: ["iron_sword"], mobs: [creeper], result: "fight" },
    { name: "bow alone", items: ["bow", "arrow"], mobs: [creeper], result: "explosive" },
    { name: "pair without ranged equipment", items: ["iron_sword"], mobs: pair,
      result: "explosive", ids: [8, 9] },
    { name: "pair with ranged equipment", items: ["iron_sword", "bow", "arrow"], mobs: pair, result: "fight" },
    { name: "second explosive inside observation range", items: ["iron_sword"],
      mobs: [creeper, { ...pair[1]!, x: 12 }], result: "explosive" },
    { name: "second explosive beyond observation range", items: ["iron_sword"],
      mobs: [creeper, { ...pair[1]!, x: 20 }], result: "fight" },
  ];
  for (const row of cases) {
    const directive = observeHostileResponse(botWith(row));
    assert.equal(directive.kind === "evade" ? directive.reason : directive.kind, row.result, row.name);
    if (row.ids) assert.deepEqual(directive.kind === "evade" ? directive.threats.map((threat) => threat.id) : directive,
      row.ids, row.name);
  }
});

test("a creeper in a crowd is fought last: the zombie behind it is the target", () => {
  const directive = observeHostileResponse(
    botWith({
      items: ["iron_sword"],
      mobs: [
        { id: 8, name: "creeper", x: 4 },
        { id: 9, name: "zombie", x: 3 },
      ],
    }),
  );
  assert.equal(directive.kind === "fight" ? directive.targetId : directive, 9);

  // Out of contact, the zombie does not yet count; the creeper is the fight.
  const strungOut = observeHostileResponse(
    botWith({
      items: ["iron_sword"],
      mobs: [
        { id: 8, name: "creeper", x: 4 },
        { id: 9, name: "zombie", x: 12 },
      ],
    }),
  );
  assert.equal(strungOut.kind === "fight" ? strungOut.targetId : strungOut, 8);
});

test("a creeper outside contact range does not change a fight", () => {
  const directive = observeHostileResponse(
    botWith({
      items: ["wooden_sword"],
      mobs: [
        { id: 7, name: "zombie", x: 2 },
        { id: 8, name: "creeper", x: 12 },
      ],
    }),
  );

  assert.equal(directive.kind, "fight");
});

test("evades a target no route reached instead of walking back into its fire", () => {
  const directive = observeAfterFailedFight(
    botWith({ items: ["wooden_sword"], mobs: [{ id: 7, name: "skeleton", x: 11 }] }),
    { attackers: [7] },
  );

  assert.equal(directive.kind === "evade" ? directive.reason : directive.kind, "unreachable");
});

test("a covered close blaze retains its failed approach when it moves into distant view", () => {
  const { bot } = sceneWith({ covered: true, items: ["diamond_sword"], mobs: [{ id: 7, name: "blaze", x: 2 }] });
  const survival = survivalResources();
  survival.answered.remember(responseScope(bot, () => DEFAULT_SURVIVAL_POLICY, "fight", 7),
    { kind: "unreachable", why: "No route reached the target." },
    { premise: "unreachable", ticks: 600, why: "Earlier approach stopped." });
  const seen = { ...context({ attackers: [7] }), survival };
  assert.notEqual(observeHostileResponse(bot, seen).kind, "fight");
  assert.equal(survival.answered.snapshot().length, 1);
  bot.entities[7]!.position = new Vec3(0, 0, 6);
  const next = observeHostileResponse(bot, seen);
  assert.equal(next.kind === "evade" ? next.reason : next.kind, "unreachable");
});

test("the same formerly unreachable blaze in reach, bare hands: evade outmatched", () => {
  const directive = observeAfterFailedFight(botWith({ mobs: [{ id: 7, name: "blaze", x: 2 }] }),
    { attackers: [7] });
  assert.equal(directive.kind === "evade" ? directive.reason : directive.kind, "outmatched");
});

test("wounded bare hands evade zombie and attacking enderman as outmatched before or after failed hide", () => {
  const metadata = Array.from(ENDERMAN_METADATA_KEYS, (_, index) => index === CREEPY);
  for (const name of ["zombie", "enderman"]) for (const hideAnswered of [false, true]) {
    // A failed slow-shaft attempt is represented by the same blocked hide answer.
    const bot = botWith({ health: DEFAULT_COMBAT_POLICY.engage_min_health - 1,
      mobs: [{ id: 7, name, x: name === "enderman" ? 4 : 3, metadata: name === "enderman" ? metadata : [] }] });
    const directive = observeHostileResponse(bot, context({
      attackers: name === "enderman" || hideAnswered ? [7] : [], blocked: hideAnswered ? ["hide"] : [],
    }));
    assert.deepEqual(directive.kind === "evade"
      ? { reason: directive.reason, ids: directive.threats.map((threat) => threat.id) } : directive,
      { reason: "outmatched", ids: [7] }, `${name}, hide answered: ${hideAnswered}`);
  }
});

test("enderman shelter does not change healthy fights, neutral encounters, or distant observation", () => {
  const metadata = Array.from(ENDERMAN_METADATA_KEYS, (_, index) => index === CREEPY);
  const angry = { id: 7, name: "enderman", x: 4, metadata };
  assert.equal(
    observeHostileResponse(
      botWith({ health: DEFAULT_COMBAT_POLICY.engage_min_health, mobs: [angry] }),
      context({ attackers: [7] }), { ...DEFAULT_COMBAT_POLICY, fight_margin: 0 },
    ).kind,
    "fight",
  );
  assert.equal(observeHostileResponse(botWith({ health: 11, mobs: [{ id: 7, name: "enderman", x: 4 }] })).kind, "none");

  const distant = observeHostileResponse(
    botWith({
      health: 11,
      mobs: [
        { ...angry, x: 12 },
        { id: 8, name: "zombie", x: 2 },
      ],
    }),
  );
  assert.equal(distant.kind === "evade" ? distant.reason : distant.kind, "outmatched");
});

test("wounded enderman shelter preserves creeper and unreachable priorities", () => {
  const metadata = Array.from(ENDERMAN_METADATA_KEYS, (_, index) => index === CREEPY);
  const angry = { id: 7, name: "enderman", x: 4, metadata };
  for (const items of [[], ["iron_sword"]]) {
    const creeper = observeHostileResponse(
      botWith({
        health: 11,
        items,
        mobs: [angry, { id: 8, name: "creeper", x: 4 }, { id: 9, name: "creeper", x: 12 }],
      }),
    );
    assert.equal(creeper.kind === "evade" ? creeper.reason : creeper.kind, "explosive");
  }

  const unreachable = observeAfterFailedFight(
    botWith({ health: 11, items: ["bow", "arrow"], mobs: [angry] }),
    { attackers: [7] },
  );
  assert.equal(unreachable.kind === "evade" ? unreachable.reason : unreachable.kind, "unreachable");
});

test("an iron sword still fights at exactly the half-health threshold", () => {
  const directive = observeHostileResponse(
    botWith({ health: DEFAULT_COMBAT_POLICY.engage_min_health, items: ["iron_sword"], mobs: [{ id: 7, name: "zombie", x: 3 }] }),
  );

  assert.equal(directive.kind, "fight");
});

test("evades every observed threat as one aggregate response", () => {
  const directive = observeHostileResponse(
    botWith({
      health: 10,
      mobs: [
        { id: 7, name: "zombie", x: 3 },
        { id: 8, name: "zombie", x: 12 },
        { id: 9, name: "zombie", x: 20 },
      ],
    }),
  );

  assert.deepEqual(
    directive.kind === "evade"
      ? { ids: directive.threats.map((threat) => threat.id), safeRange: directive.safeRange }
      : directive,
    { ids: [7, 8], safeRange: DEFAULT_COMBAT_POLICY.evade_safe_range },
  );
});

test("hides instead of running below the hide bar", () => {
  const directive = observeHostileResponse(
    botWith({
      health: DEFAULT_COMBAT_POLICY.critical_health - 1,
      mobs: [
        { id: 7, name: "zombie", x: 3 },
        { id: 8, name: "skeleton", x: 12 },
      ],
    }),
  );

  assert.deepEqual(
    directive.kind === "hide"
      ? { reason: directive.reason, ids: directive.threats.map((threat) => threat.id) }
      : directive,
    { reason: "hurt", ids: [7, 8] },
  );
});

test("under the hide bar a hostile merely in sight is reason enough to dig in", () => {
  const directive = observeHostileResponse(
    botWith({ health: DEFAULT_COMBAT_POLICY.critical_health - 1, mobs: [{ id: 7, name: "skeleton", x: 14 }] }),
  );

  assert.equal(directive.kind, "hide");
});

test("hides when the last evade could not get away, whatever the health", () => {
  const directive = observeHostileResponse(
    botWith({ health: 20, mobs: [{ id: 7, name: "zombie", x: 3 }] }),
    context({ blocked: ["evade"] }),
  );

  assert.equal(directive.kind, "hide");
  if (directive.kind === "hide") assert.equal(directive.reason, "cornered");
});

/**
 * A spider is a hostile by Mineflayer's category at every hour, and vanilla
 * only sends it at anything in the dark. On 2026-09-04 a passive spider
 * standing in the open at fifteen blocks kept the hide trigger armed through
 * an entire morning, from which the bot never recovered.
 */
test("a spider in daylight is left alone; the same spider at night is a threat", () => {
  const spider = [{ id: 7, name: "spider", x: 3 }] as const;
  const daylight = observeHostileResponse(
    botWith({ mobs: spider, timeOfDay: NOON_TICKS, skyLight: SPIDER_PASSIVE_SKY_LIGHT }),
  );
  const dusk = observeHostileResponse(botWith({ items: ["wooden_sword"], mobs: spider, timeOfDay: NIGHT_TICKS, skyLight: 15 }));
  // Noon underground: the clock says day and the cell is unlit, so it hunts.
  const cave = observeHostileResponse(
    botWith({ items: ["wooden_sword"], mobs: spider, timeOfDay: NOON_TICKS, skyLight: SPIDER_PASSIVE_SKY_LIGHT - 1 }),
  );
  const provoked = observeHostileResponse(
    botWith({ items: ["wooden_sword"], mobs: spider, timeOfDay: NOON_TICKS, skyLight: 15 }),
    context({ attackers: [7] }),
  );

  assert.deepEqual(daylight, { kind: "none" }, "a spider in the sun is not a threat");
  assert.equal(dusk.kind, "fight");
  assert.equal(cave.kind, "fight");
  assert.equal(provoked.kind, "fight", "a spider that bit the bot is fought whatever the sun is doing");
});

/**
 * The livelock of 2026-09-04: below the hide bar with a hide that could not be
 * built, the policy chose the same hide every tick, and each choice claimed
 * the body and cancelled the model's way out.
 */
test("a hide that failed here is not chosen again until something has changed", () => {
  const mobs = [{ id: 7, name: "zombie", x: 3 }];
  const options = {
    health: DEFAULT_COMBAT_POLICY.critical_health - 1,
    mobs,
    items: [{ name: "cobblestone", count: 16 }],
  };
  const bot = botWith(options);

  assert.equal(observeHostileResponse(bot, context()).kind, "hide", "the first hide is chosen");
  assert.deepEqual(
    observeHostileResponse(bot, context({ blocked: ["hide"] })),
    {
      kind: "evade",
      threats: observeHostileContact(bot, context()),
      safeRange: DEFAULT_COMBAT_POLICY.evade_safe_range,
      reason: "hurt",
    },
    "another permitted response can be chosen without repeating hide",
  );
});

/**
 * Standing still is the better answer only while nothing is landing. The plan
 * that introduced the stand-down said so outright: being hit where the bot
 * stands is worse than the worst evade.
 */
test("damage re-arms the run even with a failed hide on record", () => {
  const mobs = [{ id: 7, name: "zombie", x: 3 }];
  const options = { health: DEFAULT_COMBAT_POLICY.critical_health - 1, mobs };
  const bot = botWith(options);

  const ignored = observeHostileResponse(bot, context({ blocked: ["hide"] }));
  const bitten = observeHostileResponse(bot, context({ blocked: ["hide"], attackers: [7] }));

  assert.equal(ignored.kind, "evade");
  assert.deepEqual(
    bitten.kind === "evade" ? { reason: bitten.reason, ids: bitten.threats.map((threat) => threat.id) } : bitten,
    {
      reason: "hurt",
      ids: [7],
    },
  );
});

test("a failed hide is not the answer to a failed evade either", () => {
  const mobs = [{ id: 7, name: "zombie", x: 3 }];
  const bot = botWith({ health: 20, mobs, items: ["iron_sword"] });

  const cornered = observeHostileResponse(bot, context({ blocked: ["evade"] }));
  const spent = observeHostileResponse(bot, context({ blocked: ["evade", "hide"] }));

  assert.equal(cornered.kind, "hide");
  // Healthy and out of holes: back to fighting rather than digging the hole
  // that already refused to be dug.
  assert.equal(spent.kind, "fight");
});

test("ignores a resolved target while its dying entity is still loaded", () => {
  const directive = observeHostileResponse(
    botWith({ mobs: [{ id: 7, name: "zombie", x: 3 }] }),
    context({ resolved: [7] }),
  );

  assert.deepEqual(directive, { kind: "none" });
});

test("does not respond before a hostile enters contact range", () => {
  const directive = observeHostileResponse(botWith({ mobs: [{ id: 7, name: "zombie", x: 9 }] }));

  assert.deepEqual(directive, { kind: "none" });
});

for (const health of [20, 10, 6]) {
  test(`an observed distant blaze attacker remains eligible at health ${health}`, () => {
    const bot = botWith({ health, items: ["iron_sword", "cobblestone"], mobs: [{ id: 7, name: "blaze", x: 28 }] });
    assert.equal(observeHostileResponse(bot).kind, "none", "a distant unprovoked mob remains outside passive contact");
    const observed = context({ attackers: [7] });
    assert.notEqual(observeHostileResponse(bot, observed).kind, "none");
    assert.deepEqual(
      observeHostileContact(bot, observed).map((threat) => threat.id),
      [7],
    );
    assert.equal(observeHostileResponse(bot, context({ attackers: [7], resolved: [7] })).kind, "none");
    const covered = botWith({ health, covered: true, mobs: [{ id: 7, name: "blaze", x: 28 }] });
    assert.equal(observeHostileResponse(covered, observed).kind, "none", "existing cover still ends contact");
  });
}

test("observed aggressive piglin remains subject to contact and exposure", () => {
  const mob = { id: 7, name: "piglin", x: 3, metadata: piglinMetadata({ mob_flags: 4 }) };
  const bot = botWith({ items: ["wooden_sword"], mobs: [mob] });
  assert.equal(isThreat(bot, bot.entities[7], context()), false);
  assert.equal(shouldAvoidEntity(bot, bot.entities[7], context()), true);
  const response = observeHostileResponse(bot);
  assert.equal(response.kind, "evade");
  if (response.kind === "evade") assert.equal(response.reason, "observed_aggression");
  assert.equal(observeHostileResponse(bot, context({ attackers: [7] })).kind, "fight");
  assert.equal(observeHostileResponse(botWith({ health: 6, mobs: [mob] })).kind, "hide");
  for (const flags of [undefined, 0, 1, 2, "4"]) {
    assert.equal(observeHostileResponse(botWith({ mobs: [{ ...mob, metadata: piglinMetadata({ mob_flags: flags }) }] })).kind, "none");
  }
  assert.equal(observeHostileResponse(botWith({ mobs: [{ ...mob, metadata: piglinMetadata({ mob_flags: 0, baby: true }) }] })).kind, "none");
  assert.equal(observeHostileResponse(botWith({ mobs: [{ ...mob, x: 20 }] })).kind, "none");
  assert.equal(observeHostileResponse(botWith({ mobs: [mob], covered: true })).kind, "none");
});

test("wounded unguarded ranged contact seeks shelter, retaining guarded and failed-build escapes", () => {
  for (const name of ["blaze", "skeleton"]) {
    const bot = botWith({ health: 10, items: ["diamond_sword", "cobblestone", "bow", "arrow"], mobs: [{ id: 7, name, x: 10 }] });
    if (name === "skeleton") holdBow(bot, bot.entities[7]!);
    const seen = context({ attackers: [7] });
    assert.equal(observeHostileResponse(bot, seen).kind, "hide", name);
    assert.equal(
      observeAfterFailedFight(bot, { attackers: [7] }).kind,
      "evade",
      "a retained fight answer uses the unanswered escape",
    );
    assert.equal(
      observeHostileResponse(bot, context({ attackers: [7], blocked: ["hide"] })).kind,
      "evade",
      "construction refusal retains the escape fallback",
    );
    const guarded = botWith({ health: 10, items: ["diamond_sword", "shield"], mobs: [{ id: 7, name, x: 10 }] });
    if (name === "skeleton") holdBow(guarded, guarded.entities[7]!);
    assert.equal(observeHostileResponse(guarded, seen).kind, "evade", "a carried shield preserves guarded travel");
  }
});

test("an existing burn needs recovery even when a shield can block future ranged hits", () => {
  for (const name of ["blaze", "skeleton"]) {
    const bot = botWith({
      health: 10,
      items: ["shield", "diamond_sword", "cobblestone", "bow", "arrow"],
      mobs: [{ id: 7, name, x: 10 }],
    });
    if (name === "skeleton") holdBow(bot, bot.entities[7]!);
    bot.entity.metadata = [];
    const flags = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("shared_flags");
    Reflect.set(bot.entity.metadata, flags, 1);
    assert.equal(observeHostileResponse(bot, context({ attackers: [7] })).kind, "hide");
    Reflect.set(bot.entity.metadata, flags, 0);
    assert.equal(observeHostileResponse(bot, context({ attackers: [7] })).kind, "evade");
  }
});

test("an Enderman angry at an unknown victim never authorizes attack or shelter", () => {
  const metadata: unknown[] = [];
  metadata[CREEPY] = true;
  for (const health of [20, 11, 4]) {
    const bot = botWith({ health, mobs: [{ id: 7, name: "enderman", x: 2, metadata }] });
    assert.equal(isThreat(bot, bot.entities[7], context()), false);
    assert.equal(shouldAvoidEntity(bot, bot.entities[7], context()), false);
    assert.deepEqual(observeHostileResponse(bot), { kind: "none" });
    assert.notEqual(observeHostileResponse(bot, context({ attackers: [7] })).kind, "none");
  }
});

test("angry head attention starts defense before a hit, not body orientation or anger alone", () => {
  for (const health of [20, 11, 4]) {
    const metadata: unknown[] = [];
    metadata[CREEPY] = true;
    const bot = botWith({ health, mobs: [{ id: 7, name: "enderman", x: 6, metadata }] });
    const mob = bot.entities[7]!;
    mob.yaw = -Math.PI / 2; // Body away, head toward this bot.
    Reflect.set(mob, "headYaw", Math.PI / 2);
    mob.pitch = Math.atan2(1.62 - 2.55, 6);
    assert.equal(isThreat(bot, mob, context()), true);
    assert.notEqual(observeHostileResponse(bot).kind, "none");
    Reflect.set(mob, "headYaw", -Math.PI / 2);
    mob.yaw = Math.PI / 2;
    assert.equal(isThreat(bot, mob, context()), false, "head aimed at someone else");
    assert.equal(observeHostileResponse(bot).kind, "none");
    assert.equal(isThreat(bot, mob, context({ attackers: [7] })), true, "known attacker briefly turning");
    Reflect.set(mob, "headYaw", Math.PI / 2);
    mob.pitch = Math.PI / 4;
    assert.equal(isThreat(bot, mob, context()), false, "looking above us at a flying target");
    mob.pitch = Math.atan2(1.62 - 2.55, 6) + (2 * Math.PI) / 256;
    assert.equal(isThreat(bot, mob, context()), true, "packet angle quantisation");
    metadata[CREEPY] = false;
    assert.equal(isThreat(bot, mob, context()), false, "calm eye contact");
  }
});
