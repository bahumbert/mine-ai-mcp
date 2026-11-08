import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { DEFAULT_DATA_ROOT, parseHostOptions } from "./config.js";
import { RUNTIME_RESTART } from "./runtime-liveness.js";

test("defaults to persistent personal bot data, and to no unrestricted JavaScript execution", () => {
  const options = parseHostOptions([]);

  assert.deepEqual(options.botData, {
    storage: {
      kind: "persistent",
      root: path.resolve(DEFAULT_DATA_ROOT),
    },
    scope: "bot",
  });
  assert.equal(options.debugExecuteJavaScript, false);
  assert.equal(options.neoforgeComponents, null);
  // Debug execution is reachable only through its own explicit flag.
  assert.equal(parseHostOptions(["--debug-execute-javascript"]).debugExecuteJavaScript, true);
});

test("temporary bot data has no meaningless persistent root", () => {
  const options = parseHostOptions([
    "--bot-data-persistence",
    "temporary",
    "--data-root",
    "ignored-for-temporary-data",
  ]);

  assert.deepEqual(options.botData, {
    storage: { kind: "temporary" },
    scope: "bot",
  });
});

test("rejects unknown bot-data choices at the host boundary", () => {
  assert.throws(
    () => parseHostOptions(["--bot-data-persistence", "sometimes"]),
    /--bot-data-persistence must be one of persistent, temporary/,
  );
  assert.throws(
    () => parseHostOptions(["--bot-data-scope", "team"]),
    /--bot-data-scope must be one of bot, shared/,
  );
});

test("the chat command prefix is off unless given, and a prefix that is not one chat line is refused", () => {
  assert.equal(parseHostOptions([]).chatCommandPrefix, null);
  assert.equal(parseHostOptions(["--chat-command-prefix", "!"]).chatCommandPrefix, "!");
  assert.equal(parseHostOptions(["--chat-command-prefix", "!b"]).chatCommandPrefix, "!b");
  for (const refused of ["", "/x", "a b", "!!!!", " "]) {
    assert.throws(
      () => parseHostOptions(["--chat-command-prefix", refused]),
      /--chat-command-prefix must be 1 to 3 characters, with no whitespace, not starting with "\/"/,
      JSON.stringify(refused),
    );
  }
});

test("the restart settings default to the runtime's", () => {
  assert.deepEqual(parseHostOptions([]).restart, RUNTIME_RESTART);
});

test("restart flags set the delays, attempts and reset time", () => {
  const { restart } = parseHostOptions([
    "--restart-delays-ms", "0-0,1000-2000",
    "--restart-attempts", "3",
    "--restart-reset-after-ms", "60000",
  ]);
  assert.deepEqual(restart, {
    delays: [{ minMs: 0, maxMs: 0 }, { minMs: 1000, maxMs: 2000 }],
    attempts: 3,
    healthyMs: 60000,
  });
});

test("bad restart flags are refused at start, naming the flag", () => {
  // 2147483648 does not fit a timer: the runtime would restart after 1 ms while the failure promised a date years away.
  for (const refused of ["5000-0", "abc", "", "0-5000,", "-1-5", "1.5-2", "0-2147483648"]) {
    assert.throws(
      () => parseHostOptions([`--restart-delays-ms=${refused}`]),
      (error: Error) =>
        /--restart-delays-ms must be a comma list of <min>-<max> whole milliseconds with min <= max/.test(error.message) &&
        error.message.includes(`received ${JSON.stringify(refused)}`),
      JSON.stringify(refused),
    );
  }
  assert.throws(() => parseHostOptions(["--restart-attempts", "0"]), /--restart-attempts must be a positive integer/);
  assert.throws(() => parseHostOptions(["--restart-reset-after-ms=-1"]), /--restart-reset-after-ms must be a positive integer/);
});
