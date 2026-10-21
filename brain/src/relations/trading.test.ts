import assert from "node:assert/strict";
import test from "node:test";
import { Body, INSTANT_TYPING } from "../body.ts";
import { ConversationBudget, ConversationController } from "../conversation/controller.ts";
import type { Clock } from "../conversation/socialise.ts";
import { FakeRuntime, scriptedMind, testPersona, until } from "../testing.ts";
import { offerFrom, TradeAsks, tradePlan, tradeRoutine, wantedItems } from "./trading.ts";
import type { ItemCount, Trade, TradeState } from "./types.ts";

const MIN = 60_000;
const OPEN = { open: true, to: ["Theo"], topic: "iron", length: "medium", say: "Theo! Got a minute?" };
const limits = { openingDistance: 16, talkRange: 64, maxMinutes: 6 };
const theoAt = (x: number) => [{ username: "Theo", position: { x, y: 64, z: 0 } }];
const stack = (name: string, count: number) => ({ name, count });

test("wantedItems finds the item ids an objective names, else the needs", () => {
  assert.deepEqual(wantedItems("trade Theo for 3 iron ingots", []), ["iron_ingot"]);
  assert.deepEqual(wantedItems("get some white_wool and oak_log from Theo", ["bread"]), ["white_wool", "oak_log"]);
  assert.deepEqual(wantedItems("swap with Theo for his shiny thing", ["bread", "stick"]), ["bread", "stick"]);
  assert.deepEqual(wantedItems("swap with Theo", []), []);
});

test("TradeAsks.current drops carried needs and old ones, and keeps three", () => {
  const asks = new TradeAsks();
  asks.needs.set(["iron_ingot", "bread", "stick", "dirt"], 1_000);
  assert.deepEqual(asks.needs.current(1_000, [stack("bread", 2)]), ["iron_ingot", "stick", "dirt"], "carried bread dropped");
  asks.needs.set(["iron_ingot", "bread", "stick", "dirt"], 1_000);
  assert.equal(asks.needs.current(1_000, []).length, 3, "at most 3");
  asks.needs.set(["iron_ingot", "bread", "stick", "dirt"], 1_000);
  assert.deepEqual(asks.needs.current(1_000 + 10 * MIN, []), ["iron_ingot", "bread", "stick"], "10 min old still counts");
  assert.deepEqual(asks.needs.current(1_000 + 10 * MIN + 1, []), [], "10 min and 1 ms old does not");
});

test("TradeAsks refusals last 10 minutes and drop a need every partner refused", () => {
  const asks = new TradeAsks();
  asks.refused.add("Theo", ["iron_ingot"], 0);
  assert.equal(asks.refused.isRefused("theo", ["iron_ingot"], 5 * MIN), true);
  assert.equal(asks.refused.isRefused("Theo", ["iron_ingot", "bread"], 5 * MIN), false, "a new item is a new ask");
  assert.equal(asks.refused.isRefused("Theo", ["iron_ingot"], 10 * MIN + 1), false);
  asks.needs.set(["iron_ingot", "bread"], 0);
  asks.dropRefused(["Theo", "Bruno"], MIN);
  assert.deepEqual(asks.needs.current(MIN, []), ["iron_ingot", "bread"], "Bruno did not refuse");
  asks.refused.add("Bruno", ["iron_ingot"], 0);
  asks.dropRefused(["Theo", "Bruno"], MIN);
  assert.deepEqual(asks.needs.current(MIN, []), ["bread"]);
  asks.dropRefused([], MIN);
  assert.deepEqual(asks.needs.current(MIN, []), ["bread"], "no partners: nothing dropped");
});

test("offerFrom lists the five biggest stacks, not the wanted items", () => {
  const inventory = ["a", "b", "c", "d", "e", "f"].map((n, i) => stack(`oak_${n}`, i + 1)).concat([stack("iron_ingot", 99)]);
  assert.deepEqual(offerFrom(inventory, ["iron_ingot"]).map((o) => o.item), ["oak_f", "oak_e", "oak_d", "oak_c", "oak_b"]);
});

function setup(players: FakeRuntime["snapshot"]["players"]) {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players, inventory: [stack("oak_log", 32)] };
  const { chat, mind } = scriptedMind();
  let now = 1_000_000;
  const talks = new ConversationController({
    self: "Ayla", persona: testPersona(), mind, budget: new ConversationBudget(2), modelFree: () => talks.current === null, talkRange: 64, localized: true,
    random: () => 0, now: () => now, speak: () => undefined, journal: () => undefined, memorize: () => undefined, log: () => undefined, history: () => [],
  });
  const clock: Clock = { now: () => now, sleep: async (ms) => { now += ms; } };
  const controller = new AbortController();
  const asks = new TradeAsks();
  const reads: { partner: string; since: number }[] = [];
  let found: Trade | null = null;
  const give: ItemCount[] = [{ item: "oak_log", count: 4 }];
  const get: ItemCount[] = [{ item: "iron_ingot", count: 3 }];
  const setTrade = (state: TradeState | null) => {
    found = state === null ? null : ({ id: "t", partner: "Theo", give, get, first: "me", state, createdAt: now, agreedAt: null, gaveAt: null, received: [], endedAt: null, brokenBy: null, late: false, note: "" } as Trade);
  };
  // The fake clock jumps instead of waiting: only for the runs that wait on a partner who never comes (a fake sleep in the follow loop would never yield).
  const run = (extra: { signal?: AbortSignal; fake?: boolean } = {}) => tradeRoutine({
    runtime, signal: extra.signal ?? controller.signal, partner: "Theo", want: ["iron_ingot"], asks,
    trades: { latestWith: (partner, since) => { reads.push({ partner, since }); return found; } }, talks,
    context: { runtime, body: new Body(runtime, () => undefined, INSTANT_TYPING), signal: controller.signal, self: "Ayla" },
    openFacts: { activity: "trading", lately: [], lastFailed: null }, limits, since: 5, ...(extra.fake === true && { clock }),
  });
  return { runtime, chat, talks, asks, reads, setTrade, run, controller, clock };
}

/** Starts the routine with a partner 30 blocks away and returns it once the opening line is out. */
async function startTalk(t: ReturnType<typeof setup>) {
  t.chat.reply(OPEN);
  t.runtime.durations.navigate = 5;
  const running = t.run();
  await until(() => t.talks.current !== null);
  return running;
}

for (const state of ["agreed", "i_gave", "they_gave", "done"] as const) {
  test(`a trade ${state} with the partner ends the objective done with the terms`, async () => {
    const t = setup(theoAt(30));
    t.setTrade(state);
    const running = startTalk(t);
    await until(() => t.talks.current !== null);
    t.talks.said(true);
    assert.deepEqual(await running, { status: "done", detail: "agreed with Theo: 4 oak_log for 3 iron_ingot" });
    assert.equal(t.asks.refused.isRefused("Theo", ["iron_ingot"], Date.now()), false);
    assert.deepEqual(t.reads, [{ partner: "Theo", since: 5 }], "read with the objective's start");
    assert.match(JSON.stringify(t.chat.requests[0]), /You came to trade: ask for iron_ingot, offer some of 32 oak_log/u);
  });
}

for (const state of [null, "cancelled", "proposed", "broken"] as const) {
  test(`${state ?? "no trade"} after the talk fails the objective and remembers the refusal`, async () => {
    const t = setup(theoAt(30));
    t.setTrade(state);
    const running = startTalk(t);
    await until(() => t.talks.current !== null);
    t.talks.said(true);
    assert.deepEqual(await running, { status: "failed", detail: "Theo did not trade iron_ingot" });
    assert.equal(t.asks.refused.isRefused("Theo", ["iron_ingot"], Date.now()), true);
  });
}

test("a partner who never came is no refusal", async () => {
  const t = setup([]);
  t.chat.reply(OPEN);
  const result = await t.run({ fake: true });
  assert.deepEqual(result, { status: "failed", detail: "Theo did not come" });
  assert.equal(t.asks.refused.isRefused("Theo", ["iron_ingot"], Date.now()), false);
  assert.deepEqual(t.reads, []);
});

test("a model that has nothing to say is no refusal", async () => {
  const t = setup(theoAt(30));
  t.chat.reply({ ...OPEN, open: false });
  const result = await t.run();
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.detail : "", /had nothing to say/u);
  assert.equal(t.asks.refused.isRefused("Theo", ["iron_ingot"], Date.now()), false);
});

test("an abort mid-talk is stopped: no refusal, no trade read", async () => {
  const t = setup(theoAt(30));
  const running = startTalk(t);
  await until(() => t.talks.current !== null);
  t.controller.abort();
  assert.deepEqual(await running, { status: "stopped" });
  assert.equal(t.asks.refused.isRefused("Theo", ["iron_ingot"], Date.now()), false);
  assert.deepEqual(t.reads, []);
});

test("tradePlan names the items and a partner, else why not", () => {
  const t = setup(theoAt(30));
  const snapshot = t.runtime.snapshot;
  const now = Date.now();
  assert.deepEqual(tradePlan("trade Theo for iron ingots", [], ["Theo", "Bruno"], t.asks, snapshot, now), { want: ["iron_ingot"], partner: "Theo" });
  assert.deepEqual(tradePlan("trade with someone", ["bread"], ["Theo"], t.asks, snapshot, now), { want: ["bread"], partner: "Theo" }, "the needs when the text names none");
  assert.deepEqual(tradePlan("trade with someone", [], ["Theo"], t.asks, snapshot, now), { failed: "nothing to trade for" });
  t.asks.refused.add("Theo", ["iron_ingot"], now);
  assert.deepEqual(tradePlan("trade Theo for iron ingots", [], ["Theo"], t.asks, snapshot, now), { failed: "no one to trade iron_ingot with" });
  assert.deepEqual(tradePlan("trade Theo for iron ingots", [], ["Theo", "Bruno"], t.asks, snapshot, now), { want: ["iron_ingot"], partner: "Bruno" }, "the partner who refused is skipped");
  assert.deepEqual(tradePlan("trade for iron ingots", [], [], t.asks, snapshot, now), { failed: "no one to trade iron_ingot with" });
});

test("tradePlan does not ask for what is carried: the offer named in the objective is dropped", () => {
  const t = setup(theoAt(30));
  const snapshot = t.runtime.snapshot;
  const now = Date.now();
  assert.deepEqual(tradePlan("trade my oak logs for iron ingots", [], ["Theo"], t.asks, snapshot, now), { want: ["iron_ingot"], partner: "Theo" });
  assert.deepEqual(tradePlan("trade my oak logs to Theo", ["bread"], ["Theo"], t.asks, snapshot, now), { want: ["bread"], partner: "Theo" }, "only carried items named: the needs");
  assert.deepEqual(tradePlan("trade my oak logs to Theo", [], ["Theo"], t.asks, snapshot, now), { failed: "nothing to trade for" });
});
