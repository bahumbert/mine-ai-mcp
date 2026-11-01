import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadScenario, type Scenario } from "mine-labs";
import { laneOf } from "../arena/lanes.ts";
import { loadAllScenarios } from "../arena/all-scenarios.ts";
import { FRESH_SERVER_GAMERULES } from "../arena/gamerule-defaults.ts";
import { settingsOf } from "../arena/settings.ts";
import { CLIENT_HOST_PROTOCOL } from "../client-boot-marker.ts";
import { shiftScenario } from "../arena/shift-scenario.ts";
import { changesWorldDuringTrial, gameruleNamesOf, isTimingTrial, parseGameruleAnswer, placeScenario, reservePlacement, runsOurClientHost, type ArenaPorts } from "./placement.ts";
import { fixtureScenario } from "./scenario-fixture.ts";

// check-reads: scenarios/**/*.yaml, tests/minecraft/scenarios/**/*.yaml, tests/minecraft/templates/**/*.yaml
const MINECRAFT_DIR = fileURLToPath(new URL("..", import.meta.url));
const OUR_CLIENT_HOST = path.join(MINECRAFT_DIR, "client-host.ts");
const LEGACY_SMELT_YAML = fileURLToPath(new URL("../../../scenarios/flat/craft/smelt-batch-normal.yaml", import.meta.url));

const accepting: ArenaPorts = {
  settingsOf: (scenario, defaults) => ({ ...settingsOf(scenario, defaults), key: "key-of-" + scenario.name }),
  shiftScenario: (scenario, lane) => ({ ok: true, scenario: { ...scenario, name: `${scenario.name}@${lane.index}` } }),
  canResetScenario: () => true,
  worldCompatibilityKey: scenario => `world-of-${scenario.name}`,
};

function withCommands(scenario: Scenario, field: "tick" | "reset", commands: string[]): Scenario {
  return { ...scenario, [field]: commands };
}

test("a scenario the shift accepts is placed on a lane of its settings key, with the lifted scenario", () => {
  const placement = placeScenario(fixtureScenario(10, "a"), {}, accepting);
  assert.equal(placement.kind, "lane");
  assert.equal(placement.key, "key-of-a");
  assert.equal(placement.kind === "lane" ? placement.scenario.name : "", "a");
});

test("the probe shift uses lane 1 and a refusal becomes a server of its own with the reason", () => {
  let probed = 0;
  const refusing: ArenaPorts = { ...accepting, shiftScenario: (_scenario, lane) => { probed = lane.index; return { ok: false, reason: "world.type is default" }; } };
  const placement = placeScenario(fixtureScenario(10, "nat"), {}, refusing);
  assert.equal(probed, laneOf(1).index);
  assert.deepEqual(placement, { kind: "own", key: "own:world-of-nat|key-of-nat", reason: "world.type is default", reusable: true });
});

test("a refused scenario that cannot be reset is not reusable", () => {
  const refusing: ArenaPorts = { ...accepting, canResetScenario: () => false, shiftScenario: () => ({ ok: false, reason: "no" }) };
  const placement = placeScenario(fixtureScenario(10), {}, refusing);
  assert.equal(placement.kind === "own" && placement.reusable, false);
});

test("a settings verb in tick or reset makes a refused scenario non-reusable (it changes the world during its trial)", () => {
  const refusing: ArenaPorts = { ...accepting, shiftScenario: () => ({ ok: false, reason: "gamerule in tick" }) };
  const ticking = withCommands(fixtureScenario(10), "tick", ["gamerule doDaylightCycle false"]);
  const placement = placeScenario(ticking, {}, refusing);
  assert.equal(placement.kind === "own" && placement.reusable, false);
});

test("changesWorldDuringTrial finds a settings verb at the head of a command or after execute ... run", () => {
  const base = fixtureScenario(10);
  assert.equal(changesWorldDuringTrial(withCommands(base, "reset", ["time set day"])), true);
  assert.equal(changesWorldDuringTrial(withCommands(base, "tick", ["execute as @a at @s run weather clear"])), true);
  assert.equal(changesWorldDuringTrial(withCommands(base, "tick", ["gamemode spectator @a[name=!Actor]"])), false);
  assert.equal(changesWorldDuringTrial(withCommands(base, "reset", ["fill 0 -60 0 1 -60 1 air"])), false);
});

// One world, real settings: only the server-wide values in `setup` tell two refused scenarios apart.
const sameWorldRefusing: ArenaPorts = { ...accepting, settingsOf, worldCompatibilityKey: () => "one-world", shiftScenario: () => ({ ok: false, reason: "tagged 'exclusive'" }) };

function withSetup(scenario: Scenario, setup: string[]): Scenario {
  return { ...scenario, setup: [...scenario.setup, ...setup] };
}

function ownOf(placement: ReturnType<typeof placeScenario>): Extract<ReturnType<typeof placeScenario>, { kind: "own" }> {
  assert.equal(placement.kind, "own");
  return placement as Extract<ReturnType<typeof placeScenario>, { kind: "own" }>;
}

// The two ways a scenario gets a server of its own: the shift refuses it, or its client cannot use a lane.
const OWN_PATHS: readonly { readonly what: string; readonly shape: (scenario: Scenario) => Scenario }[] = [
  { what: "refused by the shift", shape: scenario => scenario },
  { what: "with a client that cannot use a lane", shape: scenario => withClient(scenario, { command: "node" }) },
];
const brokenSettings: ArenaPorts = { ...accepting, settingsOf: () => { throw new Error("odd rule"); } };

for (const { what, shape } of OWN_PATHS) {
  test(`scenarios of one world ${what}: another tick rate in setup (8, 8.5, none) gives another own key, the same settings share a reusable one`, () => {
    const keyOf = (name: string, setup: string[]): string => ownOf(placeScenario(shape(withSetup(fixtureScenario(10, name), setup)), FRESH_SERVER_GAMERULES, sameWorldRefusing)).key;
    assert.equal(new Set([keyOf("a", ["tick rate 8"]), keyOf("a", ["tick rate 8.5"]), keyOf("a", [])]).size, 3, "the next trial of the plain key must not inherit a slow server");
    assert.equal(keyOf("a", ["tick rate 8"]), keyOf("b", ["tick rate 8"]));
    assert.equal(ownOf(placeScenario(shape(fixtureScenario(10)), FRESH_SERVER_GAMERULES, sameWorldRefusing)).reusable, true);
  });

  test(`a scenario ${what} whose settings cannot be read gets a server of its own that is not reusable, with the reason`, () => {
    const placement = ownOf(placeScenario(shape(fixtureScenario(10)), {}, brokenSettings));
    assert.equal(placement.reusable, false);
    assert.equal(placement.key, "own:world-of-demo", "no settings to key by, and a server that stops after its trial needs no match");
    assert.match(placement.reason, /odd rule|arena frame/u);
  });
}

function withClient(scenario: Scenario, client: Partial<Scenario["client"]>): Scenario {
  return { ...scenario, client: { ...scenario.client, ...client } };
}

function ownReason(placement: ReturnType<typeof placeScenario>): string {
  return ownOf(placement).reason;
}

test("a legacy scenario whose client never reads the arena frame gets a server of its own with the reason, whether or not the shift would accept it", async () => {
  const legacy = await loadScenario(LEGACY_SMELT_YAML);
  const shiftRefuses: ArenaPorts = { ...accepting, shiftScenario: () => ({ ok: false, reason: "world.type is default" }) };
  for (const ports of [accepting, shiftRefuses]) {
    const reason = ownReason(placeScenario(legacy, {}, ports));
    assert.match(reason, /client .*client-host\.ts does not read the arena frame \(MINE_AI_ARENA\)/u);
    assert.match(reason, /coordinates would stay at offset zero/u);
  }
});

const UNUSABLE_CLIENTS: readonly { readonly what: string; readonly client: Partial<Scenario["client"]>; readonly reason: RegExp }[] = [
  { what: "an entry that does not exist", client: { args: ["no-such-host.ts"] }, reason: /its client entry .*no-such-host\.ts could not be resolved \(ENOENT\)/u },
  { what: "a flag in place of the entry", client: { args: ["--smol", "client-host.ts"] }, reason: /its client entry .*--smol could not be resolved/u },
  { what: "a command other than bun", client: { command: "node" }, reason: /command node.*arena frame/u },
  { what: "no arguments", client: { args: [] }, reason: /no entry.*arena frame/u },
];

for (const { what, client, reason } of UNUSABLE_CLIENTS) {
  test(`a client with ${what} is a server of its own with the reason, and placement does not throw`, () => {
    assert.match(ownReason(placeScenario(withClient(fixtureScenario(10), client), {}, accepting)), reason);
  });
}

test("our client host named through a template, a symlink or a .. segment stays on a lane", async () => {
  const templated = await loadScenario(path.join(MINECRAFT_DIR, "scenarios/collect/parkour-ore-gap.yaml"));
  assert.equal(placeScenario(templated, {}, accepting).kind, "lane");
  const folder = mkdtempSync(path.join(tmpdir(), "placement-client-"));
  try {
    symlinkSync(OUR_CLIENT_HOST, path.join(folder, "host-link.ts"));
    assert.equal(placeScenario(withClient(fixtureScenario(10), { cwd: folder, args: ["host-link.ts"] }), {}, accepting).kind, "lane");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  assert.equal(placeScenario(withClient(fixtureScenario(10), { cwd: MINECRAFT_DIR, args: ["shared/../client-host.ts"] }), {}, accepting).kind, "lane");
});

test("no scenario of the census moves to a server of its own because of its client", async () => {
  for (const { file, scenario } of await loadAllScenarios()) {
    const shiftable = shiftScenario(settingsOf(scenario, FRESH_SERVER_GAMERULES).scenario, laneOf(1)).ok;
    assert.equal(placeScenario(scenario, FRESH_SERVER_GAMERULES).kind === "lane", shiftable, file);
  }
});

test("a gamerule answer yields its value", () => {
  assert.equal(parseGameruleAnswer("Gamerule doFireTick is currently set to: true"), "true");
  assert.equal(parseGameruleAnswer("Gamerule randomTickSpeed is currently set to: 3"), "3");
});

test("an answer that is not a gamerule value is null, so a defaults read can name the rule it failed on", () => {
  assert.equal(parseGameruleAnswer("Incorrect argument for command"), null);
});

test("the gamerules a scenario sets, and Mine Labs' flat-world doMobSpawning, are found by asking its settings with no defaults", () => {
  const scenario = { ...fixtureScenario(10), world: { ...fixtureScenario(10).world, gamerules: { doFireTick: false, randomTickSpeed: 0 } } };
  assert.deepEqual(gameruleNamesOf(scenario).sort(), ["doFireTick", "doMobSpawning", "randomTickSpeed"]);
});

test("a scenario whose settings cannot be read names no rule", () => {
  const broken: ArenaPorts = { ...accepting, settingsOf: () => { throw new Error("odd"); } };
  assert.deepEqual(gameruleNamesOf(fixtureScenario(10), broken), []);
});

const refusing: ArenaPorts = { ...accepting, shiftScenario: () => ({ ok: false, reason: "tagged 'exclusive'" }) };

test("a refused scenario tagged exclusive is a timing placement, and one refused for another reason is not", () => {
  const tagged = placeScenario({ ...fixtureScenario(10, "t"), tags: ["exclusive"] }, {}, refusing);
  assert.equal(tagged.kind === "own" && tagged.exclusive, true);
  assert.equal(isTimingTrial(tagged, false), true);
  const plainRefused = placeScenario(fixtureScenario(10, "n"), {}, refusing);
  assert.equal(isTimingTrial(plainRefused, false), false);
  assert.equal(isTimingTrial(plainRefused, true), true, "every trial of a locked batch times something");
  assert.equal(isTimingTrial(placeScenario(fixtureScenario(10, "l"), {}, accepting), false), false);
});

test("a locked batch's placement gets a pool key of its own that no other batch's placement has, and the world key inside it is kept", () => {
  const lane = placeScenario(fixtureScenario(10, "a"), {}, accepting);
  const one = reservePlacement(lane, 3);
  const two = reservePlacement(lane, 4);
  assert.notEqual(one.key, two.key);
  assert.notEqual(one.key, lane.key);
  assert.match(one.key, /^key-of-a/u);
  assert.equal(one.reservedFor, 3);
  assert.equal(lane.reservedFor, undefined, "the original placement is not changed");
});

test("only our client host is booted ahead: it is the one that says when it booted", () => {
  const scenario = fixtureScenario(60);
  assert.equal(runsOurClientHost(scenario), true);
  assert.equal(runsOurClientHost({ ...scenario, client: { ...scenario.client, command: "node" } }), false, "another runner never writes the booted line");
  assert.equal(runsOurClientHost({ ...scenario, client: { ...scenario.client, args: [] } }), false, "no entry file to check");
});

// A second source root: another worktree, or a snapshot of one (plan 2026-10-30-scenario-clients-ext4 T1, spec D8).
function inSecondRoot(files: Record<string, string>, body: (root: string) => void): void {
  const folder = mkdtempSync(path.join(tmpdir(), "placement-root2-"));
  try {
    const root = path.join(folder, "root2");
    for (const [relative, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      writeFileSync(path.join(root, relative), text);
    }
    body(root);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const OTHER_ROOT_HOST = {
  "bun.lock": "",
  "tests/minecraft/client-host.ts": "",
  "tests/minecraft/client-boot-marker.ts": `export const CLIENT_HOST_PROTOCOL = ${CLIENT_HOST_PROTOCOL};\n`,
};

test("our client host in another source root is our client host: the scenario gets a lane", () => {
  inSecondRoot(OTHER_ROOT_HOST, root => {
    const scenario = withClient(fixtureScenario(10), { cwd: path.join(root, "tests/minecraft"), args: ["client-host.ts", "drivers/bot-contract.ts"] });
    assert.equal(runsOurClientHost(scenario), true);
    assert.equal(placeScenario(scenario, {}, accepting).kind, "lane");
  });
});

const MARKER = "tests/minecraft/client-boot-marker.ts";
const HOST_FILE = "tests/minecraft/client-host.ts";
const REFUSED_OTHER_ROOT_HOSTS: readonly { readonly what: string; readonly files: Record<string, string>; readonly cwd: string; readonly entry: string; readonly reason: RegExp }[] = [
  { what: "the legacy client host", files: { ...OTHER_ROOT_HOST, "scenarios/src/client-host.ts": "" }, cwd: "scenarios", entry: "src/client-host.ts", reason: /does not read the arena frame \(MINE_AI_ARENA\)/u },
  { what: "a client host with no bun.lock above it", files: { [HOST_FILE]: "" }, cwd: "tests/minecraft", entry: "client-host.ts", reason: /no bun\.lock in any parent directory/u },
  { what: "a host that speaks another protocol", files: { ...OTHER_ROOT_HOST, [MARKER]: "export const CLIENT_HOST_PROTOCOL = 999;\n" }, cwd: "tests/minecraft", entry: "client-host.ts", reason: new RegExp(`its client host speaks protocol 999, the daemon ${CLIENT_HOST_PROTOCOL}; update that worktree`, "u") },
  { what: "a host with no marker file", files: { "bun.lock": "", [HOST_FILE]: "" }, cwd: "tests/minecraft", entry: "client-host.ts", reason: /no CLIENT_HOST_PROTOCOL stamp.*client-boot-marker\.ts.*is missing or holds none.*update that worktree/u },
  { what: "a host whose marker holds no stamp", files: { "bun.lock": "", [HOST_FILE]: "", [MARKER]: "export const CLIENT_BOOTED_MESSAGE = 'x';\n" }, cwd: "tests/minecraft", entry: "client-host.ts", reason: /no CLIENT_HOST_PROTOCOL stamp/u },
  { what: "a host whose marker mentions the stamp only in a comment", files: { ...OTHER_ROOT_HOST, [MARKER]: `// was CLIENT_HOST_PROTOCOL = ${CLIENT_HOST_PROTOCOL}\nexport const CLIENT_HOST_PROTOCOL = 999;\n` }, cwd: "tests/minecraft", entry: "client-host.ts", reason: /speaks protocol 999/u },
];

for (const { what, files, cwd, entry, reason } of REFUSED_OTHER_ROOT_HOSTS) {
  test(`${what} of another source root gets a server of its own, with the reason`, () => {
    inSecondRoot(files, root => {
      const scenario = withClient(fixtureScenario(10), { cwd: path.join(root, cwd), args: [entry] });
      assert.equal(runsOurClientHost(scenario), false);
      assert.match(ownReason(placeScenario(scenario, {}, accepting)), reason);
    });
  });
}
