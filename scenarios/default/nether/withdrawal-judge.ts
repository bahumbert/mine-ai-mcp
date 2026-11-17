// Judge fortress withdrawal using the walk-end and post-window observations.
import { Vec3 } from "vec3";

/** Walk-end and post-window positions, return status and final safety evidence. */
export interface WithdrawalSample {
  positionAtWalkEnd: Vec3;
  positionAfterWindow: Vec3;
  exit: Vec3;
  final: { deaths: number; health: number; dimension: string };
  returned: { result: { status: string } };
}

/** Judge successful arrival at walk end, retaining the post-window reading for other returns. */
export function judgeWithdrawal(sample: WithdrawalSample) {
  const position = sample.returned.result.status === "succeeded" ? sample.positionAtWalkEnd : sample.positionAfterWindow;
  const atExit = position.distanceTo(sample.exit) <= 2;
  const { final } = sample;
  const passed = final.deaths === 0 && final.health > 0 && final.dimension === "the_nether" && atExit;
  return { atExit, passed };
}
