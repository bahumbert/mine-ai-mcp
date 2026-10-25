// view_status: the retained death, End observations, movement unlocks, digging, food and vehicle the status reports.
import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { viewStatusResultSchema } from "./contract.js";
import { formatViewStatusResult, observeLiveSituation } from "./view-status.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { recordLastDeath } from "../../bot-data/index.js";
import { SurvivalPolicyState } from "../../survival/state/survival-policy.js";
import { idleActivity, registry, loaded, liveBot } from "./view-status-fixtures.test.js";

test("status exposes the retained death after the live position has changed", (t) => {
  const bot = liveBot();
  const data = temporaryBotData({ botId: "TestBot", closeAfter: t });
  recordLastDeath(data, {
    botId: "TestBot", dimension: "overworld", position: { x: 4.5, y: 63, z: -9.5 },
    observedAt: "2026-09-13T09:00:00.000Z", cause: "fell from a high place",
  });

  const situation = observeLiveSituation(bot, data, idleActivity);

  assert.deepEqual(situation.lastDeath, {
    dimension: "overworld", position: { x: 4.5, y: 63, z: -9.5 },
    observedAt: "2026-09-13T09:00:00.000Z", cause: "fell from a high place",
  });
  assert.match(formatViewStatusResult({ status: "succeeded", situation }), /Last death: `4.5, 63, -9.5`/);
});

test("End observations name dragon phases, render the estimated head, and report loaded cage evidence", (t) => {
  // Bars beside crystal 21, an unloaded cell beside crystal 23, air everywhere else.
  const bot = liveBot({
    entities: {
      20: loaded("ender_dragon", new Vec3(30.5, 80, 0.5), { yaw: 0 }),
      21: loaded("end_crystal", new Vec3(0.5, 83, 0.5)),
      22: loaded("end_crystal", new Vec3(10.5, 83, 0.5)),
      23: loaded("end_crystal", new Vec3(20.5, 83, 0.5)),
    },
    cells: { "2,83,0": "iron_bars", "18,82,-2": "void" },
  });
  const dragon = bot.entities[20]!;
  const phaseKey = registry.entitiesByName.ender_dragon!.metadataKeys!.indexOf("phase");
  const healthKey = registry.entitiesByName.ender_dragon!.metadataKeys!.indexOf("health");
  // Prismarine types metadata as objects; the server sends the phase and health as numbers.
  Object.assign(dragon.metadata, { [phaseKey]: 6, [healthKey]: 150 });

  const situation = observeLiveSituation(bot, temporaryBotData({ botId: "TestBot", closeAfter: t }), idleActivity);

  assert.deepEqual(
    situation.endFight.crystals.map(({ entityId, cage }) => ({ entityId, cage })),
    [
      { entityId: 21, cage: "present" },
      { entityId: 22, cage: "none_observed" },
      { entityId: 23, cage: "unknown" },
    ],
  );
  assert.equal(situation.endFight.dragons[0]?.phaseName, "sitting_scanning");
  assert.deepEqual(situation.endFight.dragons[0]?.headEstimate, { x: 30.5, y: 79, z: 7 });
  assert.equal(situation.endFight.dragons[0]?.landingHeadEstimate, null);
  const rendered = formatViewStatusResult({ status: "succeeded", situation });
  assert.match(rendered, /phase 6 \(sitting_scanning\).*estimated head `30.5, 79, 7`/);
  assert.match(rendered, /Crystal #21.*cage present/);
  assert.match(rendered, /Crystal #23.*cage unknown/);
  assert.match(rendered, /Bow tip: bows can hit caged crystals through gaps, but may waste arrows/);
  viewStatusResultSchema.parse({ status: "succeeded", situation });
});

test("landing head preparation is reported only from observed fountain geometry", (t) => {
  // The fountain: a bedrock pillar from y 60 to 63 on (0, 0) and its rim at y 60, three blocks out; air elsewhere.
  const fountain = ["0,60,0", "0,61,0", "0,62,0", "0,63,0", "3,60,0", "-3,60,0", "0,60,3", "0,60,-3"];
  const bot = liveBot({
    entities: { 20: loaded("ender_dragon", new Vec3(30.5, 80, 0.5), { yaw: 0 }) },
    cells: Object.fromEntries(fountain.map((cell) => [cell, "bedrock"])),
  });
  const phaseKey = registry.entitiesByName.ender_dragon!.metadataKeys!.indexOf("phase");
  Object.assign(bot.entities[20]!.metadata, { [phaseKey]: 2 });
  const base = new Vec3(0, 60, 0);
  bot.findBlocks = () => [base];

  const observed = observeLiveSituation(bot, temporaryBotData({ botId: "TestBot", closeAfter: t }), idleActivity);
  assert.equal(observed.endFight.dragons[0]?.phaseName, "landing_approach");
  assert.equal(observed.endFight.dragons[0]?.headEstimate, null);
  assert.deepEqual(observed.endFight.dragons[0]?.landingHeadEstimate, { x: 0.5, y: 63, z: 7 });
  const rendered = formatViewStatusResult({ status: "succeeded", situation: observed });
  assert.match(rendered, /Predicted head after landing: `0.5, 63, 7`; direction may change/);
  assert.match(rendered, /prepare_dragon_perch.*attack_dragon_perch/);

  bot.findBlocks = () => [];
  // The cached observation remains usable only while the actual fountain
  // blocks are loaded. A missing search result alone does not erase them.
  bot.blockAt = () => null;
  const unknown = observeLiveSituation(bot, temporaryBotData({ botId: "TestBot", closeAfter: t }), idleActivity);
  assert.equal(unknown.endFight.dragons[0]?.landingHeadEstimate, null);
});

/**
 * The water bucket is the one carried item that changes how far a route will
 * fall, and a model cannot read that off the stack list: three blocks without
 * one, eighty with. The report says so both ways round, and it names the
 * missing bucket rather than reporting a bare unavailable.
 */
test("reports which movements the carried inventory unlocks, and what blocks the rest", (t) => {
  const data = () => temporaryBotData({ botId: "TestBot", closeAfter: t });
  const report = (bot: Bot) =>
    formatViewStatusResult({ status: "succeeded", situation: observeLiveSituation(bot, data(), idleActivity) });

  const empty = liveBot();
  const dry = observeLiveSituation(empty, data(), idleActivity);
  assert.deepEqual(dry.mobility.bucketDrop, { available: false, maximumBlocks: 0, blockedBy: ["no_water_bucket"] });
  assert.deepEqual(dry.mobility.fallSave, { available: false, blockedBy: ["no_water_bucket"] });
  assert.equal(dry.mobility.waterBuckets, 0);
  assert.deepEqual(dry.mobility.scaffold, { available: true, item: "cobblestone", blocks: 76, blockedBy: [] });
  assert.equal(viewStatusResultSchema.parse({ status: "succeeded", situation: dry }).situation.mobility.maximumDrop, 3);
  const dryMarkdown = report(empty);
  assert.match(
    dryMarkdown,
    /- Water buckets carried: 0; no planned bucket drops or emergency fall saves \(no water bucket carried\)/,
  );
  assert.match(dryMarkdown, /- Scaffold placement \(pillar up, bridge gaps\): cobblestone x76/);

  const carried = liveBot({ carried: { 36: { name: "water_bucket" }, 9: { name: "cobblestone", count: 64 } } });
  const wet = observeLiveSituation(carried, data(), idleActivity);
  assert.deepEqual(wet.mobility.bucketDrop, { available: true, maximumBlocks: 80, blockedBy: [] });
  assert.deepEqual(wet.mobility.fallSave, { available: true, blockedBy: [] });
  assert.equal(wet.mobility.waterBuckets, 1);
  // A stocked bot pays no standing text for a capability it already has.
  assert.match(report(carried), /### Mobility\n- Water buckets carried: 1\n- Scaffold placement/);

  // A full bucket is no help where the pour boils off before anything lands in it.
  Object.assign(carried.game, { dimension: "the_nether" });
  const nether = observeLiveSituation(carried, data(), idleActivity);
  assert.deepEqual(nether.mobility.bucketDrop.blockedBy, ["water_evaporates_here"]);
  assert.equal(nether.mobility.waterBuckets, 1);
  assert.match(
    report(carried),
    /- Water buckets carried: 1; no planned bucket drops or emergency fall saves \(water evaporates in this dimension\)/,
  );

  // Nothing admitted to place: the route keeps its drops and loses its climbs.
  const unarmed = liveBot({ carried: { 36: { name: "stone_pickaxe" } } });
  const noScaffold = observeLiveSituation(unarmed, data(), idleActivity);
  assert.deepEqual(noScaffold.mobility.scaffold, { available: false, item: null, blocks: 0, blockedBy: ["no_scaffold_block"] });
  assert.match(
    report(unarmed),
    /- Scaffold placement \(pillar up, bridge gaps\): unavailable \(no admitted scaffold block carried\)/,
  );
});

test("reports straight-down digging from the live policy, and renders only its loss", async (t) => {
  const bot = liveBot();
  const observe = () => observeLiveSituation(bot, temporaryBotData({ botId: "TestBot", closeAfter: t }), idleActivity);
  const policy = new SurvivalPolicyState(bot);
  assert.deepEqual(observe().mobility.digStraightDown, { available: true, blockedBy: [] });
  assert.doesNotMatch(formatViewStatusResult({ status: "succeeded", situation: observe() }), /straight-down/);

  await policy.edit({
    operation: "set",
    expected_revision: policy.snapshot().revision,
    changes: { navigation: { dig_straight_down: false } },
    lifetime: { kind: "session" },
    reason: "never dig a shaft",
  });
  const stairs = observe();
  assert.deepEqual(stairs.mobility.digStraightDown, { available: false, blockedBy: ["policy_disabled"] });
  assert.equal(viewStatusResultSchema.parse({ status: "succeeded", situation: stairs }).situation.mobility.digStraightDown.available, false);
  assert.match(
    formatViewStatusResult({ status: "succeeded", situation: stairs }),
    /- No straight-down digging \(switched off in the survival policy\); routes descend by staircase/,
  );
});

/**
 * What a carried food restores is game data a model otherwise guesses at: a brain choosing between farming and
 * hunting, or counting a day's worth of food, reads it here, one line per food kind, most filling first.
 */
test("lists each carried food once with its hunger points and saturation from game data", (t) => {
  const bot = liveBot({
    carried: {
      9: { name: "bread", count: 3 },
      10: { name: "cobblestone", count: 64 },
      11: { name: "cooked_beef", count: 2 },
      12: { name: "bread", count: 1 },
    },
  });
  const situation = observeLiveSituation(bot, temporaryBotData({ botId: "TestBot", closeAfter: t }), idleActivity);
  assert.deepEqual(situation.inventory.foods, [
    { name: "cooked_beef", count: 2, points: 8, saturation: 12.8 },
    { name: "bread", count: 4, points: 5, saturation: 6 },
  ]);
  const markdown = formatViewStatusResult({ status: "succeeded", situation });
  assert.match(markdown, /- Food carried: cooked_beef x2 \(8 hunger points, 12.8 saturation each\); bread x4 \(5 hunger points, 6 saturation each\)/);
});

test("vehicle is null on foot, names the boat while mounted and is null again after the dismount", (t) => {
  const bot = liveBot({ entities: { 77: loaded("oak_boat", new Vec3(0, 99, 0)) } });
  const data = temporaryBotData({ botId: "TestBot", closeAfter: t });
  assert.equal(observeLiveSituation(bot, data, idleActivity).vehicle, null);
  const boat = bot.entities[77]!;
  Object.assign(bot.entity, { vehicle: boat });
  const mounted = observeLiveSituation(bot, data, idleActivity);
  assert.deepEqual(mounted.vehicle, { name: "oak_boat", id: 77 });
  assert.equal(viewStatusResultSchema.safeParse({ status: "succeeded", situation: mounted }).success, true);
  Object.assign(bot.entity, { vehicle: null });
  assert.equal(observeLiveSituation(bot, data, idleActivity).vehicle, null);
});
