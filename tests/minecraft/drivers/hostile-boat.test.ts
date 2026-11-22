// The physical driver keeps its seat checks through the fight and cancels before the approach resumes.
import assert from "node:assert/strict";
import test from "node:test";
import { loadScenario } from "mine-labs";
import { Vec3 } from "vec3";
import { createFakeBot, createFakeClock, itemOf } from "../../../src/test-support/fake-bot/index.ts";
import { watchVehicle } from "../../../src/actions/navigate/vehicle-sync.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import { run } from "./hostile-boat.ts";
import { carriedBoats } from "./boat-state.ts";

const scenario = await loadScenario(new URL("../scenarios/boat/hostile-at-sea-seated.yaml", import.meta.url).pathname);

test("the at-sea driver rejects a seat lost before hurt or before the kill", async () => {
  for (const lossAt of ["before hurt", "before kill"]) {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    const world = createFakeBot({ clock, entities: { 7: { name: "oak_boat", position: new Vec3(0.5, 64, 0.5) },
      8: { name: "zombie", position: new Vec3(2.5, 64, 0.5) } } });
    const stop = watchVehicle(world.bot);
    let navigates = 0;
    try {
      const pending = run(scenarioTestContext({ bot: world.bot, scenario,
        call: async (action) => {
          if (action === "navigate" && ++navigates === 1) {
            world.bot.mount(world.bot.entities[7]!);
            clock.after(100, () => {
              if (lossAt === "before hurt") world.entities.remove(7);
              world.combat.hurtBot(1, 8);
            });
            clock.after(200, () => {
              world.combat.hurt(8, null, 1);
              if (lossAt === "before kill") world.entities.remove(7);
              world.combat.kill(8);
            });
          }
          return { action, durationMs: 0, result: { status: "succeeded" }, summary: "fixture completed" };
        },
      }));
      assert.equal((await clock.settle(pending, 1_000)).status, "failed", lossAt);
    } finally { stop(); }
  }
});

// Age packets arrive in +20 jumps: contract/checks/world-age-at-slow-tick.ts. Seat, hurt and kill evidence:
// boat/hostile-{at-sea-seated,near-shore-take-back}, facts/boat-seated-response-and-get-off.md.
// The budget rows at each rate (20 and 10 tps; 5 tps is the labelled stress rate, add-scenario-test S2). The response
// budget is 80 ticks and the off budget 40 ticks, so each edge has a row on the success side and one above it.
const budgetRows = [
  { name: "seated at age zero", atSea: true, effectTicks: 0, want: "succeeded" },
  { name: "seated below", atSea: true, effectTicks: 60, want: "succeeded" },
  { name: "seated at response edge", atSea: true, effectTicks: 80, want: "succeeded" },
  { name: "seated above", atSea: true, effectTicks: 100, want: "failed" },
  { name: "shore valid", atSea: false, effectTicks: 60, offTicks: 20, want: "succeeded" },
  { name: "shore at off edge", atSea: false, effectTicks: 60, offTicks: 40, want: "succeeded" },
  { name: "shore above off", atSea: false, effectTicks: 60, offTicks: 60, want: "failed" },
  { name: "shore at response edge", atSea: false, effectTicks: 80, offTicks: 20, want: "succeeded" },
  { name: "shore above response", atSea: false, effectTicks: 100, offTicks: 20, want: "failed" },
];

for (const rate of [20, 10, 5]) {
  for (const { name, atSea, effectTicks, offTicks, want } of budgetRows) {
    const label = rate === 5 ? " (stress, S2)" : "";
    test(`hostile response and dismount budgets at ${rate} tps${label}: ${name}`, async () => {
      const clock = createFakeClock({ mode: "mocked" });
      using _timers = clock.install();
      const world = createFakeBot({ clock, server: { ticksPerSecond: rate, startAge: 0 }, entities: {
        7: { name: "oak_boat", position: new Vec3(0.5, 64, 0.5) },
        8: { name: "zombie", position: new Vec3(2.5, 64, 0.5) },
      } });
      const stop = watchVehicle(world.bot);
      let navigates = 0;
      let cancelled = false;
      const calls: string[] = [];
      try {
        const pending = run(scenarioTestContext({ bot: world.bot, scenario: { ...scenario,
          params: { ...scenario.params, atSea, responseWithinTicks: 80, offWithinTicks: 40 },
        }, call: async (action) => {
          calls.push(action);
          if (action === "cancel_foreground_action") cancelled = true;
          if (action === "navigate" && ++navigates === 1) {
            world.bot.mount(world.bot.entities[7]!);
            clock.after(100, () => world.combat.hurtBot(1, 8));
            if (offTicks !== undefined) clock.after(offTicks * 1_000 / rate + 150, () => {
              world.entities.remove(7);
              world.inventory.updateSlot(36, itemOf(world.bot.registry, "oak_boat"));
            });
            clock.after(effectTicks * 1_000 / rate + 150, () => {
              world.combat.hurt(8, null, 1);
              world.combat.kill(8);
              // T17e t00044: a resumed approach can leave the boat before the next observation poll.
              if (atSea && !cancelled) world.entities.remove(7);
            });
          }
          return { action, durationMs: 0, result: { status: "succeeded" }, summary: "fixture completed" };
        } }));
        const result = await clock.settle(pending, 30_000);
        assert.equal(result.status, want, JSON.stringify({ rate, atSea, effectTicks, offTicks, detail: result.detail }));
        assert.equal(navigates, want === "succeeded" ? 2 : 1, "only a successful response starts the next navigate");
        if (want === "succeeded") {
          // The response is cancelled before the next navigate, whatever the seat (a cleanup cancel after it does not count).
          const nextNavigate = calls.lastIndexOf("navigate");
          assert.ok(calls.slice(0, nextNavigate).includes("cancel_foreground_action"), "the response is cancelled before the next navigate");
        }
        if (want === "succeeded" && !atSea) assert.ok(carriedBoats(world.bot) > 0, "the near-shore response carries its boat");
        if (want === "succeeded") {
          // The observed packet age, not the ms offset, is what the budget counts (world-age-at-slow-tick.ts).
          assert.match(result.detail ?? "", new RegExp(`hurt-to-effect ${effectTicks} ticks`));
          if (!atSea) assert.match(result.detail ?? "", new RegExp(`hurt-to-off ${offTicks} ticks`));
        }
        if (want === "succeeded" && atSea) assert.equal(world.bot.vehicle?.id, 7, "the response retains its boat");
      } finally { stop(); }
    });
  }
}

test("the hostile driver fails a stopped server clock and removes its observation listeners", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const { bot, server } = createFakeBot({ clock });
  server.stop();
  const events = ["entityHurt", "entityDead", "mount"] as const;
  const before = events.map((event) => bot.listenerCount(event));
  const pending = run(scenarioTestContext({ bot, scenario: { ...scenario,
    params: { ...scenario.params, responseWithinTicks: 80 },
  }, call: async (action) => ({ action, durationMs: 0, result: { status: "succeeded" }, summary: "fixture completed" }) }));
  const result = await clock.settle(pending, 30_000);
  assert.equal(result.status, "failed");
  assert.match(result.detail ?? "", /clock stood still/);
  assert.deepEqual(events.map((event) => bot.listenerCount(event)), before);
});
