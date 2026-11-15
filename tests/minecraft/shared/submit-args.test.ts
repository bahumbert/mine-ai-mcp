import test from "node:test";
import assert from "node:assert/strict";
import { exitCodeOf, formatMessage, forwardedEnv, parseSubmitArgs, submitEnv } from "./submit-args.ts";

test("featured results, totals and exit codes distinguish infrastructure", () => {
  const result = { type: "result", name: "x", outcome: "error", elapsedMs: 1000, detail: "pending", runDir: "/r" } as const;
  assert.ok(formatMessage({ ...result, class: "infra", cause: "socket" }).includes("  cause: socket"));
  assert.ok(formatMessage({ ...result, class: "infra" })[1]!.startsWith("INFRA  x  1.0s"));
  assert.match(formatMessage({ ...result, outcome: "pass", class: "pass", retried: "server died: y" })[1]!, /after an infra retry: server died: y/u);
  const done = { type: "done", runs: 6, passed: 3, failed: 3, cancelled: 0, infra: 2 } as const;
  assert.deepEqual(formatMessage(done), ["session: 3/6 passed, 3 failed, 2 infra, 0 cancelled"]);
  for (const [failed, infra, cancelled, expected] of [[0, 0, 0, 0], [2, 2, 0, 3], [3, 2, 0, 1], [2, 2, 1, 1], [1, undefined, 0, 1]] as const) {
    assert.equal(exitCodeOf({ ...done, failed, infra, cancelled }), expected);
  }
  assert.equal(submitEnv({ MINE_AI_SUBMIT_FEATURES: "wrong" }).MINE_AI_SUBMIT_FEATURES, "classes");
});

test("paths and options are told apart and paths become absolute", () => {
  const args = parseSubmitArgs(["tests/a", "b.yaml", "--repeat", "3", "--lanes", "2", "--out", "out", "--lock"], "/work");
  assert.deepEqual(args, {
    paths: ["/work/tests/a", "/work/b.yaml"], repeat: 3, lanes: 2, out: "/work/out", lock: true, isolated: false, stop: false,
    socket: undefined, port: undefined, hold: false, tickRate: null,
  });
});

test("tick rate accepts 1 through 20 including decimals and refuses isolated runs", () => {
  for (const [value, expected] of [["10", 10], ["2.5", 2.5]] as const) assert.equal(parseSubmitArgs(["x", "--tick-rate", value], "/work").tickRate, expected);
  for (const value of ["0", "0.5", "21", "x"]) assert.throws(() => parseSubmitArgs(["x", "--tick-rate", value], "/work"), /--tick-rate/u);
  assert.throws(() => parseSubmitArgs(["x", "--tick-rate"], "/work"), /--tick-rate/u);
  assert.throws(() => parseSubmitArgs(["x", "--tick-rate", "5", "--isolated"], "/work"), /--tick-rate needs the daemon/u);
});

test("--hold is the load batch's flag, and --holds-lock (the old inner run of a flock) no longer exists", () => {
  assert.equal(parseSubmitArgs(["x.yaml", "--hold"], "/work").hold, true);
  assert.equal(parseSubmitArgs(["x.yaml"], "/work").hold, false);
  assert.throws(() => parseSubmitArgs(["x.yaml", "--holds-lock"], "/work"), /--holds-lock/u);
});

test("--lock only asks the daemon for servers of the batch's own: parsing it takes no file lock and re-runs nothing", () => {
  const args = parseSubmitArgs(["x.yaml", "--lock", "--lanes", "1"], "/work");
  assert.deepEqual([args.lock, args.hold, args.lanes], [true, false, 1]);
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

test("a relative MINE_AI_DIG_TRACE is made absolute against the submitter's directory, so it names the same file whatever cwd the client starts in", () => {
  assert.equal(forwardedEnv({ MINE_AI_DIG_TRACE: "traces/dig.jsonl" }, "/work/tree").MINE_AI_DIG_TRACE, "/work/tree/traces/dig.jsonl");
  assert.equal(forwardedEnv({ MINE_AI_DIG_TRACE: "/tmp/t" }, "/work/tree").MINE_AI_DIG_TRACE, "/tmp/t");
  assert.equal(forwardedEnv({ MINE_AI_DIG_TRACE: "traces/dig.jsonl" }).MINE_AI_DIG_TRACE, "traces/dig.jsonl", "without a directory the value is forwarded as it is");
  assert.equal(forwardedEnv({ MINE_AI_SCENARIO_EVIDENCE: "rel/x" }, "/work/tree").MINE_AI_SCENARIO_EVIDENCE, "rel/x", "only the dig trace is a path");
});
