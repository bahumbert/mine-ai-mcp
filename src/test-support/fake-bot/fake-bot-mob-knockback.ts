/**
 * What the client hears of a mob that a hit pushed (contract checks `attack-mob-knockback`, `-decay` and `-sprint`, Mine Labs 1.21.4, 2026-10-24). A mob
 * with no AI (every mob of the fake is one) keeps the push as a motion that never moves it: a tick after the hit its
 * `entity_velocity` is told twice (around the health metadata), then its motion decays by 0.98 a tick, a component under 0.003 is
 * dropped, and the tracker tells the velocity every 3 ticks when it changed by more than 0.0003 since the last one told (else
 * on a later 3rd tick), the last being a velocity of zero. No position packet moves it. Mineflayer files only the velocity
 * (`entities.js:302-307`).
 * Not modelled: a mob with AI (it takes 0.36 up as well, then walks, falls and turns on its own: `sync_entity_position` and move packets
 * each tick), the sporadic move packet with a delta of zero and `onGround` false, a push on a mob the hit killed or on one hurt by
 * another actor (unmeasured), a tracker's phase (the fake counts from the hit).
 */
import { Vec3 } from "vec3";
import type { Entity } from "prismarine-entity";
import { fromNotchVelocity, notchVelocity } from "./fake-bot-combat-rules.js";
import type { FakeBot } from "./fake-bot.js";

/** The push loses 2 % a tick (`LivingEntity.aiStep` drag on a mob that does not travel). */
const DECAY_PER_TICK = 0.98;
/** A component under this is dropped to zero each tick. */
const REST_BELOW = 0.003;
/** The tracker looks every 3 ticks and tells a velocity that moved by more than `sqrt(1e-7)` since the last told. */
const TELL_EVERY_TICKS = 3;
const TELL_CHANGE_SQUARED = 1e-7;

/** A pushed mob's motion, what the client was last told, and the ticks since it was told. */
interface Motion {
  velocity: Vec3;
  told: Vec3;
  ticksSinceTold: number;
  running: boolean;
}

export interface MobKnockback {
  /** `knockback(strength, direction)` of the server: the motion halves and `strength` along `direction` (horizontal, normalised here) is added. Nothing is told yet. */
  push(entity: Entity, direction: Vec3, strength: number): void;
  /** A tick after the hit: the velocity told, `between` run (the health metadata), the velocity told again, and the decay started. */
  tellAround(entity: Entity, between: () => void): void;
}

/** The mobs' pushes: `hear` is the client's packet emitter, `afterTicks` the server's one-shot timer. */
export function attachMobKnockback(bot: FakeBot, parts: { readonly hear: (name: string, data: unknown) => void; readonly afterTicks: (count: number, run: () => void) => void }): MobKnockback {
  const motions = new Map<number, Motion>();
  const motionOf = (entity: Entity): Motion => {
    const known = motions.get(entity.id);
    if (known !== undefined) return known;
    const created = { velocity: new Vec3(0, 0, 0), told: new Vec3(0, 0, 0), ticksSinceTold: 0, running: false };
    motions.set(entity.id, created);
    return created;
  };

  /** `entity_velocity` as the client files it: the packet, then the entity's velocity from the truncated notch. */
  const tell = (entity: Entity, motion: Motion) => {
    const notch = notchVelocity(motion.velocity);
    parts.hear("entity_velocity", { entityId: entity.id, velocity: notch });
    entity.velocity.update(fromNotchVelocity(notch));
    motion.told = motion.velocity.clone();
    motion.ticksSinceTold = 0;
  };

  const rested = (motion: Motion) => motion.velocity.norm() === 0 && motion.told.norm() === 0;

  /** One tick of the mob's own motion, and the tracker's look every 3rd one. */
  const step = (entity: Entity, motion: Motion) => {
    if (bot.entities[entity.id] !== entity) {
      motions.delete(entity.id);
      return;
    }
    const decayed = motion.velocity.scaled(DECAY_PER_TICK);
    motion.velocity = new Vec3(...[decayed.x, decayed.y, decayed.z].map((component) => (Math.abs(component) < REST_BELOW ? 0 : component)) as [number, number, number]);
    motion.ticksSinceTold += 1;
    if (motion.ticksSinceTold % TELL_EVERY_TICKS === 0 && motion.velocity.minus(motion.told).norm() ** 2 > TELL_CHANGE_SQUARED) tell(entity, motion);
    if (rested(motion)) {
      motion.running = false;
      return;
    }
    parts.afterTicks(1, () => step(entity, motion));
  };

  return {
    push(entity, direction, strength) {
      const motion = motionOf(entity);
      const horizontal = new Vec3(direction.x, 0, direction.z);
      const away = horizontal.norm() === 0 ? horizontal : horizontal.scaled(strength / horizontal.norm());
      motion.velocity = new Vec3(motion.velocity.x / 2 + away.x, motion.velocity.y, motion.velocity.z / 2 + away.z);
    },
    tellAround(entity, between) {
      const motion = motionOf(entity);
      tell(entity, motion);
      between();
      tell(entity, motion);
      if (motion.running) return;
      motion.running = true;
      parts.afterTicks(1, () => step(entity, motion));
    },
  };
}
