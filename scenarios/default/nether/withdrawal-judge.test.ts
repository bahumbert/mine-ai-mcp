// Verify withdrawal arrival: the server confirms it, the last request is judged, and a second return fails.
import { expect, test } from "bun:test";
import { Vec3 } from "vec3";
import { COVER_REFUSED_CODE } from "../../../src/survival/state/cover-obligation.ts";
import { STALLED_CODE } from "../../../src/survival/state/request-stall.ts";
import { judgeWithdrawal, type WithdrawalRequest, type WithdrawalSample } from "./withdrawal-judge.ts";

const succeeded: WithdrawalRequest = { status: "succeeded", evades: 0, error: null, stall: null };
const stalled: WithdrawalRequest = {
  status: "cancelled", evades: 2, error: `${STALLED_CODE} 2 hostile responses (2 evades)`, stall: `${STALLED_CODE} 2 hostile responses (2 evades)`,
};
const refused: WithdrawalRequest = { status: "failed", evades: 0, error: `${COVER_REFUSED_CODE} step 1/3`, stall: null };

const sample = (): WithdrawalSample => ({
  positionAtWalkEnd: new Vec3(1, 0, 0), positionAfterWindow: new Vec3(6, 0, 0), exit: new Vec3(0, 0, 0),
  arrivedOnServer: true, requests: [succeeded],
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

test("a server-confirmed arrival passes when defence moves the bot 3.07 blocks after it", () => {
  const s = sample();
  s.positionAtWalkEnd = new Vec3(0, 0, 0);
  s.positionAfterWindow = new Vec3(3.07, 0, 0);
  expect(judgeWithdrawal(s)).toEqual({ atExit: true, passed: true });
});

test("a succeeded walk the server does not confirm fails", () => {
  const s = sample();
  s.arrivedOnServer = false;
  expect(judgeWithdrawal(s).passed).toBe(false);
  s.arrivedOnServer = null;
  expect(judgeWithdrawal(s).passed).toBe(false);
});

test("a failed last request near the exit fails", () => {
  const s = sample();
  s.requests = [refused];
  s.returned = { result: { status: "failed" } };
  s.arrivedOnServer = null;
  s.positionAtWalkEnd = new Vec3(6, 0, 0);
  s.positionAfterWindow = new Vec3(1, 0, 0);
  expect(judgeWithdrawal(s).passed).toBe(false);
});

test("a cancelled walk that is not a stall fails, even near the exit", () => {
  const s = sample();
  s.requests = [{ status: "cancelled", evades: 0, error: "cancelled by the caller", stall: null }];
  s.returned = { result: { status: "cancelled" } };
  s.arrivedOnServer = null;
  s.positionAfterWindow = new Vec3(1, 0, 0);
  expect(judgeWithdrawal(s).passed).toBe(false);
});

test("the last of two requests is judged", () => {
  const s = sample();
  s.requests = [succeeded, refused];
  s.returned = { result: { status: "failed" } };
  s.arrivedOnServer = null;
  s.positionAfterWindow = new Vec3(1, 0, 0);
  expect(judgeWithdrawal(s).passed).toBe(false);
});

test("a stalled return followed by one succeeded navigate passes when the server confirms it", () => {
  const s = sample();
  s.requests = [stalled, succeeded];
  expect(judgeWithdrawal(s).passed).toBe(true);
});

test("a second return fails", () => {
  const s = sample();
  s.requests = [stalled, stalled, succeeded];
  expect(judgeWithdrawal(s).passed).toBe(false);
});

test("a death during the window fails", () => {
  const s = sample();
  s.final = { deaths: 1, health: 20, dimension: "the_nether" };
  expect(judgeWithdrawal(s).passed).toBe(false);
});
