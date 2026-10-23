import test from "node:test";
import assert from "node:assert/strict";
import { formatMessage, forwardedEnv, parseSubmitArgs } from "./submit-args.ts";

test("paths and options are told apart and paths become absolute", () => {
  const args = parseSubmitArgs(["tests/a", "b.yaml", "--repeat", "3", "--lanes", "2", "--out", "out", "--lock"], "/work");
  assert.deepEqual(args, {
    paths: ["/work/tests/a", "/work/b.yaml"], repeat: 3, lanes: 2, out: "/work/out", lock: true, isolated: false, stop: false,
    socket: undefined, port: undefined, holdsLock: false,
  });
});

test("the defaults: one repeat, any number of lanes, output in .mine-labs of the submitter", () => {
  const args = parseSubmitArgs(["x.yaml"], "/work");
  assert.deepEqual([args.repeat, args.lanes, args.out, args.lock, args.isolated], [1, null, "/work/.mine-labs", false, false]);
});

test("--stop needs no path", () => {
  assert.equal(parseSubmitArgs(["--stop"], "/work").stop, true);
});

test("no path and no --stop is refused with the usage", () => {
  assert.throws(() => parseSubmitArgs([], "/work"), /usage/iu);
});

test("an unknown option, a lanes of 0 and a repeat that is not a number are refused naming the option", () => {
  assert.throws(() => parseSubmitArgs(["x.yaml", "--fast"], "/work"), /--fast/u);
  assert.throws(() => parseSubmitArgs(["x.yaml", "--lanes", "0"], "/work"), /--lanes/u);
  assert.throws(() => parseSubmitArgs(["x.yaml", "--repeat", "many"], "/work"), /--repeat/u);
  assert.throws(() => parseSubmitArgs(["x.yaml", "--out"], "/work"), /--out/u);
});

test("--socket and --port are kept for a daemon of your own", () => {
  const args = parseSubmitArgs(["x.yaml", "--socket", "/tmp/mine.sock", "--port", "25300"], "/work");
  assert.deepEqual([args.socket, args.port], ["/tmp/mine.sock", 25_300]);
});

test("a result prints like Mine Labs: outcome, name, seconds, then the goal line", () => {
  const lines = formatMessage({ type: "result", name: "craft/smelt", outcome: "pass", elapsedMs: 12_345, detail: "all goals met", runDir: "/r" });
  assert.deepEqual(lines, ["", "PASS  craft/smelt  12.3s", "  goal: all goals met"]);
});

test("a failing result prints its error before the goal", () => {
  const lines = formatMessage({ type: "result", name: "x", outcome: "error", elapsedMs: 900, detail: "pending", error: "server stalled", runDir: "/r" });
  assert.deepEqual(lines, ["", "ERROR  x  0.9s", "server stalled", "  goal: pending"]);
});

test("a done prints the session line the scripts grep for", () => {
  assert.deepEqual(formatMessage({ type: "done", runs: 5, passed: 4, failed: 1, cancelled: 0 }), ["session: 4/5 passed, 1 failed, 0 cancelled"]);
});

test("wait, info and error messages print their text", () => {
  assert.deepEqual(formatMessage({ type: "wait", text: "a waits: memory" }), ["waiting: a waits: memory"]);
  assert.deepEqual(formatMessage({ type: "error", text: "bad.yaml: broken" }), ["ERROR  bad.yaml: broken"]);
  assert.deepEqual(formatMessage({ type: "info", text: "3 scenarios" }), ["3 scenarios"]);
});

test("the clients get the submitter's MINE_AI_* variables, never the daemon's settings nor a lane offset", () => {
  assert.deepEqual(
    forwardedEnv({ MINE_AI_DIG_TRACE: "/tmp/t", MINE_AI_SCENARIO_EVIDENCE: "1", MINE_AI_SCENARIO_SOCKET_PATH: "/tmp/s", MINE_AI_ARENA: "{}", PATH: "/bin", MINE_AI_UNSET: undefined }),
    { MINE_AI_DIG_TRACE: "/tmp/t", MINE_AI_SCENARIO_EVIDENCE: "1" },
  );
});
