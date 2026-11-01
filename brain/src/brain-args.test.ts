import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { otherAgentsFor, parseBrainArgs } from "./brain-args.ts";

test("without --other-agent the live-run arguments parse as before and an agent's others are the in-process ones but itself", () => {
  // The argument shape of .agent/scripts/live-run/templates/start.sh.
  const { values } = parseBrainArgs([
    "--agent", "ayla.json=http://127.0.0.1:25575/mcp", "--agent", "brea.json=http://127.0.0.1:25576/mcp",
    "--chat-model", "m", "--action-model", "m", "--planner-model", "m", "--known-names", "Opus",
    "--model-slots", "3", "--start-when-free", "--start-gap", "5",
  ]);
  assert.equal(values["other-agent"], undefined);
  assert.deepEqual(values.agent, ["ayla.json=http://127.0.0.1:25575/mcp", "brea.json=http://127.0.0.1:25576/mcp"]);
  assert.equal(values["model-slots"], "3");
  assert.equal(values["start-gap"], "5");
  assert.equal(values["start-when-free"], true);
  assert.equal(values["known-names"], "Opus");
  assert.deepEqual(otherAgentsFor("Ayla", ["Ayla", "Brea"], values["other-agent"] ?? []), ["Brea"]);
  assert.deepEqual(otherAgentsFor("Ayla", ["Ayla"], []), []);
});

test("--other-agent is repeatable and its names join the agent's others", () => {
  const { values } = parseBrainArgs(["--agent", "ayla.json=http://x/mcp", "--other-agent", "Brea", "--other-agent", "Cato"]);
  assert.deepEqual(values["other-agent"], ["Brea", "Cato"]);
  assert.deepEqual(otherAgentsFor("Ayla", ["Ayla"], values["other-agent"] ?? []), ["Brea", "Cato"]);
});

test("--other-agents-file takes a path, absent by default", () => {
  assert.equal(parseBrainArgs(["--agent", "a.json=http://x/mcp"]).values["other-agents-file"], undefined);
  assert.equal(parseBrainArgs(["--other-agents-file", "run/other-agents.json"]).values["other-agents-file"], "run/other-agents.json");
});

test("an agent's own username and a repeated name are dropped, whatever their case", () => {
  assert.deepEqual(otherAgentsFor("Ayla", ["Ayla", "Brea"], ["Ayla", "ayla", "brea", "Cato", "Cato"]), ["Brea", "Cato"]);
});

test("brain-mem.ts, which loads main.ts by import, still runs the brain, whose --help documents --other-agents-file", () => {
  const run = spawnSync(process.execPath, [".agent/scripts/ops/brain-mem.ts", "brain/src/main.ts", "--help"], { encoding: "utf8", env: { ...process.env, BRAIN_MEM_LOG: "/dev/null" }, timeout: 30_000 });
  assert.match(run.stdout, /Usage: bun brain\/src\/main\.ts/);
  assert.match(run.stdout, /--other-agents-file\n/u);
});
