// Verify traverse arrival and the safety evidence observed afterward.
import { expect, test } from "bun:test";
import { Vec3 } from "vec3";
import { judgeTraverse, type TraverseSample } from "./basalt-judge.ts";

const sample = (): TraverseSample => ({
  travel: { result: { status: "succeeded" } },
  positionAtWalkEnd: new Vec3(35.49, 101, 0.49),
  positionAfterWindow: new Vec3(30.55, 101, 1.39),
  handoff: undefined, shelter: { samples: 0, coveredSamples: 0 },
  state: { deaths: 0, inLava: false, onMagma: false, endermanAttackedFirst: false },
  exercised: true, health: 20, onGround: true, dimension: "the_nether",
});

test("arrival survives displacement after the walk, while final distance describes the window", () => {
  const result = judgeTraverse(sample());
  expect(result.arrived).toBe(true);
  expect(result.finalDistance).toBeCloseTo(6.01619, 5);
  expect(result.passed).toBe(true);
});

test("arrival requires a succeeded walk inside the strict two-block boundary", () => {
  const s = sample();
  s.positionAtWalkEnd = new Vec3(34.51, 101, 0.5);
  expect(judgeTraverse(s).arrived).toBe(true);
  s.positionAtWalkEnd = new Vec3(34.5, 101, 0.5);
  expect(judgeTraverse(s).arrived).toBe(false);
  expect(judgeTraverse(s).passed).toBe(false);
  s.positionAtWalkEnd = new Vec3(34.49, 101, 0.5);
  expect(judgeTraverse(s).arrived).toBe(false);
  s.positionAtWalkEnd = new Vec3(35.5, 101, 0.5);
  s.travel.result.status = "cancelled";
  expect(judgeTraverse(s).arrived).toBe(false);
});

test("lava or death during the window still fails after arrival", () => {
  const s = sample();
  s.state.inLava = true;
  expect(judgeTraverse(s).passed).toBe(false);
  s.state.inLava = false;
  s.state.deaths = 1;
  expect(judgeTraverse(s).passed).toBe(false);
});
