import test from "node:test";
import assert from "node:assert/strict";
import { daemonCommand, daemonEnv, daemonLockPath } from "./daemon-launch.ts";

test("the default socket's daemon lock is the plan's /tmp/mine-ai-scenario-server.lock", () => {
  assert.equal(daemonLockPath("/tmp/mine-ai-scenarios.sock"), "/tmp/mine-ai-scenario-server.lock");
});

test("a daemon of your own on another socket has its own lock next to it, so both can run", () => {
  assert.equal(daemonLockPath("/tmp/mine-w4.sock"), "/tmp/mine-w4.sock.lock");
});

test("the daemon is started under a non-blocking flock so a second start exits instead of waiting", () => {
  const [program, ...args] = daemonCommand("/repo/tests/minecraft/shared/daemon.ts", "/tmp/mine-w4.sock", 25_300, "/usr/bin/bun");
  assert.equal(program, "flock");
  assert.deepEqual(args, ["-n", "/tmp/mine-w4.sock.lock", "/usr/bin/bun", "/repo/tests/minecraft/shared/daemon.ts", "--socket", "/tmp/mine-w4.sock", "--port", "25300"]);
});

test("without a socket or port the daemon gets neither option", () => {
  const [, ...args] = daemonCommand("/d.ts", undefined, undefined, "bun");
  assert.deepEqual(args, ["-n", "/tmp/mine-ai-scenario-server.lock", "bun", "/d.ts"]);
});

test("the daemon starts without the first submitter's MINE_AI_* client variables, which would reach every later submitter's clients", () => {
  const env = daemonEnv({ MINE_AI_DIG_TRACE: "/tmp/t", MINE_AI_SCENARIO_EVIDENCE: "1", MINE_AI_SCENARIO_MSPT_ADMIT_MS: "30", PATH: "/bin" });
  assert.deepEqual(env, { MINE_AI_SCENARIO_MSPT_ADMIT_MS: "30", PATH: "/bin" });
});
