import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { setCarriedCount } from "../../test-support/carried-counts.js";
import { type FakeHarness, createFakeBot, createFakeClock } from "../../test-support/fake-bot/index.js";
import { useNativeDigging } from "../../test-support/fake-bot/native-digging.js";
import { installNativeDigClock, nativeDigTicks } from "../../navigation/index.js";
import { SERVER_CLOCK_STOPPED_MS } from "../../world/world-age.js";
import { extinguishFireAt } from "../positioning/fire-clearance.js";
import { DEFAULT_SURVIVAL_POLICY } from "../policy/contract.js";
import { survivalResources } from "../state/resources.js";
import { recoverUnderCover } from "./recover.js";

/** A meal as the server answers it: one of the first carried stack leaves the window, hunger is full, health 18. */
function eatOne({ bot, inventory }: FakeHarness): void {
  const [food] = inventory.items();
  setCarriedCount(inventory, bot.registry, food!.type, inventory.count(food!.type, null) - 1);
  bot.food = 20;
  bot.health = 18;
}

for (const healthAfterContact of [16, 8]) test(`defence with healing prohibited applies the health floor after contact at ${healthAfterContact}`, async () => {
  const { bot } = createFakeBot({ health: 20, food: 10 });
  let threat = true, ticks = 0;
  const result = await recoverUnderCover(bot, {
    signal: new AbortController().signal, recoverTo: 12, maximumMs: 90_000,
    isProtected: () => true, holdWhile: () => threat,
    defendIntruder: async () => {}, releaseItemUse: () => {},
    wait: async () => { ticks++; bot.health = healthAfterContact; threat = false; },
    survival: survivalResources(),
    policy: () => ({ ...DEFAULT_SURVIVAL_POLICY, combat: { ...DEFAULT_SURVIVAL_POLICY.combat, recover: "never" } }),
  });
  assert.equal(result.kind, healthAfterContact >= 12 ? "recovered" : "held");
  if (result.kind === "held") {
    assert.equal(result.stop, "prohibited");
    assert.match(result.reason, /health 8; required 12/);
  }
  assert.equal(result.ate, null);
  assert.equal(ticks, 1);
  assert.equal(bot.health, healthAfterContact, "successful defence does not mean health increased");
});

test("covered recovery waits for both restored health and the owner's passing threat", async () => {
  const { bot } = createFakeBot({ health: 20, food: 20 });
  let threat = true, ticks = 0;
  const result = await recoverUnderCover(bot, {
    signal: new AbortController().signal, recoverTo: 18, maximumMs: 90_000,
    isProtected: () => true, holdWhile: () => threat,
    defendIntruder: async () => {}, releaseItemUse: () => {},
    wait: async () => {
      ticks++;
      if (ticks === 1) { bot.health = 15; threat = false; }
      if (ticks === 3) bot.health = 18;
    },
    survival: survivalResources(), policy: () => DEFAULT_SURVIVAL_POLICY,
  });
  assert.equal(result.kind, "recovered");
  assert.equal(ticks, 3, "a passing hit must heal before the same action resumes");
});

test("healthy but still threatened cover cannot report recovered when its hold expires", async () => {
  const { bot } = createFakeBot({ health: 20, food: 20 });
  const result = await recoverUnderCover(bot, {
    signal: new AbortController().signal, recoverTo: 18, maximumMs: 0,
    isProtected: () => true, holdWhile: () => true,
    defendIntruder: async () => {}, releaseItemUse: () => {}, wait: async () => {},
    survival: survivalResources(), policy: () => DEFAULT_SURVIVAL_POLICY,
  });
  assert.equal(result.kind, "held");
  assert.match(result.kind === "held" ? result.reason : "", /threat still prevents leaving cover/);
});

test("an incoming arrow invalidates recovery even while the shelter callback still says protected", async () => {
  const { bot } = createFakeBot({ health: 8, food: 20,
    entities: { 8: { name: "arrow", position: new Vec3(0.5, 65, 8.5), velocity: new Vec3(0, 0, -1.5), metadata: [] } } });
  bot.world.raycast = () => null;
  const result = await recoverUnderCover(bot, {
    signal: new AbortController().signal, recoverTo: 18, maximumMs: 90_000,
    isProtected: () => true,
    defendIntruder: async () => {},
    releaseItemUse: () => assert.fail("Do not lower the guard for exposed recovery"),
    wait: async () => assert.fail("Do not wait under an incoming arrow"),
    survival: survivalResources(), policy: () => DEFAULT_SURVIVAL_POLICY,
  });
  assert.equal(result.kind, "exposed");
});

test("a closed shelter containing soul fire is not a recovery position", async () => {
  const { bot } = createFakeBot({ cells: { "0,64,0": "soul_fire" }, health: 8, food: 20 });
  const survival = survivalResources();
  const result = await recoverUnderCover(bot, {
    signal: new AbortController().signal,
    recoverTo: 18,
    maximumMs: 90_000,
    isProtected: () => true,
    defendIntruder: async () => {},
    releaseItemUse: () => {},
    wait: async () => assert.fail("Recovery must not wait inside the source of fire damage"),
    survival,
    policy: () => DEFAULT_SURVIVAL_POLICY,
  });
  assert.deepEqual(result, { kind: "exposed", ate: null });
  assert.deepEqual(survival.answered.snapshot(), [], "environmental exposure does not answer recovery futility");
});

test("a spent protected hold survives damage, another cell, and unrelated policy edits", async () => {
  const { bot } = createFakeBot({ health: 6, food: 20 });
  const survival = survivalResources();
  let policy = DEFAULT_SURVIVAL_POLICY;
  let waits = 0;
  const options = {
    signal: new AbortController().signal,
    recoverTo: 18,
    maximumMs: 0,
    isProtected: () => true,
    defendIntruder: async () => {},
    releaseItemUse: () => {},
    wait: async () => {
      waits++;
    },
    survival,
    policy: () => policy,
  };
  const first = await recoverUnderCover(bot, options);
  assert.equal(first.kind === "held" && first.stop, "exhausted");
  bot.health = 3;
  bot.entity.position.x = 40;
  policy = { ...policy, combat: { ...policy.combat, bow: !policy.combat.bow } };
  const again = await recoverUnderCover(bot, options);
  assert.equal(again.kind === "held" && again.stop, "answered");
  assert.equal(waits, 0);
  assert.equal(survival.answered.snapshot().length, 1);
  assert.deepEqual(survival.budgets.snapshot(), []);
  bot.health = 18;
  assert.equal((await recoverUnderCover(bot, options)).kind, "recovered");
});

/** Waits a protected hold made before its `maximumMs` of covered recovery ended, with the wall clock stepped by `wallStepMs` at the first one. */
async function holdWaitsAcrossWallStep(maximumMs: number, wallStepMs: number): Promise<number> {
  const clock = createFakeClock({ mode: "mocked", startMs: 1_000_000 });
  const { bot } = createFakeBot({ clock, health: 6, food: 20 });
  using _installed = clock.install();
  // Live the two clocks read unrelated values (uptime vs epoch): a budget started on the wrong one cannot pass.
  clock.stepWallClock(5_000);
  let waits = 0;
  const result = await clock.settle(recoverUnderCover(bot, {
    signal: new AbortController().signal, recoverTo: 18, maximumMs,
    isProtected: () => true,
    defendIntruder: async () => {}, releaseItemUse: () => {},
    wait: async () => {
      if (++waits === 1) clock.stepWallClock(wallStepMs);
      await clock.sleep(1_000);
    },
    survival: survivalResources(),
    policy: () => DEFAULT_SURVIVAL_POLICY,
  }), maximumMs + 5_000);
  assert.equal(result.kind === "held" && result.stop, "exhausted");
  return waits;
}

for (const wallStepMs of [-800, 1_200]) {
  test(`covered recovery counts monotonic time: a 3 s budget with a ${wallStepMs} ms wall step is spent after 3 waits of 1 s`, async () => {
    assert.equal(await holdWaitsAcrossWallStep(3_000, wallStepMs), 3);
  });
}

test("losing cover during a bite returns exposure without answering recovery", async () => {
  let protectedNow = true;
  const { bot, clock, server } = createFakeBot({ carried: { cooked_beef: 2 }, health: 7, food: 10 });
  bot.consume = async () => {
    bot.usingHeldItem = true;
    protectedNow = false;
    await bot.waitForTicks(1);
    throw new Error("Consumption interrupted");
  };
  const survival = survivalResources();
  const recovery = recoverUnderCover(bot, {
    policy: () => DEFAULT_SURVIVAL_POLICY,
    signal: new AbortController().signal,
    recoverTo: 18,
    maximumMs: 90_000,
    isProtected: () => protectedNow,
    defendIntruder: async () => {},
    releaseItemUse: () => {},
    wait: async () => {
      assert.fail("An exposed bite must return immediately");
    },
    survival,
  });
  await clock.advance(1_000);
  const result = await recovery;
  assert.deepEqual(result, { kind: "exposed", ate: null });
  // The fake's deactivateItem tells the server the use is released (`block_dig` status 5) and clears usingHeldItem.
  const releases = server.packets.filter(({ name, data }) => name === "block_dig" && (data as { status: number }).status === 5);
  assert.equal(releases.length, 1);
  assert.equal(bot.usingHeldItem, false);
  assert.equal(bot.listenerCount("physicsTick"), 0);
  assert.deepEqual(survival.answered.snapshot(), []);
  assert.deepEqual(survival.budgets.snapshot(), []);
});

test("caller cancellation during an exposed bite remains terminal", async () => {
  const owner = new AbortController();
  const reason = new Error("Caller cancelled");
  let protectedNow = true;
  const { bot, clock } = createFakeBot({ carried: { cooked_beef: 2 }, health: 7, food: 10 });
  bot.consume = async () => {
    owner.abort(reason);
    protectedNow = false;
    await bot.waitForTicks(1);
    throw new Error("Consumption interrupted");
  };
  const survival = survivalResources();
  const rejected = assert.rejects(
    recoverUnderCover(bot, {
      policy: () => DEFAULT_SURVIVAL_POLICY,
      signal: owner.signal,
      recoverTo: 18,
      maximumMs: 90_000,
      isProtected: () => protectedNow,
      defendIntruder: async () => {},
      releaseItemUse: () => {},
      wait: async () => {},
      survival,
    }),
    (cause) => cause === reason,
  );
  await clock.advance(1_000);
  await rejected;
  assert.equal(bot.listenerCount("physicsTick"), 0);
  assert.deepEqual(survival.answered.snapshot(), []);
});

test("eating releases a shield raised by intruder defence during the same recovery hold", async () => {
  let releases = 0;
  const harness = createFakeBot({ carried: { cooked_beef: 2 }, health: 10, food: 20 });
  const { bot } = harness;
  bot.consume = async () => {
    assert.equal(bot.usingHeldItem, false, "a retained off-hand guard prevents native main-hand eating");
    eatOne(harness);
  };
  const result = await recoverUnderCover(bot, {
    policy: () => DEFAULT_SURVIVAL_POLICY,
    survival: survivalResources(),
    signal: new AbortController().signal,
    recoverTo: 18,
    maximumMs: 90_000,
    isProtected: () => true,
    defendIntruder: async () => {
      bot.usingHeldItem = true;
    },
    releaseItemUse: () => {
      releases++;
      bot.usingHeldItem = false;
    },
    wait: async () => {
      if (bot.health < 18) bot.food = 17;
    },
  });
  assert.deepEqual(result, { kind: "recovered", ate: "cooked_beef" });
  assert.equal(releases, 1);
  assert.equal(bot.inventory.items()[0]!.count, 1);
});

/**
 * A hunt's raw drops were eaten inside the shelter as readily as a cooked
 * meal. Above the policy's health floor the hold now ends at once, naming
 * the meat and the floor, instead of spending it.
 */
test("covered recovery keeps uncooked meat for cooking above the raw_food health floor and says so", async () => {
  const { bot } = createFakeBot({ carried: { beef: 4 }, health: 12, food: 10,
    overrides: { consume: async () => assert.fail("raw beef must not be eaten at health 12") } });
  const survival = survivalResources();
  const result = await recoverUnderCover(bot, {
    policy: () => DEFAULT_SURVIVAL_POLICY,
    survival,
    signal: new AbortController().signal,
    recoverTo: 18,
    maximumMs: 90_000,
    isProtected: () => true,
    defendIntruder: async () => {},
    releaseItemUse: () => {},
    wait: async () => {},
  });
  assert.equal(result.kind, "held");
  assert.match(
    result.kind === "held" ? result.reason : "",
    /only uncooked beef is carried and uncooked food is kept for cooking until hunger is at most 6 or health is below 10/,
  );
  assert.equal(bot.inventory.items()[0]!.count, 4);
});

test("below the raw_food health floor covered recovery spends the uncooked meat", async () => {
  const harness = createFakeBot({ carried: { beef: 4 }, health: 8, food: 10 });
  const { bot } = harness;
  bot.consume = async () => {
    eatOne(harness);
  };
  const result = await recoverUnderCover(bot, {
    policy: () => DEFAULT_SURVIVAL_POLICY,
    survival: survivalResources(),
    signal: new AbortController().signal,
    recoverTo: 18,
    maximumMs: 90_000,
    isProtected: () => true,
    defendIntruder: async () => {},
    releaseItemUse: () => {},
    wait: async () => {},
  });
  assert.deepEqual(result, { kind: "recovered", ate: "beef" });
  assert.equal(bot.inventory.items()[0]!.count, 3);
});

/** The feet cell of a bot at (0.5, 64, 0.5), and a fire in it: the probe's state when a shelter closes around a burning cell. */
const FEET_FIRE = { "0,64,0": "fire" } as const;
const FEET = new Vec3(0, 64, 0);

test("a fire in the protected feet cell is dug out, and the recovery goes on", async () => {
  const { bot, clock } = createFakeBot({ position: new Vec3(0.5, 64, 0.5), cells: FEET_FIRE, health: 8, food: 20 });
  const signal = new AbortController().signal;
  let waits = 0;
  const result = await clock.settle(recoverUnderCover(bot, {
    signal, recoverTo: 18, maximumMs: 90_000,
    isProtected: () => true,
    extinguish: (cell) => extinguishFireAt(bot, cell, signal, true),
    defendIntruder: async () => {}, releaseItemUse: () => {},
    wait: async () => { waits++; bot.health = 18; },
    survival: survivalResources(), policy: () => DEFAULT_SURVIVAL_POLICY,
  }), 90_000);
  assert.deepEqual(result, { kind: "recovered", ate: null });
  assert.equal(waits, 1, "the recovery waited for health only after the fire was out");
  assert.equal(bot.blockAt(FEET)?.name, "air");
});

test("a fire outside a protected shell is not dug: the recovery is exposed and nothing is asked", async () => {
  const { bot, clock } = createFakeBot({ position: new Vec3(0.5, 64, 0.5), cells: FEET_FIRE, health: 8, food: 20 });
  let asked = 0;
  const result = await clock.settle(recoverUnderCover(bot, {
    signal: new AbortController().signal, recoverTo: 18, maximumMs: 90_000,
    isProtected: () => false,
    extinguish: async () => { asked++; return "clear"; },
    defendIntruder: async () => {}, releaseItemUse: () => {},
    wait: async () => assert.fail("An open position does not wait"),
    survival: survivalResources(), policy: () => DEFAULT_SURVIVAL_POLICY,
  }), 90_000);
  assert.deepEqual(result, { kind: "exposed", ate: null });
  assert.equal(asked, 0);
  assert.equal(bot.blockAt(FEET)?.name, "fire");
});

test("a fire lit during a bite stops the bite, is dug out, and the recovery eats again", async () => {
  const harness = createFakeBot({ position: new Vec3(0.5, 64, 0.5), carried: { cooked_beef: 2 }, health: 7, food: 10 });
  const { bot, clock, world } = harness;
  const signal = new AbortController().signal;
  let bites = 0;
  bot.consume = async () => {
    bites++;
    bot.usingHeldItem = true;
    if (bites === 1) {
      // Stopgap (unverified on the real server): the fire update, the consume receipt and the tick order are the fake's.
      world.setCell(FEET, "fire");
      await bot.waitForTicks(1);
      throw new Error("Consumption interrupted");
    }
    eatOne(harness);
  };
  const result = await clock.settle(recoverUnderCover(bot, {
    signal, recoverTo: 18, maximumMs: 90_000,
    isProtected: () => true,
    extinguish: (cell) => extinguishFireAt(bot, cell, signal, true),
    defendIntruder: async () => {}, releaseItemUse: () => {},
    wait: async () => {},
    survival: survivalResources(), policy: () => DEFAULT_SURVIVAL_POLICY,
  }), 90_000);
  assert.deepEqual(result, { kind: "recovered", ate: "cooked_beef" });
  assert.equal(bites, 2, "the interrupted bite is not kept; the second eats");
  assert.equal(bot.blockAt(FEET)?.name, "air");
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

test("a fire lit during a bite that was already consumed keeps the meal and recovers", async () => {
  const harness = createFakeBot({ position: new Vec3(0.5, 64, 0.5), carried: { cooked_beef: 2 }, health: 7, food: 10 });
  const { bot, clock, world } = harness;
  const signal = new AbortController().signal;
  let bites = 0;
  bot.consume = async () => {
    bites++;
    bot.usingHeldItem = true;
    world.setCell(FEET, "fire");
    // The meal lands in the same packet turn that the fire is seen: the count drops and the health bar moves.
    eatOne(harness);
    await bot.waitForTicks(1);
    throw new Error("Consumption interrupted");
  };
  const result = await clock.settle(recoverUnderCover(bot, {
    signal, recoverTo: 18, maximumMs: 90_000,
    isProtected: () => true,
    extinguish: (cell) => extinguishFireAt(bot, cell, signal, true),
    defendIntruder: async () => {}, releaseItemUse: () => {},
    wait: async () => {},
    survival: survivalResources(), policy: () => DEFAULT_SURVIVAL_POLICY,
  }), 90_000);
  assert.deepEqual(result, { kind: "recovered", ate: "cooked_beef" });
  assert.equal(bites, 1);
  assert.equal(bot.blockAt(FEET)?.name, "air");
});

test("a fire lit by the last wait is dug out before the hold reports recovered", async () => {
  const { bot, clock, world } = createFakeBot({ position: new Vec3(0.5, 64, 0.5), health: 8, food: 20 });
  const signal = new AbortController().signal;
  const result = await clock.settle(recoverUnderCover(bot, {
    signal, recoverTo: 18, maximumMs: 90_000,
    isProtected: () => true,
    extinguish: (cell) => extinguishFireAt(bot, cell, signal, true),
    defendIntruder: async () => {}, releaseItemUse: () => {},
    wait: async () => { bot.health = 18; world.setCell(FEET, "fire"); },
    survival: survivalResources(), policy: () => DEFAULT_SURVIVAL_POLICY,
  }), 90_000);
  assert.deepEqual(result, { kind: "recovered", ate: null });
  assert.equal(bot.blockAt(FEET)?.name, "air");
});

test("a bot that dies while the fire is dug ends as death, not as exposure", async () => {
  const { bot, clock } = createFakeBot({ position: new Vec3(0.5, 64, 0.5), cells: FEET_FIRE, health: 8, food: 20,
    overrides: { dig: async () => { bot.health = 0; throw new Error("died while digging"); } } });
  const signal = new AbortController().signal;
  const result = await clock.settle(recoverUnderCover(bot, {
    signal, recoverTo: 18, maximumMs: 90_000,
    isProtected: () => true,
    extinguish: (cell) => extinguishFireAt(bot, cell, signal, true),
    defendIntruder: async () => {}, releaseItemUse: () => {},
    wait: async () => assert.fail("A dead bot does not wait"),
    survival: survivalResources(), policy: () => DEFAULT_SURVIVAL_POLICY,
  }), 90_000);
  assert.deepEqual(result, { kind: "held", stop: "death", ate: null, reason: "The bot died during recovery." });
});

test("an abort during the fire's dig throws the abort and stops the dig", async () => {
  const abort = new AbortController();
  const reason = new Error("Caller cancelled");
  const { bot, clock } = createFakeBot({ position: new Vec3(0.5, 64, 0.5), cells: FEET_FIRE, health: 8, food: 20 });
  let stopped = false;
  bot.dig = () => new Promise<void>((_, reject) => {
    bot.stopDigging = () => { stopped = true; reject(new Error("Digging aborted")); };
  });
  const pending = recoverUnderCover(bot, {
    signal: abort.signal, recoverTo: 18, maximumMs: 90_000,
    isProtected: () => true,
    extinguish: (cell) => extinguishFireAt(bot, cell, abort.signal, true),
    defendIntruder: async () => {}, releaseItemUse: () => {},
    wait: async () => assert.fail("An aborted recovery does not wait"),
    survival: survivalResources(), policy: () => DEFAULT_SURVIVAL_POLICY,
  });
  const rejected = assert.rejects(pending, (cause) => cause === reason);
  await clock.advance(1_000);
  abort.abort(reason);
  await rejected;
  assert.equal(stopped, true, "the dig was stopped");
});

/** A bot in a fire's feet cell whose digs are the server's: the native dig clock of the production plugin. */
function nativeFireBot(ticksPerSecond: number) {
  const harness = createFakeBot({ position: new Vec3(0.5, 64, 0.5), cells: FEET_FIRE, health: 8, food: 20,
    clock: createFakeClock({ mode: "mocked" }), server: { ticksPerSecond } });
  useNativeDigging(harness);
  installNativeDigClock(harness.bot);
  return harness;
}

for (const ticksPerSecond of [20, 10]) test(`a fire in the feet cell is dug out on the server's clock at ${ticksPerSecond} tps`, async () => {
  const { bot, clock, server } = nativeFireBot(ticksPerSecond);
  const signal = new AbortController().signal;
  const digTicks = nativeDigTicks(bot.digTime(bot.blockAt(FEET)!));
  using _timers = clock.install();
  const startedTick = server.gameTime;
  const result = await clock.settle(recoverUnderCover(bot, {
    signal, recoverTo: 18, maximumMs: 90_000,
    isProtected: () => true,
    extinguish: (cell) => extinguishFireAt(bot, cell, signal, true),
    defendIntruder: async () => {}, releaseItemUse: () => {},
    wait: async () => { bot.health = 18; },
    survival: survivalResources(), policy: () => DEFAULT_SURVIVAL_POLICY,
  }), 90_000);
  assert.deepEqual(result, { kind: "recovered", ate: null });
  assert.equal(bot.blockAt(FEET)?.name, "air");
  // Mining plus the removal answer's budget, in server ticks (the world age), not in client milliseconds.
  assert.ok(server.gameTime - startedTick <= digTicks, `the dig took ${server.gameTime - startedTick} server ticks, budget ${digTicks}`);
});

test("a fire dig on a stopped server ends the recovery as exposed within the stall bound", async () => {
  const { bot, clock, server } = nativeFireBot(20);
  const signal = new AbortController().signal;
  server.stop();
  using _timers = clock.install();
  const result = await clock.settle(recoverUnderCover(bot, {
    signal, recoverTo: 18, maximumMs: 90_000,
    isProtected: () => true,
    extinguish: (cell) => extinguishFireAt(bot, cell, signal, true),
    defendIntruder: async () => {}, releaseItemUse: () => {},
    wait: async () => assert.fail("An exposed position does not wait"),
    survival: survivalResources(), policy: () => DEFAULT_SURVIVAL_POLICY,
  }), SERVER_CLOCK_STOPPED_MS * 4);
  assert.deepEqual(result, { kind: "exposed", ate: null });
  assert.equal(bot.blockAt(FEET)?.name, "fire", "the server never confirmed the dig");
});

test("a bot that dies while a fire is dug out after an interrupted bite ends as death, without a wait", async () => {
  const harness = createFakeBot({ position: new Vec3(0.5, 64, 0.5), carried: { cooked_beef: 2 }, health: 7, food: 10 });
  const { bot, clock, world } = harness;
  const signal = new AbortController().signal;
  bot.consume = async () => {
    bot.usingHeldItem = true;
    world.setCell(FEET, "fire");
    await bot.waitForTicks(1);
    throw new Error("Consumption interrupted");
  };
  // The dig kills the bot: the bite is over and its health is gone, so no physics tick may be waited for.
  bot.dig = async () => { bot.health = 0; throw new Error("died while digging"); };
  const result = await clock.settle(recoverUnderCover(bot, {
    signal, recoverTo: 18, maximumMs: 90_000,
    isProtected: () => true,
    extinguish: (cell) => extinguishFireAt(bot, cell, signal, true),
    defendIntruder: async () => {}, releaseItemUse: () => {},
    wait: async () => assert.fail("A dead bot does not wait"),
    survival: survivalResources(), policy: () => DEFAULT_SURVIVAL_POLICY,
  }), 90_000);
  assert.deepEqual(result, { kind: "held", stop: "death", ate: null, reason: "The bot died during recovery." });
});
