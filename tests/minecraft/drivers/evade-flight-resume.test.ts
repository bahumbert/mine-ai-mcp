import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { awaitResumeAction, chooseResumeTarget, createLeeWitness, judgeNavigationEvents, judgeResume, observeResumeFlight, pairResumeReceipts, readResumeObservation, readResumeProbe, readResumeSpeed, resumeLeeCovered, resumeTargetInRange, run, waitResumeTrigger } from "./evade-flight.ts";
import { createFakeBot, createFakeClock, listenersAddedSince } from "../../../src/test-support/fake-bot/index.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";
import { loadScenario, scenarioDefinitionSchema } from "mine-labs";
import { survivalReceiptSchema, type SurvivalReceipt } from "../../../src/survival/evidence/contract.ts";
import { SurvivalPolicyState } from "../../../src/survival/state/survival-policy.ts";
import type { NavigationEvent } from "../../../src/navigation/telemetry/index.ts";
import type { ScenarioCall } from "../scenario.ts";
import { arenaFrame } from "../arena/frame.ts";
import { Vec3 } from "vec3";

// check-reads: tests/minecraft/scenarios/combat/evade-stationary-shooter-detour.yaml, tests/minecraft/scenarios/combat/evade-stationary-shooter-no-cover.yaml

const cover = [{ start: 10, end: 20, response: "evade", outcome: "safe_separation", basis: "cover", requestId: 1, shooterId: 7 }];
const detour = { mode: "detour" as const, status: "succeeded", error: "", nextStatus: "succeeded", requestId: 1,
  shooterId: 7, endpointCovered: true, nextMoved: true, nextArrived: true, deaths: 0, cutoff: 22 };
const refused = { ...detour, mode: "no-cover" as const, status: "failed", error: "[COVER_ROUTE_REFUSED]" };

test("an already cancelled action does not start", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  let calls = 0;
  await assert.rejects(awaitResumeAction(() => { calls++; return Promise.resolve(); }, controller.signal), /cancelled/);
  assert.equal(calls, 0);
});

test("cancelling a pending action releases its abort listener and ignores late settlement", async () => {
  const controller = new AbortController();
  let resolve!: (value: number) => void;
  const pending = awaitResumeAction(() => new Promise<number>(done => { resolve = done; }), controller.signal);
  controller.abort(new Error("trial ended"));
  await assert.rejects(pending, /trial ended/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  resolve(1);
  assert.equal(controller.signal.aborted, true);
});

test("the resumed run refuses once before searching", () => {
  const started = { seq: 21, kind: "run_started", runId: "resumed" };
  const refusal = { seq: 22, kind: "route_refused", runId: "resumed", planId: null };
  assert.equal(judgeNavigationEvents([started, refusal], 20, 25), true);
  assert.equal(judgeNavigationEvents([started, { ...refusal, planId: "plan" }], 20, 25), false);
  assert.equal(judgeNavigationEvents([started, { seq: 22, kind: "search_started", runId: "resumed" }, refusal], 20, 25), false);
  assert.equal(judgeNavigationEvents([], 20, 25), false);
  assert.equal(judgeNavigationEvents([started, { ...started, seq: 23, runId: "second" }, refusal], 20, 25), false);
  assert.equal(judgeNavigationEvents([{ ...started, seq: 19 }, refusal], 20, 25), false);
});

for (const { mode, offset, variant } of [
  ...(["detour", "no-cover"] as const).flatMap(mode => [{ x: 0, z: 0 }, { x: 64, z: 1536 }].map(offset => ({ mode, offset, variant: "normal" as const }))),
  { mode: "no-cover" as const, offset: { x: 0, z: 0 }, variant: "alternate" as const },
  { mode: "no-cover" as const, offset: { x: 0, z: 0 }, variant: "predicted-only" as const },
  { mode: "no-cover" as const, offset: { x: 0, z: 0 }, variant: "settle-trigger" as const },
  { mode: "no-cover" as const, offset: { x: 0, z: 0 }, variant: "settle-speed" as const },
  { mode: "no-cover" as const, offset: { x: 0, z: 0 }, variant: "reject-speed" as const },
  { mode: "no-cover" as const, offset: { x: 0, z: 0 }, variant: "invalid-first" as const },
  { mode: "no-cover" as const, offset: { x: 0, z: 0 }, variant: "no-navigation-collector" as const },
  { mode: "no-cover" as const, offset: { x: 0, z: 0 }, variant: "malformed-receipt" as const },
  { mode: "no-cover" as const, offset: { x: 0, z: 0 }, variant: "nested-limit" as const },
  { mode: "no-cover" as const, offset: { x: 0, z: 0 }, variant: "outer-thrown" as const },
  { mode: "no-cover" as const, offset: { x: 0, z: 0 }, variant: "abort-follow" as const },
  { mode: "no-cover" as const, offset: { x: 0, z: 0 }, variant: "death-follow" as const },
])
  test(`framed ${mode} ${variant} resume at ${offset.x},${offset.z}`, async () => {
    const file = new URL(`../scenarios/combat/evade-stationary-shooter-${mode}.yaml`, import.meta.url).pathname;
    const { client: _client, ...loaded } = await loadScenario(file);
    const scenario = scenarioDefinitionSchema.parse(loaded);
    const frame = arenaFrame(offset);
    const clock = createFakeClock({ mode: "mocked" });
    const harness = createFakeBot({ clock, username: "Actor", health: 7, food: 20,
      position: new Vec3(...frame.world([0.5, -60, 0.5])), groundY: -61 });
    const { bot, world, entities } = harness;
    const added = listenersAddedSince(bot);
    const controller = new AbortController();
    for (let z = -2; z <= (mode === "detour" ? 14 : 2); z++) for (let y = -60; y <= -58; y++)
      world.setCell(new Vec3(...frame.world([3, y, z])), "bedrock");
    const commands: string[] = [];
    const calls: Record<string, unknown>[] = [];
    let receipt: (value: SurvivalReceipt) => void = () => {};
    let navigation: (event: NavigationEvent, owner?: { requestId: number | null; current: string | null }) => void = () => {};
    let stored = { matched: false, position: bot.entity.position.clone() };
    let beforeFollow: Vec3 | undefined;
    let resolvePrimary: (value: ScenarioCall) => void = () => {};
    let rejectPrimary: (error: Error) => void = () => {};
    let primaryInput: Record<string, unknown> = {};
    const policyBase = new SurvivalPolicyState(bot).snapshot();
    const policy = { ...policyBase, effective: { ...policyBase.effective, combat: { ...policyBase.effective.combat, hide: "never" as const } } };
    const status = { summary: "responding", request: null, owner: { current: "navigate", reserved: null, connected: true, transfer: null },
      dangers: [], response: null, decisions: [], budgets: [], answered: [], observations: { missing: [], stale: [] }, policy,
      vitals: { health: 7, food: 20, air: null, inWater: false }, runtime: { liveness: "observed_in_process", observedAt: 0, physicsObservedAt: null } };
    const lee = new Vec3(...frame.world([4.6, -60, mode === "detour" ? -1.5 : 2.5]));
    const sendReceipt = (kind: "claim" | "outcome", shooterId: number, point = lee) => {
      const request = kind === "claim" ? { id: "primary", requestId: 1, action: "navigate", admittedAt: 0,
        objective: primaryInput, state: { kind: "running" }, evidence: null } : null;
      const evidence = kind === "claim" ? { response: "evade" } : { response: "evade", cancelled: false,
        outcome: { outcome: "safe_separation", finalPosition: { x: point.x, y: point.y, z: point.z }, ends: [{ id: shooterId, basis: "cover" }] } };
      const actual = variant === "malformed-receipt" && kind === "claim" ? {} : kind === "outcome" && variant === "nested-limit"
        ? { response: "evade", cancelled: false, outcome: { kind: "limit", limit: "no_progress" } }
        : kind === "outcome" && variant === "outer-thrown" ? { response: "evade", kind: "execution_failed", why: "thrown" } : evidence;
      receipt(survivalReceiptSchema.parse({ kind, source: "hostile_reflex", evidence: actual, status: { ...status, request } }));
    };
    const event = (value: object) => navigation(value as NavigationEvent, { requestId: 1, current: "navigate" });
    bot.chat = message => {
      commands.push(message);
      if (message.startsWith("/effect give")) {
        bot.entity.effects[10] = { id: 10, amplifier: 3, duration: 3600 };
      } else if (message.startsWith("/summon minecraft:skeleton")) {
        const [sx, sy, sz] = frame.world([-5.5, -60, 0.5]);
        const shooter = entities.spawn({ id: 7, name: "skeleton", position: new Vec3(sx, sy, sz) });
        if (variant === "settle-speed" || variant === "reject-speed") return;
        sendReceipt("claim", shooter.id);
        clock.after(100, () => {
          bot.entity.position = lee.clone();
          bot.emit("move", bot.entity.position);
          sendReceipt("outcome", shooter.id, variant === "invalid-first" ? new Vec3(offset.x + 2, -60, offset.z + 2.5) : lee);
          clock.after(100, () => {
            if (variant === "invalid-first") { sendReceipt("claim", shooter.id); sendReceipt("outcome", shooter.id); }
            event({ kind: "run_started", runId: "resumed", atMs: 0 });
            if (mode === "no-cover") event({ kind: "route_refused", runId: "resumed", planId: null, observation: "[COVER_ROUTE_REFUSED]", atMs: 0 });
            else { bot.entity.position = new Vec3(...frame.world([4, -60, 12])); bot.emit("move", bot.entity.position); }
            resolvePrimary({ action: "navigate", durationMs: 1, summary: "primary", requestId: 1,
              result: mode === "detour" ? { status: "succeeded" } : { status: "failed", error: "[COVER_ROUTE_REFUSED]" } });
          });
        });
      } else if (message.includes("store success storage mine_ai:cm p_resume_Actor_") && message.includes("time query gametime")) {
        const selector = /@s\[([^\]]+)\]/u.exec(message)?.[1];
        const coordinate = (name: string) => Number(new RegExp(`(?:^|,)${name}=(-?[\\d.]+)`, "u").exec(selector ?? "")?.[1]);
        const radius = Number(/distance=\.\.([\d.]+)/u.exec(selector ?? "")?.[1]);
        const hasPoint = Number.isFinite(radius);
        let position = bot.entity.position.clone();
        if (variant === "alternate" && (message.includes("_next_range") || message.includes("_chosen_range")))
          position = new Vec3(offset.x + 5, -60, offset.z);
        if (message.includes("_chosen_range")) beforeFollow = position.clone();
        if (variant === "predicted-only" && message.includes("_next_arrival")) position = beforeFollow!.clone();
        stored = { position, matched: !hasPoint || position.distanceTo(new Vec3(coordinate("x"), coordinate("y"), coordinate("z"))) <= radius };
      } else if (message.startsWith("/tellraw @s") && message.includes("resume_probe_Actor_")) {
        const id = /resume_probe_Actor_([a-z_0-9]+) /u.exec(message)?.[1];
        assert.ok(id);
        const { position, matched } = stored;
        clock.after(50, () => bot.emit("messagestr", `resume_probe_Actor_${id} ${matched ? 1 : 0} 42 [${position.x}d, ${position.y}d, ${position.z}d]`, "system", {} as never));
      } else if (message.startsWith("/tellraw @s") && message.includes("resume_shooter_Actor")) {
        clock.after(50, () => bot.emit("messagestr", `resume_shooter_Actor [${offset.x - 5.5}d, -60d, ${offset.z + 0.5}d]`, "system", {} as never));
      } else if (message.startsWith("/tellraw @s") && message.includes("resume_speed_Actor")) {
        if (variant === "settle-speed") resolvePrimary({ action: "navigate", durationMs: 1, summary: "early", requestId: 1, result: { status: "succeeded" } });
        if (variant === "reject-speed") rejectPrimary(new Error("primary rejected"));
        clock.after(50, () => bot.emit("messagestr", "resume_speed_Actor 1 0", "system", {} as never));
      }
    };
    let navigates = 0;
    const context = { ...scenarioTestContext({ bot, scenario, arena: frame, call: async (action, input) => {
      if (action === "view_status") return { action, durationMs: 0, summary: action, result: { status: "succeeded" }, survivalPolicy: policy } as ScenarioCall;
      if (action === "set_survival_policy") return { action, durationMs: 0, summary: action, result: { status: "succeeded" } };
      assert.equal(action, "navigate");
      calls.push(input);
      if (++navigates === 1) {
        primaryInput = input;
        const pending = new Promise<ScenarioCall>((resolve, reject) => { resolvePrimary = resolve; rejectPrimary = reject; });
        clock.after(50, () => {
          if (variant === "settle-trigger") {
            resolvePrimary({ action: "navigate", durationMs: 1, summary: "early", requestId: 1, result: { status: "succeeded" } });
            return;
          }
          entities.spawn({ id: 99, name: "skeleton", position: new Vec3(...frame.world([-5.5, -60, 0.5])) });
          bot.entity.position.z = offset.z + 0.7; bot.emit("move", bot.entity.position);
        });
        return pending;
      }
      if (variant === "abort-follow" || variant === "death-follow") {
        if (variant === "abort-follow") controller.abort(new Error("trial aborted during follow-up"));
        else bot.emit("death");
        return await new Promise<ScenarioCall>(() => {});
      }
      bot.entity.position = new Vec3(Number(input.x) + 0.35, Number(input.y), Number(input.z) + 1.66);
      bot.emit("move", bot.entity.position);
      return { action, durationMs: 1, summary: "next", requestId: 2, result: { status: "succeeded" } };
    } }), signal: controller.signal, onSurvivalReceipt: (observer: typeof receipt) => { receipt = observer; return () => { receipt = () => {}; }; },
      onNavigationEvent: variant === "no-navigation-collector" ? undefined : (observer: typeof navigation) => { navigation = observer; return () => { navigation = () => {}; }; } };
    using _timers = clock.install();
    if (["settle-trigger", "settle-speed", "reject-speed", "invalid-first", "no-navigation-collector", "malformed-receipt", "nested-limit", "outer-thrown", "abort-follow", "death-follow"].includes(variant)) {
      const pending = clock.settle(run(context), 15_000);
      if (["settle-speed", "invalid-first", "no-navigation-collector", "nested-limit", "outer-thrown"].includes(variant)) {
        const result = await pending;
        assert.equal(result.status, "failed");
        if (variant === "nested-limit" || variant === "outer-thrown") assert.match(result.detail ?? "", /not exercised/);
      }
      else await assert.rejects(pending, variant === "settle-trigger" ? /primary settled before trigger/ : variant === "reject-speed" ? /primary rejected/ :
        variant === "malformed-receipt" ? /hostile response name missing/ : variant === "abort-follow" ? /trial aborted during follow-up/ : /actor died/);
      const count = commands.length;
      await clock.advance(40_000);
      assert.equal(commands.length, count, "no commands after settlement");
      assert.equal(calls.length, variant === "abort-follow" || variant === "death-follow" ? 2 : 1, "no extra action after settlement");
      for (const name of ["time", "move", "forcedMove", "entitySpawn", "messagestr"]) assert.equal(added(name), 0, name);
      return;
    }
    const result = await clock.settle(run(context), 15_000);
    assert.equal(result.status, variant === "predicted-only" ? "failed" : "succeeded", result.detail ?? "driver failed");
    assert.deepEqual(calls, [{ x: offset.x + 4, y: -60, z: offset.z + 12, range: 1, dig: false, scaffold: false },
      { x: offset.x + (variant === "alternate" ? 8 : 5), y: -60, z: offset.z, range: 1, dig: false, scaffold: false }]);
    assert.equal(commands.filter(command => command.startsWith(`/summon minecraft:skeleton ${offset.x - 6} -60 ${offset.z} `) && command.includes('Tags:["resume_Actor"]')).length, 1);
    assert.equal(commands.filter(command => command.includes("attribute @e[type=minecraft:skeleton,tag=resume_Actor,limit=1] minecraft:movement_speed get")).length, 1);
    assert.equal(commands.filter(command => command.includes("resume_shooter_Actor")).length, 1);
    assert.equal(commands.some(command => command.includes("evade_resume_lee")), false);
  });

test("the first lee witness requires uninterrupted cover", () => {
  const centre = new Vec3(4.6, -60, 2.5);
  const witness = () => createLeeWitness(position => position.x > 4, centre);
  const exited = witness();
  exited.move(new Vec3(3, -60, 2.5));
  exited.move(centre);
  assert.equal(exited.answer(centre), false, "late re-entry cannot restore the first receipt");
  const handoff = witness();
  handoff.handoff();
  assert.equal(handoff.answer(centre), false);
  const settled = witness();
  settled.move(centre);
  assert.equal(settled.answer(centre), true, "ordinary in-lee settlement remains eligible");
});

test("recorded detour cover outcomes stay valid outside the old lee sphere", () => {
  const { bot, world, entities } = createFakeBot({ position: new Vec3(4.6, -60, -1.5), groundY: -61 });
  for (let z = -2; z <= 14; z++) for (let y = -60; y <= -58; y++) world.setCell(new Vec3(3, y, z), "bedrock");
  const shooter = entities.spawn({ id: 7, name: "skeleton", position: new Vec3(-5.5, -60, 0.5) });
  for (const position of [new Vec3(5.1618, -60, -1.46775), new Vec3(4.54788, -60, -1.99502)])
    assert.equal(resumeLeeCovered(bot, shooter, position, 3), true);
  assert.equal(resumeLeeCovered(bot, shooter, new Vec3(4.31, -60, -2.1), 3), false);
  assert.equal(resumeLeeCovered(bot, shooter, new Vec3(40, -60, 100), 3), false, "distance is not cover");
  assert.equal(resumeLeeCovered(bot, shooter, new Vec3(4.6, -58, -1.5), 3), false, "the body must stand on support");
  world.setCell(new Vec3(4, -61, -2), "stone_slab");
  assert.equal(resumeLeeCovered(bot, shooter, new Vec3(4.6, -60.2, -1.5), 3), false, "a floating body is not held by the slab");
  world.setCell(new Vec3(4, -60, -2), "void");
  assert.equal(resumeLeeCovered(bot, shooter, new Vec3(4.6, -60, -1.5), 3), false, "unloaded body geometry is not evidence of cover");
});

test("a foreign navigation run cannot satisfy the primary request's refusal proof", () => {
  const events = [
    { seq: 21, kind: "run_started", runId: "foreign", requestId: 2, owner: "navigate" },
    { seq: 22, kind: "route_refused", runId: "foreign", requestId: 2, owner: "navigate", planId: null },
  ];
  assert.equal(judgeNavigationEvents(events, 20, 23, 1), false);
  const both = [...events,
    { seq: 23, kind: "run_started", runId: "primary", requestId: 1, owner: "navigate" },
    { seq: 24, kind: "route_refused", runId: "primary", requestId: 1, owner: "navigate", planId: null }];
  assert.equal(judgeNavigationEvents(both, 20, 25, 1), true);
  assert.equal(judgeNavigationEvents([...both, { seq: 25, kind: "search_started", runId: "primary", requestId: 1, owner: "navigate" }], 20, 26, 1), false);
});

test("a probe reads one stored decision and the actor's server position", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, server } = createFakeBot({ clock, username: "Actor" });
  const start = server.gameTime;
  const commands: string[] = [];
  bot.chat = message => { commands.push(message); };
  const scenario = scenarioDefinitionSchema.parse({ name: "resume", players: [{ name: "Actor" }], goal: { kind: "completion", who: "Actor" } });
  const context = scenarioTestContext({ bot, scenario, call: async () => { throw new Error("unused"); } });
  const stop = server.onTick(() => { if (server.gameTime === start + 1) bot.emit("messagestr", "resume_probe_Actor_one 1 42 [4.6d, -60.0d, 2.5d]", "system", {} as never); });
  using _timers = clock.install();
  try {
    const result = await clock.settle(readResumeObservation(context, "entity @s[tag=evade_resume_lee]", "one"), 5000);
    assert.equal(result.matched, true);
    assert.equal(result.tick, 42);
    assert.deepEqual(result.position, new Vec3(4.6, -60, 2.5));
    assert.equal(commands.filter(command => command.includes("if entity @s[tag=evade_resume_lee]")).length, 1);
    assert.ok(commands.some(command => command.includes("data merge storage mine_ai:cm {p_resume_Actor_one:0,v_resume_Actor_one:0}")),
      "a failed selector must leave explicit zero values rather than missing or stale storage");
    assert.equal(commands.filter(command => command.includes("unless entity")).length, 0);
  } finally { stop(); }
});

test("a probe rejects malformed and conflicting replies and releases its listener", async () => {
  for (const messages of [["garbage"], ["1 42 [0.5d, 64d, 0.5d]", "0 0 [0.5d, 64d, 0.5d]"]]) {
    const clock = createFakeClock({ mode: "mocked" });
    const { bot } = createFakeBot({ clock, username: "Actor" });
    const added = listenersAddedSince(bot);
    bot.chat = message => {
      if (message.startsWith("/tellraw")) clock.after(50, () => {
        for (const value of messages) bot.emit("messagestr", `resume_probe_Actor_bad ${value}`, "system", {} as never);
      });
    };
    const scenario = scenarioDefinitionSchema.parse({ name: "resume", players: [{ name: "Actor" }], goal: { kind: "completion", who: "Actor" } });
    const context = scenarioTestContext({ bot, scenario, call: async () => { throw new Error("unused"); } });
    using _timers = clock.install();
    await assert.rejects(clock.settle(readResumeObservation(context, "entity @s", "bad"), 5000), /malformed or conflicting/);
    assert.equal(added("messagestr"), 0);
  }
});

for (const ticksPerSecond of [20, 10]) test(`trigger waits for the server crossing at ${ticksPerSecond} tps`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, server } = createFakeBot({ clock, username: "Actor", server: { ticksPerSecond } });
  const startAge = bot.time.age;
  const added = listenersAddedSince(bot);
  bot.entity.position.z = 0.7;
  let reads = 0;
  bot.chat = message => {
    if (!message.startsWith("/tellraw ")) return;
    const z = ++reads === 1 ? 0.5 : 0.7;
    const id = reads;
    clock.after(50, () => {
      if (id === 2) bot.emit("messagestr", "resume_probe_Actor_trigger_1 1 42 [0.5d, 64d, 0.9d]", "system", {} as never);
      bot.emit("messagestr", `resume_probe_Actor_trigger_${id} 1 42 [0.5d, 64d, ${z}d]`, "system", {} as never);
    });
  };
  const scenario = scenarioDefinitionSchema.parse({ name: "resume", players: [{ name: "Actor" }], goal: { kind: "completion", who: "Actor" } });
  const context = scenarioTestContext({ bot, scenario, call: async () => { throw new Error("unused"); } });
  using _timers = clock.install();
  const result = await clock.settle(waitResumeTrigger(context, 0.6, () => startAge), 10_000);
  assert.equal(reads, 2);
  assert.equal(result.position.z, 0.7);
  assert.ok(server.gameTime >= startAge + 20);
  assert.equal(added("messagestr"), 0);
});

test("an aborted trigger cannot accept a late server answer", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot } = createFakeBot({ clock, username: "Actor" });
  const added = listenersAddedSince(bot);
  const controller = new AbortController();
  bot.entity.position.z = 0.7;
  bot.chat = () => {};
  const scenario = scenarioDefinitionSchema.parse({ name: "resume", players: [{ name: "Actor" }], goal: { kind: "completion", who: "Actor" } });
  const context = { ...scenarioTestContext({ bot, scenario, call: async () => { throw new Error("unused"); } }), signal: controller.signal };
  using _timers = clock.install();
  const pending = waitResumeTrigger(context, 0.6, () => bot.time.age);
  controller.abort(new Error("primary settled"));
  await assert.rejects(clock.settle(pending, 5000), /primary settled/);
  bot.emit("messagestr", "resume_probe_Actor_trigger_1 1 42 [0.5d, 64d, 0.7d]", "system", {} as never);
  assert.equal(added("messagestr"), 0);
});

for (const [name, actual, expected] of [
  ["exposed", judgeResume([{ seq: 21, exposed: true }], cover, detour).passed, false],
  ["missing separation", judgeResume([], [], detour).reason, "not exercised"],
  ["cancelled stall", judgeResume([], cover, { ...refused, status: "cancelled", error: "[HOSTILE_STALLED]" }).passed, false],
  ["failed next", judgeResume([{ seq: 21, exposed: false }], cover, { ...detour, nextStatus: "failed" }).passed, false],
  ["detour", judgeResume([{ seq: 21, exposed: false }], cover, detour).passed, true],
  ["refusal", judgeResume([], cover, refused).passed, true],
  ["endpoint", judgeResume([], cover, { ...refused, endpointCovered: false }).passed, false],
  ["movement", judgeResume([], cover, { ...refused, nextMoved: false }).passed, false],
  ["shooter", judgeResume([], cover, { ...refused, shooterId: 8 }).reason, "not exercised"],
  ["unknown", judgeResume([{ seq: 21, exposed: null }], cover, detour).reason, "invalid evidence"],
  ["no sample", judgeResume([], cover, detour).passed, false],
  ["request", judgeResume([{ seq: 21, exposed: false }], cover, { ...detour, requestId: 2 }).reason, "not exercised"],
  ["post cutoff sample", judgeResume([{ seq: 21, exposed: false }, { seq: 23, exposed: true }], cover, detour).passed, true],
  ["post cutoff separation", judgeResume([], cover, { ...refused, cutoff: 19 }).reason, "not exercised"],
] as const) test(`resume verdict: ${name}`, () => assert.equal(actual, expected));

test("only hostile response spans exclude samples, even at the same age", () => {
  const spans = [...cover,
    { start: 23, end: 25, response: "fight", outcome: "cancelled", basis: null, requestId: 1, shooterId: null },
    { start: 27, end: Infinity, response: "evade", outcome: "", basis: null, requestId: 1, shooterId: null }];
  const samples = [{ seq: 21, exposed: false }, { seq: 24, exposed: true }, { seq: 26, exposed: true }, { seq: 28, exposed: true }];
  const verdict = judgeResume(samples, spans, { ...detour, cutoff: 28 });
  assert.equal(verdict.exposed, 1);
  assert.equal(verdict.judged, 2);
  assert.equal(verdict.passed, false);
});

test("an already-in-range follow-up selects the other destination", async () => {
  const checked: string[] = [];
  const chosen = await chooseResumeTarget([5, -60, 0], [8, -60, 0], async (_point, id) => { checked.push(id); return id === "next_range"; });
  assert.deepEqual(chosen, [8, -60, 0]);
  assert.deepEqual(checked, ["next_range", "chosen_range"]);
  await assert.rejects(chooseResumeTarget([5, -60, 0], [8, -60, 0], async () => true), /already in range/);
});

test("a GoalNear cell can be in range while the server's exact feet are not", () => {
  const point: [number, number, number] = [5, -60, 0];
  const position = new Vec3(6.8, -60, 0.5);
  assert.equal(resumeTargetInRange(point, { position, matched: false, tick: 42 }), true);
  assert.throws(() => resumeTargetInRange(point, { position, matched: true, tick: 42 }), /range mismatch/);
});

test("trigger uses the remaining driver ticks and does no work after that budget", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot } = createFakeBot({ clock });
  let commands = 0;
  bot.chat = () => { commands++; };
  const scenario = scenarioDefinitionSchema.parse({ name: "resume", players: [{ name: "Actor" }], goal: { kind: "completion", who: "Actor" } });
  const context = scenarioTestContext({ bot, scenario, call: async () => { throw new Error("unused"); } });
  using _timers = clock.install();
  await assert.rejects(clock.settle(waitResumeTrigger(context, 0.6, () => bot.time.age - 3600), 5000), /remaining trial ticks/);
  assert.equal(commands, 0);
});

for (const rate of [20, 10]) for (const answerTick of [19, 20])
  test(`trigger ${answerTick === 19 ? "accepts the last" : "rejects the first expired"} tick at ${rate} tps`, async () => {
    const clock = createFakeClock({ mode: "mocked" });
    const { bot, server } = createFakeBot({ clock, username: "Actor", server: { ticksPerSecond: rate } });
    const start = server.gameTime;
    const anchor = bot.time.age - 3580;
    const added = listenersAddedSince(bot);
    bot.entity.position.z = 0.7;
    bot.chat = () => {};
    const scenario = scenarioDefinitionSchema.parse({ name: "resume", players: [{ name: "Actor" }], goal: { kind: "completion", who: "Actor" } });
    const context = scenarioTestContext({ bot, scenario, call: async () => { throw new Error("unused"); } });
    const stop = server.onTick(() => {
      if (server.gameTime !== start + answerTick) return;
      server.resendTime();
      bot.emit("messagestr", `resume_probe_Actor_trigger_1 1 ${server.gameTime} [0.5d, 64d, 0.7d]`, "system", {} as never);
    });
    using _timers = clock.install();
    try {
      const pending = clock.settle(waitResumeTrigger(context, 0.6, () => anchor), 5000);
      if (answerTick === 19) assert.equal((await pending).tick, start + 19);
      else await assert.rejects(pending, /remaining trial ticks|resume probe/);
      assert.equal(server.gameTime, start + answerTick);
      assert.equal(added("messagestr"), 0);
    } finally { stop(); }
  });

test("trigger accepts the first time packet when driver entry had no age", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, server } = createFakeBot({ clock, username: "Actor", server: { timePacketYet: false } });
  assert.equal(bot.time.age, null);
  let anchor: number | undefined;
  const remember = () => { anchor ??= bot.time.age; };
  bot.on("time", remember);
  const start = server.gameTime;
  const stop = server.onTick(() => { if (server.gameTime === start + 21) bot.entity.position.z = 0.7; });
  bot.chat = message => { if (message.startsWith("/tellraw")) clock.after(50, () =>
    bot.emit("messagestr", "resume_probe_Actor_trigger_1 1 42 [0.5d, 64d, 0.7d]", "system", {} as never)); };
  const scenario = scenarioDefinitionSchema.parse({ name: "resume", players: [{ name: "Actor" }], goal: { kind: "completion", who: "Actor" } });
  const context = scenarioTestContext({ bot, scenario, call: async () => { throw new Error("unused"); } });
  using _timers = clock.install();
  try {
    const answer = await clock.settle(waitResumeTrigger(context, 0.6, () => anchor), 5000);
    assert.equal(answer.position.z, 0.7);
    assert.notEqual(anchor, undefined);
    assert.ok(server.gameTime >= start + 21);
  } finally { stop(); bot.off("time", remember); }
});

test("pairs each hostile outcome and excludes only samples inside its own claim", () => {
  const spans = pairResumeReceipts([
    { seq: 1, kind: "claim", source: "hostile_reflex", response: "evade", requestId: 1 },
    { seq: 2, kind: "outcome", source: "hostile_reflex", response: "evade", requestId: 1 },
    { seq: 3, kind: "claim", source: "hostile_reflex", response: "fight", requestId: 1 },
    { seq: 4, kind: "outcome", source: "other", response: "fight", requestId: 1 },
    { seq: 6, kind: "outcome", source: "hostile_reflex", response: "fight", requestId: 1 },
    { seq: 8, kind: "claim", source: "hostile_reflex", response: "evade", requestId: 1 },
    { seq: 10, kind: "outcome", source: "hostile_reflex", response: "evade", requestId: 1 },
  ]);
  assert.deepEqual(spans.map(({ start, end }) => [start, end]), [[1, 2], [3, 6], [8, 10]]);
  assert.throws(() => pairResumeReceipts([{ seq: 1, kind: "outcome", source: "hostile_reflex", response: "evade", requestId: 1 }]), /unmatched/);
  assert.throws(() => pairResumeReceipts([
    { seq: 1, kind: "claim", source: "hostile_reflex", response: "evade", requestId: 1 },
    { seq: 2, kind: "claim", source: "hostile_reflex", response: "evade", requestId: 1 },
  ]), /duplicate/);
  assert.throws(() => pairResumeReceipts([
    { seq: 1, kind: "claim", source: "hostile_reflex", response: "evade", requestId: 1 },
    { seq: 2, kind: "outcome", source: "hostile_reflex", response: "fight", requestId: 1 },
  ]), /unmatched/);
  assert.deepEqual(pairResumeReceipts([{ seq: 11, kind: "claim", source: "hostile_reflex", response: "evade", requestId: 1 }])
    .map(({ start, end }) => [start, end]), [[11, Infinity]]);
});

test("an absent receipt subscription does not leave movement listeners", () => {
  const { bot } = createFakeBot();
  const added = listenersAddedSince(bot);
  const scenario = scenarioDefinitionSchema.parse({ name: "resume", players: [{ name: "Actor" }], goal: { kind: "completion", who: "Actor" } });
  assert.throws(() => observeResumeFlight(scenarioTestContext({ bot, scenario, call: async () => { throw new Error("unused"); } }), () => undefined, 36), /no survival receipt observer/);
  for (const event of ["time", "move", "forcedMove"]) assert.equal(added(event), 0, event);
});

test("a failed movement listener registration removes earlier subscriptions", () => {
  const { bot } = createFakeBot();
  const added = listenersAddedSince(bot);
  const add = bot.on.bind(bot);
  bot.on = ((event: string, listener: (...args: never[]) => void) => {
    if (event === "move") throw new Error("registration failed");
    return add(event as never, listener as never);
  }) as typeof bot.on;
  const scenario = scenarioDefinitionSchema.parse({ name: "resume", players: [{ name: "Actor" }], goal: { kind: "completion", who: "Actor" } });
  let subscribed = true;
  const context = { ...scenarioTestContext({ bot, scenario, call: async () => { throw new Error("unused"); } }),
    onSurvivalReceipt: () => () => { subscribed = false; } };
  assert.throws(() => observeResumeFlight(context, () => undefined, 36), /registration failed/);
  assert.equal(subscribed, false);
  assert.equal(added("time"), 0);
});

test("a failed navigation subscription removes the receipt subscription", () => {
  const { bot } = createFakeBot();
  const added = listenersAddedSince(bot);
  const scenario = scenarioDefinitionSchema.parse({ name: "resume", players: [{ name: "Actor" }], goal: { kind: "completion", who: "Actor" } });
  let subscriptions = 0;
  const context = { ...scenarioTestContext({ bot, scenario, call: async () => { throw new Error("unused"); } }),
    onSurvivalReceipt: () => { subscriptions++; return () => { subscriptions--; }; },
    onNavigationEvent: () => { throw new Error("navigation subscription failed"); } };
  assert.throws(() => observeResumeFlight(context, () => undefined, 36), /navigation subscription failed/);
  assert.equal(subscriptions, 0);
  for (const event of ["time", "move", "forcedMove"]) assert.equal(added(event), 0);
});

test("failed receipt cleanup still removes the navigation and movement listeners", () => {
  const { bot } = createFakeBot();
  const added = listenersAddedSince(bot);
  const scenario = scenarioDefinitionSchema.parse({ name: "resume", players: [{ name: "Actor" }], goal: { kind: "completion", who: "Actor" } });
  let navigationOpen = true;
  const context = { ...scenarioTestContext({ bot, scenario, call: async () => { throw new Error("unused"); } }),
    onSurvivalReceipt: () => () => { throw new Error("cleanup failed"); },
    onNavigationEvent: () => () => { navigationOpen = false; } };
  const observation = observeResumeFlight(context, () => undefined, 36);
  assert.throws(() => observation.close(), /cleanup failed/);
  assert.equal(navigationOpen, false);
  for (const event of ["time", "move", "forcedMove"]) assert.equal(added(event), 0);
});

for (const failure of ["death", "abort", "command"] as const) test(`resume setup releases listeners after ${failure}`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot } = createFakeBot({ clock, health: 7, food: 20 });
  const added = listenersAddedSince(bot);
  const controller = new AbortController();
  const commands: string[] = [];
  bot.chat = message => { commands.push(message); if (failure === "command") throw new Error("command failed"); };
  const scenario = scenarioDefinitionSchema.parse({ name: "resume", players: [{ name: "Actor" }], goal: { kind: "completion", who: "Actor" },
    params: { mob: "skeleton", target: [4, -60, 12], spawn: [-6, -60, 0], bases: ["cover"], judge: "resume", mode: "no-cover",
      wall: [3, -60, 0], nextTarget: [5, -60, 0], alternateNextTarget: [8, -60, 0] } });
  const context = { ...scenarioTestContext({ bot, scenario, call: async () => { throw new Error("unexpected action"); } }), signal: controller.signal };
  using _timers = clock.install();
  if (failure === "death") clock.after(50, () => bot.emit("death"));
  if (failure === "abort") clock.after(50, () => controller.abort(new Error("trial aborted")));
  await assert.rejects(clock.settle(run(context), 5000), failure === "death" ? /actor died/ : failure === "abort" ? /trial aborted/ : /command failed/);
  const count = commands.length;
  await clock.advance(40_000);
  assert.equal(commands.length, count);
  for (const event of ["death", "time", "move", "forcedMove", "entitySpawn", "messagestr"]) assert.equal(added(event), 0, event);
});

test("movement at the same age remains ordered around receipts and cutoff removes listeners", () => {
  const { bot } = createFakeBot();
  const added = listenersAddedSince(bot);
  const scenario = scenarioDefinitionSchema.parse({ name: "resume", players: [{ name: "Actor" }], goal: { kind: "completion", who: "Actor" } });
  let callback: (receipt: SurvivalReceipt) => void = () => {};
  let navigation: (event: NavigationEvent) => void = () => {};
  let unsubscribed = 0;
  const context = { ...scenarioTestContext({ bot, scenario, call: async () => { throw new Error("unused"); } }),
    onSurvivalReceipt: (observer: (receipt: SurvivalReceipt) => void) => { callback = observer; return () => { unsubscribed++; callback = () => {}; }; },
    onNavigationEvent: (observer: typeof navigation) => { navigation = observer; return () => { unsubscribed++; }; } };
  const observation = observeResumeFlight(context, () => undefined, 36);
  bot.emit("move", bot.entity.position);
  callback({} as never);
  navigation({ kind: "run_started", runId: "resume", atMs: 0 });
  bot.emit("move", bot.entity.position);
  const cutoff = observation.cutoff();
  bot.emit("move", bot.entity.position);
  assert.deepEqual(observation.samples.map(sample => sample.seq), [1, 4, 5]);
  assert.equal(observation.receipts[0]?.seq, 2);
  assert.equal(observation.navigation[0]?.seq, 3);
  assert.equal(observation.hasNavigation, true);
  assert.equal(cutoff, 5);
  observation.close();
  observation.close();
  assert.equal(unsubscribed, 2);
  for (const event of ["time", "move", "forcedMove"]) assert.equal(added(event), 0, event);
});

test("a shooter at the safe-range boundary is visible, just beyond it is not, and unloaded sight is unknown", () => {
  const scenario = scenarioDefinitionSchema.parse({ name: "resume", players: [{ name: "Actor" }], goal: { kind: "completion", who: "Actor" } });
  const make = (loadedColumns: [number, number][]) => {
    const { bot } = createFakeBot({ position: new Vec3(0, 64, 0), loadedColumns,
      entities: { 2: { name: "skeleton", position: new Vec3(36, 64, 0) } } });
    const context = { ...scenarioTestContext({ bot, scenario, call: async () => { throw new Error("unused"); } }),
      onSurvivalReceipt: () => () => {} };
    return { bot, observation: observeResumeFlight(context, () => 2, 36) };
  };
  const loaded = make([[0, 0], [1, 0], [2, 0], [-1, 0], [0, -1], [1, -1], [2, -1], [-1, -1]]);
  loaded.bot.emit("move", loaded.bot.entity.position);
  assert.equal(loaded.observation.samples[0]?.exposed, true);
  loaded.bot.entities[2]!.position.x = 36.01;
  loaded.bot.emit("move", loaded.bot.entity.position);
  assert.equal(loaded.observation.samples[1]?.exposed, false);
  loaded.observation.close();
  const unknown = make([[0, 0]]);
  unknown.bot.emit("move", unknown.bot.entity.position);
  assert.equal(unknown.observation.samples[0]?.exposed, null);
  unknown.observation.close();
});

for (const ticksPerSecond of [20, 10]) test(`probe reads the answer at ${ticksPerSecond} tps and removes its listener`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, server } = createFakeBot({ clock, server: { ticksPerSecond } });
  const start = server.gameTime;
  const added = listenersAddedSince(bot);
  const scenario = scenarioDefinitionSchema.parse({ name: "resume", players: [{ name: "Actor" }], goal: { kind: "completion", who: "Actor" } });
  const context = scenarioTestContext({ bot, scenario, call: async () => { throw new Error("unused"); } });
  const stop = server.onTick(() => { if (server.gameTime === start + 1) bot.emit("messagestr", `resume_probe_${bot.username}_test 1 42 [0.5d, 64.0d, 0.5d]`, "system", {} as never); });
  using _timers = clock.install();
  try {
    assert.equal(await clock.settle(readResumeProbe(context, "entity @s", "test"), 5000), true);
    assert.ok(server.gameTime >= start + 1);
    assert.equal(added("messagestr"), 0);
    await clock.advance(40_000);
    assert.equal(clock.pendingGlobalTimers(), 0);
  } finally { stop(); }
});

for (const ticksPerSecond of [20, 10]) test(`held shooter speed is confirmed at ${ticksPerSecond} tps`, async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, server } = createFakeBot({ clock, username: "Actor", server: { ticksPerSecond } });
  const start = server.gameTime;
  const commands: string[] = [];
  bot.chat = (message) => { commands.push(message); };
  const added = listenersAddedSince(bot);
  const scenario = scenarioDefinitionSchema.parse({ name: "resume", players: [{ name: "Actor" }], goal: { kind: "completion", who: "Actor" } });
  const context = scenarioTestContext({ bot, scenario, call: async () => { throw new Error("unused"); } });
  const stop = server.onTick(() => { if (server.gameTime === start + 1) bot.emit("messagestr", "resume_speed_Actor 1 0", "system", {} as never); });
  using _timers = clock.install();
  try {
    await clock.settle(readResumeSpeed(context, "resume_Actor"), 5000);
    assert.ok(commands[0]?.includes("tag=resume_Actor"));
    assert.equal(server.gameTime, start + 1);
    assert.equal(added("messagestr"), 0);
  } finally { stop(); }
});

test("probe exits when the server stops", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot, server } = createFakeBot({ clock });
  const start = server.gameTime;
  const added = listenersAddedSince(bot);
  const scenario = scenarioDefinitionSchema.parse({ name: "resume", players: [{ name: "Actor" }], goal: { kind: "completion", who: "Actor" } });
  const context = scenarioTestContext({ bot, scenario, call: async () => { throw new Error("unused"); } });
  server.stop();
  using _timers = clock.install();
  await assert.rejects(clock.settle(readResumeProbe(context, "entity @s", "test"), 40_000), /stalled/);
  assert.equal(server.gameTime, start);
  assert.equal(added("messagestr"), 0);
});

test("the speed read handles abort without leaving its answer listener", async () => {
  const clock = createFakeClock({ mode: "mocked" });
  const { bot } = createFakeBot({ clock });
  const added = listenersAddedSince(bot);
  const scenario = scenarioDefinitionSchema.parse({ name: "resume", players: [{ name: "Actor" }], goal: { kind: "completion", who: "Actor" } });
  const controller = new AbortController();
  const context = { ...scenarioTestContext({ bot, scenario, call: async () => { throw new Error("unused"); } }), signal: controller.signal };
  using _timers = clock.install();
  const pending = readResumeSpeed(context, "tagged");
  controller.abort(new Error("trial aborted"));
  await assert.rejects(clock.settle(pending, 5000), /trial aborted/);
  assert.equal(added("messagestr"), 0);
  await clock.advance(40_000);
  assert.equal(clock.pendingGlobalTimers(), 0);
});
