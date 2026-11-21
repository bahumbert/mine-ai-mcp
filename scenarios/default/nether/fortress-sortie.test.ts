// The sortie's return: one navigate once the runner is idle, a death that ends the arrival confirmation, and the failed
// detail of a return that was never admitted (plan 2026-11-18-scenario-reds-part3-a2 T18a).
/// <reference types="bun" />
import assert from "node:assert/strict";
import test from "node:test";
import { mock } from "bun:test";
import { COLLECT_MOB_DROP } from "../../../src/actions/hunt-mob/contract.ts";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { DRIVER_CLOCK_STOPPED_MS } from "../../../tests/minecraft/drivers/server-ticks.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import * as runtimeModule from "../../src/runtime.ts";
import * as fortress from "./fortress-common.ts";

const SETTLE_MS = 5 * DRIVER_CLOCK_STOPPED_MS;
const exit = [0, 64, 0] as const;
const succeeded = { status: "succeeded" } as const;

interface SortieTrial {
  readonly rate: number;
  /** A reflex holds the body for this many ticks of world age after the hunt (the return may only start after it). */
  readonly reflexTicks?: number;
  /** The server's clock stops once the hunt returns, so no wait for the runner can end. */
  readonly serverStopsAfterHunt?: boolean;
  /** The bot dies while the arrival is being confirmed. */
  readonly diesInConfirmation?: boolean;
}

/** Drive the real sortie driver with controlled runtime replies and the shared fake bot. */
async function runSortie({ rate, reflexTicks = 0, serverStopsAfterHunt = false, diesInConfirmation = false }: SortieTrial) {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot, combat, server } = createFakeBot({ clock, dimension: "the_nether", carried: { blaze_rod: 1 }, server: { ticksPerSecond: rate } });
  const added = listenersAddedSince(bot);
  const context = { bot, signal: new AbortController().signal, scenario: { params: { exit } }, log() {}, progress() {} } as unknown as MineAiScenarioContext;
  const navigates: { busy: boolean }[] = [];
  const confirmations: { signalAbortedAfterwards: boolean }[] = [];
  let busyUntilAge = 0;
  const runtime = {
    actions: [{ name: COLLECT_MOB_DROP }, { name: "navigate" }],
    async run(action: { name: string }) {
      if (action.name === COLLECT_MOB_DROP) {
        busyUntilAge = reflexTicks === 0 ? 0 : bot.time.age + reflexTicks;
        if (serverStopsAfterHunt) { busyUntilAge = Infinity; server.stop(); }
        return { action: action.name, durationMs: 0, result: succeeded };
      }
      navigates.push({ busy: bot.time.age < busyUntilAge });
      return { action: action.name, durationMs: 400, result: succeeded };
    },
    status: () => {
      const busy = bot.time.age < busyUntilAge;
      return { busy, activeAction: busy ? { action: "hostile_reflex", startedAt: "" } : null, owner: busy ? "foreground" : "idle" };
    },
    async close() {},
  } as unknown as runtimeModule.Runtime;
  const originalRuntime = { ...runtimeModule };
  const originalFortress = { ...fortress };
  mock.module("../../src/runtime.ts", () => ({ ...originalRuntime, openRuntime: async () => runtime }));
  mock.module("./fortress-common.ts", () => ({ ...originalFortress,
    prepareFortress: async () => {}, releaseThreats: async () => {},
    confirmArrival: async (confirmed: MineAiScenarioContext) => {
      if (diesInConfirmation) combat.setHealth(0);
      confirmations.push({ signalAbortedAfterwards: confirmed.signal.aborted });
      return true;
    },
  }));
  try {
    const { run } = await import("./fortress-sortie.ts");
    const outcome = await clock.settle(run(context), SETTLE_MS);
    return { outcome, navigates, confirmations, added };
  } finally {
    mock.module("../../src/runtime.ts", () => originalRuntime);
    mock.module("./fortress-common.ts", () => originalFortress);
  }
}

for (const rate of [20, 10]) {
  test(`the sortie returns only once the reflex has handed the body back, at ${rate} tps`, async () => {
    const { outcome, navigates, confirmations, added } = await runSortie({ rate, reflexTicks: 60 });
    assert.deepEqual(navigates, [{ busy: false }], "the return started while a reflex held the body");
    assert.equal(confirmations.length, 1);
    const detail = JSON.parse(outcome.detail!);
    assert.equal(detail.returns, 0);
    assert.deepEqual(detail.owners, ["hostile_reflex"]);
    assert.equal(added("death"), 0, "the death listener outlived the return");
  });

  test(`a death during the arrival confirmation aborts the confirmation and leaves no listener, at ${rate} tps`, async () => {
    const { confirmations, added } = await runSortie({ rate, diesInConfirmation: true });
    assert.deepEqual(confirmations, [{ signalAbortedAfterwards: true }]);
    assert.equal(added("death"), 0);
  });

  test(`a return the stopped server never lets start fails with the wait's end in the detail, at ${rate} tps`, async () => {
    const { outcome, navigates, confirmations, added } = await runSortie({ rate, serverStopsAfterHunt: true });
    assert.equal(outcome.status, "failed");
    assert.deepEqual(navigates, []);
    assert.deepEqual(confirmations, []);
    const detail = JSON.parse(outcome.detail!);
    assert.equal(detail.returnRun, "not_admitted");
    assert.equal(detail.wait.kind, "stalled");
    assert.deepEqual(detail.wait.owners, ["hostile_reflex"]);
    assert.equal(added("death"), 0);
  });
}
