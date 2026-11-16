import test from "node:test";
import assert from "node:assert/strict";
import { classifyEnd, type ClassInput } from "./result-class.ts";

const base: ClassInput = { outcome: "fail", placement: "lane", submissionCancelled: false, startFailed: null, diedBeforeSettle: null, transportFailure: null, hitWallBound: false, late: false, harnessError: null, phases: null, detail: "scenario failed" };

test("classifies outcomes in bench-event precedence order", () => {
  const cases: [Partial<ClassInput>, string, boolean | undefined, string | undefined][] = [
    [{ outcome: "pass", transportFailure: "lost" }, "pass", undefined, undefined],
    [{ submissionCancelled: true, diedBeforeSettle: "dead" }, "cancelled", undefined, undefined],
    [{ startFailed: "boot" }, "infra", false, "boot"],
    [{ startFailed: "boot", placement: "own" }, "infra", true, "boot"],
    [{ diedBeforeSettle: "dead", hitWallBound: true }, "infra", true, "dead"],
    [{ transportFailure: "lost", hitWallBound: true }, "infra", true, "lost"],
    [{ hitWallBound: true, phases: "join=10" }, "product", undefined, "join=10"],
    [{ late: true }, "infra", true, "did not settle"],
    [{ harnessError: "threw" }, "infra", false, "threw"],
    [{ outcome: "cancelled" }, "cancelled", undefined, undefined],
    [{ outcome: "timeout" }, "product", undefined, "scenario failed"],
    [{ outcome: "error" }, "product", undefined, "scenario failed"],
  ];
  for (const [input, expected, selfMade, cause] of cases) {
    const actual = classifyEnd({ ...base, ...input });
    assert.equal(actual.class, expected);
    assert.equal(actual.selfMade, selfMade);
    if (cause) assert.ok(actual.cause?.includes(cause), actual.cause ?? "missing cause");
  }
});
