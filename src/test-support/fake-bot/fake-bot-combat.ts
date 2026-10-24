/**
 * The fake server's fights (contract checks `attack-hurts-and-kills`, `attack-cooldown-damage`, `attack-out-of-reach`,
 * `damage-event-to-bot`, `explosion-knockback`, Mine Labs 1.21.4, 2026-10-23). A hit (`use_entity`, mouse 1: the packet
 * `attack` writes) on a creature in reach costs it the held weapon's damage at the swing's strength; the creature keeps a
 * hurt window; each hurt is one `damage_event` (Mineflayer's `entityHurt(victim, source)`) and the health in the creature's
 * metadata a tick later; at 0 it dies (`entity_status` 3, `entityDead`) and leaves the client after its death animation.
 * Scene controls (`FakeHarness.combat`) are what other actors do. Mineflayer's handlers of these packets are not installed
 * on the fake client, so each send also runs the handler's effect (`entities.js:398-402` for `damage_event`, `:385-395` for
 * `entity_status`, `health.js` for `update_health`, `physics.js:314-326` for `explosion`).
 * Not modelled: a hit's knockback on a mob, the weapon's durability, critical and sweeping hits, armor (a fixture mob has none),
 * absorption hearts, the bot's natural regeneration, the difficulty's scaling of a mob's attack (the amount given to `hurtBot` is final), a blast
 * stopped by blocks (vanilla's seen percent) or reaching a creative bot, a creative bot hurt (the fake ignores her hurts), a hit written in the same tick as a slot change (the server used the old
 * slot), drops other than a spec's `drops`, the blast's crater and its damage to mobs.
 */
import { Vec3 } from "vec3";
import type { Entity } from "prismarine-entity";
import type { ServerEntities } from "./fake-bot-entities.js";
import { BOAT_NAME, inEntityReach } from "./fake-bot-entity-reach.js";
import { type MobKnockback, attachMobKnockback } from "./fake-bot-mob-knockback.js";
import { attachFakeFireballs } from "./fake-bot-fireballs.js";
import { attachFakeShots } from "./fake-bot-shots.js";
import { DEFAULT_MOB_HEALTH, HURT_WINDOW_TICKS, KNOCKBACK_SIDEWAYS, NOT_HURTABLE_TYPES, SPRINT_BONUS_ABOVE_STRENGTH, SPRINT_KNOCKBACK, swingStrength, type ShotProjectile, notchVelocity, blastOn, damageTaken, knockbackFrom, opensHurtWindow, swingDamage, weaponOf } from "./fake-bot-combat-rules.js";
import { attachFakeHeldUse } from "./fake-bot-held-use.js";
import { eyeHeightOf } from "./fake-bot-physics.js";
import { onServerTick } from "./fake-bot-server-ticks.js";
import type { FakeBot } from "./fake-bot.js";
import type { FakeClock } from "./fake-clock.js";
import type { FakeInventory } from "./fake-inventory.js";
import type { FakeServer } from "./fake-server.js";

/** The horizontal direction the bot looks along (Mineflayer's yaw 0 faces -z). */
function lookingAt(bot: FakeBot): Vec3 {
  return new Vec3(-Math.sin(bot.entity.yaw), 0, -Math.cos(bot.entity.yaw));
}

/** What other actors do to the bot and the creatures around her, each sending what the server sends. */
export interface FakeCombat {
  /** A creature on the client is hurt by `sourceId` (null: no source) for `amount`: the hurt window and the death apply. */
  hurt(entityId: number, sourceId: number | null, amount: number): void;
  /** The bot is hurt by `sourceId` (null: no source) for `amount`, pushed away from it: `damage_event`, `entity_velocity`, `update_health`; at 0 she dies. */
  hurtBot(amount: number, sourceId: number | null): void;
  /** A creature swings its arm (`animation` 0, `entitySwingArm`). */
  swing(entityId: number): void;
  /** A creature dies at once (`/kill`): `entity_status` 3, its removal after the death animation. */
  kill(entityId: number): void;
  /** `shooterId` (a creature on the client) shoots the bot with an arrow or a small fireball that costs `amount` when it lands: the flight, the `damage_event`, the push, and a fireball's fire. */
  shootBot(projectile: ShotProjectile, shooterId: number, amount: number): void;
  /** The server summons a ghast's fireball at `position` flying with `motion` (blocks a tick) and accelerating along it; the bot can hit it to send it along her look. */
  launchFireball(position: Vec3, motion: Vec3): Entity;
  /** `update_health`: the bot's health and food (food as it is when omitted). */
  setHealth(health: number, food?: number): void;
  /** A creeper blows up at `position`: the `explosion` packet with the bot's knockback, her hurt, the creeper gone. */
  explode(position: Vec3): void;
}

type CombatParts = { clock: FakeClock; server: FakeServer; inventory: FakeInventory; entities: ServerEntities };

/** A bot that has stood about has a full swing (the ticker counts from the login). */
const STANDING_SWING_TICKS = 1_000;
/** The death animation keeps a dead mob on the client for 945 ms. */
const DEATH_ANIMATION_TICKS = 19;
const SWING_ARM = 0;
const STATUS_DEAD = 3;

/** A creature's hurt window: its health, the ticks left of its invulnerability and the damage that opened it. */
interface Creature {
  health: number;
  invulnerableTicks: number;
  lastHurt: number;
  dying: boolean;
}

/** The id the server gives a damage type: its place in the registry the login sends. */
function damageTypeId(bot: FakeBot, name: string): number {
  const { loginPacket } = bot.registry as unknown as { loginPacket: { dimensionCodec: Record<string, { entries: { key: string }[] }> } };
  const index = loginPacket.dimensionCodec["minecraft:damage_type"]!.entries.findIndex(({ key }) => key === `minecraft:${name}`);
  if (index < 0) throw new Error(`the registry has no damage type ${name}`);
  return index;
}

/** The server's ticks, what runs after some of them, and the packets it sends to the client. */
function createSender(bot: FakeBot, parts: CombatParts) {
  let ticks = 0;
  const later: { dueTick: number; run: () => void }[] = [];
  onServerTick(parts.clock, parts.server, () => {
    ticks += 1;
    for (const due of later.filter(({ dueTick }) => dueTick <= ticks)) {
      later.splice(later.indexOf(due), 1);
      due.run();
    }
  });
  let alive = true;
  let deaths = 0;
  return {
    ticks: () => ticks,
    /** How many times the bot has died: a fire or a push that began in an earlier life is not hers any more. */
    deaths: () => deaths,
    afterTicks: (count: number, run: () => void) => void later.push({ dueTick: ticks + count, run }),
    hear: (name: string, data: unknown) => void bot._client.emit(name, data),
    /** `health.js:21-40`: the values filed, `health` emitted, and `death` / `spawn` as the health crosses 0. */
    sendHealth(health: number, food: number) {
      bot._client.emit("update_health", { health, food, foodSaturation: bot.foodSaturation });
      Object.assign(bot, { health, food });
      bot.emit("health");
      if (health <= 0 && alive) {
        alive = false;
        deaths += 1;
        bot.emit("death");
      } else if (health > 0 && !alive) {
        alive = true;
        bot.emit("spawn");
      }
    },
  };
}

type Sender = ReturnType<typeof createSender>;

/** A creature dies: `entity_status` 3 and `entityDead`, its drops where it stood, its removal after the death animation. */
function killCreature(bot: FakeBot, parts: CombatParts, sender: Sender, entity: Entity, creature: Creature): void {
  if (creature.dying) return;
  creature.dying = true;
  sender.hear("entity_status", { entityId: entity.id, entityStatus: STATUS_DEAD });
  bot.emit("entityDead", entity);
  const drops = (Reflect.get(entity, "drops") ?? []) as { name: string; count: number }[];
  for (const { name, count } of drops) parts.entities.spawn({ name: "item", position: entity.position, item: { name, count } });
  sender.afterTicks(DEATH_ANIMATION_TICKS, () => {
    if (bot.entities[entity.id] === entity) parts.entities.remove(entity.id);
  });
}

/** Whether a hit on `entity` hurts it: a creature that is not the bot or a boat (a boat's answer is `fake-bot-boat-damage.ts`). */
function isHurtable(bot: FakeBot, entity: Entity | undefined): entity is Entity {
  return entity !== undefined && entity !== bot.entity && !BOAT_NAME.test(entity.name ?? "") && !NOT_HURTABLE_TYPES.has(entity.type);
}

/** The server's sprint flag of the bot: `entity_action` 3 and 4, which a hit that gets the sprint bonus clears (`Player.attack`). */
function trackSprint(server: FakeServer): { readonly active: () => boolean; readonly clear: () => void } {
  let sprinting = false;
  server.onPacket("entity_action", (data) => {
    const { actionId } = data as { actionId: number | string };
    if (actionId === 3 || actionId === "start_sprinting") sprinting = true;
    else if (actionId === 4 || actionId === "stop_sprinting") sprinting = false;
  });
  return { active: () => sprinting, clear: () => void (sprinting = false) };
}

/** The creatures' and the bot's hurt windows, hurts and deaths, each told to the client as the server tells it. */
function createHurts(bot: FakeBot, parts: CombatParts, sender: Sender, knock: MobKnockback) {
  const creatures = new Map<number, Creature>();
  const botWindow: Creature = { health: bot.health, invulnerableTicks: 0, lastHurt: 0, dying: false };
  onServerTick(parts.clock, parts.server, () => {
    for (const creature of [botWindow, ...creatures.values()]) creature.invulnerableTicks = Math.max(0, creature.invulnerableTicks - 1);
  });
  const healthKeyOf = (entity: Entity) => bot.registry.entitiesByName[entity.name!]?.metadataKeys?.indexOf("health") ?? -1;
  const creatureOf = (entity: Entity): Creature => {
    const known = creatures.get(entity.id);
    if (known !== undefined) return known;
    const filed: unknown = Reflect.get(entity.metadata, healthKeyOf(entity));
    const created = { health: typeof filed === "number" ? filed : DEFAULT_MOB_HEALTH, invulnerableTicks: 0, lastHurt: 0, dying: false };
    creatures.set(entity.id, created);
    return created;
  };

  /** `entities.js:398-402`: the packet, then `entityHurt(victim, source)`. */
  const announceHurt = (victim: Entity, source: Entity | null, type: string, direct: Entity | null = source) => {
    sender.hear("damage_event", { entityId: victim.id, sourceTypeId: damageTypeId(bot, type), sourceCauseId: source === null ? 0 : source.id + 1, sourceDirectId: direct === null ? 0 : direct.id + 1 });
    bot.emit("entityHurt", victim, (source ?? undefined) as Entity); // Mineflayer's typing leaves the absent source out
  };
  /** A `entity_metadata` packet with the health, filed as `entities.js:470-475` does. */
  const announceHealth = (entity: Entity, health: number) => {
    Reflect.set(entity.metadata, healthKeyOf(entity), health);
    bot.emit("entityUpdate", entity);
  };

  const die = (entity: Entity, creature: Creature) => killCreature(bot, parts, sender, entity, creature);

  /** A hurt of a creature: what became of it (`missed`: the window or a dead creature took it), and `pushed` run when it lives, so its push is told around its health. */
  const hurtCreature = (entity: Entity, source: Entity | null, amount: number, type: string, pushed?: () => void): "missed" | "killed" | "survived" => {
    const creature = creatureOf(entity);
    const taken = damageTaken(amount, creature.invulnerableTicks, creature.lastHurt);
    if (creature.dying || taken <= 0) return "missed";
    const opens = opensHurtWindow(creature.invulnerableTicks);
    const push = opens ? pushed : undefined;
    if (opens) creature.invulnerableTicks = HURT_WINDOW_TICKS;
    creature.lastHurt = amount;
    creature.health -= taken;
    if (opens) announceHurt(entity, source, type);
    if (creature.health <= 0) {
      die(entity, creature);
      return "killed";
    }
    push?.();
    sender.afterTicks(1, () => (push === undefined ? announceHealth(entity, creature.health) : knock.tellAround(entity, () => announceHealth(entity, creature.health))));
    return "survived";
  };

  /** `entity_velocity` for the bot, filed as `entities.js:302-307` does. */
  const pushBot = (velocity: Vec3) => {
    sender.hear("entity_velocity", { entityId: bot.entity.id, velocity: notchVelocity(velocity) });
    bot.entity.velocity.update(velocity);
  };
  /** A hurt of the bot: `taken` is what it costs her (0: nothing, a creative bot or the hurt window), `opened` whether it opened the window and was told. `hooks` run before and after the `damage_event`, which names `direct` as its direct source when it is not the cause (a projectile). */
  const hurtTheBot = (amount: number, source: Entity | null, type: string, push: Vec3 | null, hooks: { readonly beforeEvent?: () => void; readonly afterEvent?: () => void; readonly direct?: Entity } = {}) => {
    const taken = damageTaken(amount, botWindow.invulnerableTicks, botWindow.lastHurt);
    if (taken <= 0 || bot.game.gameMode === "creative") return { taken: 0, opened: false };
    const opens = opensHurtWindow(botWindow.invulnerableTicks);
    hooks.beforeEvent?.();
    if (opens) botWindow.invulnerableTicks = HURT_WINDOW_TICKS;
    botWindow.lastHurt = amount;
    if (opens) announceHurt(bot.entity, source, type, hooks.direct ?? source);
    hooks.afterEvent?.();
    if (opens && push !== null) pushBot(push);
    const health = Math.max(0, bot.health - taken);
    if (health <= 0) {
      sender.hear("entity_status", { entityId: bot.entity.id, entityStatus: STATUS_DEAD });
      bot.emit("entityDead", bot.entity);
    }
    sender.sendHealth(health, bot.food);
    return { taken, opened: opens };
  };
  return { creatureOf, hurtCreature, hurtTheBot, pushBot, die };
}

/** Give `bot` the server's answers to a hit and the scene controls of the harness. */
export function attachFakeCombat(bot: FakeBot, parts: CombatParts): FakeCombat {
  const sender = createSender(bot, parts);
  let ticksSinceSwing = STANDING_SWING_TICKS;
  let heldType = parts.inventory.heldItem?.type;
  onServerTick(parts.clock, parts.server, () => void (ticksSinceSwing += 1));
  // `Player.tick`: a different item type in the main hand starts the swing over.
  parts.inventory.onHeldItemChanged((held) => {
    if (held?.type !== heldType) ticksSinceSwing = 0;
    heldType = held?.type;
  });
  attachFakeHeldUse(bot, { server: parts.server, inventory: parts.inventory, entities: parts.entities, ...sender });
  const knock = attachMobKnockback(bot, sender);
  const { creatureOf, hurtCreature, hurtTheBot, pushBot, die } = createHurts(bot, parts, sender, knock);
  const fireballs = attachFakeFireballs(bot, { clock: parts.clock, server: parts.server, entities: parts.entities, hear: sender.hear, hurtTheBot });
  const sprint = trackSprint(parts.server);
  const shootBot = attachFakeShots(bot, { entities: parts.entities, afterTicks: sender.afterTicks, deaths: sender.deaths, hurtTheBot, pushBot });

  // `entities.js:860-873`: A2's `attack` writes the packet; a boat's answer is `fake-bot-boat-damage.ts`.
  parts.server.onPacket("use_entity", (data) => {
    const { target, mouse } = data as { target: number; mouse: number };
    if (mouse !== 1) return;
    parts.server.answer(() => {
      const entity = bot.entities[target];
      const fireballHit = entity === undefined ? null : fireballs.hit(entity);
      if (fireballHit !== null) {
        // `Player.attack` starts the swing over before it deflects a ball; a hit the server ignores is not an attack.
        if (fireballHit === "deflected") ticksSinceSwing = 0;
        return;
      }
      if (!isHurtable(bot, entity) || !inEntityReach(bot, parts.server, entity)) return;
      const weapon = weaponOf(parts.inventory.heldItem?.name);
      const damage = swingDamage(weapon, ticksSinceSwing);
      const sprintBonus = sprint.active() && swingStrength(weapon, ticksSinceSwing) > SPRINT_BONUS_ABOVE_STRENGTH;
      ticksSinceSwing = 0;
      const result = hurtCreature(entity, bot.entity, damage, "player_attack", () => {
        knock.push(entity, entity.position.minus(bot.entity.position), KNOCKBACK_SIDEWAYS);
        if (sprintBonus) knock.push(entity, lookingAt(bot), SPRINT_KNOCKBACK);
      });
      if (sprintBonus && result !== "missed") sprint.clear();
    });
  });

  return {
    hurt: (entityId, sourceId, amount) => {
      const entity = bot.entities[entityId];
      if (entity === undefined) throw new Error(`no entity ${entityId} on the bot to hurt`);
      const source = sourceId === null ? null : (bot.entities[sourceId] ?? null);
      hurtCreature(entity, source, amount, source?.name === "player" ? "player_attack" : source === null ? "generic" : "mob_attack");
    },
    hurtBot: (amount, sourceId) => {
      const source = sourceId === null ? null : (bot.entities[sourceId] ?? null);
      if (sourceId !== null && source === null) throw new Error(`no entity ${sourceId} on the bot to hurt her from`);
      hurtTheBot(amount, source, source === null ? "generic" : "mob_attack", source === null ? null : knockbackFrom(source.position, bot.entity.position));
    },
    swing: (entityId) => {
      const entity = bot.entities[entityId];
      if (entity === undefined) throw new Error(`no entity ${entityId} on the bot to swing`);
      sender.hear("animation", { entityId, animation: SWING_ARM });
      bot.emit("entitySwingArm", entity);
    },
    kill: (entityId) => {
      const entity = bot.entities[entityId];
      if (entity === undefined) throw new Error(`no entity ${entityId} on the bot to kill`);
      die(entity, creatureOf(entity));
    },
    shootBot,
    launchFireball: fireballs.launch,
    setHealth: (health, food) => sender.sendHealth(health, food ?? bot.food),
    explode: (position) => {
      const creeper = parts.entities.spawn({ name: "creeper", position });
      const blast = blastOn(position, bot.entity.position, eyeHeightOf(bot.entity));
      if (blast !== null) hurtTheBot(blast.damage, creeper, "player_explosion", null);
      sender.hear("explosion", { x: position.x, y: position.y, z: position.z, ...(blast !== null && { playerKnockback: { x: blast.knockback.x, y: blast.knockback.y, z: blast.knockback.z } }) });
      if (blast !== null && bot.game.gameMode !== "creative") bot.entity.velocity.add(blast.knockback);
      parts.entities.remove(creeper.id);
    },
  };
}
