// Regression for wounded withdrawal policy setup (T5, 2026-11-16).
/// <reference types="bun" />
import assert from "node:assert/strict";
import test from "node:test";
import { mock } from "bun:test";
import { createFakeBot } from "../../../src/test-support/fake-bot/index.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import * as runtimeModule from "../../src/runtime.ts";
import * as fortress from "./fortress-common.ts";

test("withdrawal disables hide before releasing the threats", async () => {
  const { bot } = createFakeBot({ username: "FortressBot", loadedColumns: [] });
  bot.setMaxListeners(40);
  const context = { bot, signal: new AbortController().signal, scenario: { params: { exit: [0, 64, 0] } }, log: () => {} } as unknown as MineAiScenarioContext;
  let runtime: runtimeModule.Runtime | undefined;
  const released = new Error("release checked");
  const originalRuntime = { ...runtimeModule };
  const originalFortress = { ...fortress };
  mock.module("../../src/runtime.ts", () => ({ ...originalRuntime, openRuntime: async (...args: Parameters<typeof runtimeModule.openRuntime>) => {
    runtime = await originalRuntime.openRuntime(...args);
    return runtime;
  } }));
  mock.module("./fortress-common.ts", () => ({ ...originalFortress, prepareFortress: async () => {},
    releaseThreats: async () => {
      assert.ok(runtime, "runtime must open while threats are frozen");
      assert.equal(runtime.status().survivalPolicy.effective.combat.hide, "never");
      throw released;
    },
  }));
  try {
    const { run } = await import("./fortress-withdrawal.ts");
    await assert.rejects(run(context), released);
  } finally {
    mock.restore();
    mock.module("../../src/runtime.ts", () => originalRuntime);
    mock.module("./fortress-common.ts", () => originalFortress);
    assert.equal(runtimeModule.openRuntime, originalRuntime.openRuntime);
    assert.equal(fortress.prepareFortress, originalFortress.prepareFortress);
    assert.equal(fortress.releaseThreats, originalFortress.releaseThreats);
  }
});
