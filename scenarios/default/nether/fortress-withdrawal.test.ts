// Regression for wounded withdrawal policy setup (T5, 2026-11-16).
/// <reference types="bun" />
import assert from "node:assert/strict";
import test from "node:test";
import { mock } from "bun:test";
import { NAVIGATE } from "@aibengineering/mine-ai-mcp";
import { createFakeBot } from "../../../src/test-support/fake-bot/index.ts";
import { STALLED_CODE } from "../../../src/survival/state/request-stall.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import * as runtimeModule from "../../src/runtime.ts";
import * as fortress from "./fortress-common.ts";
import * as idleWindow from "../../flat/combat/idle-reflex-window.ts";
import * as reflex from "../../flat/combat/reflex.ts";

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

test("a stalled return starts one new navigate", async () => {
  const { bot } = createFakeBot({ username: "FortressBot", loadedColumns: [], dimension: "the_nether" });
  bot.setMaxListeners(40);
  const context = { bot, signal: new AbortController().signal, scenario: { params: { exit: [-490, 60, 270] } }, log: () => {} } as unknown as MineAiScenarioContext;
  const navigates: unknown[] = [];
  const outputs = [
    {
      result: { status: "cancelled", error: `${STALLED_CODE} 2 hostile responses (2 evades) from zombie#7 over 1700 server ticks without progress on navigate` },
      interruptions: ["[HOSTILE_CONTACT] evade response for zombie#7", "[HOSTILE_CONTACT] evade response for zombie#7"],
    },
    { result: { status: "succeeded" }, interruptions: [] },
  ];
  const runtime = {
    actions: [{ name: "set_survival_policy" }, { name: NAVIGATE }],
    run: async (action: { name: string }, input: unknown) => {
      if (action.name === "set_survival_policy") return { result: { status: "succeeded" } };
      navigates.push(input);
      return outputs[navigates.length - 1];
    },
    status: () => ({ survivalPolicy: { revision: 0, effective: { combat: { hide: "never" } } } }),
    close: async () => {},
  } as unknown as runtimeModule.Runtime;
  const originalRuntime = { ...runtimeModule };
  const originalFortress = { ...fortress };
  const originalIdle = { ...idleWindow };
  const originalReflex = { ...reflex };
  mock.module("../../src/runtime.ts", () => ({ ...originalRuntime, openRuntime: async () => runtime }));
  mock.module("./fortress-common.ts", () => ({ ...originalFortress, prepareFortress: async () => {}, releaseThreats: async () => {},
    confirmArrival: async () => true }));
  mock.module("../../flat/combat/idle-reflex-window.ts", () => ({ ...originalIdle, observeIdleWindow: async () => ({ observedTicks: 100 }) }));
  mock.module("../../flat/combat/reflex.ts", () => ({ ...originalReflex, readEncounters: async () => [] }));
  try {
    const { run } = await import("./fortress-withdrawal.ts");
    const outcome = await run(context);
    assert.equal(outcome?.status, "succeeded");
    assert.deepEqual(navigates, [
      { x: -490, y: 60, z: 270, range: 1 },
      { x: -490, y: 60, z: 270, range: 1 },
    ]);
  } finally {
    mock.restore();
    mock.module("../../src/runtime.ts", () => originalRuntime);
    mock.module("./fortress-common.ts", () => originalFortress);
    mock.module("../../flat/combat/idle-reflex-window.ts", () => originalIdle);
    mock.module("../../flat/combat/reflex.ts", () => originalReflex);
  }
});
