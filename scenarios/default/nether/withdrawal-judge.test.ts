// Verify withdrawal arrival and the legacy fallback for cancelled walks.
import { expect, test } from "bun:test";
import { Vec3 } from "vec3";
import { judgeWithdrawal, type WithdrawalSample } from "./withdrawal-judge.ts";

const sample = (): WithdrawalSample => ({
  positionAtWalkEnd: new Vec3(1, 0, 0), positionAfterWindow: new Vec3(6, 0, 0), exit: new Vec3(0, 0, 0),
  final: { deaths: 0, health: 20, dimension: "the_nether" }, returned: { result: { status: "succeeded" } },
});

test("a successful withdrawal remains at the exit after displacement in the window", () => {
  expect(judgeWithdrawal(sample())).toEqual({ atExit: true, passed: true });
});

test("successful withdrawal uses the inclusive two-block boundary", () => {
  const s = sample();
  s.positionAtWalkEnd = new Vec3(1.99, 0, 0);
  expect(judgeWithdrawal(s).atExit).toBe(true);
  s.positionAtWalkEnd = new Vec3(2, 0, 0);
  expect(judgeWithdrawal(s).atExit).toBe(true);
  s.positionAtWalkEnd = new Vec3(2.01, 0, 0);
  expect(judgeWithdrawal(s).atExit).toBe(false);
});

test("a cancelled walk retains the post-window exit reading", () => {
  const s = sample();
  s.returned.result.status = "cancelled";
  s.positionAtWalkEnd = new Vec3(6, 0, 0);
  s.positionAfterWindow = new Vec3(1, 0, 0);
  expect(judgeWithdrawal(s)).toEqual({ atExit: true, passed: true });
});
