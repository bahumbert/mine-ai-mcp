/** A flying dragon's current safe bow intercept, rechecked throughout the draw. */
import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import type { DragonShotObservation } from "../../perception/combat/dragon-shot.js";
import { endermanGazeRisk } from "../../perception/combat/gaze.js";
import { bowTrajectory, clearBowTrajectory } from "../../weapons/bow-trajectory.js";
import { fitsDragonShot } from "../../weapons/dragon-shot.js";

/** Lead the body centre; the parent's 16-wide box is not a hitbox. */
export function aimDragonBow(bot: Bot, observation: DragonShotObservation, origin: Vec3) {
  const dragon = observation.target!, velocity = observation.velocity, previousVelocity = observation.previousVelocity;
  if (!velocity || !previousVelocity) { observation.blockedBy = "Waiting for fresh dragon motion."; return null; }
  const target = dragon.position.offset(Math.sin(dragon.yaw) * 0.5, 1.5, Math.cos(dragon.yaw) * 0.5);
  if (bot.entity.position.distanceTo(target) > 64) {
    observation.blockedBy = "Dragon is beyond the 64-block firing range; move closer or wait for its next pass.";
    return null;
  }
  const trajectory = bowTrajectory(origin, target, velocity);
  if (!trajectory || !clearBowTrajectory(trajectory, (p, d, n) => bot.world.raycast(p, d, n))) {
    observation.blockedBy = "No clear intercept from this footing; wait for a pass or move to an exposed position.";
    return null;
  }
  if (!fitsDragonShot(trajectory.points.at(-1)!, target, velocity, previousVelocity,
      trajectory.flightTicks, observation.hitboxMargin)) {
    observation.blockedBy = "Dragon motion leaves the inset body estimates; holding the arrow for a steadier or closer pass.";
    return null;
  }
  const yaw = Math.atan2(-trajectory.velocity.x, -trajectory.velocity.z);
  const pitch = Math.atan2(trajectory.velocity.y, Math.hypot(trajectory.velocity.x, trajectory.velocity.z));
  if (endermanGazeRisk(bot, bot.entity.position, yaw, pitch)) {
    observation.blockedBy = "An Enderman obstructs the safe aim direction.";
    return null;
  }
  observation.blockedBy = null;
  return { trajectory, yaw, pitch };
}
