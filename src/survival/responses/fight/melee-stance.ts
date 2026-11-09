// Observed attackers and hazard identity shared by stance admission and movement.
import { cellKey, type Position3 } from "../../../utils/index.js";
import { hasMeleeKnockbackRoom, meleeKnockbackHazard } from "../../weapons/melee.js";
import type { FightScene } from "./scene.js";

/** The selected quarry and imminent contacts can push from different sides of the body. */
function meleeAttackerEntries(scene: FightScene, defender = scene.target) {
  const attackers = new Map([[scene.target.id, scene.target.position], [defender.id, defender.position]]);
  for (const threat of scene.perception.read()) {
    const entity = scene.bot.entities[threat.id];
    if (threat.meleeImminent && entity?.isValid) attackers.set(entity.id, entity.position);
  }
  return [...attackers.entries()].sort(([a], [b]) => a - b);
}

/** Re-read contacts when a route resolves or its approach watch runs. */
export function meleeAttackers(scene: FightScene, defender = scene.target): readonly Position3[] {
  return meleeAttackerEntries(scene, defender).map(([, position]) => position);
}

/** A refusal belongs only to the same body, attacker identities/cells and observed hazards. */
export function meleeStanceKey(scene: FightScene, defender = scene.target): string {
  const { world } = scene.navigation;
  const position = scene.bot.entity.position;
  const attackers = meleeAttackerEntries(scene, defender).map(([id, attacker]) => [
    id, cellKey(attacker), meleeKnockbackHazard(world, position, [attacker], scene.bot.health),
    hasMeleeKnockbackRoom(world, position, attacker),
  ]);
  return JSON.stringify([cellKey(position), attackers]);
}
