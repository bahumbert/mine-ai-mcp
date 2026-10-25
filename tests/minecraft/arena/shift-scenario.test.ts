import assert from "node:assert/strict";
import test from "node:test";
import { canResetScenario, scenarioSchema, type Scenario, type ScenarioInput } from "mine-labs";
import { ARENA_ENV, decodeArena } from "./frame.ts";
import { LAST_BODY, laneOf } from "./lanes.ts";
import { shiftScenario } from "./shift-scenario.ts";

const LANE_3 = laneOf(3);
const Z = LANE_3.offset.z;

function scenarioWith(fields: Partial<ScenarioInput> = {}): Scenario {
  return scenarioSchema.parse({
    players: [{ name: "Actor", pos: [0.5, -60, 0.5] }],
    goal: { kind: "reach", pos: [5, -60, 0], timeout: 10 },
    client: { command: "bun", env: { KEEP: "yes" } },
    reset: ["fill -16 -59 -16 20 -40 16 air"],
    ...fields,
  });
}

function shifted(scenario: Scenario, lane = LANE_3): Scenario {
  const result = shiftScenario(scenario, lane);
  assert.ok(result.ok, result.ok ? "" : result.reason);
  return result.scenario;
}

function refusal(scenario: Scenario): string {
  const result = shiftScenario(scenario, LANE_3);
  assert.ok(!result.ok, "the scenario was shifted");
  return result.reason;
}

test("positions of players, entities, geometry and goals move by the lane offset, y never", () => {
  const lane = shifted(
    scenarioWith({
      entities: [{ type: "zombie", pos: [3, -60, -3] }],
      geometry: [
        { fill: { block: "stone", from: [-5, -61, -5], to: [5, -61, 5], mode: "replace" } },
        { setblock: { block: "glass", at: "1 -60 1" } },
        { run: "fill 0 -60 0 1 -60 1 air" },
      ],
      goal: {
        kind: "all",
        timeout: 10,
        goals: [
          { kind: "reach", pos: [5, -60, 0] },
          { kind: "blockAt", pos: [1, -60, 1], block: "glass" },
          { kind: "any", goals: [{ kind: "blocksAt", block: "stone", positions: [[0, -61, 0], [1, -61, 2]] }, { kind: "completion" }] },
        ],
      },
    }),
  );
  assert.deepEqual(lane.players[0]!.pos, [0.5, -60, Z + 0.5]);
  assert.deepEqual(lane.entities[0]!.pos, [3, -60, Z - 3]);
  assert.deepEqual(lane.geometry, [
    { fill: { block: "stone", from: [-5, -61, Z - 5], to: [5, -61, Z + 5], mode: "replace" } },
    { setblock: { block: "glass", at: `1 -60 ${Z + 1}` } },
    { run: `fill 0 -60 ${Z} 1 -60 ${Z + 1} air` },
  ]);
  assert.deepEqual(lane.goal, {
    kind: "all",
    timeout: 10,
    goals: [
      { kind: "reach", pos: [5, -60, Z] },
      { kind: "blockAt", pos: [1, -60, Z + 1], block: "glass" },
      { kind: "any", goals: [{ kind: "blocksAt", block: "stone", positions: [[0, -61, Z], [1, -61, Z + 2]] }, { kind: "completion" }] },
    ],
  });
});

test("reset, setup and tick commands are shifted, tick ones as tick commands", () => {
  const lane = shifted(
    scenarioWith({
      setup: ["setblock 0 -60 0 stone"],
      tick: ["execute if entity @a[name=Actor,x=1,y=-62,z=-1,dx=1,dy=3,dz=2] run say hi"],
    }),
  );
  assert.deepEqual(lane.reset, [`fill -16 -59 ${Z - 16} 20 -40 ${Z + 16} air`]);
  assert.deepEqual(lane.setup, [`setblock 0 -60 ${Z} stone`]);
  assert.deepEqual(lane.tick, [`execute if entity @a[name=ActorL3000,x=1,y=-62,z=${Z - 1},dx=1,dy=3,dz=2] run say hi`]);
});

test("a player is renamed everywhere: players, goals' who, commands", () => {
  const lane = shifted(
    scenarioWith({
      players: [{ name: "Actor", pos: [0, -60, 0] }, { name: "Helper", pos: [2, -60, 0] }],
      goal: { kind: "hasItem", item: "stone", who: "Helper", timeout: 10 },
      tick: ["effect give Actor minecraft:hunger 2 120 true"],
    }),
  );
  assert.deepEqual(lane.players.map((player) => player.name), ["ActorL3000", "HelperL3000"]);
  assert.equal(lane.goal.kind === "hasItem" ? lane.goal.who : undefined, "HelperL3000");
  assert.deepEqual(lane.tick, ["effect give ActorL3000 minecraft:hunger 2 120 true"]);
});

/** Scenario player name, lane, body -> the name the server sees: `<name>L<lane><body in base 36 on 3 characters>`, the name cut to fit 16. */
const LANE_NAMES: readonly (readonly [string, number, number, string])[] = [
  ["Actor", 3, 0, "ActorL3000"],
  ["Actor", 3, 1, "ActorL3001"],
  ["Actor", 3, 35, "ActorL300z"],
  ["Actor", 3, 36, "ActorL3010"],
  ["Actor", 3, LAST_BODY, "ActorL3zzz"],
  ["ABCDEFGHIJKLMNO", 3, 0, "ABCDEFGHIJKL3000"],
  ["ABCDEFGHIJKLMNOP", 1, LAST_BODY, "ABCDEFGHIJKL1zzz"],
  ["ABCDEFGHIJKLMNOP", 98, 5, "ABCDEFGHIJL98005"],
];

test("the body of a lane ends the player's name, so a new body logs in as a new player, and a name is never over 16 characters", () => {
  for (const [name, lane, body, expected] of LANE_NAMES) {
    const scenario = scenarioWith({ players: [{ name, pos: [0, -60, 0] }], goal: { kind: "completion", timeout: 10 } });
    assert.equal(shifted(scenario, laneOf(lane, body)).players[0]!.name, expected);
    assert.ok(expected.length <= 16, expected);
  }
});

test("the body follows the rename into goals' who and commands", () => {
  const lane = shifted(
    scenarioWith({
      goal: { kind: "hasItem", item: "stone", who: "Actor", timeout: 10 },
      tick: ["effect give Actor minecraft:hunger 2 120 true"],
    }),
    laneOf(3, 12),
  );
  assert.equal(lane.goal.kind === "hasItem" ? lane.goal.who : undefined, "ActorL300c");
  assert.deepEqual(lane.tick, ["effect give ActorL300c minecraft:hunger 2 120 true"]);
});

test("two names equal after the cut are refused for every body, naming the lane name", () => {
  const clashing = scenarioWith({
    players: [{ name: "ABCDEFGHIJKLMNOA", pos: [0, -60, 0] }, { name: "ABCDEFGHIJKLMNOB", pos: [2, -60, 0] }],
    goal: { kind: "completion", timeout: 10 },
  });
  for (const body of [0, 1, LAST_BODY]) {
    const result = shiftScenario(clashing, laneOf(3, body));
    assert.ok(!result.ok, `body ${body} shifted the clash`);
    assert.match(result.reason, new RegExp(`ABCDEFGHIJKL3${body.toString(36).padStart(3, "0")}`, "u"));
  }
});

test("the client is told the lane offset, keeps its other env, and the spectator is dropped", () => {
  const lane = shifted(scenarioWith({ spectator: { mods: [], systemProperties: {} } }));
  assert.deepEqual(decodeArena(lane.client.env), LANE_3.offset);
  assert.equal(lane.client.env.KEEP, "yes");
  assert.ok(ARENA_ENV in lane.client.env);
  assert.equal(lane.spectator, undefined);
});

test("params are handed to the client untouched: the client shifts them through its frame", () => {
  const params = { target: [1, -60, 2], legs: [{ target: { x: 3, z: 4 } }] };
  assert.deepEqual(shifted(scenarioWith({ params })).params, params);
});

test("the input scenario is left as it was, and the shifted one is a valid scenario", () => {
  const original = scenarioWith({ tick: ["gamemode spectator @a[name=!Actor,gamemode=!spectator]"], entities: [{ type: "zombie", pos: [1, -60, 1] }] });
  const before = structuredClone(original);
  const lane = shifted(original);
  assert.deepEqual(original, before);
  assert.ok(scenarioSchema.safeParse(lane).success);
});

test("a scenario with no reset is shifted: the lane restores it from its snapshot", () => {
  const lane = shifted(scenarioWith({ reset: [], geometry: [{ setblock: { block: "stone", at: [0, -61, 0] } }] }));
  assert.deepEqual(lane.reset, []);
});

test("refuses a world that is not flat, a dimension that is not the overworld, and a world spawn", () => {
  assert.match(refusal(scenarioWith({ world: { type: "default", seed: 1 } })), /world\.type/u);
  assert.match(refusal(scenarioWith({ world: { dimension: "the_nether" }, players: [{ name: "Actor", pos: [0, 70, 0] }] })), /world\.dimension/u);
  assert.match(refusal(scenarioWith({ world: { spawn: [0, -60, 0] } })), /world\.spawn/u);
});

test("refuses a tag exclusive scenario, a verification run and a player with no position", () => {
  assert.match(refusal(scenarioWith({ tags: ["exclusive"] })), /exclusive/u);
  assert.match(refusal(scenarioWith({ verification: { radius: 5, locations: [[0, -60, 0]] } })), /verification/u);
  assert.match(refusal(scenarioWith({ players: [{ name: "Actor" }] })), /pos/u);
});

test("refuses goals that count entities across the whole server, also nested", () => {
  for (const goal of [
    { kind: "kill", target: "zombie" },
    { kind: "entityCount", entity: "zombie", min: 1 },
    { kind: "entityDistance", entity: "zombie", distance: 3 },
  ] as const) {
    assert.match(refusal(scenarioWith({ goal: { ...goal, timeout: 10 } })), new RegExp(`goal.*${goal.kind}`, "u"));
    assert.match(refusal(scenarioWith({ goal: { kind: "all", timeout: 10, goals: [{ kind: "completion" }, goal] } })), new RegExp(goal.kind, "u"));
  }
});

test("a refused command is named with its field and text", () => {
  const reason = refusal(scenarioWith({ tick: ["gamemode spectator @a", "gamerule doFireTick false"] }));
  assert.match(reason, /tick\[1\]/u);
  assert.match(reason, /gamerule doFireTick false/u);
  assert.match(refusal(scenarioWith({ setup: ["setworldspawn 0 -60 0"] })), /setup\[0\]/u);
  assert.match(refusal(scenarioWith({ reset: ["kill @e[distance=..3]"] })), /reset\[0\]/u);
  assert.match(refusal(scenarioWith({ geometry: [{ run: "fill ~ ~ ~ ~ ~ ~ air" }] })), /geometry\[0\]/u);
  assert.match(refusal(scenarioWith({ geometry: [{ setblock: { block: "stone", at: "~ ~ ~" } }] })), /geometry\[0\]\.setblock\.at/u);
  assert.match(refusal(scenarioWith({ entities: [{ type: "zombie", pos: "~ ~ ~" }] })), /entities\[0\]\.pos/u);
});

test("an arena that leaves its lane's cell, or whose scratch copy does, is refused as wider than a lane", () => {
  assert.match(refusal(scenarioWith({ reset: ["fill -600 -59 -16 20 -40 16 air"] })), /wider than a lane|outside the lane.s cell/u);
  assert.match(refusal(scenarioWith({ reset: ["fill -16 -59 -300 20 -40 300 air"] })), /wider than a lane|outside the lane.s cell/u);
  assert.match(refusal(scenarioWith({ reset: ["fill -16 -59 -16 600 -40 16 air"] })), /wider than a lane|outside the lane.s cell/u);
});

test("an arena that pins more chunks than Minecraft force-loads, with its scratch copy, is refused with the count", () => {
  assert.match(refusal(scenarioWith({ reset: ["fill 0 -59 0 300 -40 120 air"] })), /\d+ chunks/u);
});

/** Mine Labs keeps its force-load limit private; this holds ours to the answer of its `canResetScenario`. */
test("the force-load limit is Mine Labs' own: a scenario fits a lane exactly when Mine Labs can reset it", () => {
  for (let width = 120; width <= 400; width += 8) {
    const scenario = scenarioWith({ reset: [`fill 0 -59 0 ${width} -40 100 air`] });
    const result = shiftScenario(scenario, LANE_3);
    assert.equal(result.ok, canResetScenario(scenario), `fill width ${width}: ${result.ok ? "shifted" : result.reason}`);
  }
});

test("a typed position that lands outside the lane's cell is refused, in a player, entity, geometry or goal position", () => {
  assert.match(refusal(scenarioWith({ players: [{ name: "Actor", pos: [0, -60, 400] }] })), /players\[0\]\.pos/u);
  assert.match(refusal(scenarioWith({ entities: [{ type: "zombie", pos: [0, -60, -400] }] })), /entities\[0\]\.pos/u);
  assert.match(refusal(scenarioWith({ goal: { kind: "reach", pos: [900000, -60, 0], timeout: 10 } })), /goal/u);
});

test("an entity whose NBT holds a position is refused, one with other NBT is shifted", () => {
  assert.match(refusal(scenarioWith({ entities: [{ type: "villager", pos: [0, -60, 0], nbt: "{HomePos:[I;5,-60,5]}" }] })), /entities\[0\]\.nbt/u);
  const lane = shifted(scenarioWith({ entities: [{ type: "zombie", pos: [0, -60, 0], nbt: "{PersistenceRequired:1b}" }] }));
  assert.equal(lane.entities[0]!.nbt, "{PersistenceRequired:1b}");
});
