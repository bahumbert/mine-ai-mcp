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
import { HURT_WINDOW_TICKS, VELOCITY_UNIT, blastOn, damageTaken, knockbackFrom, opensHurtWindow, swingDamage, weaponOf } from "./fake-bot-combat-rules.js";
import { attachFakeHeldUse } from "./fake-bot-held-use.js";
import { eyeHeightOf } from "./fake-bot-physics.js";
import { onServerTick } from "./fake-bot-server-ticks.js";
import type { FakeBot } from "./fake-bot.js";
import type { FakeClock } from "./fake-clock.js";
import type { FakeInventory } from "./fake-inventory.js";
import type { FakeServer } from "./fake-server.js";

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
  /** `update_health`: the bot's health and food (food as it is when omitted). */
  setHealth(health: number, food?: number): void;
  /** A creeper blows up at `position`: the `explosion` packet with the bot's knockback, her hurt, the creeper gone. */
  explode(position: Vec3): void;
}

type CombatParts = { clock: FakeClock; server: FakeServer; inventory: FakeInventory; entities: ServerEntities };

/** A mob that no record or metadata gives a health has this (a zombie, a creeper). */
const DEFAULT_MOB_HEALTH = 20;
/** A bot that has stood about has a full swing (the ticker counts from the login). */
const STANDING_SWING_TICKS = 1_000;
/** The death animation keeps a dead mob on the client for 945 ms. */
const DEATH_ANIMATION_TICKS = 19;
const SWING_ARM = 0;
const STATUS_DEAD = 3;
/** Entity types that are not creatures a hit hurts. */
const NOT_HURTABLE_TYPES = new Set(["player", "projectile", "other"]);

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
  return {
    ticks: () => ticks,
    afterTicks: (count: number, run: () => void) => void later.push({ dueTick: ticks + count, run }),
    hear: (name: string, data: unknown) => void bot._client.emit(name, data),
    /** `health.js:21-40`: the values filed, `health` emitted, and `death` / `spawn` as the health crosses 0. */
    sendHealth(health: number, food: number) {
      bot._client.emit("update_health", { health, food, foodSaturation: bot.foodSaturation });
      Object.assign(bot, { health, food });
      bot.emit("health");
      if (health <= 0 && alive) {
        alive = false;
        bot.emit("death");
      } else if (health > 0 && !alive) {
        alive = true;
        bot.emit("spawn");
      }
    },
  };
}

type Sender = ReturnType<typeof createSender>;

/** The creatures' and the bot's hurt windows, hurts and deaths, each told to the client as the server tells it. */
function createHurts(bot: FakeBot, parts: CombatParts, sender: Sender) {
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
  const announceHurt = (victim: Entity, source: Entity | null, type: string) => {
    sender.hear("damage_event", { entityId: victim.id, sourceTypeId: damageTypeId(bot, type), sourceCauseId: source === null ? 0 : source.id + 1, sourceDirectId: source === null ? 0 : source.id + 1 });
    bot.emit("entityHurt", victim, (source ?? undefined) as Entity); // Mineflayer's typing leaves the absent source out
  };
  /** A `entity_metadata` packet with the health, filed as `entities.js:470-475` does. */
  const announceHealth = (entity: Entity, health: number) => {
    Reflect.set(entity.metadata, healthKeyOf(entity), health);
    bot.emit("entityUpdate", entity);
  };

  const die = (entity: Entity, creature: Creature) => {
    if (creature.dying) return;
    creature.dying = true;
    sender.hear("entity_status", { entityId: entity.id, entityStatus: STATUS_DEAD });
    bot.emit("entityDead", entity);
    const drops = (Reflect.get(entity, "drops") ?? []) as { name: string; count: number }[];
    for (const { name, count } of drops) parts.entities.spawn({ name: "item", position: entity.position, item: { name, count } });
    sender.afterTicks(DEATH_ANIMATION_TICKS, () => {
      if (bot.entities[entity.id] === entity) parts.entities.remove(entity.id);
    });
  };

  const hurtCreature = (entity: Entity, source: Entity | null, amount: number, type: string) => {
    const creature = creatureOf(entity);
    const taken = damageTaken(amount, creature.invulnerableTicks, creature.lastHurt);
    if (creature.dying || taken <= 0) return;
    const opens = opensHurtWindow(creature.invulnerableTicks);
    if (opens) creature.invulnerableTicks = HURT_WINDOW_TICKS;
    creature.lastHurt = amount;
    creature.health -= taken;
    if (opens) announceHurt(entity, source, type);
    if (creature.health <= 0) die(entity, creature);
    else sender.afterTicks(1, () => announceHealth(entity, creature.health));
  };

  /** `entity_velocity` for the bot, filed as `entities.js:302-307` does. */
  const pushBot = (velocity: Vec3) => {
    const notch = { x: Math.round(velocity.x * VELOCITY_UNIT), y: Math.round(velocity.y * VELOCITY_UNIT), z: Math.round(velocity.z * VELOCITY_UNIT) };
    sender.hear("entity_velocity", { entityId: bot.entity.id, velocity: notch });
    bot.entity.velocity.update(velocity);
  };
  const hurtTheBot = (amount: number, source: Entity | null, type: string, push: Vec3 | null) => {
    const taken = damageTaken(amount, botWindow.invulnerableTicks, botWindow.lastHurt);
    if (taken <= 0 || bot.game.gameMode === "creative") return;
    const opens = opensHurtWindow(botWindow.invulnerableTicks);
    if (opens) botWindow.invulnerableTicks = HURT_WINDOW_TICKS;
    botWindow.lastHurt = amount;
    if (opens) announceHurt(bot.entity, source, type);
    if (opens && push !== null) pushBot(push);
    const health = Math.max(0, bot.health - taken);
    if (health <= 0) {
      sender.hear("entity_status", { entityId: bot.entity.id, entityStatus: STATUS_DEAD });
      bot.emit("entityDead", bot.entity);
    }
    sender.sendHealth(health, bot.food);
  };
  return { creatureOf, hurtCreature, hurtTheBot, die };
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
  const { creatureOf, hurtCreature, hurtTheBot, die } = createHurts(bot, parts, sender);

  const isHurtable = (entity: Entity | undefined): entity is Entity =>
    entity !== undefined && entity !== bot.entity && !BOAT_NAME.test(entity.name ?? "") && !NOT_HURTABLE_TYPES.has(entity.type);

  // `entities.js:860-873`: A2's `attack` writes the packet; a boat's answer is `fake-bot-boat-damage.ts`.
  parts.server.onPacket("use_entity", (data) => {
    const { target, mouse } = data as { target: number; mouse: number };
    if (mouse !== 1) return;
    parts.server.answer(() => {
      const entity = bot.entities[target];
      if (!isHurtable(entity) || !inEntityReach(bot, parts.server, entity)) return;
      const damage = swingDamage(weaponOf(parts.inventory.heldItem?.name), ticksSinceSwing);
      ticksSinceSwing = 0;
      hurtCreature(entity, bot.entity, damage, "player_attack");
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
