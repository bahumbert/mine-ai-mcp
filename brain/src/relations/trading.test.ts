import assert from "node:assert/strict";
import test from "node:test";
import type { Activity } from "../activities.ts";
import { Body, INSTANT_TYPING } from "../body.ts";
import { ConversationBudget, ConversationController } from "../conversation/controller.ts";
import type { Clock } from "../conversation/socialise.ts";
import { FakeRuntime, scriptedMind, testPersona, until } from "../testing.ts";
import { offerFrom, TradeAsks, tradePlan, tradeRoutine, tradingPartners, wantedItems, withoutRefusedTrading } from "./trading.ts";
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
  // A walk takes time: the follow step of a talk would otherwise finish at once and be repeated without yielding.
  runtime.durations.navigate = 5;
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
  const run = (extra: { signal?: AbortSignal; fake?: boolean; since?: number } = {}) => tradeRoutine({
    runtime, signal: extra.signal ?? controller.signal, partner: "Theo", want: ["iron_ingot"], asks,
    trades: { latestWith: (partner, since) => { reads.push({ partner, since }); return found; } }, talks,
    context: { runtime, body: new Body(runtime, () => undefined, INSTANT_TYPING), signal: controller.signal, self: "Ayla" },
    openFacts: { activity: "trading", lately: [], lastFailed: null }, limits, since: extra.since ?? 5, ...(extra.fake === true && { clock }),
  });
  return { runtime, chat, talks, asks, reads, setTrade, run, controller, clock, now: () => now };
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

/** The partner ends the talk (without the bot saying a word) once the routine has walked up and started following. */
const partnerTalksThenLeaves = (t: ReturnType<typeof setup>): void => {
  t.talks.heard("Theo", "Ayla, got a minute?", ["Ayla"], "chat");
  const navigates = (): number => t.runtime.submitted.filter((call) => call.tool === "navigate").length;
  const leaveAt = navigates() + 2;
  void until(() => navigates() >= leaveAt, 5_000).then(() => t.talks.end("goodbye"));
};

/** A routine whose chance talk and extra opening are both ended by the partner before the bot speaks. */
const leaverRun = (t: ReturnType<typeof setup>, extra: { since?: number } = {}) => {
  t.talks.openSocial = async () => { partnerTalksThenLeaves(t); return true; };
  partnerTalksThenLeaves(t);
  return t.run(extra);
};

test("a chance talk open when the routine starts: the bot's reply carries the intent, and that line is the ask", async () => {
  const t = setup(theoAt(30));
  t.talks.heard("Theo", "Ayla, nice day", ["Ayla"], "chat");
  const running = t.run();
  await until(() => t.runtime.submitted.filter((call) => call.tool === "navigate").length >= 2);
  assert.deepEqual(t.talks.facts()?.intent, { kind: "trade", partner: "Theo", want: ["iron_ingot"], offer: [{ item: "oak_log", count: 32 }] });
  t.talks.said(true);
  assert.deepEqual(await running, { status: "failed", detail: "Theo did not trade iron_ingot" });
  assert.equal(t.talks.askedSince("Theo", 5), true);
  assert.equal(t.asks.refused.isRefused("Theo", ["iron_ingot"], Date.now()), true);
  assert.equal(t.chat.requests.length, 1, "only the gist: no extra opening");
});

test("a talk that ended since the start without an ask gets a second run with the intent; a trade agreed in it is done", async () => {
  const t = setup(theoAt(30));
  t.chat.reply({ gist: "Chatted." }, OPEN, { gist: "Traded." });
  t.talks.heard("Theo", "Ayla, nice day", ["Ayla"], "chat");
  t.talks.end("goodbye");
  await t.talks.finished();
  const running = t.run();
  await until(() => t.talks.current !== null);
  t.setTrade("agreed");
  assert.match(JSON.stringify(t.chat.requests[1]), /You came to trade: ask for iron_ingot, offer some of 32 oak_log/u, "the extra opening carries the intent");
  t.talks.said(true);
  assert.deepEqual(await running, { status: "done", detail: "agreed with Theo: 4 oak_log for 3 iron_ingot" });
});

test("a talk open with another bot shows no intent; once it ends, the extra run opens with the partner", async () => {
  const t = setup(theoAt(30));
  t.chat.reply({ gist: "Chatted." }, OPEN);
  t.talks.heard("Bruno", "Ayla, hello", ["Ayla"], "chat");
  const running = t.run();
  await until(() => t.talks.current !== null);
  assert.equal(t.talks.facts()?.intent, undefined);
  t.talks.said(true);
  await until(() => t.chat.requests.length >= 2 && t.talks.current !== null);
  assert.match(JSON.stringify(t.chat.requests[1]), /You came to trade/u);
  t.talks.said(true);
  assert.deepEqual(await running, { status: "failed", detail: "Theo did not trade iron_ingot" });
  assert.equal(t.talks.askedSince("Theo", 5), true);
});

test("a partner who ends the talk before the bot speaks: 'did not get to ask' the first time, a refusal the second within 10 minutes", async () => {
  const t = setup(theoAt(30));
  assert.deepEqual(await leaverRun(t), { status: "failed", detail: "did not get to ask Theo" });
  assert.equal(t.asks.refused.isRefused("Theo", ["iron_ingot"], Date.now()), false);
  assert.deepEqual(await leaverRun(t), { status: "failed", detail: "did not get to ask Theo" });
  assert.equal(t.asks.refused.isRefused("Theo", ["iron_ingot"], Date.now()), true, "the second miss is a refusal");
});

test("an extra opening that fails is 'had nothing to say': no refusal, no miss", async () => {
  const t = setup(theoAt(30));
  for (let run = 0; run < 2; run++) {
    t.chat.reply({ gist: "Chatted." }, { ...OPEN, open: false });
    partnerTalksThenLeaves(t);
    const result = await t.run();
    assert.match(result.status === "failed" ? result.detail : "", /had nothing to say/u);
    await t.talks.finished();
  }
  assert.equal(t.asks.refused.isRefused("Theo", ["iron_ingot"], Date.now()), false);
});

test("a trade agreed through the chat path before the bot asks is done, with no extra run", async () => {
  const t = setup(theoAt(30));
  t.setTrade("agreed");
  partnerTalksThenLeaves(t);
  assert.deepEqual(await t.run(), { status: "done", detail: "agreed with Theo: 4 oak_log for 3 iron_ingot" });
  assert.equal(t.chat.requests.filter((request) => /You came to trade/u.test(JSON.stringify(request))).length, 0);
});

test("a cancelled or broken trade since the start is a refusal even when no ask was said", async () => {
  for (const state of ["cancelled", "broken"] as const) {
    const t = setup(theoAt(30));
    t.setTrade(state);
    assert.deepEqual(await leaverRun(t), { status: "failed", detail: "Theo did not trade iron_ingot" });
    assert.equal(t.asks.refused.isRefused("Theo", ["iron_ingot"], Date.now()), true);
  }
});

test("a proposed trade with no ask said is not a refusal", async () => {
  const t = setup(theoAt(30));
  t.setTrade("proposed");
  assert.deepEqual(await leaverRun(t), { status: "failed", detail: "did not get to ask Theo" });
  assert.equal(t.asks.refused.isRefused("Theo", ["iron_ingot"], Date.now()), false);
});

test("an abort mid-talk releases the intent: no extra run, and a later talk shows none", async () => {
  const t = setup(theoAt(30));
  t.talks.heard("Theo", "Ayla, nice day", ["Ayla"], "chat");
  const running = t.run();
  await until(() => t.talks.current !== null);
  t.controller.abort();
  assert.deepEqual(await running, { status: "stopped" });
  assert.equal(t.chat.requests.length, 0, "no extra opening");
  assert.equal(t.asks.refused.isRefused("Theo", ["iron_ingot"], Date.now()), false);
  t.talks.end("goodbye");
  t.talks.heard("Theo", "Ayla, again", ["Ayla"], "chat");
  assert.equal(t.talks.facts()?.intent, undefined);
});

test("after the routine ends (done or failed), a later chance talk shows no intent and records no ask", async () => {
  for (const state of ["agreed", null] as const) {
    const t = setup(theoAt(30));
    t.setTrade(state);
    await leaverRun(t);
    const before = t.now();
    t.talks.heard("Theo", "Ayla, again", ["Ayla"], "chat");
    assert.equal(t.talks.facts()?.intent, undefined);
    t.talks.said(false);
    assert.equal(t.talks.askedSince("Theo", before), false);
  }
});

test("resumed after a stop where the ask was already said: no extra run", async () => {
  const t = setup(theoAt(30));
  t.chat.reply(OPEN, { gist: "Asked." });
  const first = t.run();
  await until(() => t.talks.current !== null);
  t.controller.abort();
  assert.deepEqual(await first, { status: "stopped" });
  t.talks.end("goodbye");
  await t.talks.finished();
  const requests = t.chat.requests.length;
  assert.deepEqual(await t.run({ signal: new AbortController().signal }), { status: "failed", detail: "Theo did not trade iron_ingot" });
  assert.equal(t.chat.requests.length, requests, "no new opening");
});

test("Refusals.missed notes the first miss and refuses on the second within 10 minutes; a late second is a first again", () => {
  const asks = new TradeAsks();
  asks.refused.missed("Theo", ["iron_ingot"], 0);
  assert.equal(asks.refused.isRefused("Theo", ["iron_ingot"], 1), false);
  asks.refused.missed("THEO", ["iron_ingot"], 10 * MIN);
  assert.equal(asks.refused.isRefused("Theo", ["iron_ingot"], 10 * MIN), true);
  asks.refused.missed("Bruno", ["bread"], 0);
  asks.refused.missed("Bruno", ["bread"], 10 * MIN + 1);
  assert.equal(asks.refused.isRefused("Bruno", ["bread"], 10 * MIN + 1), false);
});

test("refusedAnything and tradingPartners: a partner stays out for 10 minutes after any refusal, and a miss is no refusal", () => {
  const asks = new TradeAsks();
  asks.refused.add("Theo", ["iron_ingot"], 0);
  asks.refused.missed("Bruno", ["bread"], 0);
  assert.equal(asks.refused.refusedAnything("theo", MIN), true);
  assert.equal(asks.refused.refusedAnything("Theo", 10 * MIN + 1), false);
  assert.equal(asks.refused.refusedAnything("Bruno", MIN), false);
  assert.deepEqual(tradingPartners(["Theo", "Bruno"], asks, MIN), ["Bruno"]);
  assert.deepEqual(tradingPartners(["Theo"], asks, MIN), []);
  assert.deepEqual(tradingPartners(["Theo"], asks, 10 * MIN + 1), ["Theo"]);
});

test("withoutRefusedTrading drops trading only when every partner refused lately; socialising stays", () => {
  const asks = new TradeAsks();
  const available: Activity[] = ["exploring", "socialising", "trading"];
  assert.deepEqual(withoutRefusedTrading(available, ["Theo"], asks, MIN), available, "nobody refused");
  asks.refused.add("Theo", ["iron_ingot"], 0);
  assert.deepEqual(withoutRefusedTrading(available, ["Theo"], asks, MIN), ["exploring", "socialising"]);
  assert.deepEqual(withoutRefusedTrading(available, ["Theo", "Bruno"], asks, MIN), available, "Bruno did not refuse");
  assert.deepEqual(withoutRefusedTrading(available, ["Theo"], asks, 10 * MIN + 1), available, "forgotten");
  assert.deepEqual(withoutRefusedTrading(available, [], asks, MIN), available, "no partners: availableActivities already decides");
});
