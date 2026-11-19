import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";
import { chatSlotsFor, otherAgentsFor, parseBrainArgs, speakerBudgetLimits } from "./brain-args.ts";

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

test("chatSlotsFor: default, flag refused, env value logged and ignored", () => {
  const logs: string[] = [];
  const log = (line: string): void => void logs.push(line);
  assert.equal(chatSlotsFor(3, undefined, undefined, log), 1);
  assert.equal(chatSlotsFor(1, undefined, undefined, log), 0);
  assert.equal(chatSlotsFor(null, undefined, undefined, log), 0);
  assert.equal(chatSlotsFor(3, "2", undefined, log), 2);
  assert.equal(chatSlotsFor(3, "0", undefined, log), 0);
  assert.throws(() => chatSlotsFor(3, "x", undefined, log), /\[BAD_CHAT_SLOTS\] --chat-slots x: "x" is not a whole number/u, "the refusal quotes the text, never NaN");
  assert.throws(() => chatSlotsFor(3, "1e0", undefined, log), /\[BAD_CHAT_SLOTS\]/u);
  assert.throws(() => chatSlotsFor(3, "", undefined, log), /\[BAD_CHAT_SLOTS\]/u);
  assert.throws(() => chatSlotsFor(3, "3", undefined, log), /\[BAD_CHAT_SLOTS\]/u);
  assert.throws(() => chatSlotsFor(3, "-1", undefined, log), /\[BAD_CHAT_SLOTS\]/u);
  assert.throws(() => chatSlotsFor(null, "1", undefined, log), /\[BAD_CHAT_SLOTS\]/u);
  assert.deepEqual(logs, [], "nothing logged so far");
  assert.equal(chatSlotsFor(1, undefined, "1", log), 0);
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /MODEL_CHAT_SLOTS=1 ignored/u);
  assert.equal(chatSlotsFor(null, undefined, "1", log), 0);
  assert.equal(logs.length, 2);
  assert.equal(chatSlotsFor(3, undefined, "2", log), 2);
  assert.equal(logs.length, 2, "a good env value logs nothing");
  assert.equal(chatSlotsFor(3, "2", "7", log), 2, "the flag wins over the env value");
  assert.equal(logs.length, 2);
});

test("--chat-slots takes a value, absent by default", () => {
  assert.equal(parseBrainArgs(["--agent", "a.json=http://x/mcp"]).values["chat-slots"], undefined);
  assert.equal(parseBrainArgs(["--chat-slots", "2"]).values["chat-slots"], "2");
});

test("--stop-words takes a value, absent by default", () => {
  assert.equal(parseBrainArgs(["--agent", "a.json=http://x/mcp"]).values["stop-words"], undefined);
  assert.equal(parseBrainArgs(["--stop-words", "stop,stop it"]).values["stop-words"], "stop,stop it");
});

test("--speaker-chat-per-minute and --speaker-chat-burst take a value, absent by default", () => {
  assert.equal(parseBrainArgs(["--agent", "a.json=http://x/mcp"]).values["speaker-chat-per-minute"], undefined);
  const { values } = parseBrainArgs(["--speaker-chat-per-minute", "3", "--speaker-chat-burst", "9"]);
  assert.deepEqual([values["speaker-chat-per-minute"], values["speaker-chat-burst"]], ["3", "9"]);
});

test("speakerBudgetLimits: defaults 6 a minute and 15 held, bad values refuse to start, 0 a minute turns it off", () => {
  assert.deepEqual(speakerBudgetLimits(undefined, undefined), { perMinute: 6, burst: 15 });
  assert.deepEqual(speakerBudgetLimits("0", "1"), { perMinute: 0, burst: 1 });
  assert.throws(() => speakerBudgetLimits("x", undefined), /\[BAD_START_ARG\] --speaker-chat-per-minute expects a whole number \(0 or more\), got x/u);
  assert.throws(() => speakerBudgetLimits(undefined, "0"), /\[BAD_START_ARG\] --speaker-chat-burst expects a whole number \(1 or more\), got 0/u);
  assert.throws(() => speakerBudgetLimits("-1", undefined), /got -1/u);
});

// CI checks out the public repository, which has no .agent: the script is run wherever it is present.
const BRAIN_MEM = ".agent/scripts/ops/brain-mem.ts";

test("brain-mem.ts, which loads main.ts by import, still runs the brain, whose --help documents --other-agents-file", { skip: existsSync(BRAIN_MEM) ? false : ".agent is not in this checkout (the public repository has none)" }, () => {
  const run = spawnSync(process.execPath, [BRAIN_MEM, "brain/src/main.ts", "--help"], { encoding: "utf8", env: { ...process.env, BRAIN_MEM_LOG: "/dev/null" }, timeout: 30_000 });
  assert.match(run.stdout, /Usage: bun brain\/src\/main\.ts/);
  assert.match(run.stdout, /--other-agents-file\n/u);
});
