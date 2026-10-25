/**
 * A ghast's fireball in flight and its deflection (contract check `deflect-fireball`, Mine Labs 1.21.4, 2026-10-24). The server moves it each
 * tick (`fake-bot-combat-rules.ts` FIREBALL_*) and tells the client rarely: one tick after it appears a position packet with a delta of
 * zero, then at its 2nd tick and at every 10th one from the 10th its velocity and its position (`entity_move_look` with the delta
 * since the last one told in 1/4096 of a block, `sync_entity_position` with the absolute position when the delta passes 8 blocks).
 * The ball's true position is the server's (`setServerPosition` at launch and each tick), so a hit is judged on it while the client holds
 * the last position it was told. A hit in reach (`use_entity`, mouse 1) sets it flying along the way the attacker looks; the client hears the new velocity and a move
 * packet of zero in that tick, nothing about an owner. A hit out of reach changes nothing. At the bot it hurts her (`damage_event`
 * of type `unattributed_fireball`, the ball as cause and direct source) and blows up (`explosion`, the ball destroyed).
 * Not modelled: the ball's yaw and pitch (they lerp toward its heading), blocks (a ball flies on until removed or until it meets
 * the bot), a ball with an owner (its hit is `fireball`), a hit on a ball that is not a `fireball`, the sound and particles.
 */
import { Vec3 } from "vec3";
import type { Entity } from "prismarine-entity";
import type { ServerEntities } from "./fake-bot-entities.js";
import { inEntityReach } from "./fake-bot-entity-reach.js";
import {
  FIREBALL_BLAST_POWER,
  FIREBALL_DEFLECTED_POWER,
  FIREBALL_DEFLECTED_SPEED,
  FIREBALL_DRAG,
  FIREBALL_HIT_DAMAGE,
  FIREBALL_LAUNCH_POWER,
  blastOn,
  fromNotchVelocity,
  notchVelocity,
} from "./fake-bot-combat-rules.js";
import { eyeHeightOf } from "./fake-bot-physics.js";
import { onServerTick } from "./fake-bot-server-ticks.js";
import type { FakeBot } from "./fake-bot.js";
import type { FakeServer } from "./fake-server.js";

/** What the fireballs need of the fights: the client's packets, the bot's hurts, and the entities of the server. */
export interface FireballParts {
  readonly server: FakeServer;
  readonly entities: ServerEntities;
  readonly hear: (name: string, data: unknown) => void;
  readonly hurtTheBot: (amount: number, source: Entity | null, type: string, push: Vec3 | null) => { readonly taken: number; readonly opened: boolean };
}

export interface FakeFireballs {
  /** The server summons a fireball at `position` flying with `motion` (blocks a tick), accelerating along it. */
  launch(position: Vec3, motion: Vec3): Entity;
  /** The bot hits `entity`: a fireball in reach flies on along her look (`deflected`), one out of reach is not touched (`ignored`); anything else is `null`. */
  hit(entity: Entity): "deflected" | "ignored" | null;
}

/** A ball as the server holds it: its true position, motion and the acceleration along it. */
interface Ball {
  readonly entity: Entity;
  position: Vec3;
  velocity: Vec3;
  power: number;
  ticks: number;
}

const POSITION_UNIT = 4_096;
/** The relative move packet holds a delta of 8 blocks at most (a short of 1/4096). */
const MOVE_LIMIT = 8;
const FIRST_TOLD_TICK = 2;
const TELL_EVERY_TICKS = 10;
/** The ball's box is 1 block wide; the bot's 0.6 wide and 1.8 tall. */
const HIT_REACH_SIDEWAYS = 0.5 + 0.3;
const HIT_REACH_UP = 0.5;

/** What the client is told of a ball: its velocity, its position (relative or absolute), a position that moves nothing; each also runs the handler of Mineflayer's. */
function createBallTelling(bot: FakeBot, parts: FireballParts) {
  const tellVelocity = (ball: Ball) => {
    const notch = notchVelocity(ball.velocity);
    parts.hear("entity_velocity", { entityId: ball.entity.id, velocity: notch });
    ball.entity.velocity.update(fromNotchVelocity(notch));
  };
  /** The position packet of a pass: the delta since what the client has, relative or absolute (`entities.js:322-379`). */
  const tellPosition = (ball: Ball) => {
    const delta = ball.position.minus(ball.entity.position);
    if (Math.max(Math.abs(delta.x), Math.abs(delta.y), Math.abs(delta.z)) < MOVE_LIMIT) {
      const moved = { dX: Math.round(delta.x * POSITION_UNIT), dY: Math.round(delta.y * POSITION_UNIT), dZ: Math.round(delta.z * POSITION_UNIT) };
      parts.hear("entity_move_look", { entityId: ball.entity.id, ...moved, yaw: 0, pitch: 0, onGround: false });
      ball.entity.position.translate(moved.dX / POSITION_UNIT, moved.dY / POSITION_UNIT, moved.dZ / POSITION_UNIT);
    } else {
      parts.hear("sync_entity_position", { entityId: ball.entity.id, x: ball.position.x, y: ball.position.y, z: ball.position.z, dx: ball.velocity.x, dy: ball.velocity.y, dz: ball.velocity.z, yaw: 0, pitch: 0, onGround: false });
      ball.entity.position.set(ball.position.x, ball.position.y, ball.position.z);
      ball.entity.velocity.set(ball.velocity.x, ball.velocity.y, ball.velocity.z);
    }
    bot.emit("entityMoved", ball.entity);
  };
  /** A position packet that moves nothing (the first tick after the ball appears, the tick of a hit). */
  const tellStill = (ball: Ball) => {
    parts.hear("rel_entity_move", { entityId: ball.entity.id, dX: 0, dY: 0, dZ: 0, onGround: false });
    bot.emit("entityMoved", ball.entity);
  };
  return { tellVelocity, tellPosition, tellStill };
}

/** The fireballs of the server: flight, what the client is told, the hit by the bot and the hit on her. */
export function attachFakeFireballs(bot: FakeBot, parts: FireballParts): FakeFireballs {
  const balls = new Map<number, Ball>();

  const { tellVelocity, tellPosition, tellStill } = createBallTelling(bot, parts);

  const touchesBot = (ball: Ball) => {
    const feet = bot.entity.position;
    return Math.abs(ball.position.x - feet.x) < HIT_REACH_SIDEWAYS && Math.abs(ball.position.z - feet.z) < HIT_REACH_SIDEWAYS && ball.position.y > feet.y - HIT_REACH_UP && ball.position.y < feet.y + bot.entity.height + HIT_REACH_UP;
  };
  /** The ball meets the bot: her hurt, the blast, the ball gone, in the server's order. */
  const explodeOnBot = (ball: Ball) => {
    balls.delete(ball.entity.id);
    parts.hurtTheBot(FIREBALL_HIT_DAMAGE, ball.entity, "unattributed_fireball", null);
    const blast = blastOn(ball.position, bot.entity.position, eyeHeightOf(bot.entity), FIREBALL_BLAST_POWER);
    if (blast !== null) {
      parts.hurtTheBot(blast.damage, ball.entity, "explosion", null);
      parts.hear("explosion", { x: ball.position.x, y: ball.position.y, z: ball.position.z, playerKnockback: { x: blast.knockback.x, y: blast.knockback.y, z: blast.knockback.z } });
      if (bot.game.gameMode !== "creative") bot.entity.velocity.add(blast.knockback);
    }
    if (bot.entities[ball.entity.id] === ball.entity) parts.entities.remove(ball.entity.id);
  };

  /** One tick of the server's ball: the flight, the passes that tell the client, the meeting with the bot. */
  const step = (ball: Ball) => {
    if (bot.entities[ball.entity.id] !== ball.entity) {
      balls.delete(ball.entity.id);
      return;
    }
    ball.ticks += 1;
    const heading = ball.velocity.norm() === 0 ? ball.velocity : ball.velocity.scaled(1 / ball.velocity.norm());
    ball.velocity = ball.velocity.plus(heading.scaled(ball.power)).scaled(FIREBALL_DRAG);
    ball.position = ball.position.plus(ball.velocity);
    parts.server.setServerPosition(ball.entity.id, ball.position);
    if (touchesBot(ball)) return explodeOnBot(ball);
    if (ball.ticks === 1) tellStill(ball);
    else if (ball.ticks === FIRST_TOLD_TICK || ball.ticks % TELL_EVERY_TICKS === 0) {
      tellVelocity(ball);
      tellPosition(ball);
    }
  };
  onServerTick(parts.server, () => [...balls.values()].forEach(step));

  return {
    launch(position, motion) {
      const entity = parts.entities.spawn({ name: "fireball", position, velocity: motion.clone() });
      balls.set(entity.id, { entity, position: position.clone(), velocity: motion.clone(), power: FIREBALL_LAUNCH_POWER, ticks: 0 });
      parts.server.setServerPosition(entity.id, position);
      return entity;
    },
    hit(entity) {
      const ball = balls.get(entity.id);
      if (ball === undefined) return null;
      if (!inEntityReach(bot, parts.server, entity)) return "ignored";
      const look = new Vec3(-Math.sin(bot.entity.yaw) * Math.cos(bot.entity.pitch), Math.sin(bot.entity.pitch), -Math.cos(bot.entity.yaw) * Math.cos(bot.entity.pitch));
      ball.velocity = look.scaled(FIREBALL_DEFLECTED_SPEED);
      ball.power = FIREBALL_DEFLECTED_POWER;
      tellVelocity(ball);
      tellStill(ball);
      return "deflected";
    },
  };
}
