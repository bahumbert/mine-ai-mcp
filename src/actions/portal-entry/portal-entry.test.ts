import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { CarriedCounts } from "../../test-support/carried-counts.js";
import { type FakeHarness, createFakeBot } from "../../test-support/fake-bot/index.js";
import { parseNavigateRequest } from "../navigate/contract.js";
import { parseEndPortalRequest, parseNetherPortalRequest } from "./contract.js";
import { personalRespawnObservation, recordPersonalRespawn } from "./respawn-knowledge.js";
import { portalSupplyWarning } from "./portal-policy.js";
import { beginPortalEntry, endRespawnProblem, enterPortalAction } from "./portal-entry.js";

/** Rewrite how many of `name` the harness's window carries, as the server's slot updates would. */
function carry(harness: FakeHarness, name: string, total: number): void {
  new CarriedCounts(harness.inventory, harness.bot.registry).set(harness.bot.registry.itemsByName[name]!.id, total);
}

test("portal inputs live only on their dedicated actions", () => {
  assert.throws(() => parseNavigateRequest({ x: 1, y: 64, z: 1, destination_dimension: "the_end" }));
  assert.deepEqual(parseNetherPortalRequest({ x: 1, y: 64, z: 1 }), {
    kind: "nether", x: 1, y: 64, z: 1, allowLowSupplies: false, respawnWithin: 128, allowDistantRespawn: false,
  });
  assert.deepEqual(parseEndPortalRequest({ x: 1, y: 64, z: 1 }), {
    kind: "end", x: 1, y: 64, z: 1, allowLowSupplies: false, respawnWithin: 128, allowDistantRespawn: false,
  });
  assert.equal(parseEndPortalRequest({ x: 1, y: 64, z: 1, respawn_within: 32, allow_distant_respawn: true }).respawnWithin, 32);
});

/**
 * A bot in open air beside an End portal block at 0,64,0, carrying nothing. `controls` records every control the code
 * sets; `deathListeners` is the harness's own count of `death` listeners (its digging and physics each keep one), the
 * baseline a released request returns to.
 */
function crossingBot(options: Parameters<typeof createFakeBot>[0] = {}) {
  const controls = new Map<string, boolean>();
  const harness = createFakeBot({
    position: new Vec3(-2.5, 65, 0.5),
    groundY: null,
    cells: { "0,64,0": "end_portal" },
    ...options,
  });
  const { bot } = harness;
  const setControlState = bot.setControlState;
  bot.setControlState = (name, value) => {
    controls.set(name, value);
    setControlState(name, value);
  };
  return { bot, controls, harness, deathListeners: bot.listenerCount("death") };
}

test("portal action accepts only a server-positioned destination and releases observation with its lifetime", async () => {
  const { bot, deathListeners } = crossingBot();
  const lifetime = new AbortController();
  const result = await enterPortalAction(
    bot,
    parseEndPortalRequest({ x: 0, y: 64, z: 0, allow_distant_respawn: true, allow_low_supplies: true }),
    {} as never,
    {
      createMovements: () => ({}) as never,
      navigate: async () => {
        bot.game.dimension = "the_end";
        bot.entity.position.set(100.5, 49, 0.5);
        bot.emit("forcedMove");
        return { status: "stopped", reason: "dimension changed", elapsedMs: 7 };
      },
    },
    lifetime.signal,
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.navigation.endDimension, "the_end");
  assert.equal(result.navigation.remainingDistance, null);
  assert.equal(bot.listenerCount("forcedMove"), 1);
  lifetime.abort();
  assert.equal(bot.listenerCount("forcedMove"), 0);
  assert.equal(bot.listenerCount("death"), deathListeners);
});

test("portal action preserves caller cancellation and lifetime cleanup", async () => {
  const { bot, deathListeners } = crossingBot();
  const caller = new AbortController();
  const lifetime = new AbortController();
  const pending = enterPortalAction(
    bot,
    parseEndPortalRequest({ x: 0, y: 64, z: 0, allow_distant_respawn: true, allow_low_supplies: true }),
    { signal: caller.signal } as never,
    {
      createMovements: () => ({}) as never,
      navigate: async ({ signal }) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })),
    },
    lifetime.signal,
  );
  caller.abort(new Error("operator cancelled"));
  await assert.rejects(pending, /operator cancelled/);
  lifetime.abort();
  assert.equal(bot.listenerCount("forcedMove"), 0);
  assert.equal(bot.listenerCount("death"), deathListeners);
});

test("a portal approach settles tool loss before issuing entry and retains navigation resource evidence", async () => {
  const { bot, controls, harness } = crossingBot({ slots: { 36: { name: "diamond_pickaxe" }, 9: { name: "stone_pickaxe" } } });
  const { inventory } = harness;
  // The window's own listeners (the harness follows the held stack through it): the count a released request leaves.
  const updateSlotListeners = inventory.listenerCount("updateSlot");
  const lifetime = new AbortController();
  try {
    const result = await enterPortalAction(bot,
      parseEndPortalRequest({ x: 0, y: 64, z: 0, allow_distant_respawn: true, allow_low_supplies: true }), {}, {
        createMovements: () => ({}) as never,
        navigate: async ({ onToolSelected, stopSignal }) => {
          onToolSelected?.(bot.registry.itemsByName.diamond_pickaxe!.id);
          carry(harness, "diamond_pickaxe", 0);
          await Promise.resolve();
          assert.equal(stopSignal?.aborted, true);
          return { status: "stopped", reason: "tool loss", elapsedMs: 1 };
        },
      }, lifetime.signal);
    assert.equal(result.status, "partial");
    assert.match("error" in result ? result.error : "", /TOOL_TIER_LOST.*stone pickaxe remains/);
    assert.equal(controls.size, 0, "No portal entry was issued after the approach stopped.");
    assert.ok(result.navigation.scaffolding.some((stock) => stock.item === "end_stone"));
    assert.deepEqual(result.navigation.bucketDrops, { count: 0, waterRecovered: 0 });
  } finally { lifetime.abort(); }
  assert.equal(inventory.listenerCount("updateSlot"), updateSlotListeners);
});

test("an immediate return while still inside the arrival portal settles truthfully instead of waiting forever", async () => {
  const { bot } = crossingBot();
  bot.game.dimension = "the_end";
  bot.entity.position.set(0.5, 64, 0.5);
  const result = await enterPortalAction(
    bot,
    parseEndPortalRequest({ x: 0, y: 64, z: 0 }),
    {} as never,
    { createMovements: () => ({}) as never, navigate: async () => { throw new Error("must not route"); } },
    new AbortController().signal,
  );
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.error : "", /PORTAL_ALREADY_INSIDE/);
});

test("a crossing observed during takeover resumes with its original destination and receipt", async () => {
  const { bot } = crossingBot();
  const lifetime = new AbortController();
  const attempt = new AbortController();
  let routes = 0;
  const resume = beginPortalEntry(
    bot,
    parseEndPortalRequest({ x: 0, y: 64, z: 0, allow_distant_respawn: true, allow_low_supplies: true }),
    {
      createMovements: () => ({}) as never,
      navigate: async () => {
        routes++;
        bot.game.dimension = "the_end";
        bot.entity.position.set(100.5, 49, 0.5);
        bot.emit("forcedMove");
        attempt.abort(new Error("survival takeover"));
        throw attempt.signal.reason;
      },
    },
    lifetime.signal,
  );
  await assert.rejects(resume({ signal: attempt.signal } as never), /survival takeover/);
  const result = await resume({} as never);
  assert.equal(result.status, "succeeded");
  assert.equal(result.navigation.startDimension, "overworld");
  assert.equal(result.navigation.endDimension, "the_end");
  assert.equal(routes, 1, "resumption must not reinterpret the End arrival as an Overworld return");
  assert.equal(bot.listenerCount("forcedMove"), 1, "one request lifetime owns one observer");
  lifetime.abort();
  assert.equal(bot.listenerCount("forcedMove"), 0);
});

test("death makes a resumed portal request terminal instead of routing again or reporting timeout", async () => {
  const { bot } = crossingBot();
  const lifetime = new AbortController();
  const attempt = new AbortController();
  let routes = 0;
  const resume = beginPortalEntry(
    bot,
    parseEndPortalRequest({ x: 0, y: 64, z: 0, allow_distant_respawn: true, allow_low_supplies: true }),
    {
      createMovements: () => ({}) as never,
      navigate: async () => {
        routes++;
        bot.emit("death");
        attempt.abort(new Error("death takeover"));
        throw attempt.signal.reason;
      },
    },
    lifetime.signal,
  );
  await assert.rejects(resume({ signal: attempt.signal } as never), /death takeover/);
  const result = await resume({} as never);
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.error : "", /PORTAL_DIED/);
  assert.equal(routes, 1);
  lifetime.abort();
});

test("End guard refuses unknown, distant, and visibly missing bed evidence while allowing the explicit override", () => {
  const { bot, world } = createFakeBot();
  const request = parseEndPortalRequest({ x: 0, y: 64, z: 0 });
  assert.match(endRespawnProblem(bot, request, "the_end")!, /RESPAWN_UNKNOWN/);
  recordPersonalRespawn(bot, { x: 200, y: 64, z: 0 });
  world.setCell(new Vec3(200, 64, 0), "red_bed");
  assert.match(endRespawnProblem(bot, request, "the_end")!, /RESPAWN_DISTANT.*200\.00/);
  world.setCell(new Vec3(200, 64, 0), "air");
  assert.match(endRespawnProblem(bot, request, "the_end")!, /RESPAWN_STALE/);
  const override = parseEndPortalRequest({ x: 0, y: 64, z: 0, allow_distant_respawn: true });
  assert.equal(endRespawnProblem(bot, override, "the_end"), null);
  assert.equal(endRespawnProblem(bot, request, "overworld"), null, "End return is exempt");
});

test("supply thresholds count usable items and exempt return", () => {
  const harness = createFakeBot({ carried: { bread: 16, arrow: 32 } });
  const { bot } = harness;
  assert.equal(portalSupplyWarning(bot, "the_end"), null);
  carry(harness, "bread", 15);
  assert.match(portalSupplyWarning(bot, "the_nether")!, /15\/16/);
  assert.equal(portalSupplyWarning(bot, "overworld"), null);
});

test("personal respawn knowledge is confirmed separately from world spawn and invalidated by spawnReset", () => {
  const { bot } = createFakeBot();
  bot.spawnPoint = new Vec3(0, 64, 0);
  assert.equal(personalRespawnObservation(bot), null);
  recordPersonalRespawn(bot, { x: 100, y: 65, z: 100 });
  assert.deepEqual(personalRespawnObservation(bot)?.position, { x: 100, y: 65, z: 100 });
  assert.deepEqual(bot.spawnPoint, new Vec3(0, 64, 0));
  bot.emit("spawnReset");
  assert.equal(personalRespawnObservation(bot), null);
});
