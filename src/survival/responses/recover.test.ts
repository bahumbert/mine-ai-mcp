import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { setCarriedCount } from "../../test-support/carried-counts.js";
import { type FakeHarness, createFakeBot } from "../../test-support/fake-bot/index.js";
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
