import assert from "node:assert/strict";
import test from "node:test";
import { CLIENT_HOST_USAGE, parseClientHostArgs } from "./client-host-args.ts";

test("a driver alone runs with the runtime, as every scenario did before the flag", () => {
  assert.deepEqual(parseClientHostArgs(["drivers/single-action.ts"]), { driverFile: "drivers/single-action.ts", withRuntime: true });
});

test("--without-runtime after the driver runs it on the bare bot", () => {
  assert.deepEqual(parseClientHostArgs(["drivers/bot-contract.ts", "--without-runtime"]), { driverFile: "drivers/bot-contract.ts", withRuntime: false });
});

test("no driver, the flag first, an unknown argument or a repeated flag is the usage error", () => {
  for (const args of [[], ["--without-runtime"], ["drivers/a.ts", "--verbose"], ["drivers/a.ts", "--without-runtime", "--without-runtime"]]) {
    assert.throws(() => parseClientHostArgs(args), { message: CLIENT_HOST_USAGE }, JSON.stringify(args));
  }
});
