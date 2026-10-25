import test from "node:test";
import assert from "node:assert/strict";
import type { Scenario } from "mine-labs";
import { fixtureScenario } from "../shared/scenario-fixture.ts";
import { renameBodyOnOwnServer } from "./own-body.ts";

function scenarioWith(overrides: Partial<Scenario>, playerNames = ["Actor"]): Scenario {
  const base = fixtureScenario(60);
  return { ...base, players: playerNames.map(name => ({ ...base.players[0]!, name })), ...overrides };
}

function renamed(scenario: Scenario, body: number): Scenario {
  const result = renameBodyOnOwnServer(scenario, body);
  assert.equal(result.ok, true, result.ok ? "" : result.reason);
  return result.ok ? result.scenario : scenario;
}

test("body 0, the first scenario of a server, runs as written: nothing was ever saved under its name", () => {
  const scenario = scenarioWith({});
  assert.equal(renamed(scenario, 0), scenario);
});

test("a later body renames each player with the lane-0 suffix and the body in base 36 on 3 characters", () => {
  assert.deepEqual(renamed(scenarioWith({}), 1).players.map(player => player.name), ["ActorL0001"]);
  assert.deepEqual(renamed(scenarioWith({}), 36 * 36 + 35).players.map(player => player.name), ["ActorL010z"]);
});

test("the cut of a long name is the same for every body, and the whole fits 16 characters", () => {
  const names = ["ABCDEFGHIJKLMNOP", "Short"];
  const first = renamed(scenarioWith({}, names), 1).players.map(player => player.name);
  const later = renamed(scenarioWith({}, names), 900).players.map(player => player.name);
  assert.ok(first.every(name => name.length <= 16));
  assert.equal(first[0]!.slice(0, 11), later[0]!.slice(0, 11));
  assert.equal(first[0], "ABCDEFGHIJKL0001");
});

test("two players that are the same after the cut cannot each have a fresh body: refused with both names", () => {
  const result = renameBodyOnOwnServer(scenarioWith({}, ["ABCDEFGHIJKAAAAA", "ABCDEFGHIJKBBBBB"]), 1);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.reason, /ABCDEFGHIJKAAAAA.*ABCDEFGHIJKBBBBB/u);
});

test("the goal's player follows the rename, inside all and any goals too", () => {
  const scenario = scenarioWith({
    goal: { kind: "all", timeout: 60, goals: [{ kind: "health", who: "Actor", min: 1 }, { kind: "any", goals: [{ kind: "health", who: "Actor", min: 2 }] }] } as unknown as Scenario["goal"],
  });
  const goal = JSON.stringify(renamed(scenario, 2).goal);
  assert.equal(goal.includes('"who":"Actor"'), false);
  assert.equal(goal.match(/"who":"ActorL0002"/gu)?.length, 2);
});

test("a command that names the player is rewritten as a whole word, in setup, tick, reset and a geometry run", () => {
  const scenario = scenarioWith({
    setup: ["give Actor stone 3", "execute as Actor run tp Actor 0 -60 0", "tag @a[name=Actor] add ready", "say ActorBox and NotActor stay"],
    tick: ["effect give Actor speed"], reset: ["clear Actor"], geometry: [{ run: "tp Actor 1 2 3" }] as Scenario["geometry"],
  });
  const out = renamed(scenario, 1);
  assert.deepEqual(out.setup, ["give ActorL0001 stone 3", "execute as ActorL0001 run tp ActorL0001 0 -60 0", "tag @a[name=ActorL0001] add ready", "say ActorBox and NotActor stay"]);
  assert.deepEqual(out.tick, ["effect give ActorL0001 speed"]);
  assert.deepEqual(out.reset, ["clear ActorL0001"]);
  assert.deepEqual(out.geometry, [{ run: "tp ActorL0001 1 2 3" }]);
});

test("nothing but names moves: positions, the world and the client stay as they were", () => {
  const scenario = scenarioWith({});
  const out = renamed(scenario, 3);
  assert.deepEqual(out.players[0]!.pos, scenario.players[0]!.pos);
  assert.deepEqual(out.client, scenario.client);
  assert.deepEqual(out.entities, scenario.entities);
  assert.deepEqual(out.world, scenario.world);
});

test("a body past the last one is refused: the name would come back", () => {
  assert.equal(renameBodyOnOwnServer(scenarioWith({}), 36 ** 3).ok, false);
});
