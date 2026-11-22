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
import type { FakeBurn } from "./fake-bot-burn.js";
import { FIRE_TICKS, SHOTS, type ShotProjectile, afterOnePhysicsTick, knockbackFrom } from "./fake-bot-combat-rules.js";
import type { FakeBot } from "./fake-bot.js";

/** What the shots need of the fights: the server's ticks and what lands on the bot. */
export interface ShotParts {
  readonly entities: ServerEntities;
  readonly afterTicks: (count: number, run: () => void) => void;
  readonly burn: FakeBurn;
  readonly hurtTheBot: (amount: number, source: Entity | null, type: string, push: Vec3 | null, hooks?: { readonly beforeEvent?: () => void; readonly afterEvent?: () => void; readonly direct?: Entity }) => { readonly taken: number; readonly opened: boolean };
  readonly pushBot: (velocity: Vec3) => void;
}

const SPAWN_HEIGHT_OF_SHOOTER = 0.85;
/** The shots aim at her chest, as the check's subject does. */
const CHEST_OF_BOT = 0.7;

/** `shootBot` of the harness: `shooterId` shoots the bot with `projectile`, which costs `amount` once it lands. */
export function attachFakeShots(bot: FakeBot, parts: ShotParts): (projectile: ShotProjectile, shooterId: number, amount: number) => void {
  const land = (projectile: ShotProjectile, shooter: Entity, ball: Entity, amount: number, direction: Vec3) => {
    if (bot.entities[ball.id] !== ball) return;
    const remove = () => parts.entities.remove(ball.id);
    const { setsFire, damageType } = SHOTS[projectile];
    const hit = parts.hurtTheBot(amount, shooter, damageType, null, {
      beforeEvent: () => setsFire && parts.burn.igniteFor(FIRE_TICKS),
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
