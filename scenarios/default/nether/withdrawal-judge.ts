// Judge fortress withdrawal: the server confirms the arrival, the last request succeeded, and at most one return happened.
import { Vec3 } from "vec3";
import { COVER_REFUSED_CODE } from "../../../src/survival/state/cover-obligation.ts";
import { STALLED_CODE } from "../../../src/survival/state/request-stall.ts";

/** One navigate request of the withdrawal: its status, its `[HOSTILE_CONTACT]` count and its error text, if any. */
export interface WithdrawalRequest {
  status: string;
  evades: number;
  error: string | null;
  /** The stall reason when the request ended stalled (`STALLED_CODE`), else null. */
  stall: unknown | null;
}

/** Walk-end and post-window positions, the requests in order, the server's arrival answer and final safety evidence. */
export interface WithdrawalSample {
  positionAtWalkEnd: Vec3;
  positionAfterWindow: Vec3;
  exit: Vec3;
  /** Whether the server confirmed the bot within 2 blocks of the exit (`confirmArrival`); null when not asked. */
  arrivedOnServer: boolean | null;
  requests: readonly WithdrawalRequest[];
  final: { deaths: number; health: number; dimension: string };
  returned: { result: { status: string } };
}

/** A navigate's output as the judge reads it: the result status and error text, and the interruption reasons. */
export function requestOf(returned: { result: { status: string; error?: unknown }; interruptions?: readonly string[] }): WithdrawalRequest {
  const error = typeof returned.result.error === "string" ? returned.result.error : null;
  return {
    status: returned.result.status,
    evades: (returned.interruptions ?? []).filter((text) => text.includes("[HOSTILE_CONTACT]")).length,
    error,
    stall: error?.includes(STALLED_CODE) ? error : null,
  };
}

/** A return: a request cancelled by a stall, or failed by a refused cover route. */
export function isReturn(request: WithdrawalRequest): boolean {
  const coded = request.error ?? "";
  return (request.status === "cancelled" && coded.includes(STALLED_CODE))
    || (request.status === "failed" && coded.includes(COVER_REFUSED_CODE));
}

/**
 * The server's answer decides the arrival; the window's later position is recorded, not judged.
 * Passed: the last request succeeded, the server confirmed the arrival, at most one return happened, and the bot lived.
 */
export function judgeWithdrawal(sample: WithdrawalSample) {
  const atExit = sample.positionAtWalkEnd.distanceTo(sample.exit) <= 2;
  const last = sample.requests[sample.requests.length - 1];
  const returns = sample.requests.filter(isReturn).length;
  const { final } = sample;
  const passed = last?.status === "succeeded" && sample.arrivedOnServer === true && returns <= 1
    && final.deaths === 0 && final.health > 0 && final.dimension === "the_nether";
  return { atExit, passed };
}
