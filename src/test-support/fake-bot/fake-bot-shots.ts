/**
 * A mob's projectile that hits the bot (contract check `projectile-hit-bot`, Mine Labs 1.21.4, 2026-10-24): the client hears it
 * spawn flying at her (the spawn packet carries its velocity), the hit comes after the ticks its distance and speed make, and then
 * in the server's order: a small fireball sets her on fire (the flags' bit 0), `damage_event` (type `arrow` or `fireball`, cause the
 * shooter, direct source the projectile), the projectile gone, `update_health`; a tick later her push, which carries one tick of her
 * own physics. A hit the hurt window absorbs lights no fire and pushes nobody, but the projectile is gone all the same. Fire costs
 * 1 of `on_fire` damage at 1, 2, 3 and 4 s and goes out at 5 s; a second fireball starts the five seconds over.
 * The projectile stays at its spawn point on the client and on the server (it is only removed at its landing, and a projectile is not
 * hurtable), so no `setServerPosition` is needed for it.
 * Not modelled: the arrow's count in her metadata, the burn hurt's own `entity_velocity` (0, -0.0784, 0), the spawn height (0.85 of
 * the shooter's height: unmeasured), a flight bent by gravity or blocks, water putting the fire out, a shield.
 */
import { Vec3 } from "vec3";
import type { Entity } from "prismarine-entity";
import type { ServerEntities } from "./fake-bot-entities.js";
import { BURN_DAMAGE, BURN_EVERY_TICKS, FIRE_TICKS, SHOTS, type ShotProjectile, afterOnePhysicsTick, knockbackFrom } from "./fake-bot-combat-rules.js";
import type { FakeBot } from "./fake-bot.js";

/** What the shots need of the fights: the server's ticks and what lands on the bot. */
export interface ShotParts {
  readonly entities: ServerEntities;
  readonly afterTicks: (count: number, run: () => void) => void;
  readonly deaths: () => number;
  readonly hurtTheBot: (amount: number, source: Entity | null, type: string, push: Vec3 | null, hooks?: { readonly beforeEvent?: () => void; readonly afterEvent?: () => void; readonly direct?: Entity }) => { readonly taken: number; readonly opened: boolean };
  readonly pushBot: (velocity: Vec3) => void;
}

const SPAWN_HEIGHT_OF_SHOOTER = 0.85;
/** The bit of the entity flags (metadata key 0) that says an entity is on fire. */
const FIRE_FLAG = 1;
const FLAGS_KEY = 0;
/** The shots aim at her chest, as the check's subject does. */
const CHEST_OF_BOT = 0.7;

/** `shootBot` of the harness: `shooterId` shoots the bot with `projectile`, which costs `amount` once it lands. */
export function attachFakeShots(bot: FakeBot, parts: ShotParts): (projectile: ShotProjectile, shooterId: number, amount: number) => void {
  let fireGeneration = 0;
  const setFire = (burning: boolean) => {
    const flags = Number(bot.entity.metadata[FLAGS_KEY] ?? 0);
    Reflect.set(bot.entity.metadata, FLAGS_KEY, burning ? flags | FIRE_FLAG : flags & ~FIRE_FLAG);
    bot.emit("entityUpdate", bot.entity);
  };
  /** Five seconds of fire from now: a burn hurt each second while she lives, the flag out at the end; a later fire makes this one's callbacks do nothing. */
  const ignite = () => {
    fireGeneration += 1;
    const generation = fireGeneration;
    const lifeStarted = parts.deaths();
    setFire(true);
    /** Fire stays with the life it was lit in: a death ends it, and a later fire makes this one's callbacks do nothing. */
    const burning = () => {
      if (generation !== fireGeneration) return false;
      if (parts.deaths() === lifeStarted) return true;
      fireGeneration += 1;
      setFire(false);
      return false;
    };
    for (let burn = 1; burn * BURN_EVERY_TICKS < FIRE_TICKS; burn += 1) {
      parts.afterTicks(burn * BURN_EVERY_TICKS, () => void (burning() && parts.hurtTheBot(BURN_DAMAGE, null, "on_fire", null)));
    }
    parts.afterTicks(FIRE_TICKS, () => void (burning() && setFire(false)));
  };

  const land = (projectile: ShotProjectile, shooter: Entity, ball: Entity, amount: number, direction: Vec3) => {
    if (bot.entities[ball.id] !== ball) return;
    const remove = () => parts.entities.remove(ball.id);
    const { setsFire, damageType } = SHOTS[projectile];
    const hit = parts.hurtTheBot(amount, shooter, damageType, null, {
      beforeEvent: () => setsFire && ignite(),
      afterEvent: remove,
      direct: ball,
    });
    if (hit.taken === 0) remove();
    if (hit.opened) parts.afterTicks(1, () => parts.pushBot(afterOnePhysicsTick(knockbackFrom(bot.entity.position.minus(direction), bot.entity.position))));
  };

  return (projectile, shooterId, amount) => {
    const shooter = bot.entities[shooterId];
    if (shooter === undefined) throw new Error(`no entity ${shooterId} on the bot to shoot her`);
    const { speed } = SHOTS[projectile];
    const start = shooter.position.offset(0, shooter.height * SPAWN_HEIGHT_OF_SHOOTER, 0);
    const toChest = bot.entity.position.offset(0, bot.entity.height * CHEST_OF_BOT, 0).minus(start);
    const distance = toChest.norm();
    const direction = distance === 0 ? new Vec3(0, 0, 0) : toChest.scaled(1 / distance);
    const ball = parts.entities.spawn({ name: projectile, position: start, velocity: direction.scaled(speed) });
    parts.afterTicks(Math.max(1, Math.ceil(distance / speed)), () => land(projectile, shooter, ball, amount, direction));
  };
}
