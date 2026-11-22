import assert from "node:assert/strict";
import test from "node:test";
import {
  readNotificationSummary,
  recordEvent,
  type BotEvent,
  type BotEventInput,
  type SqlBotData,
} from "../../bot-data/index.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { DEFAULT_COMBAT_POLICY } from "../../survival/policy/combat/contract.js";
import { SurvivalPolicyState } from "../../survival/state/survival-policy.js";
import { createFakeBot } from "../../test-support/fake-bot/index.js";
import { botEventInputSchema } from "../../bot-data/event-log.js";
import { formatReadRecentEventsResult, parseReadRecentEventsRequest, readRecentBotEvents } from "./index.js";

/** Historical records stay readable; production only writes the new receipts. */
function historicalEvent(data: SqlBotData, event: Omit<BotEvent, "eventId" | "botId">): void {
  data.transaction((database) =>
    database
      .prepare("INSERT INTO events (bot_id, event_type, observed_at, summary, payload_json) VALUES (?, ?, ?, ?, ?)")
      .run("MineAI", event.type, event.observedAt, event.summary, JSON.stringify(event.payload)),
  );
}

test("old combat policies and new survival policies share a readable advancing event cursor", () => {
  using data = temporaryBotData();
  const override = { changes: { bow: false }, lifetime: { kind: "session" as const } };
  for (const legacyOverride of [null, override]) {
    const event = {
      type: "combat_policy" as const, observedAt: "2026-09-11T00:00:00.000Z", summary: "Historical policy",
      payload: { revision: "old:1", defaults: DEFAULT_COMBAT_POLICY,
        effective: { ...DEFAULT_COMBAT_POLICY, bow: legacyOverride === null },
        override: legacyOverride, encounter: null, response: null, settling: false,
        lastChange: "Model replaced the policy override.", constraint: null },
    };
    historicalEvent(data, event);
    assert.equal(botEventInputSchema.safeParse(event).success, false, "old events remain read-only");
  }
  const policy = new SurvivalPolicyState(createFakeBot().bot).snapshot();
  historicalEvent(data, { type: "survival_policy", observedAt: "2026-09-12T00:00:00.000Z", summary: "Current policy", payload: policy });
  const first = readRecentBotEvents(data, "MineAI", { limit: 2 });
  assert.deepEqual(first.events.map((event) => event.type), ["combat_policy", "combat_policy"]);
  assert.equal(first.remainingEventCount, 1);
  assert.match(formatReadRecentEventsResult(first), /combat policy \(historical\)/);
  assert.match(formatReadRecentEventsResult(first), /"bow":false/);
  const second = readRecentBotEvents(data, "MineAI", { limit: 2 });
  assert.deepEqual(second.events.map((event) => event.type), ["survival_policy"]);
  assert.equal(second.readThroughEventId, 3);
  assert.equal(second.remainingEventCount, 0);
  assert.match(formatReadRecentEventsResult(second), /survival policy/);
  assert.equal(readRecentBotEvents(data, "MineAI", { limit: 2 }).events.length, 0);
});

/**
 * A reflex that did not achieve its purpose must read as the attempt it was.
 * Each row is a historical payload whose rendering must not overstate recovery.
 */
const reflexRows: ReadonlyArray<{
  name: string;
  event: Omit<BotEvent, "eventId" | "botId">;
  matches: RegExp[];
  doesNotMatch: RegExp[];
}> = [
  {
    name: "a fire escape the bot could not complete",
    event: {
      type: "fire_reflex" as const,
      observedAt: "2026-09-07T07:00:00.000Z",
      summary: "Fire escape blocked",
      payload: {
        outcome: "blocked",
        healthBefore: 20,
        healthAfter: 16,
        interrupted: { action: "collect_block", startedAt: "2026-09-07T06:59:00.000Z" },
      },
    },
    matches: [/Outcome: blocked/, /Health: 20 → 16/, /collect_block/],
    doesNotMatch: [/Outcome: escaped/],
  },
  {
    name: "a breath attempt with zero observed recovery",
    event: {
      type: "breath_reflex" as const,
      observedAt: "2026-09-05T03:46:00.000Z",
      summary: "MineAI could not reach air; air 0 → 0.",
      payload: { airBefore: 0, airAfter: 0, healthBefore: 20, healthAfter: 20, dug: 0, interrupted: null },
    },
    matches: [/surfacing attempt/, /could not reach air/],
    doesNotMatch: [/surfaced for air/],
  },
];

test("a reflex that did not recover is reported as an attempt, never as a rescue", () => {
  for (const row of reflexRows) {
    using data = temporaryBotData();
    historicalEvent(data, row.event);
    const markdown = formatReadRecentEventsResult(readRecentBotEvents(data, "MineAI", { limit: 50 }));
    for (const pattern of row.matches) assert.match(markdown, pattern, row.name);
    for (const pattern of row.doesNotMatch) assert.doesNotMatch(markdown, pattern, row.name);
  }
});

function messageEvent(message: string, direction: "incoming" | "outgoing" = "incoming"): BotEventInput {
  const username = direction === "incoming" ? "Alex" : "MineAI";
  return {
    type: "player_message",
    observedAt: "2026-08-23T01:00:00.000Z",
    summary: `${username}: ${message}`,
    payload: { username, channel: "chat", direction, message, addressed: direction === "incoming" },
  };
}

test("old policy snapshots in durable events do not block later messages", () => {
  const policy = new SurvivalPolicyState(createFakeBot().bot).snapshot();
  const legacyCombat = { ...DEFAULT_COMBAT_POLICY, evade_safe_range: 27 };
  Reflect.deleteProperty(legacyCombat, "evade_clear_range");
  Reflect.deleteProperty(legacyCombat, "evade_cover_range");
  const snapshot = { ...policy, defaults: { ...policy.defaults, combat: legacyCombat },
    effective: { ...policy.effective, combat: { ...legacyCombat, evade_clear_range: 12 } } };
  const status = { summary: "safe" as const, request: null, owner: { current: null, reserved: null, connected: true, transfer: null },
    dangers: [], response: null, decisions: [], budgets: [], answered: [], observations: { missing: [], stale: [] },
    policy: snapshot, vitals: { health: 20, food: 20, air: null, inWater: false },
    runtime: { liveness: "observed_in_process" as const, observedAt: 0, physicsObservedAt: null } };
  const oldCombat = { ...policy, defaults: legacyCombat, effective: legacyCombat, override: null };
  Reflect.deleteProperty(oldCombat, "overrides");
  const rows = [
    { type: "survival_policy" as const, payload: snapshot },
    { type: "survival_outcome" as const, payload: { kind: "outcome" as const, source: "test", evidence: null, status } },
    { type: "combat_policy" as const, payload: oldCombat },
  ];
  for (const row of rows) {
    using data = temporaryBotData();
    historicalEvent(data, { ...row, observedAt: "2026-09-11T00:00:00Z", summary: "old" });
    recordEvent(data, "MineAI", messageEvent("next"));
    const result = readRecentBotEvents(data, "MineAI", { limit: 50 });
    assert.deepEqual(result.events.map((event) => event.type), [row.type, "player_message"]);
    assert.equal(result.readThroughEventId, 2);
    assert.equal(readRecentBotEvents(data, "MineAI", { limit: 50 }).events.length, 0);
    const event = result.events[0]!;
    const defaults = event.type === "combat_policy" ? event.payload.defaults : event.type === "survival_policy"
      ? event.payload.defaults.combat : event.type === "survival_outcome" ? event.payload.status.policy.defaults.combat : null;
    assert.ok(defaults);
    assert.equal(defaults.evade_clear_range, 27);
    assert.equal(defaults.evade_cover_range, 27);
    if (event.type === "survival_policy" || event.type === "survival_outcome") {
      const parsed = event.type === "survival_policy" ? event.payload : event.payload.status.policy;
      assert.equal(parsed.effective.combat.evade_clear_range, 12);
      assert.equal(parsed.effective.combat.evade_cover_range, 27);
    }
  }
  using invalid = temporaryBotData();
  historicalEvent(invalid, { type: "survival_policy", observedAt: "2026-09-11T00:00:00Z", summary: "invalid",
    payload: { ...snapshot, defaults: { ...snapshot.defaults, combat: { ...legacyCombat, evade_clear_range: 0 } } } });
  assert.throws(() => readRecentBotEvents(invalid, "MineAI", { limit: 50 }));
});

test("returns incoming and outgoing events, advances the cursor, and formats their evidence", (t) => {
  assert.deepEqual(parseReadRecentEventsRequest(undefined), { limit: 50 });
  assert.deepEqual(parseReadRecentEventsRequest({ limit: 2 }), { limit: 2 });
  assert.throws(() => parseReadRecentEventsRequest({ limit: 0 }));
  assert.throws(() => parseReadRecentEventsRequest({ limit: 101 }));

  const data = temporaryBotData({ closeAfter: t });
  recordEvent(data, "MineAI", messageEvent("Can you bring wood?"));
  recordEvent(data, "MineAI", messageEvent("Yes, I can.", "outgoing"));

  const result = readRecentBotEvents(data, "MineAI", { limit: 50 });
  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    result.events.map((event) => (event.type === "player_message" ? event.payload.direction : event.type)),
    ["incoming", "outgoing"],
  );
  assert.equal(result.readThroughEventId, 2);
  assert.equal(result.remainingEventCount, 0);

  const markdown = formatReadRecentEventsResult(result);
  assert.match(markdown, /Event 1: player message/);
  assert.match(markdown, /Can you bring wood\?/);
  assert.match(markdown, /Direction: outgoing/);
  assert.match(markdown, /Remaining events:\*\* 0/);
  assert.deepEqual(readNotificationSummary(data, "MineAI"), { unreadCount: 0 });
});

test("returns and formats a player death lifecycle event through the existing event page", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  recordEvent(data, "MineAI", {
    type: "player_death",
    observedAt: "2026-08-30T01:02:03.000Z",
    summary: "MineAI died at 12.5, 64, -3.25 in overworld.",
    payload: { dimension: "overworld", position: { x: 12.5, y: 64, z: -3.25 }, cause: null },
  });

  const result = readRecentBotEvents(data, "MineAI", { limit: 50 });
  assert.equal(result.events[0]?.type, "player_death");
  const markdown = formatReadRecentEventsResult(result);
  assert.match(markdown, /Event 1: player death/);
  assert.match(markdown, /Observed: 2026-08-30T01:02:03.000Z/);
  assert.match(markdown, /Dimension: `overworld`/);
  assert.match(markdown, /Position: `12.5, 64, -3.25`/);
});

test("a death event with its context tells the model what the bot held, wore and where it would wake", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  recordEvent(data, "MineAI", {
    type: "player_death",
    observedAt: "2026-08-30T01:02:03.000Z",
    summary: "MineAI died at 12.5, 64, -3.25 in overworld.",
    payload: {
      dimension: "overworld",
      position: { x: 12.5, y: 64, z: -3.25 },
      cause: "MineAI was slain by Zombie",
      context: {
        lastAlive: { health: 14, food: 9, saturation: 0, msBefore: 1_200 },
        food: 9,
        held: "iron_sword",
        armour: { head: "iron_helmet", chest: null, legs: null, feet: "iron_boots" },
        carriesWeapon: true,
        bestMelee: "iron_sword",
        enclosed: false,
        respawn: { kind: "bed", dimension: "overworld", x: 20.5, y: 64, z: -3.25, distance: 8 },
      },
    },
  });
  recordEvent(data, "MineAI", {
    type: "player_death",
    observedAt: "2026-08-30T02:00:00.000Z",
    summary: "MineAI died at 1, 64, 1 in the_nether.",
    payload: {
      dimension: "the_nether",
      position: { x: 1, y: 64, z: 1 },
      cause: null,
      context: {
        lastAlive: null,
        food: 20,
        held: null,
        armour: { head: null, chest: null, legs: null, feet: null },
        carriesWeapon: false,
        bestMelee: null,
        enclosed: true,
        respawn: { kind: "world_spawn", dimension: "overworld", x: 0, y: 70, z: 0, distance: null },
      },
    },
  });
  recordEvent(data, "MineAI", {
    type: "player_death",
    observedAt: "2026-08-30T03:00:00.000Z",
    summary: "MineAI died at 1, 64, 1 in overworld.",
    payload: { dimension: "overworld", position: { x: 1, y: 64, z: 1 }, cause: null },
  });
  recordEvent(data, "MineAI", {
    type: "player_death", observedAt: "2026-08-30T04:00:00.000Z", summary: "MineAI died.",
    payload: { dimension: "overworld", position: { x: 1, y: 64, z: 1 }, cause: null, context: {
      lastAlive: null, food: 20, held: null, armour: { head: null, chest: null, legs: null, feet: null },
      carriesWeapon: false, bestMelee: null, enclosed: false,
      respawn: { kind: "last_wake", dimension: "overworld", x: 13, y: 64, z: 1, distance: 12 },
    } },
  });

  const markdown = formatReadRecentEventsResult(readRecentBotEvents(data, "MineAI", { limit: 50 }));

  assert.match(
    markdown,
    /- State at death: held iron_sword; armour head iron_helmet, feet iron_boots; food 9; last health 14 \(1\.2 s before\); in the open; respawn bed 8 blocks away/,
  );
  assert.match(
    markdown,
    /- State at death: held nothing; armour none; food 20; last health not seen; enclosed; respawn world spawn in another dimension/,
  );
  assert.match(markdown, /respawn where it last woke, 12 blocks away/);
  assert.equal(markdown.match(/State at death/g)?.length, 3, "an old row without context prints no state line");
});

test("a status recorded before dig_straight_down existed reads back with its default", async () => {
  // Live 2026-10-04: Tom's old survival receipts failed validation on his first read, and his brain stopped.
  const { withNavigationDefaults } = await import("./read-recent-events.js");
  const navigation = { scaffold_blocks: [], bucket_fall_save: true, bucket_drops: true, hostile_avoidance_multiplier: 1 };
  const old = { kind: "outcome", status: { policy: { defaults: { navigation: { ...navigation } }, effective: { navigation: { ...navigation, dig_straight_down: false } } } } };
  const read = withNavigationDefaults(old) as typeof old & { status: { policy: { defaults: { navigation: { dig_straight_down?: boolean } }; effective: { navigation: { dig_straight_down?: boolean } } } } };
  assert.equal(read.status.policy.defaults.navigation.dig_straight_down, true);
  assert.equal(read.status.policy.effective.navigation.dig_straight_down, false, "a recorded value is kept");
  assert.deepEqual(withNavigationDefaults({ kind: "message" }), { kind: "message" });
});

test("formats a hurt_by row as the attacker and what struck, 'the attacker itself' when the player did", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  recordEvent(data, "MineAI", { type: "hurt_by", observedAt: "2026-10-29T01:02:03.000Z", summary: "Zed hurt MineAI.", payload: { attacker: "Zed", direct: null, at: 1_000 } });
  recordEvent(data, "MineAI", { type: "hurt_by", observedAt: "2026-10-29T01:02:04.000Z", summary: "Zed shot MineAI.", payload: { attacker: "Zed", direct: "arrow", at: 2_000 } });

  const markdown = formatReadRecentEventsResult(readRecentBotEvents(data, "MineAI", { limit: 50 }));
  assert.match(markdown, /### Event 1: hurt by a player\n- Observed: 2026-10-29T01:02:03.000Z\n- Attacker: `Zed`\n- Direct source: the attacker itself\n/);
  assert.match(markdown, /### Event 2: hurt by a player\n- Observed: 2026-10-29T01:02:04.000Z\n- Attacker: `Zed`\n- Direct source: arrow\n/);
});

test("formats a dimension change row with where the bot came from, went to and arrived", (t) => {
  const data = temporaryBotData({ closeAfter: t });
  recordEvent(data, "MineAI", {
    type: "player_dimension_change",
    observedAt: "2026-10-29T01:02:03.000Z",
    summary: "MineAI went to the nether.",
    payload: { from: "overworld", to: "the_nether", position: { x: 1.5, y: 70, z: -2 } },
  });

  const markdown = formatReadRecentEventsResult(readRecentBotEvents(data, "MineAI", { limit: 50 }));
  assert.match(markdown, /### Event 1: dimension change\n- Observed: 2026-10-29T01:02:03.000Z\n- From: `overworld`\n- To: `the_nether`\n- Arrived at: `1.5, 70, -2`/);
});
