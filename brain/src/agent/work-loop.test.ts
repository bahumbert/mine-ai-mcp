// Tests of the work loop: objectives, step guards, repeat and failure rules, and a model that is unavailable.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakeClock, flush, type FakeClock } from "../../../src/test-support/fake-bot/fake-clock.ts";
import { Agent } from "../agent.ts";
import { INSTANT_TYPING } from "../body.ts";
import type { BrainEvent } from "../brain-log.ts";
import { CHAT_RETRY_MS } from "../model-wait.ts";
import { FakeRuntime, scriptedMind, steppedClocks, testPersona, until } from "../testing.ts";
import { planFollowStep } from "../skills/follow.ts";
import { say, agentFor, others, steveAt, journaledAgent } from "./agent-fixtures.test.ts";
import type { Step } from "../actions.ts";
import { newWork, type StepDecision, type Work } from "./work.ts";

function bodyCalls(runtime: FakeRuntime): string[] {
  return runtime.submitted.filter((call) => call.tool !== "send_message").map((call) => call.tool);
}

/** Orders asking, one after the other, for a craft that has no recipe (live 2026-10-10: it failed in six objectives). */
function craftOrders(t: Parameters<typeof agentFor>[0]) {
  const runtime = new FakeRuntime();
  runtime.failures.craft_item = "[ITEMS_NOT_CRAFTABLE] Minecraft has no crafting recipe for: cooked_beef.";
  const tiers = agentFor(t, runtime);
  let said = 0;
  const order = async (request: string, ...steps: object[]) => {
    const before = tiers.action.requests.length;
    tiers.chat.reply({ say: "Okay!", route: "act", request }, { say: "Can't, sorry." });
    tiers.action.reply(...steps);
    await tiers.agent.handle(say("Steve", request));
    said += 2;
    await until(() => runtime.said.length === said);
    return tiers.action.requests.slice(before).map((request) => request.at(-1)?.content ?? "");
  };
  return { order, runtime };
}

const CRAFT = { step: { skill: "craft_item", item: "cooked_beef", count: 3 } };

const HUNT = { step: { skill: "hunt", mob: "glow_squid", drop: "ink_sac", count: 8 } };

/** A short window (0.002 minutes = 120 ms) looked at every 10 ms, instead of 5 minutes every 30 seconds. */
const QUICK_GAIN = { noGain: { minutes: 0.002, sampleMs: 10 } };

/** A fetch for logs seen 900 blocks away: nothing near, so it walks there (the first `navigate` takes `duration` polls, later ones none) before gathering. */
function farFetch(duration: number) {
  const runtime = new FakeRuntime();
  runtime.simulateInventory = true;
  runtime.walkOnNavigate = true;
  const submit = runtime.submit.bind(runtime);
  let trips = 0;
  runtime.submit = (tool, input) => {
    if (tool === "navigate") runtime.durations.navigate = trips++ === 0 ? duration : 0;
    return submit(tool, input);
  };
  runtime.failNext.collect_block = { error: "[NO_TARGET_IN_RANGE] No oak_log block left within 64 blocks of where the run started; none is loaded farther either." };
  runtime.seen = { oak_log: { dimension: "overworld", x: 900, z: 0 } };
  return runtime;
}

const FETCH = { step: { skill: "get_items", items: [{ item: "oak_log", count: 2 }] } };

const COLLECT = { step: { skill: "collect_block", block: "oak_log", count: 16 } };

const DIRT = { step: { skill: "collect_block", block: "dirt", count: 2 } };

test("follow planning holds when close, moves when far, and reports a lost player", () => {
  const snapshot = new FakeRuntime().snapshot;
  assert.deepEqual(planFollowStep({ ...snapshot, players: [steveAt(3)] }, "steve", 3), { kind: "hold" });
  assert.deepEqual(planFollowStep({ ...snapshot, players: [steveAt(10)] }, "Steve", 3), { kind: "move", target: { x: 10, y: 64, z: 0 } });
  assert.deepEqual(planFollowStep({ ...snapshot, players: [{ username: "Steve", position: null }] }, "Steve", 3), { kind: "lost" });
});

test("a request becomes an objective worked out one step at a time, each step seeing what the last ones did", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(3)] };
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Sure.", route: "act", request: "give Steve 2 dirt" }, { say: "Here you go!" });
  action.reply(
    { thought: "I carry no dirt.", step: { skill: "collect_block", block: "dirt", count: 2 } },
    { step: { skill: "give_item", player: "Steve", item: "dirt", count: 2 } },
    { done: "Steve has 2 dirt" },
  );
  await agent.handle(say("Steve", "could you give me a bit of dirt, 2 is enough"));
  await until(() => runtime.said.length === 2);
  assert.deepEqual(runtime.said, ["Sure.", "Here you go!"]);
  assert.deepEqual(bodyCalls(runtime), ["collect_block", "navigate", "drop_item"]);
  assert.match(action.requests[0]?.[1]?.content ?? "", /Objective \(asked by Steve\): "give Steve 2 dirt"\n\nSteps so far: none yet\./u);
  assert.match(action.requests[1]?.[1]?.content ?? "", /1\. collect 2 dirt -> done: collected 2 dirt/u);
  assert.match(action.requests[2]?.[1]?.content ?? "", /2\. give 2 dirt to Steve -> done: gave 2 dirt to Steve/u);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /\("give Steve 2 dirt"\) is done: Steve has 2 dirt/u);
  assert.equal(agent.activity, "idle");
});

test("a failed step is shown to the model, which may give up and say why in character", async (t) => {
  const runtime = new FakeRuntime();
  runtime.failures.collect_block = "[NO_LOADED_MATCHING_TARGETS] Observed 0 loaded birch_log blocks.";
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Okay!", route: "act", request: "collect 5 birch_log" }, { say: "No birch around here, sorry!" });
  action.reply({ step: { skill: "collect_block", block: "birch_log", count: 5 } }, { give_up: "there is no birch_log nearby" });
  await agent.handle(say("Steve", "get me some birch"));
  await until(() => runtime.said.length === 2);
  assert.match(action.requests[1]?.[1]?.content ?? "", /1\. collect 5 birch_log -> failed: no birch_log within 64 blocks, and you know of none farther away: .*\[NO_LOADED_MATCHING_TARGETS\]/u);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /You stopped working on "collect 5 birch_log": there is no birch_log nearby/u);
});

test("a cancelled step's settle text reaches the next decision's earlier failures", async (t) => {
  const runtime = new FakeRuntime();
  const contact = "[HOSTILE_CONTACT] evade response for zombie#12 at 1,2,3 (4.0 blocks).";
  const settled = "[HOSTILE_SETTLED] evade ended with capability_limit at health 6: x.";
  const submit = runtime.submit.bind(runtime);
  runtime.submit = async (tool, input, ...rest) => {
    const outcome = await submit(tool, input, ...rest);
    return tool === "navigate" && outcome.state !== "refused"
      ? { state: "settled", actionId: outcome.actionId, status: "cancelled", error: `${contact} ${settled}` }
      : outcome;
  };
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Okay!", route: "act", request: "go there and collect dirt" }, { say: "Got the dirt." });
  action.reply({ step: { skill: "go_to", x: 10, y: 64, z: 0 } }, DIRT, { done: "collected dirt" });
  await agent.handle(say("Steve", "go there and collect dirt"));
  await until(() => runtime.said.length === 2);
  const prompt = action.requests[1]?.[1]?.content ?? "";
  const earlierFailures = prompt.slice(prompt.indexOf("Steps that failed lately in this objective"));
  assert.ok(earlierFailures.includes(`${contact} ${settled}`));
  assert.deepEqual(bodyCalls(runtime), ["navigate", "collect_block"]);
  assert.match(action.requests[2]?.[1]?.content ?? "", /collect 2 dirt -> done: collected 2 dirt/u);
  assert.equal(agent.activity, "idle");
});

test("the same step failing the same way several times in a row ends the objective instead of looping", async (t) => {
  const runtime = new FakeRuntime();
  runtime.failures.collect_block = "[NO_LOADED_MATCHING_TARGETS] Observed 0 loaded birch_log blocks.";
  // Two in a row: a step failed twice is refused from then on (one retry), so the guard is tried at its smallest.
  const { agent, chat, action } = agentFor(t, runtime, { settings: { ...testPersona().settings, maxSameStepInARow: 2 } });
  chat.reply({ say: "Okay!", route: "act", request: "collect 5 birch_log" }, { say: "I can't find any birch, sorry!" });
  const collect = { step: { skill: "collect_block", block: "birch_log", count: 5 } };
  action.reply(collect, collect, collect);
  await agent.handle(say("Steve", "get me some birch"));
  await until(() => runtime.said.length === 2);
  assert.equal(runtime.submitted.filter((call) => call.tool === "collect_block").length, 2);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /collect 5 birch_log failed the same way 2 times in a row: no birch_log within 64 blocks/u);
  assert.equal(action.requests.length, 2);
});

test("the same failure between other steps ends the objective too", async (t) => {
  // Live 2026-10-09: Ayla's farm in a cave failed "25 not tillable (air)" 20 times, each after a different step.
  const runtime = new FakeRuntime();
  runtime.failures.collect_block = "[NO_LOADED_MATCHING_TARGETS] Observed 0 loaded birch_log blocks.";
  runtime.failures.craft_item = "[UNKNOWN_CRAFT_ITEMS] Minecraft has no registry items named: birch_thing.";
  const { agent, chat, action } = agentFor(t, runtime, { settings: { ...testPersona().settings, maxSameStepInARow: 2 } });
  chat.reply({ say: "Okay!", route: "act", request: "collect 5 birch_log" }, { say: "I can't find any birch, sorry!" });
  const collect = { step: { skill: "collect_block", block: "birch_log", count: 5 } };
  const craft = { step: { skill: "craft_item", item: "birch_thing", count: 1 } };
  action.reply(collect, craft, collect, craft);
  await agent.handle(say("Steve", "get me some birch"));
  await until(() => runtime.said.length === 2);
  assert.equal(action.requests.length, 3);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /collect 5 birch_log failed the same way 2 times: no birch_log within 64 blocks/u);
});

test("the same step done again and again ends the objective as changing nothing only when the inventory stayed the same", async (t) => {
  const collect = { step: { skill: "collect_block", block: "cobblestone", count: 32 } };
  {
    // Live 2026-10-09: three "collected 32 cobblestone" in a row ended objectives although each gained items.
    const runtime = new FakeRuntime();
    runtime.simulateInventory = true;
    const { agent, chat, action } = agentFor(t, runtime);
    chat.reply({ say: "Okay!", route: "act", request: "collect 96 cobblestone" }, { say: "Got them!" });
    action.reply(collect, collect, collect, collect, { done: "96 cobblestone collected" });
    await agent.handle(say("Steve", "get me 96 cobblestone"));
    await until(() => runtime.said.length === 2);
    // 4 calls: the second identical step goes back once ("just succeeded") and is sent again.
    assert.equal(action.requests.length, 4, "the objective ended after the third identical step that gained");
    assert.doesNotMatch(chat.requests[1]?.[1]?.content ?? "", /changed nothing/u);
    assert.match(chat.requests[1]?.[1]?.content ?? "", /the same step \(collect 32 cobblestone\) was done 3 times in a row and the objective is not reached/u);
  }
  {
    const runtime = new FakeRuntime();
    const { agent, chat, action } = agentFor(t, runtime);
    chat.reply({ say: "Okay!", route: "act", request: "collect 96 cobblestone" }, { say: "Nothing is happening, sorry!" });
    action.reply(collect, collect, collect, collect, collect);
    await agent.handle(say("Steve", "get me 96 cobblestone"));
    await until(() => runtime.said.length === 2);
    assert.equal(action.requests.length, 4);
    assert.match(chat.requests[1]?.[1]?.content ?? "", /collect 32 cobblestone changed nothing 3 times in a row: collected 32 cobblestone/u);
  }
});

test("a failure or another step in between resets the successful-step count", async (t) => {
  // Live 2026-10-11 run 10: "collect 16 dirt" 60+ times under one own objective, each gaining.
  const dirt = { step: { skill: "collect_block", block: "dirt", count: 16 } };
  const sand = { step: { skill: "collect_block", block: "sand", count: 16 } };
  {
    const runtime = new FakeRuntime();
    runtime.simulateInventory = true;
    const { agent, chat, action } = agentFor(t, runtime);
    chat.reply({ say: "Okay!", route: "act", request: "dig dirt" }, { say: "Done!" });
    const submit = runtime.submit.bind(runtime);
    let collects = 0;
    runtime.submit = async (tool, input, ...rest) => {
      if (tool === "collect_block" && (collects += 1) === 2) runtime.failNext.collect_block = { error: "[NO_PATH] no route" };
      return submit(tool, input, ...rest);
    };
    action.reply(dirt, dirt, dirt, dirt, { done: "enough" });
    await agent.handle(say("Steve", "dig dirt"));
    await until(() => runtime.said.length === 2);
    assert.equal(action.requests.length, 5, "done, failed, done: not ended");
  }
  {
    const runtime = new FakeRuntime();
    runtime.simulateInventory = true;
    const { agent, chat, action } = agentFor(t, runtime);
    chat.reply({ say: "Okay!", route: "act", request: "dig" }, { say: "Done!" });
    action.reply(dirt, sand, dirt, sand, { done: "enough" });
    await agent.handle(say("Steve", "dig"));
    await until(() => runtime.said.length === 2);
    assert.equal(action.requests.length, 5, "two steps alternating: not ended");
  }
});

test("a drop that worked and is repeated ends the objective although the inventory changes in between", async (t) => {
  // Live 2026-10-10 run 7: drop, pick the items up again, drop... 26 times: the changing inventory counted as gaining.
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "coal", count: 16 }] };
  let count = 16;
  for (let i = 0; i < 3; i++) {
    runtime.dropOutcomes.push({ status: "succeeded", error: null, dropped: [{ item: "coal", dropped: 16 }], effect: () => { count += 1; runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "coal", count }] }; } });
  }
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Okay!", route: "act", request: "make room" }, { say: "I keep dropping the same thing, sorry!" });
  const drop = { step: { skill: "drop_item", items: [{ item: "coal" }] } };
  action.reply(drop, drop, drop, drop, drop);
  await agent.handle(say("Steve", "make room"));
  await until(() => runtime.said.length === 2);
  assert.equal(action.requests.length, 4);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /changed nothing 3 times in a row/u);
});

test("a step set aside for an order stays interrupted", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(3)] };
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action, planner } = agentFor(t, runtime, { goal: "build yourself a base" });
  planner.reply({ objective: "collect 16 oak_log for my base" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  chat.reply({ say: "Coming!", route: "act", request: "come to Steve" }, { say: "Here I am." });
  action.reply({ step: { skill: "go_to_player", player: "Steve" } }, { done: "I am next to Steve" }, { done: "enough wood for now" });
  await agent.handle(say("Steve", "come here please"));
  await until(() => action.requests.length === 4);
  const resumed = action.requests[3]?.[1]?.content ?? "";
  assert.match(resumed, /1\. collect 16 oak_log -> interrupted/u);
  });

test("one skill failing again and again, whichever way it is tried, ends the objective", async (t) => {
  // Live 2026-10-07: explore failed in every direction in turn for 12 minutes.
  const runtime = new FakeRuntime();
  runtime.failures.collect_block = "[NO_LOADED_MATCHING_TARGETS] Observed 0 loaded matching blocks.";
  const { agent, chat, action } = agentFor(t, runtime, { settings: { ...testPersona().settings, maxSkillFailuresInARow: 3 } });
  chat.reply({ say: "Okay!", route: "act", request: "collect some wood" }, { say: "No wood around, sorry!" });
  action.reply(
    { step: { skill: "collect_block", block: "birch_log", count: 5 } },
    { step: { skill: "collect_block", block: "oak_log", count: 5 } },
    { step: { skill: "collect_block", block: "spruce_log", count: 5 } },
    { step: { skill: "collect_block", block: "acacia_log", count: 5 } },
  );
  await agent.handle(say("Steve", "get me some wood"));
  await until(() => runtime.said.length === 2);
  assert.equal(action.requests.length, 3);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /collect block failed 3 times in a row, whichever way it was tried; the last: no spruce_log within 64 blocks/u);
});

test("never digging straight down is set at start, and again after the runtime reset its policy", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, policy: { revision: "1", digStraightDown: true } };
  const { agent, chat, action } = agentFor(t, runtime);
  await until(() => runtime.digSettings.length === 1);
  assert.deepEqual(runtime.digSettings, [false]);
  // A death resets every override in the runtime.
  runtime.snapshot = { ...runtime.snapshot, policy: { revision: "7", digStraightDown: true } };
  chat.reply({ say: "Okay.", route: "act", request: "collect 1 dirt" }, { say: "Got it." });
  action.reply({ step: { skill: "collect_block", block: "dirt", count: 1 } }, { done: "collected 1 dirt" });
  await agent.handle(say("Steve", "a bit of dirt please"));
  await until(() => runtime.said.length === 2);
  assert.deepEqual(runtime.digSettings, [false, false]);
});

test("the journal gets what it takes on, its stack, each step with its input and thought, and how it ended", async (t) => {
  const runtime = new FakeRuntime();
  const events: BrainEvent[] = [];
  const tiers = scriptedMind();
  const agent = new Agent({ persona: testPersona(), runtime, mind: tiers.mind, otherAgents: others(), log: () => undefined, typing: INSTANT_TYPING, pollMs: 5, journal: (event) => events.push(event) });
  const controller = new AbortController();
  const running = agent.run(controller.signal);
  t.after(async () => {
    controller.abort();
    await running;
  });
  tiers.chat.reply({ say: "Sure.", route: "act", request: "collect 2 dirt" }, { say: "Done!" });
  tiers.action.reply({ thought: "Dirt is right here.", step: { skill: "collect_block", block: "dirt", count: 2 } }, { done: "2 dirt" });
  await agent.handle(say("Steve", "get me 2 dirt"));
  await until(() => events.some((event) => event.kind === "objective" && event.event === "finished"));
  assert.deepEqual(events.filter((event) => event.kind === "objective").map((event) => [event.event, event.text, event.requester]), [["taken", "collect 2 dirt", "Steve"], ["finished", "collect 2 dirt", "Steve"]]);
  const step = events.find((event) => event.kind === "step");
  assert.deepEqual(step && { ...step, ms: 0, times: step.kind === "step" ? step.times?.map((time) => time.activity) : undefined }, { kind: "step", objective: "collect 2 dirt", requester: "Steve", step: "collect 2 dirt", input: { skill: "collect_block", block: "dirt", count: 2 }, thought: "Dirt is right here.", outcome: "done", detail: "collected 2 dirt", ms: 0, activity: "digging", times: ["digging"], purpose: null });
  const states = events.filter((event) => event.kind === "state");
  assert.ok(states.some((state) => state.step === "collect 2 dirt" && state.stack.length === 1));
  assert.deepEqual(states.at(-1), { kind: "state", stack: [], step: null });
});

test("a step that failed once is shown to the work tier (its own objective only), and runs again", async (t) => {
  const { order } = craftOrders(t);
  const prompts = await order("cook 3 beef", CRAFT, CRAFT, { give_up: "No recipe." });
  assert.doesNotMatch(prompts[0] ?? "", /failed lately/u);
  assert.match(prompts[1] ?? "", /Steps that failed lately in this objective[^\n]*\n- craft 3 cooked_beef, 1 minute ago: \[ITEMS_NOT_CRAFTABLE\]/u);
  assert.equal(prompts.length, 3, "the second try ran, no send-back");
});

test("a step that failed twice is refused every time, for any objective, until the 30 minutes are over", async (t) => {
  const clocks = steppedClocks(t);
  const { order, runtime } = craftOrders(t);
  await order("cook 3 beef", CRAFT, { give_up: "No recipe." });
  // Failed once for the first order: it runs (second failure); then refused, on every try, until the objective ends.
  const prompts = await order("make me cooked beef then", CRAFT, CRAFT, CRAFT, CRAFT);
  assert.doesNotMatch(prompts[0] ?? "", /failed lately/u, "another objective's failure is guarded by key, not shown");
  assert.match(prompts[1] ?? "", /- craft 3 cooked_beef, failed 2 times, the last 1 minute ago \(refused now\)/u);
  assert.match(prompts[2] ?? "", /"craft 3 cooked_beef" failed 2 times in the last 30 minutes.*refused: choose a different step, or give this objective up/u);
  assert.equal(prompts.length, 4, "refused at every try until the third refusal ended the objective");
  clocks.wall(-800);
  clocks.monotonic(31 * 60_000);
  const crafted = runtime.submitted.filter((call) => call.tool === "craft_item").length;
  const later = await order("cook me 3 beef", CRAFT, { give_up: "No recipe." });
  assert.doesNotMatch(later[0] ?? "", /failed lately/u);
  assert.equal(later.length, 2, "forgotten after 30 minutes: it ran");
  assert.equal(runtime.submitted.filter((call) => call.tool === "craft_item").length, crafted + 1, "the step ran again, it was not refused");
});

test("a step refused three times ends the objective as failed; the count restarts when the step is allowed and runs", async (t) => {
  const runtime = new FakeRuntime();
  runtime.failures.craft_item = "[ITEMS_NOT_CRAFTABLE] Minecraft has no crafting recipe for: cooked_beef.";
  const { agent, events, chat, action } = journaledAgent(t, runtime);
  const ended = () => events.filter((event) => event.kind === "objective" && event.event === "finished");
  chat.reply({ say: "Okay!", route: "act", request: "cook 3 beef" }, { say: "No." });
  // Two failures, then the third send is refused three times in a row: the objective ends.
  action.reply(CRAFT, CRAFT, CRAFT, CRAFT, CRAFT);
  await agent.handle(say("Steve", "cook me 3 beef"));
  await until(() => ended().length === 1);
  const first = ended()[0];
  assert.equal(first?.kind === "objective" && first.outcome, "failed");
  assert.match(first?.kind === "objective" ? first.detail ?? "" : "", /^"craft 3 cooked_beef" was refused 3 times: it failed 2 times lately \(\[ITEMS_NOT_CRAFTABLE\][^)]*\) and nothing changed since$/u);
  assert.equal(runtime.submitted.filter((call) => call.tool === "craft_item").length, 2);
});

test("the refusal count of a step restarts when the step is allowed and runs", async (t) => {
  const runtime = new FakeRuntime();
  runtime.failures.craft_item = "[ITEMS_NOT_CRAFTABLE] Minecraft has no crafting recipe for: cooked_beef.";
  const { agent, events, chat, action } = journaledAgent(t, runtime, { settings: { ...testPersona().settings, maxSameStepInARow: 10 } });
  runtime.simulateInventory = true;
  const DIRT = { step: { skill: "collect_block", block: "dirt", count: 1 } };
  chat.reply({ say: "Okay!", route: "act", request: "cook 3 beef" }, { say: "Cooked!" });
  // Fails twice, refused once, then the dirt changes the inventory: allowed, runs (fails), and two more refusals make
  // 2, not 3 (1 + 2 would have ended the objective).
  action.reply(CRAFT, CRAFT, CRAFT, DIRT, CRAFT, CRAFT, CRAFT, { done: "ok" });
  await agent.handle(say("Steve", "cook me 3 beef"));
  await until(() => events.some((event) => event.kind === "objective" && event.event === "finished"));
  const finished = events.find((event) => event.kind === "objective" && event.event === "finished");
  assert.equal(finished?.kind === "objective" && `${finished.outcome}: ${finished.detail}`, "done: ok");
  assert.equal(runtime.submitted.filter((call) => call.tool === "craft_item").length, 3);
});

test("a refused step is allowed again when the inventory changed or the bot moved 8 blocks since its last failure (rule 2)", async (t) => {
  const { order, runtime } = craftOrders(t);
  const crafts = () => runtime.submitted.filter((call) => call.tool === "craft_item").length;
  await order("cook 3 beef", CRAFT, CRAFT, { give_up: "No recipe." });
  assert.equal(crafts(), 2);
  const unchanged = await order("cook some beef", CRAFT, CRAFT, CRAFT);
  assert.doesNotMatch(unchanged[0] ?? "", /failed lately/u, "another objective's failure is guarded by key, not shown");
  assert.equal(crafts(), 2, "nothing changed: refused");
  runtime.addItem("oak_log", 1);
  const carried = await order("cook the beef", CRAFT, { give_up: "No recipe." });
  assert.doesNotMatch(carried[0] ?? "", /failed lately/u);
  assert.equal(crafts(), 3, "the inventory changed: it ran");
  // That run failed again with the new inventory as its state: refused again until something else changes.
  const again = await order("cook beef now", CRAFT, CRAFT, CRAFT);
  assert.doesNotMatch(again[0] ?? "", /failed lately/u);
  assert.equal(crafts(), 3);
  runtime.snapshot = { ...runtime.snapshot, position: { x: 7, y: 64, z: 0 } };
  const near = await order("cook beef please", CRAFT, CRAFT, CRAFT);
  assert.doesNotMatch(near[0] ?? "", /failed lately/u);
  assert.equal(crafts(), 3, "7 blocks away is still the same place");
  runtime.snapshot = { ...runtime.snapshot, position: { x: 8, y: 64, z: 0 } };
  const moved = await order("cook beef then", CRAFT, { give_up: "No recipe." });
  assert.doesNotMatch(moved[0] ?? "", /failed lately/u);
  assert.equal(crafts(), 4, "8 blocks away: it ran");
});

test("a step out to obtain items that gains none for the whole window is stopped and fails, saying how far it got", async (t) => {
  // Live 2026-10-09: Vex's "hunt glow_squid for 8 ink_sac" ran to the time limit three times, gaining nothing.
  const runtime = new FakeRuntime();
  runtime.durations.collect_mob_drop = 100_000;
  const { agent, chat, action } = agentFor(t, runtime, {}, QUICK_GAIN);
  chat.reply({ say: "Okay!", route: "act", request: "get 8 ink_sac" }, { say: "No squid, sorry!" });
  action.reply(HUNT, { give_up: "no squid" });
  await agent.handle(say("Steve", "get me 8 ink sacs"));
  await until(() => runtime.said.length === 2, 5_000);
  assert.equal(runtime.cancelled.length, 1, "the hunt was stopped");
  assert.match(action.requests[1]?.[1]?.content ?? "", /1\. hunt glow_squid for 8 ink_sac -> failed: nothing gained in 0\.002 minutes: 0 of 8 ink_sac so far \(the rest is in your inventory\)/u);
});

// Review V3: WSL resyncs its wall clock forward after the host wakes; the no-gain window must not read that as minutes.
test("a 60 s wall clock step does not stop a step that keeps gaining", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_mob_drop = 300;
  const { agent, chat, action } = agentFor(t, runtime, {}, QUICK_GAIN);
  const gains = setInterval(() => runtime.addItem("ink_sac", 1), 30);
  const clocks = steppedClocks(t);
  setTimeout(() => clocks.wall(60_000), 100);
  t.after(() => clearInterval(gains));
  chat.reply({ say: "Okay!", route: "act", request: "get 8 ink_sac" }, { say: "Got them!" });
  action.reply(HUNT, { done: "got the ink" });
  await agent.handle(say("Steve", "get me 8 ink sacs"));
  await until(() => runtime.said.length >= 2, 5_000);
  assert.equal(runtime.cancelled.length, 0, "gaining every 30 ms: a clock step is not 60 s without a gain");
});

test("a fetch travelling to the place it saw the block gets nearer: that is progress for the no-gain stop (live 2026-10-10 run 9: Kenji's boat trip)", async (t) => {
  const runtime = farFetch(400);
  const { agent, chat, action } = agentFor(t, runtime, {}, QUICK_GAIN);
  // 20 blocks nearer every 30 ms against a 120 ms window: no item rises for 400 ms, yet it is not stopped.
  const walking = setInterval(() => { runtime.snapshot = { ...runtime.snapshot, position: { ...runtime.snapshot.position, x: runtime.snapshot.position.x + 20 } }; }, 30);
  t.after(() => clearInterval(walking));
  chat.reply({ say: "Okay!", route: "act", request: "get 2 oak_log" }, { say: "Got them!" });
  action.reply(FETCH, { done: "got the logs" });
  await agent.handle(say("Steve", "get me 2 oak logs"));
  await until(() => runtime.said.length === 2, 5_000);
  assert.equal(runtime.cancelled.length, 0, "getting nearer is progress");
  assert.equal(runtime.submitted.filter((call) => call.tool === "collect_block").length, 2, "it arrived and gathered");
});

test("a fetch travelling that gets no nearer is stopped after the window, as before", async (t) => {
  const runtime = farFetch(100_000);
  const { agent, chat, action } = agentFor(t, runtime, {}, QUICK_GAIN);
  chat.reply({ say: "Okay!", route: "act", request: "get 2 oak_log" }, { say: "Stuck, sorry!" });
  action.reply(FETCH, { give_up: "stuck" });
  await agent.handle(say("Steve", "get me 2 oak logs"));
  await until(() => runtime.said.length === 2, 5_000);
  assert.equal(runtime.cancelled.length, 1, "the walk was stopped");
  assert.match(action.requests[1]?.[1]?.content ?? "", /get 2 oak_log -> failed: nothing gained in 0\.002 minutes: 0 of 2 oak_log so far/u);
});

test("a step whose items keep increasing is not stopped, and a collect step is looked at too (any step has the silence limit)", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_mob_drop = 300;
  runtime.durations.collect_block = 300;
  const statuses = { calls: 0 };
  const status = runtime.status.bind(runtime);
  runtime.status = async () => {
    statuses.calls += 1;
    return status();
  };
  const { agent, chat, action } = agentFor(t, runtime, {}, QUICK_GAIN);
  const gains = setInterval(() => runtime.addItem("ink_sac", 1), 30);
  t.after(() => clearInterval(gains));
  chat.reply({ say: "Okay!", route: "act", request: "get 8 ink_sac" }, { say: "Got them!" });
  action.reply(HUNT, { done: "got the ink" });
  await agent.handle(say("Steve", "get me 8 ink sacs"));
  await until(() => runtime.said.length === 2, 5_000);
  assert.equal(runtime.cancelled.length, 0, "gaining every 30 ms against a 120 ms window: not stopped");
  assert.match(action.requests[1]?.[1]?.content ?? "", /1\. hunt glow_squid for 8 ink_sac -> done/u);
  clearInterval(gains);
  const sampled = statuses.calls;
  runtime.durations.collect_block = 50;
  chat.reply({ say: "Okay!", route: "act", request: "collect 1 dirt" }, { say: "Done!" });
  action.reply({ step: { skill: "collect_block", block: "dirt", count: 1 } }, { done: "dirt" });
  await agent.handle(say("Steve", "get me a dirt"));
  await until(() => runtime.said.length === 4, 5_000);
  assert.equal(runtime.cancelled.length, 0, "the collect step (about 300 ms, moving or not) is not cancelled");
  assert.ok(sampled > 15, `the hunt was sampled (${sampled} calls)`);
});

test("a step whose target never rises but another item does is not stopped; one where nothing rises still is", async (t) => {
  // Live 2026-10-10 run 8: "get 48 dark_oak_stairs" gathered 20 dark_oak_log for its planks and was stopped for no stairs.
  const runtime = new FakeRuntime();
  runtime.durations.collect_mob_drop = 300;
  const { agent, chat, action } = agentFor(t, runtime, {}, QUICK_GAIN);
  const gains = setInterval(() => runtime.addItem("dark_oak_log", 1), 30);
  t.after(() => clearInterval(gains));
  chat.reply({ say: "Okay!", route: "act", request: "get 8 ink_sac" }, { say: "Got them!" });
  action.reply(HUNT, { done: "got the ink" });
  await agent.handle(say("Steve", "get me 8 ink sacs"));
  await until(() => runtime.said.length === 2, 5_000);
  assert.equal(runtime.cancelled.length, 0, "logs rising against a 120 ms window: the chain is progressing");
  clearInterval(gains);
  runtime.durations.collect_mob_drop = 100_000;
  chat.reply({ say: "Okay!", route: "act", request: "get 8 ink_sac" }, { say: "No squid, sorry!" });
  action.reply(HUNT, { give_up: "no squid" });
  await agent.handle(say("Steve", "get me 8 ink sacs again"));
  await until(() => runtime.said.length === 4, 5_000);
  assert.equal(runtime.cancelled.length, 1, "nothing rose: stopped as before");
});

test("a step failing for a full inventory names the junk with its whole count (live 2026-10-10: 18 of 238 snowballs dropped per step)", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [...Array.from({ length: 15 }, (_, index) => ({ name: "snowball", count: index === 0 ? 8 : 16 })), { name: "stone_pickaxe", count: 1 }] };
  runtime.failures.collect_block = "[INVENTORY_FULL] no free inventory slot";
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Okay!", route: "act", request: "collect 5 birch_log" }, { say: "Full, sorry." });
  action.reply({ step: { skill: "collect_block", block: "birch_log", count: 5 } }, { step: { skill: "collect_block", block: "birch_log", count: 5 } });
  await agent.handle(say("Steve", "get me some birch"));
  await until(() => action.requests.length >= 2);
  const prompt = JSON.stringify(action.requests[1]);
  assert.match(prompt, /232 snowball \(15 slots\)/u);
  assert.doesNotMatch(prompt, /1 stone_pickaxe \(1 slot\)/u, "the pickaxe is needed");
});

test("a give done and sent again identically goes back once, and the order ends done after one give", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(3)] };
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Sure.", route: "act", request: "give Steve 2 dirt" }, { say: "Here you go!" });
  const give = { step: { skill: "give_item", player: "Steve", item: "dirt", count: 2 } };
  action.reply(give, give, { done: "Steve has 2 dirt" });
  await agent.handle(say("Steve", "give me 2 dirt"));
  await until(() => runtime.said.length === 2);
  assert.equal(runtime.submitted.filter((call) => call.tool === "drop_item").length, 1);
  assert.match(action.requests[2]?.at(-1)?.content ?? "", /just succeeded: if that did what was asked, answer done/u);
});

test("the junk hint never lists what the objective gathers (live 2026-10-11: cobblestone listed for \"Mine cobblestone\")", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "cobblestone", count: 256 }, { name: "dirt", count: 128 }] };
  runtime.failures.collect_block = "[INVENTORY_FULL] no free inventory slot";
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Okay!", route: "act", request: "Mine cobblestone" }, { say: "Full, sorry." });
  const mine = { step: { skill: "collect_block", block: "stone", count: 5 } };
  action.reply(mine, mine);
  await agent.handle(say("Steve", "mine some cobblestone"));
  await until(() => action.requests.length >= 2);
  const prompt = JSON.stringify(action.requests[1]);
  assert.match(prompt, /128 dirt/u);
  assert.doesNotMatch(prompt, /nothing you are doing needs[^"]*cobblestone/u);
});

test("a body that restarted under a step is one failed step: the objective goes on, no streak or repeat rule fires", async (t) => {
  // Both limits at their smallest: an ordinary failure would end the objective after this one step.
  const runtime = new FakeRuntime();
  runtime.throwNext.collect_block = "[BODY_RESTARTED] the body restarted: collect_block was not done";
  const { agent, chat, action } = agentFor(t, runtime, { settings: { ...testPersona().settings, maxSameStepInARow: 1, maxSkillFailuresInARow: 1 } });
  chat.reply({ say: "Okay!", route: "act", request: "collect 5 birch_log" }, { say: "Done!" });
  const collect = { step: { skill: "collect_block", block: "birch_log", count: 5 } };
  action.reply(collect, collect);
  await agent.handle(say("Steve", "get me some birch"));
  await until(() => action.requests.length === 2);
  assert.equal(runtime.submitted.filter((call) => call.tool === "collect_block").length, 2);
  assert.match(action.requests[1]?.[1]?.content ?? "", /1\. collect 5 birch_log -> failed: \[BODY_RESTARTED\] the body restarted: collect_block was not done/u);
});

test("a step with no item target and no sign of life for the whole window is cancelled and fails, saying so (run 14: a step waited for ever)", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action } = agentFor(t, runtime, {}, QUICK_GAIN);
  chat.reply({ say: "Okay!", route: "act", request: "collect 16 oak_log" }, { say: "Stuck, sorry!" });
  action.reply(COLLECT, { give_up: "stuck" });
  await agent.handle(say("Steve", "collect logs"));
  await until(() => runtime.said.length === 2, 5_000);
  assert.equal(runtime.cancelled.length, 1, "the action was cancelled as by the agent");
  assert.match(action.requests[1]?.[1]?.content ?? "", /collect 16 oak_log -> failed: the action gave no sign of life for 0\.002 minutes/u);
});

test("a step with no item target that keeps moving is alive: a sign of life resets the clock", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 400;
  const { agent, chat, action } = agentFor(t, runtime, {}, QUICK_GAIN);
  const walking = setInterval(() => { runtime.snapshot = { ...runtime.snapshot, position: { ...runtime.snapshot.position, x: runtime.snapshot.position.x + 20 } }; }, 30);
  t.after(() => clearInterval(walking));
  chat.reply({ say: "Okay!", route: "act", request: "collect 16 oak_log" }, { say: "Got them!" });
  action.reply(COLLECT, { done: "got the logs" });
  await agent.handle(say("Steve", "collect logs"));
  await until(() => runtime.said.length === 2, 5_000);
  assert.equal(runtime.cancelled.length, 0);
});

test("the silence limit holds when the inventory read never answers (the clock is the wall clock, not an event)", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 100_000;
  const status = runtime.status.bind(runtime);
  runtime.status = () => (runtime.submitted.some((call) => call.tool === "collect_block") && runtime.cancelled.length === 0 ? new Promise(() => undefined) : status());
  const { agent, chat, action } = agentFor(t, runtime, {}, QUICK_GAIN);
  chat.reply({ say: "Okay!", route: "act", request: "collect 16 oak_log" }, { say: "Stuck, sorry!" });
  action.reply(COLLECT, { give_up: "stuck" });
  await agent.handle(say("Steve", "collect logs"));
  await until(() => runtime.said.length === 2, 5_000);
  assert.equal(runtime.cancelled.length, 1);
});

test("what a collect_block step mines is wanted: fresh raw_iron is not named as junk when the inventory is full (run 15 N5)", async (t) => {
  const runtime = new FakeRuntime();
  runtime.dropSources = { ...runtime.dropSources, raw_iron: [{ block: "iron_ore", chance: 1, planted: false }] };
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "raw_iron", count: 40 }, { name: "dirt", count: 128 }] };
  runtime.failures.collect_block = "[INVENTORY_FULL] no free inventory slot";
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "Okay!", route: "act", request: "mine some iron" }, { say: "Full, sorry." });
  const mine = { step: { skill: "collect_block", block: "iron_ore", count: 5 } };
  action.reply(mine, mine);
  await agent.handle(say("Steve", "mine some iron"));
  await until(() => action.requests.length >= 2);
  const prompt = JSON.stringify(action.requests[1]);
  assert.match(prompt, /128 dirt/u);
  assert.doesNotMatch(prompt, /nothing you are doing needs[^"]*raw_iron/u);
});

test("an order whose work call finds the model unavailable three times waits and then runs its step: no bad reply, no \"could not work out\", the requester hears nothing about it", async (t) => {
  const runtime = new FakeRuntime();
  const logs: string[] = [];
  const { agent, chat, action } = agentFor(t, runtime, {}, { log: (line) => logs.push(line) });
  chat.reply({ say: "On it.", route: "act", request: "collect 2 dirt" }, { say: "Got the dirt!" });
  action.unavailable(3).reply(DIRT, { done: "collected 2 dirt" });
  await agent.handle(say("Steve", "get me 2 dirt"));
  await until(() => runtime.said.length === 2);
  assert.deepEqual(runtime.said, ["On it.", "Got the dirt!"]);
  assert.equal(action.requests.length, 5, "three calls away, the step, then done");
  assert.equal(runtime.submitted.filter((call) => call.tool === "collect_block").length, 1);
  assert.doesNotMatch(chat.requests[1]?.[1]?.content ?? "", /could not work out/u);
  assert.deepEqual(logs.filter((line) => line.startsWith("work tier failed")), [], "an unavailable model is no bad reply");
});

test("the own goal waits the same way when the goal call finds the model unavailable", async (t) => {
  const runtime = new FakeRuntime();
  const logs: string[] = [];
  const { planner, action } = agentFor(t, runtime, { goal: "gather dirt" }, { log: (line) => logs.push(line) });
  planner.unavailable(2).reply({ objective: "collect 2 dirt" });
  action.reply(DIRT, { done: "collected 2 dirt" });
  await until(() => action.requests.length === 2);
  assert.equal(planner.requests.length, 3);
  assert.ok(logs.some((line) => line.startsWith("model unavailable (1 times)")), "the first failure is logged as the model being away");
  assert.deepEqual(logs.filter((line) => line.startsWith("work loop error")), [], "it is not a work loop error");
});

test("an order taken while the agent waits for the model starts at once", async (t) => {
  const runtime = new FakeRuntime();
  // A long poll: the wait would last seconds, so only the new order can end it in time.
  const { agent, events, chat, action } = journaledAgent(t, runtime, {}, { pollMs: 60_000 });
  chat.reply({ say: "On it.", route: "act", request: "collect 2 dirt" }, { say: "Sand coming.", route: "act", request: "collect 3 sand" }, { say: "Sand!" });
  action.unavailable(1).reply({ done: "sand is here" });
  await agent.handle(say("Steve", "get me 2 dirt"));
  await until(() => action.requests.length === 1);
  await until(() => events.some((event) => event.kind === "state" && event.step === "waiting for the model"));
  assert.equal(action.requests.length, 1, "it waits instead of asking again at once");
  assert.match(agent.activity, /collect 2 dirt/u);
  await agent.handle(say("Bob", "get me 3 sand"));
  await until(() => action.requests.length >= 2, 1_000);
  assert.match(action.requests[1]?.[1]?.content ?? "", /collect 3 sand/u);
});

test("a chat line whose call finds the model unavailable once is answered after the wait, and is in the history once", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, chat } = agentFor(t, runtime);
  chat.unavailable(1).reply({ say: "Hello!", route: "talk", request: "" }, { say: "Still here.", route: "talk", request: "" });
  await agent.handle(say("Steve", "hello Ayla"));
  await until(() => runtime.said.length === 1);
  assert.deepEqual(runtime.said, ["Hello!"]);
  assert.equal(chat.requests.length, 2, "the failed call and the call that answered");
  await agent.handle(say("Steve", "you there Ayla"));
  await until(() => runtime.said.length === 2);
  const history = chat.requests[2]?.[1]?.content ?? "";
  assert.equal(history.split("hello Ayla").length - 1, 1);
});

test("a chat line superseded during the wait is dropped unasked, and the newer line has its stop kept", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action, planner } = journaledAgent(t, runtime, { goal: "build yourself a base", settings: { ...testPersona().settings, restAfterStopSeconds: 60 } });
  planner.reply({ objective: "collect 16 oak_log" });
  action.reply({ step: { skill: "collect_block", block: "oak_log", count: 16 } });
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  const release = chat.hold();
  chat.unavailable(1).reply({ spoken_to: ["Ayla"], say: "Stopping.", route: "stop", request: "" });
  runtime.inbox.push(say("Steve", "Ayla, do a dance"));
  await until(() => chat.requests.length === 1);
  runtime.inbox.push(say("Steve", "Ayla, stop"));
  await until(() => runtime.inbox.length === 0);
  release();
  await until(() => runtime.cancelled.length === 1);
  assert.deepEqual(runtime.said, ["Stopping."]);
  assert.equal(chat.requests.length, 2, "the dance line was not asked again; the stop line was asked once");
  assert.equal(agent.activity, "idle");
});

test("a stop during a slow work call: the stopped order is not narrated and no \"finished\" event is journaled, whatever the call returns", async (t) => {
  // Backlog 167, BRN-08: the late bad reply of a stopped order ended it again and the requester heard "I could not work it out".
  const runtime = new FakeRuntime();
  const { agent, events, chat, action } = journaledAgent(t, runtime);
  // The first work call (3 rounds of format repair) answers at once; the first round of the second call is held.
  const holds = [action.hold(), action.hold(), action.hold(), action.hold()];
  for (const release of holds.slice(0, 3)) release();
  chat.reply({ say: "On it.", route: "act", request: "collect 2 dirt" }, { say: "Stopping.", route: "stop", request: "" });
  action.reply("nope", "nope", "nope", "nope", "nope", "nope");
  await agent.handle(say("Steve", "Ayla, get me 2 dirt"));
  await until(() => action.requests.length === 4);
  await agent.handle(say("Steve", "Ayla, stop"));
  holds[3]!();
  await until(() => action.requests.length === 6);
  await flush();
  assert.equal(action.requests.length, 6, "the held call was answered");
  assert.deepEqual(events.filter((event) => event.kind === "objective" && event.event === "finished"), []);
  assert.equal(chat.requests.length, 2, "no narration was asked for");
  assert.deepEqual(runtime.said, ["On it.", "Stopping."]);
  assert.equal(agent.activity, "idle");
});

test("progress of an order stopped mid-step is not narrated", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 100_000;
  const { agent, chat, action } = agentFor(t, runtime, { settings: { ...testPersona().settings, narrateEverySeconds: 0 } });
  chat.hold()();
  const narration = chat.hold();
  chat.reply({ say: "Sure.", route: "act", request: "get 2 dirt" }, { say: "Stopping.", route: "stop", request: "" });
  action.reply({ step: { skill: "get_items", items: [{ item: "dirt", count: 2 }] } });
  await agent.handle(say("Steve", "Ayla, get me 2 dirt"));
  await until(() => chat.requests.length === 2, 2_000);
  await agent.handle(say("Steve", "Ayla, stop"));
  chat.reply({ say: "Digging a bit of dirt for you." });
  narration();
  await flush();
  assert.deepEqual(runtime.said, ["Sure.", "Stopping."], "the progress line of the stopped order was dropped");
});

test("a model that never answers keeps the order on the stack; the failures are logged at the 1st and the 10th", async (t) => {
  const runtime = new FakeRuntime();
  const logs: string[] = [];
  const { agent, chat, action } = agentFor(t, runtime, {}, { pollMs: 1, log: (line) => logs.push(line) });
  chat.reply({ say: "On it.", route: "act", request: "collect 2 dirt" });
  action.unavailable(1_000);
  await agent.handle(say("Steve", "Ayla, get me 2 dirt"));
  await until(() => logs.some((line) => line.startsWith("model unavailable (10 times)")), 5_000);
  const counts = logs.filter((line) => line.startsWith("model unavailable")).map((line) => /\((\d+) times\)/u.exec(line)?.[1]);
  assert.deepEqual(counts, ["1", "10"]);
  assert.match(agent.activity, /collect 2 dirt/u);
});

test("two bad replies in a row still end the order with \"could not work out what to do next\"", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, chat, action } = agentFor(t, runtime);
  chat.reply({ say: "On it.", route: "act", request: "collect 2 dirt" }, { say: "Sorry, I am lost." });
  action.reply("nope", "nope", "nope", "nope", "nope", "nope");
  await agent.handle(say("Steve", "Ayla, get me 2 dirt"));
  await until(() => runtime.said.length === 2);
  assert.match(chat.requests[1]?.[1]?.content ?? "", /could not work out what to do next/u);
  assert.equal(agent.activity, "idle");
});

// Plan 2026-10-27-p1-monotonic-clock T7: WSL steps its wall clock (back ~2 s every ~30 s); a duration is read on the
// monotonic clock, a time of day (the chat history) stays on the wall clock.
test("a chat line is asked again for CHAT_RETRY_MS of monotonic time, whatever the wall clock does", async (t) => {
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const runtime = new FakeRuntime();
  const logs: string[] = [];
  const { agent, chat } = agentFor(t, runtime, {}, { log: (line) => logs.push(line) });
  chat.unavailable(1_000);
  const handling = agent.handle(say("Steve", "hello Ayla"));
  await clock.settle(until(() => logs.some((line) => line.startsWith("model unavailable"))), 10_000);
  // 119 s have passed while the wall clock jumped 5 minutes ahead: the line is still waited for.
  clock.stepWallClock(300_000);
  await clock.advance(CHAT_RETRY_MS - 1_000);
  assert.deepEqual(logs.filter((line) => line.includes("dropped")), [], "a wall clock step ahead does not end the wait early");
  // 120.5 s have passed while the wall clock went back 5 minutes and 0.8 s: the wait is over.
  clock.stepWallClock(-300_800);
  await clock.advance(1_500);
  await clock.settle(until(() => logs.some((line) => line.includes("no answer in time"))), 60_000);
  await handling;
});

test("a step's journal ms is its monotonic time: a wall clock step back of 60 s in the step does not make it negative", async (t) => {
  const runtime = new FakeRuntime();
  runtime.durations.collect_block = 300;
  const clocks = steppedClocks(t);
  const { agent, events, chat, action } = journaledAgent(t, runtime);
  chat.reply({ say: "On it.", route: "act", request: "collect 2 dirt" }, { say: "Done." });
  action.reply(DIRT, { done: "collected 2 dirt" });
  await agent.handle(say("Steve", "get me 2 dirt"));
  await until(() => runtime.submitted.some((call) => call.tool === "collect_block"));
  clocks.wall(-60_000);
  clocks.monotonic(2_000);
  await until(() => events.some((event) => event.kind === "step"));
  const step = events.find((event) => event.kind === "step");
  assert.ok(step?.kind === "step" && step.ms >= 2_000 && step.ms < 10_000, `ms ${step?.kind === "step" ? step.ms : "no step"}`);
});

test("a follow ordered by a player counts their silence in monotonic time: a wall clock step of 11 minutes does not end it", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, players: [steveAt(1)] };
  const { agent, events, chat, action } = journaledAgent(t, runtime);
  chat.reply({ say: "Coming.", route: "act", request: "follow me" }, { say: "Done." });
  action.reply({ step: { skill: "follow_player", player: "Steve", distance: 3 } }, { done: "followed" });
  await agent.handle(say("Steve", "Ayla, follow me"));
  await until(() => events.some((event) => event.kind === "state" && event.step !== null));
  const clock = createFakeClock({ mode: "mocked", startMs: performance.now() });
  using _installed = clock.install();
  clock.stepWallClock(11 * 60_000);
  await clock.advance(1_000);
  assert.deepEqual(events.filter((event) => event.kind === "step"), [], "still following after a poll (750 ms): the silence is 1 s of controlled time");
});

/** The agent's objective stack (private): a test puts a Work it built on it, then reads what the loop does to that Work. */
function stackOf(agent: Agent): Work[] {
  return (agent as unknown as { stack: Work[] }).stack;
}

/** The recorded step outcomes, as `outcome: detail`. */
function stepOutcomes(events: BrainEvent[]): string[] {
  return events.flatMap((event) => event.kind === "step" ? [`${event.outcome}: ${event.detail}`] : []);
}

const GO_TO = { skill: "go_to", x: 100, y: 64, z: 0 } as const;

/** Drive the agent until its observable state changes. */
async function clockUntil(clock: FakeClock, condition: () => boolean): Promise<void> {
  if (condition()) return;
  let cancel = () => {};
  try {
    await clock.settle(new Promise<void>((resolve) => { cancel = clock.every(() => { if (condition()) resolve(); }, 5); }), 10_000);
  } finally { cancel(); }
}

test("an idle respawn situation runs its planned step and is described as an event", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const runtime = new FakeRuntime();
  const { mind, action } = scriptedMind();
  const agent = new Agent({ persona: testPersona({ settings: { ...testPersona().settings, goalCallsPerMinute: 1 } }), runtime, mind, otherAgents: others(), log: () => undefined, typing: INSTANT_TYPING, pollMs: 5 });
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  try {
  const guards = (agent as unknown as { guards: { waitForGoalBudget(): Promise<boolean> } }).guards;
  assert.equal(await clock.settle(guards.waitForGoalBudget(), 10_000), true);
  const planned: StepDecision = { kind: "step", thought: "", step: GO_TO };
  const situation = { info: { kind: "respawn" as const, cause: "respawn", raisedAt: 0 }, order: null, told: false };
  stackOf(agent).push(newWork({ text: "respawn", requester: null, purpose: null }, null, situation, planned));
  assert.match(agent.activity, /an event/u);
  action.reply({ done: "finished" });
  running = agent.run(controller.signal);
  await clockUntil(clock, () => action.requests.length === 1);
  assert.equal(action.requests.length, 1);
  assert.equal(runtime.submitted.filter((call) => call.tool === "navigate").length, 1);
  } finally { controller.abort(); if (running !== undefined) await clock.settle(running, 10_000); }
});

for (const underlying of ["goal", "respawn"] as const) test(`nested situations protect ${underlying} materials from the junk hint`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, inventory: [{ name: "oak_planks", count: 256 }, { name: "dirt", count: 128 }] };
  runtime.failures.collect_block = "[INVENTORY_FULL] no free inventory slot";
  let stop!: () => Promise<void>;
  const { agent, events, action } = journaledAgent({ after: (fn) => { stop = fn; } }, runtime);
  try {
    const state = (kind: "respawn" | "night" | "low_health") => ({ info: { kind, cause: kind, raisedAt: 0 }, order: null, told: false });
    const base = newWork({ text: "gather supplies", requester: null, purpose: null }, null, underlying === "respawn" ? state("respawn") : null);
    base.wanted.add("oak_planks");
    const planned: StepDecision = { kind: "step", thought: "", step: { skill: "collect_block", block: "stone", count: 5 } };
    const health = newWork({ text: "health", requester: null, purpose: null }, null, state("low_health"), planned);
    stackOf(agent).push(base, ...(underlying === "goal" ? [newWork({ text: "night", requester: null, purpose: null }, null, state("night"))] : []), health);
    action.reply({ done: "finished" });
    await clockUntil(clock, () => stepOutcomes(events).length > 0);
    const detail = stepOutcomes(events).join(" ");
    assert.match(detail, /128 dirt/u);
    assert.doesNotMatch(detail, /nothing you are doing needs[^;]*oak_planks/u);
  } finally { await clock.settle(stop(), 10_000); }
});

for (const depth of [1, 2]) test(`later work queues below an order under ${depth} situation(s)`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  using _installed = clock.install();
  const runtime = new FakeRuntime();
  const { mind, chat, action } = scriptedMind();
  const agent = new Agent({ persona: testPersona(), runtime, mind, otherAgents: others(), log: () => undefined, typing: INSTANT_TYPING, pollMs: 5 });
  const controller = new AbortController();
  let running: Promise<void> | undefined;
  try {
  const own = newWork({ text: "own", requester: null, purpose: null });
  const order = newWork({ text: "first order", requester: "Steve", purpose: null });
  const event = () => newWork({ text: "event", requester: null, purpose: null }, null, { info: { kind: "night", cause: "night", raisedAt: 0 }, order, told: false });
  stackOf(agent).push(own, order, ...Array.from({ length: depth }, event));
  chat.reply({ say: "Later", route: "later", request: "second order" });
  await clock.settle(agent.handle(say("Bob", "second order")), 10_000);
  assert.deepEqual(stackOf(agent).map((work) => work.objective.text), ["own", "second order", "first order", ...Array(depth).fill("event")]);
  assert.match(chat.requests[0]?.[0]?.content ?? "", /"later" =/u);
  action.reply({ done: "first done" }, { done: "second done" });
  const internals = agent as unknown as { finish(work: Work, outcome: "done", detail: string): void; guards: { waitForGoalBudget(): Promise<boolean> } };
  assert.equal(await clock.settle(internals.guards.waitForGoalBudget(), 10_000), false);
  for (const work of [...stackOf(agent)].reverse()) if (work.situation !== null) internals.finish(work, "done", "ended");
  running = agent.run(controller.signal);
  await clockUntil(clock, () => action.requests.length >= 2);
  assert.match(JSON.stringify(action.requests[0]), /first order/u);
  assert.match(JSON.stringify(action.requests[1]), /second order/u);
  } finally { controller.abort(); if (running !== undefined) await clock.settle(running, 10_000); }
});

test("finishing a failed situation does not record an own-goal outcome", () => {
  const runtime = new FakeRuntime();
  const agent = new Agent({ persona: testPersona(), runtime, mind: scriptedMind().mind, otherAgents: others(), log: () => undefined, typing: INSTANT_TYPING });
  const situation = newWork({ text: "event", requester: null, purpose: null }, null, { info: { kind: "night", cause: "night", raisedAt: 0 }, order: null, told: false });
  stackOf(agent).push(situation);
  const internals = agent as unknown as { finish(work: Work, outcome: "failed", detail: string): void; lastFailed: unknown; memory: { lately: unknown[] } };
  const previous = { objective: "earlier", reason: "failed" };
  internals.lastFailed = previous;
  internals.finish(situation, "failed", "event ended");
  assert.equal(internals.lastFailed, previous);
  assert.equal(internals.memory.lately.length, 0);
  assert.equal(runtime.notes.length, 0);
});

test("the running step is known while it runs and cleared after", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, lastDeath: null };
  runtime.durations.navigate = 100_000;
  const { agent, action } = journaledAgent(t, runtime);
  const work = newWork({ text: "walk to the hill", requester: null, purpose: null });
  stackOf(agent).push(work);
  action.reply({ step: GO_TO }, { give_up: "stopped" });
  await until(() => runtime.submitted.some((call) => call.tool === "navigate"));
  assert.deepEqual(work.running?.step, GO_TO, "the step is known while it runs");
  work.step?.abort();
  await until(() => action.requests.length === 2);
  assert.equal(work.running, null, "cleared once the step ended");
  assert.equal(work.step, null);
});

/**
 * The ways a step can end: each clears `running` and `step` and records its own outcome. `arrange` sets the fake
 * before the step starts; `afterStart` ends it while it runs (a death) and is empty for the other two.
 */
const ENDINGS: readonly { how: string; step: Step; arrange: (runtime: FakeRuntime) => void; afterStart: (runtime: FakeRuntime) => Promise<void>; outcome: RegExp }[] = [
  { how: "a normal end", step: { skill: "collect_block", block: "dirt", count: 2 }, arrange: () => {}, afterStart: async () => {}, outcome: /^done: collected 2 dirt$/u },
  { how: "a thrown skill", step: GO_TO, arrange: (runtime) => { runtime.throwNext.navigate = "the link dropped"; }, afterStart: async () => {}, outcome: /^failed: .*the link dropped$/u },
  { how: "a death", step: GO_TO, arrange: () => {}, afterStart: async (runtime) => {
    await until(() => runtime.submitted.some((call) => call.tool === "navigate"));
    runtime.die("Zombie");
  }, outcome: /^interrupted: you died during this step .*\(Zombie\)$/u },
];

for (const ending of ENDINGS) test(`a step cleared after ${ending.how}, recorded as its outcome`, async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, lastDeath: null };
  runtime.durations.navigate = 100_000;
  ending.arrange(runtime);
  const { agent, action, events } = journaledAgent(t, runtime);
  const work = newWork({ text: "one step", requester: null, purpose: null });
  stackOf(agent).push(work);
  action.reply({ step: ending.step }, { give_up: "the step is over" });
  await ending.afterStart(runtime);
  await until(() => action.requests.length === 2, 5_000);
  assert.equal(work.running, null);
  assert.equal(work.step, null);
  assert.match(stepOutcomes(events)[0] ?? "", ending.outcome);
});

test("a replaced step is not cleared by the old step's finally: neither its controller nor its running record", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, lastDeath: null };
  runtime.durations.navigate = 100_000;
  const { agent, action } = journaledAgent(t, runtime);
  const work = newWork({ text: "walk to the hill", requester: null, purpose: null });
  stackOf(agent).push(work);
  action.reply({ step: GO_TO }, { give_up: "stopped" });
  await until(() => runtime.submitted.some((call) => call.tool === "navigate"));
  const old = work.step;
  // A newer step replaces both records while the old one unwinds (an order's take starts it on the same work).
  const newerController = new AbortController();
  const newer = { step: { skill: "collect_block", block: "dirt", count: 2 } as const, controller: newerController };
  work.step = newerController;
  work.running = newer;
  old?.abort();
  await until(() => action.requests.length === 2);
  assert.equal(work.step, newerController, "the old step's finally left the newer controller alone");
  assert.equal(work.running, newer, "the old step's finally left the newer record alone");
});

test("a planned step runs without a model call and counts as one step", async (t) => {
  const runtime = new FakeRuntime();
  const { agent, action, events } = journaledAgent(t, runtime);
  const planned: StepDecision = { kind: "step", thought: "", step: { skill: "collect_block", block: "dirt", count: 2 } };
  stackOf(agent).push(newWork({ text: "collect 2 dirt", requester: null, purpose: null }, null, null, planned));
  action.reply({ done: "collected 2 dirt" });
  await until(() => action.requests.length === 1);
  assert.equal(runtime.submitted.filter((call) => call.tool === "collect_block").length, 1, "the planned step ran");
  assert.equal(events.filter((event) => event.kind === "step").length, 1, "the planned step is one recorded step");
  assert.match(action.requests[0]?.[1]?.content ?? "", /1\. collect 2 dirt -> done: collected 2 dirt/u, "the next decision sees the planned step");
});

test("a planned step waiting under another objective runs once that objective ends, with no model call for it", async (t) => {
  const runtime = new FakeRuntime();
  runtime.snapshot = { ...runtime.snapshot, lastDeath: null };
  const { agent, action, events } = journaledAgent(t, runtime);
  const planned: StepDecision = { kind: "step", thought: "", step: { skill: "collect_block", block: "dirt", count: 2 } };
  // Pushed bottom first: the top objective is worked, the planned one waits below it (set aside, not run).
  stackOf(agent).push(newWork({ text: "collect 2 dirt", requester: null, purpose: null }, null, null, planned), newWork({ text: "rest for a while", requester: null, purpose: null }));
  action.reply({ done: "rested" }, { done: "collected 2 dirt" });
  await until(() => action.requests.length === 2);
  assert.equal(runtime.submitted.filter((call) => call.tool === "collect_block").length, 1, "the waiting planned step ran once");
  assert.deepEqual(stepOutcomes(events), ["done: collected 2 dirt"]);
  assert.match(action.requests[1]?.[1]?.content ?? "", /1\. collect 2 dirt -> done: collected 2 dirt/u, "the decision after the planned step sees it");
});
