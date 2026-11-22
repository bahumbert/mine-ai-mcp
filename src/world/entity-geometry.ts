import { Vec3 } from "vec3";
import type { BlockRaycaster } from "./block-visibility.js";

/** A snapshot, independent of controls and of which participant is the attacker. */
export interface EntityBody {
  readonly position: Vec3;
  readonly width: number;
  readonly height: number;
}

export function nearestBodyPoint(from: Vec3, body: EntityBody): Vec3 {
  const p = body.position;
  return new Vec3(
    Math.max(p.x - body.width / 2, Math.min(from.x, p.x + body.width / 2)),
    Math.max(p.y, Math.min(from.y, p.y + body.height)),
    Math.max(p.z - body.width / 2, Math.min(from.z, p.z + body.width / 2)),
  );
}

export function clearCombatRay(world: BlockRaycaster, from: Vec3, to: Vec3): boolean {
  const delta = to.minus(from);
  const distance = delta.norm();
  return distance === 0 || world.raycast(from, delta.scaled(1 / distance), distance) === null;
}

/** Sample the near face and both sides: a wall hiding the centre can still expose the shoulder. */
export function exposedBodyFrom(world: BlockRaycaster, from: Vec3, body: EntityBody): boolean {
  const p = body.position;
  const half = body.width / 2;
  const nearest = nearestBodyPoint(from, body);
  const across = new Vec3(-(p.z - from.z), 0, p.x - from.x);
  const side = across.norm() > 0 ? across.scaled(half / across.norm()) : new Vec3(half, 0, 0);
  return [
    nearest,
    p.offset(0, body.height / 2, 0),
    p.offset(0, body.height - 0.1, 0),
    p.plus(side).offset(0, body.height / 2, 0),
    p.minus(side).offset(0, body.height / 2, 0),
  ].some((point) => clearCombatRay(world, from, point));
}

/**
 * Whether a shooter's eye, or either shoulder of it across its width, sees the body: the projectile
 * verdict, the cover goal and the combat helpers share this one geometry.
 */
export function shooterSeesBody(world: BlockRaycaster, shooter: EntityBody, body: EntityBody): boolean {
  const eye = shooter.position.offset(0, shooter.height * 0.85, 0);
  const half = shooter.width / 2;
  return [eye, eye.offset(half, 0, 0), eye.offset(-half, 0, 0), eye.offset(0, 0, half), eye.offset(0, 0, -half)]
    .some((from) => exposedBodyFrom(world, from, body));
}
