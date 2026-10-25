import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { carriedCountField } from "../../test-support/carried-counts.js";
import { type FakeClock, createFakeBot, createFakeClock, itemOf } from "../../test-support/fake-bot/index.js";
import { beginBarter } from "./barter.js";
import { barterInputSchema, barterResultSchema } from "./contract.js";

const PIGLIN_ID = 7;
const PEARL_DROP_ID = 8;
const OTHER_DROP_ID = 9;
/** The gold is held (hotbar slot 0); the first free slot is the next hotbar slot. */
const GOLD_SLOT = 36;
const FREE_SLOT = 37;
/** Player inventory slots: main 9-35 and hotbar 36-44. */
const INVENTORY_SLOTS = Array.from({ length: 36 }, (_, index) => 9 + index);

/**
 * A bot holding 3 gold beside an adult piglin, its inventory full but for one slot (dirt elsewhere). Every count
 * change is a slot update of the harness's window, which announces `updateSlot` as the server's `set_slot` does.
 * The pearl drop (#8) and another output (#9) are harness entities out of the bot's sight until a test drops them.
 * Waits for an acknowledgement are global timers: a test that reaches one passes a mocked clock and installs it.
 */
function fixture(t: TestContext, clock?: FakeClock) {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const drops = new Map<number, { name: string; count: number }>([[PEARL_DROP_ID, { name: "ender_pearl", count: 2 }]]);
  const dropAt = (id: number) => ({
    name: "item",
    position: new Vec3(2, 64, 0),
    getDroppedItem: () => {
      const stack = drops.get(id);
      return stack ? itemOf(harness.bot.registry, stack.name, stack.count) : null;
    },
  });
  // Default adult spawn packets omit the false baby flag.
  const metadata: unknown[] = [];
  const equipment: (Item | null)[] = [null, null];
  const harness = createFakeBot({
    clock,
    slots: {
      [GOLD_SLOT]: { name: "gold_ingot", count: 3 },
      ...Object.fromEntries(
        INVENTORY_SLOTS.filter((slot) => slot !== GOLD_SLOT && slot !== FREE_SLOT).map((slot) => [slot, { name: "dirt", count: 64 }]),
      ),
    },
    entities: {
      [PIGLIN_ID]: { name: "piglin", position: new Vec3(1.5, 64, 0.5), metadata, equipment },
      [PEARL_DROP_ID]: dropAt(PEARL_DROP_ID),
      [OTHER_DROP_ID]: dropAt(OTHER_DROP_ID),
    },
  });
  const { bot } = harness;
  const entities = bot.entities;
  const target = entities[PIGLIN_ID]!;
  const pearlDrop = entities[PEARL_DROP_ID]!;
  const otherDrop = entities[OTHER_DROP_ID]!;
  delete entities[PEARL_DROP_ID];
  delete entities[OTHER_DROP_ID];
  /** The harness window's own listener (it announces the held stack), which a settled barter leaves alone. */
  const idleSlotListeners = harness.inventory.listenerCount("updateSlot");
  const gold = carriedCountField(harness, "gold_ingot");
  const pearl = carriedCountField(harness, "ender_pearl");
  let offers = 0;
  bot.activateEntity = async () => {
    offers += 1;
    gold.count -= 1;
    equipment[1] = itemOf(bot.registry, "gold_ingot", 1);
    bot.emit("entityEquip", target);
  };
  const navigation = {
    navigate: async () => {
      pearl.count += 2;
      delete entities[PEARL_DROP_ID];
      return { status: "completed", elapsedMs: 0 };
    },
  } as unknown as NavigationRuntime;
  const spawn = () => {
    entities[PEARL_DROP_ID] = pearlDrop;
    bot.emit("itemDrop", pearlDrop);
  };
  /** Another output of `count` `name` drops by the piglin. */
  const dropOther = (name: string, count: number) => {
    drops.set(OTHER_DROP_ID, { name, count });
    entities[OTHER_DROP_ID] = otherDrop;
    bot.emit("itemDrop", otherDrop);
  };
  const complete = () => {
    spawn();
    equipment[1] = null;
    bot.emit("entityEquip", target);
  };
  /** Fill every empty inventory slot with dirt: no free slot is left. */
  const fillFreeSlots = () => {
    for (const slot of INVENTORY_SLOTS)
      if (!harness.inventory.slots[slot]) harness.inventory.updateSlot(slot, itemOf(bot.registry, "dirt", 64));
  };
  return {
    lifetime, events: bot, bot, navigation, gold, pearl, target, metadata, equipment, entities,
    spawn, dropOther, complete, fillFreeSlots, idleSlotListeners, offers: () => offers,
  };
}
const request = (gold_budget = 1) =>
  barterInputSchema.parse({ piglin_id: 7, item_name: "ender_pearl", count: 2, gold_budget });

test("existing desired drops satisfy a zero-gold request without activating a recipient", async (t) => {
  const f = fixture(t);
  f.spawn();
  delete f.entities[7];
  const result = await beginBarter(f.bot, f.navigation, request(0), f.lifetime.signal)({});
  assert.equal(result.status, "succeeded");
  assert.equal(f.offers(), 0);
  assert.equal(result.barter.goldSpent, 0);
  assert.equal(result.barter.gained, 2);
  barterResultSchema.parse(result);
});

test("a consumed offer survives cancellation and resumption without spending twice", async (t) => {
  const f = fixture(t);
  const run = beginBarter(f.bot, f.navigation, request(), f.lifetime.signal);
  const cancel = new AbortController();
  const pending = run({ signal: cancel.signal });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.offers(), 1);
  cancel.abort("reflex takeover");
  const interrupted = await pending;
  assert.equal(interrupted.barter.goldSpent, 1);
  assert.equal(interrupted.barter.goldOffers, 1);
  const resumed = run({});
  await new Promise((resolve) => setImmediate(resolve));
  f.complete();
  const result = await resumed;
  assert.equal(result.status, "succeeded");
  assert.equal(f.offers(), 1);
  assert.equal(f.bot.listenerCount("entityEquip"), 0);
  assert.equal(f.bot.listenerCount("entityGone"), 0);
});

test("a gone recipient settles an accepted exchange without inventing completion", async (t) => {
  const f = fixture(t);
  const pending = beginBarter(f.bot, f.navigation, request(), f.lifetime.signal)({});
  await new Promise((resolve) => setImmediate(resolve));
  // Kept: Mineflayer emits `entityGone` while the piglin is still listed and valid (`entities.js:313-318`), and `harness.entities.remove`
  // does the same; barter's wait reads `isValid` at that event and never settles (a code bug, reported to the master). The
  // test keeps the order its wait can see: the piglin invalid and unlisted, then the event.
  f.target.isValid = false;
  delete f.entities[7];
  f.events.emit("entityGone", f.target);
  const result = await pending;
  assert.equal(result.status, "partial");
  assert.equal(result.barter.goldSpent, 1);
  assert.equal(f.offers(), 1);
});

test("invalid and baby recipients cannot consume a gold offer", async (t) => {
  for (const invalid of ["gone", "baby", "unknown"] as const) {
    const f = fixture(t);
    if (invalid === "gone") delete f.entities[7];
    else
      f.metadata[f.bot.registry.entitiesByName.piglin!.metadataKeys!.indexOf("baby")] =
        invalid === "baby" ? true : "unsupported";
    const result = await beginBarter(f.bot, f.navigation, request(), f.lifetime.signal)({});
    assert.equal(result.status, "failed");
    assert.equal(f.offers(), 0);
  }
});
import { ActionRunner } from "../../session/action-runner.js";
import { createBarterAction } from "./barter.js";

function runnerAction(f: ReturnType<typeof fixture>) {
  return { ...createBarterAction(f.bot, f.navigation), execution: { kind: "resumable_task" as const } };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

test("runner takeover preserves a pending offer and accepts desired gains during the reflex", async (t) => {
  const f = fixture(t);
  const runner = new ActionRunner();
  const pending = runner.run(runnerAction(f), request());
  await turn();
  assert.equal(f.offers(), 1);
  const claim = runner.claim("hostile_reflex", "move away", async () => {
    f.pearl.count = 2;
    return { value: null, continuation: { kind: "resume" as const } };
  });
  assert.equal(claim.kind, "claimed");
  const output = await pending;
  assert.equal(output.result.status, "succeeded");
  if (!("barter" in output.result)) throw new Error("expected barter evidence");
  assert.equal(output.result.barter.inventoryBefore, 0);
  assert.equal(output.result.barter.goldOffers, 1);
  assert.equal(output.result.barter.goldSpent, 1);
  assert.equal(f.offers(), 1);
  assert.equal(f.bot.listenerCount("entityEquip"), 0);
  assert.equal(f.bot.inventory.listenerCount("updateSlot"), f.idleSlotListeners);
});

for (const stop of ["cancel", "disconnect"] as const) {
  test(`runner ${stop} settles a pending exchange and removes attempt listeners`, async (t) => {
    const f = fixture(t);
    const runner = new ActionRunner();
    const pending = runner.run(runnerAction(f), request());
    await turn();
    if (stop === "cancel") runner.cancelActive("operator cancelled");
    else runner.disconnect("connection ended");
    const output = await pending;
    await turn();
    assert.notEqual(output.result.status, "succeeded");
    assert.equal(f.offers(), 1);
    assert.equal(f.bot.listenerCount("entityEquip"), 0);
    assert.equal(f.bot.listenerCount("entityGone"), 0);
    assert.equal(f.bot.inventory.listenerCount("updateSlot"), f.idleSlotListeners);
  });
}

test("gold arriving during takeover is reconciled before a successful resumed receipt", async (t) => {
  const f = fixture(t);
  f.bot.activateEntity = async () => {};
  const runner = new ActionRunner();
  const pending = runner.run(runnerAction(f), request());
  await turn();
  const claim = runner.claim("hostile_reflex", "move away", async () => {
    f.gold.count -= 1;
    f.pearl.count = 2;
    return { value: null, continuation: { kind: "resume" as const } };
  });
  assert.equal(claim.kind, "claimed");
  const output = await pending;
  if (!("barter" in output.result)) throw new Error("expected barter evidence");
  assert.equal(output.result.status, "succeeded");
  assert.equal(output.result.barter.goldSpent, 1);
  assert.equal(output.result.barter.goldOffers, 1);
});

test("a nonreward output settles immediately and cannot exceed the one-gold budget", async (t) => {
  const f = fixture(t);
  const pending = beginBarter(f.bot, f.navigation, request(), f.lifetime.signal)({});
  await turn();
  f.dropOther("gravel", 8);
  f.equipment[1] = null;
  f.events.emit("entityEquip", f.target);
  const result = await pending;
  assert.equal(result.status, "partial");
  assert.equal(result.barter.gained, 0);
  assert.equal(result.barter.goldOffers, 1);
  assert.equal(result.barter.goldSpent, 1);
  assert.match(result.error!, /budget exhausted/);
});

test("a recipient moving out of reach while equipping receives no reserved offer", async (t) => {
  const f = fixture(t);
  f.bot.equip = async () => {
    f.target.position.x = 20;
  };
  const result = await beginBarter(f.bot, f.navigation, request(), f.lifetime.signal)({});
  assert.equal(result.status, "failed");
  assert.equal(result.barter.goldOffers, 0);
  assert.equal(f.offers(), 0);
});

test("gold hand release without a new output does not make another offer or report success", async (t) => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const f = fixture(t, clock);
  const pending = beginBarter(f.bot, f.navigation, request(2), f.lifetime.signal)({});
  await turn();
  f.equipment[1] = null;
  f.events.emit("entityEquip", f.target);
  const result = await clock.settle(pending, 5_000);
  assert.equal(result.status, "partial");
  assert.equal(result.barter.goldOffers, 1);
  assert.equal(result.barter.gained, 0);
  assert.match(result.error!, /no new nearby item output/);
});

test("full inventory without a partial requested stack stops before offering any gold", async (t) => {
  for (const carriedPearls of [0, 16]) {
    const f = fixture(t);
    f.pearl.count = carriedPearls;
    f.fillFreeSlots();
    const result = await beginBarter(f.bot, f.navigation, request(), f.lifetime.signal)({});
    assert.equal(result.status, "failed");
    assert.equal(result.barter.goldOffers, 0);
    assert.equal(result.barter.goldSpent, 0);
    assert.equal(f.offers(), 0);
    assert.match(result.error!, /no free slot or compatible partial stack for ender_pearl/);
  }
});

test("a partial requested stack permits barter even without an empty slot", async (t) => {
  const f = fixture(t);
  f.pearl.count = 14;
  f.fillFreeSlots();
  const pending = beginBarter(f.bot, f.navigation, request(), f.lifetime.signal)({});
  await turn();
  assert.equal(f.offers(), 1);
  f.complete();
  const result = await pending;
  assert.equal(result.status, "succeeded");
  assert.equal(result.barter.inventoryBefore, 14);
  assert.equal(result.barter.inventoryAfter, 16);
  assert.equal(result.barter.goldSpent, 1);
});

test("capacity is checked again after equipping before the gold offer", async (t) => {
  const f = fixture(t);
  f.bot.equip = async () => {
    f.fillFreeSlots();
  };
  const result = await beginBarter(f.bot, f.navigation, request(), f.lifetime.signal)({});
  assert.equal(result.status, "failed");
  assert.equal(f.offers(), 0);
  assert.equal(result.barter.goldOffers, 0);
  assert.match(result.error!, /no free slot/);
});

test("consuming the last carried ingot frees the slot needed for its reward", async (t) => {
  const f = fixture(t);
  f.gold.count = 1;
  f.fillFreeSlots(); // The ingot's own slot is the one consuming it frees.
  const pending = beginBarter(f.bot, f.navigation, request(), f.lifetime.signal)({});
  await turn();
  assert.equal(f.offers(), 1);
  assert.equal(f.gold.count, 0);
  f.complete();
  const result = await pending;
  assert.equal(result.status, "succeeded");
  assert.equal(result.barter.goldSpent, 1);
  assert.equal(result.barter.gained, 2);
});

test("a partial pickup revisits the remaining desired stack before another gold offer", async (t) => {
  const f = fixture(t);
  f.spawn();
  let pickups = 0;
  const navigate: NavigationRuntime["navigate"] = async () => {
    pickups++;
    f.pearl.count++;
    if (pickups === 2) delete f.entities[8];
    return { status: "completed", elapsedMs: 0 } as never;
  };
  f.bot.activateEntity = async () => {
    throw new Error("Gold offered while pearls remain on the ground");
  };
  const result = await beginBarter(f.bot, { ...f.navigation, navigate }, request(), f.lifetime.signal)({});
  assert.equal(result.status, "succeeded");
  assert.equal(pickups, 2);
  assert.equal(result.barter.goldOffers, 0);
});

test("a desired drop observed while equipping is collected before reserving gold", async (t) => {
  const f = fixture(t);
  f.bot.equip = async () => {
    f.spawn();
  };
  f.bot.activateEntity = async () => {
    throw new Error("Gold offered after pearls became observable");
  };
  const result = await beginBarter(f.bot, f.navigation, request(), f.lifetime.signal)({});
  assert.equal(result.status, "succeeded");
  assert.equal(result.barter.goldOffers, 0);
  assert.equal(result.barter.gained, 2);
});

test("an uncollectable remainder stops barter without another gold offer", async (t) => {
  const f = fixture(t);
  f.spawn();
  let pickups = 0;
  const navigate: NavigationRuntime["navigate"] = async () => {
    pickups++;
    if (pickups === 1) {
      f.pearl.count++;
    }
    return { status: "completed", elapsedMs: 0 } as never;
  };
  f.bot.activateEntity = async () => {
    throw new Error("Gold offered while an uncollectable remainder exists");
  };
  const result = await beginBarter(f.bot, { ...f.navigation, navigate }, request(), f.lifetime.signal)({});
  assert.equal(result.status, "partial");
  assert.equal(pickups, 2);
  assert.equal(result.barter.goldOffers, 0);
  assert.equal(result.barter.gained, 1);
  assert.ok("error" in result);
  assert.match(result.error, /Could not collect observed ender_pearl #8/);
});

test("desired items picked up while equipping satisfy the request before reserving gold", async (t) => {
  const f = fixture(t);
  f.bot.equip = async () => {
    f.pearl.count = 2;
  };
  f.bot.activateEntity = async () => {
    throw new Error("Gold offered after the carried target was satisfied");
  };
  const result = await beginBarter(f.bot, f.navigation, request(), f.lifetime.signal)({});
  assert.equal(result.status, "succeeded");
  assert.equal(result.barter.goldOffers, 0);
  assert.equal(result.barter.goldSpent, 0);
  assert.equal(result.barter.gained, 2);
});

test("an incidental reward observed entirely during takeover allows the next reserved offer", async (t) => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const f = fixture(t, clock);
  const runner = new ActionRunner();
  const activate = f.bot.activateEntity;
  let offered = 0;
  f.bot.activateEntity = async (target) => {
    offered++;
    await activate(target);
    if (offered === 2) {
      f.pearl.count = 2;
      f.complete();
    }
  };
  const pending = runner.run(runnerAction(f), request(2));
  await turn();
  const claim = runner.claim("fixture_reflex", "Wait through incidental output", async () => {
    f.dropOther("blackstone", 9);
    f.equipment[1] = null;
    f.events.emit("entityEquip", f.target);
    delete f.entities[9];
    return { value: null, continuation: { kind: "resume" as const } };
  });
  assert.equal(claim.kind, "claimed");
  const result = await clock.settle(pending, 5_000);
  assert.equal(offered, 2);
  assert.equal(result.result.status, "succeeded");
  assert.equal(f.bot.listenerCount("itemDrop"), 0);
  assert.equal(f.bot.inventory.listenerCount("updateSlot"), f.idleSlotListeners);
});
