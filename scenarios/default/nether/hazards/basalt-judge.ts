// Judge a basalt traverse from its walk-end position and subsequent safety evidence.
import { Vec3 } from "vec3";

/** Walk-end and post-window snapshots with the evidence used by the traverse verdict. */
export interface TraverseSample {
  travel: { result: { status: string } };
  positionAtWalkEnd: Vec3;
  positionAfterWindow: Vec3;
  handoff: { outcome: string; explosions: number; healthAfter: number } | undefined;
  shelter: { samples: number; coveredSamples: number };
  state: { deaths: number; inLava: boolean; onMagma: boolean; endermanAttackedFirst: boolean };
  exercised: boolean;
  health: number;
  onGround: boolean;
  dimension: string;
}

/** Judge arrival at walk end and safety throughout the following observation window. */
export function judgeTraverse(sample: TraverseSample) {
  const { travel, handoff, shelter, state, health, onGround, exercised, dimension } = sample;
  const finalDistance = sample.positionAfterWindow.distanceTo(new Vec3(36.5, 101, 0.5));
  const arrived = travel.result.status === "succeeded" &&
    sample.positionAtWalkEnd.distanceTo(new Vec3(36.5, 101, 0.5)) < 2;
  const blastHandoff = travel.result.status === "cancelled" && handoff?.outcome === "target_died" &&
    handoff.explosions > 0 && health >= 12 && onGround;
  const sheltered = travel.result.status === "cancelled" && handoff?.outcome === "hidden" &&
    handoff.healthAfter >= 18 && shelter.samples >= 1 && shelter.coveredSamples === shelter.samples;
  const outcome = travel.result.status === "succeeded" && arrived ? "arrived" : sheltered ? "sheltered" :
    blastHandoff ? "blast_handoff" : "incomplete";
  const passed = arrived && health > 0 && exercised && state.deaths === 0 && !state.inLava && !state.onMagma &&
    !state.endermanAttackedFirst && dimension === "the_nether";
  return { arrived, finalDistance, outcome, sheltered, blastHandoff, passed };
}
