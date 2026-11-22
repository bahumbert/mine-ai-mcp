/**
 * Every scenario's driver, run on a stand-in server at offset zero and in two lanes: what it asks the runtime and the
 * client's world is the zero run moved by the lane offset, so a YAML written in arena-local coordinates builds, walks
 * and reads in its own lane (plan 2026-10-23-shared-scenario-server T3).
 */
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadScenario, scenarioDefinitionSchema } from "mine-labs";
import { Vec3 } from "vec3";
import type { ActionResult } from "@aibengineering/mine-ai-mcp";
import { observeLiveSituation } from "../../../src/actions/view-status/view-status.ts";
import { createFakeBot, createFakeClock } from "../../../src/test-support/fake-bot/index.ts";
import { DEFAULT_SURVIVAL_POLICY } from "../../../src/survival/policy/contract.ts";
import { temporaryBotData } from "../../../src/test-support/bot-data.ts";
import { ZERO_ARENA, arenaActionInput, arenaFrame, type ArenaFrame } from "../arena/frame.ts";
import type { ScenarioContext, ScenarioRun } from "../scenario.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";

// check-reads: tests/minecraft/scenarios/**/*.yaml, tests/minecraft/templates/**/*.yaml
const MINECRAFT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
/** A lane's z offset (`LANE_SPACING` 512) and an x offset no lane has, so a driver that forgets or doubles either axis is seen. */
const SIDEWAYS = arenaFrame({ x: 64, z: 1536 });
/** Physical waits have their own tests (boat cancellation) or real-server scenario (cleanup preemption); coordinates use arenaPoint. */
const OWN_TEST = new Set(["cancel-mid-ride.ts", "cancel-after-get-off.ts", "life-saving-cleanup.ts", "lava-pool-region.ts", "hostile-boat.ts", "combat-margin.ts", "zombie-hit-formula.ts", "pacing-target.ts", "mining-body-edge.ts"]);
/** The real-driver framed receipt and command fixture in evade-flight-resume.test.ts owns these physical modes. */
const RESUME_FIXTURE = new Set(["scenarios/combat/evade-stationary-shooter-detour.yaml", "scenarios/combat/evade-stationary-shooter-no-cover.yaml"]);
/** Wall-clock waits of a driver's params, cut to nothing: the census reads what the driver asks, not how long it waits. */
const NO_WAIT_PARAMS = { walkMs: 1, silentMs: 0 };

/** These drivers need physical observations or richer action results than the coordinate stand-in supplies. */
const CENSUS_BOUNDARIES: Readonly<Record<string, string>> = {
  "arrow-reservation.ts": "view_status", "ground-first-barter.ts": "view_status",
  "netherrack-bank.ts": "view_blocks", "preserve-storage.ts": "use_container",
  "workshop.ts": "craft_item", "lava-pool-escape.ts": "view_status", "explore-frontier.ts": "explore_frontier",
};
const CHAT_BOUNDARIES = new Set(["death-is-read.ts", "zombie-at-night.ts", "unreachable-shooter-ledge.ts", "killed-mid-action.ts"]);
const CENSUS_STOP = Symbol("stand-in has no answer");

/** A step of `params.actions` (action-sequence, buried-items-stay-buried): the status it must end with, and the text its error must hold. */
interface ParamsStep {
  readonly expect?: "succeeded" | "failed";
  readonly error_contains?: string;
}

interface Recorded {
  readonly action: string;
  readonly input: Record<string, unknown>;
}

/** Drivers may inject a sleeper so this coordinate census skips fixture pacing (task review, 2026-11-16). */
type CensusRun = (context: ScenarioContext, sleep?: (ms: number) => Promise<void>) => ReturnType<ScenarioRun>;

function yamlFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? yamlFilesUnder(file) : file.endsWith(".yaml") ? [file] : [];
  });
}

/** What `view_status` reports of the policy: the defaults, which a driver reads the revision of before it sets an override. */
const POLICY_SNAPSHOT = {
  revision: "r1", defaults: DEFAULT_SURVIVAL_POLICY, effective: DEFAULT_SURVIVAL_POLICY, overrides: [], encounter: null,
  response: null, settling: false, lastChange: "", constraint: null,
};

/** A smelt that made what the scenario asks for, so `smelt-then-navigate` goes on to its navigate. */
function smeltedResult(produced: unknown): ActionResult {
  const smelt = {
    dimension: "overworld", furnace: null, inputItem: "raw_iron", fuelItem: "coal", requested: 1, fuelInserted: 1, outputItem: "iron_ingot",
    produced, inputInventoryBefore: 1, inputInventoryAfter: 0, fuelInventoryBefore: 1, fuelInventoryAfter: 0, rawRecovered: 0,
    fuelRecovered: 0, finalCookProgress: null, finalFuelProgress: null,
  };
  return { status: "succeeded", smelt } as ActionResult;
}

/**
 * A stand-in for the server that answers what the scenario's params expect, so a driver goes on to its later coordinates:
 * `navigate` walks the body to the cell, `view_status` reads the body, step N of `params.actions` ends as its `expect`
 * says, a bucket used on the `refuse` cell is refused, the first navigate of a cancel scenario (`settleWithinMs`) stays
 * pending until `cancel_foreground_action` and reads cancelled, anything else succeeds.
 */
async function recordDriverRun(run: CensusRun, file: string, frame: ArenaFrame): Promise<Recorded[]> {
  const { client: _launch, ...scenario } = await loadScenario(file);
  const driver = path.basename(_launch.args.find((arg) => arg.startsWith("drivers/"))!);
  const definition = scenarioDefinitionSchema.parse({ ...scenario, params: withoutWallWaits(scenario.params) });
  const [x, y, z] = frame.world(scenario.players[0]!.pos as [number, number, number]);
  const clock = createFakeClock({ mode: "mocked" });
  using _timers = clock.install();
  const spawn = definition.params.spawn;
  const entities = definition.params.holdShooter === true && Array.isArray(spawn)
    ? { 2: { name: String(definition.params.mob), position: new Vec3(...frame.world(spawn as [number, number, number])) } } : undefined;
  const { bot } = createFakeBot({ position: new Vec3(x, y, z), health: scenario.players[0]!.health, clock, entities });
  const data = temporaryBotData({ botId: "Actor" });
  const recorded: Recorded[] = [];
  const chat = bot.chat.bind(bot);
  bot.chat = (command) => {
    if (path.basename(file).startsWith("evade-flat-")) {
      const summon = command.match(/^\/summon minecraft:(\w+) (-?[\d.]+) (-?[\d.]+) (-?[\d.]+)/);
      if (summon) recorded.push({ action: "summon", input: { mob: summon[1], x: Number(summon[2]), y: Number(summon[3]), z: Number(summon[4]) } });
      if (command.startsWith("/attribute ")) recorded.push({ action: "hold", input: { command } });
    }
    if (CHAT_BOUNDARIES.has(driver)) throw CENSUS_STOP;
    chat(command);
  };
  const steps = (definition.params.actions ?? []) as ParamsStep[];
  const refused = definition.params.refuse as { x: number; y: number; z: number } | undefined;
  const [refusedX, refusedY, refusedZ] = refused === undefined ? [] : frame.world([refused.x, refused.y, refused.z]);
  const cancelsFirstNavigate = "settleWithinMs" in definition.params;
  let cancelFirstNavigate: () => void = () => {};
  const firstNavigateCancelled = new Promise<void>((resolve) => void (cancelFirstNavigate = resolve));
  let calls = 0;
  let policy = POLICY_SNAPSHOT;
  const context = scenarioTestContext({
    scenario: definition,
    arena: frame,
    bot,
    client: {
      body: () => ({ ...bot.entity.position, onGround: false }),
      setCell: async ([cx, cy, cz]) => void recorded.push({ action: "setCell", input: { x: cx, y: cy, z: cz } }),
    },
    call: async (action, input) => {
      recorded.push({ action, input });
      if (CENSUS_BOUNDARIES[driver] === "*" || CENSUS_BOUNDARIES[driver] === action) throw CENSUS_STOP;
      const step = steps[calls++];
      let result: ActionResult = { status: "succeeded" };
      if (step?.expect === "failed") result = { status: "failed", error: step.error_contains ?? "failed" };
      if (action === "use_bucket" && input.x === refusedX && input.y === refusedY && input.z === refusedZ) result = { status: "failed", error: "[BUCKET_NOT_A_SOURCE] refused" };
      if (action === "cancel_foreground_action") cancelFirstNavigate();
      if (action === "navigate" && cancelsFirstNavigate && calls === 1) {
        await firstNavigateCancelled;
        result = { status: "cancelled", error: "cancelled" };
      } else if (action === "navigate") bot.entity.position.set(Number(input.x) + 0.5, Number(input.y), Number(input.z) + 0.5);
      if (action === "smelt_item") result = smeltedResult(definition.params.produced);
      if (action === "read_recent_events") result = { status: "succeeded", events: [], readThroughEventId: 0,
        remainingEventCount: 0, source: { queryIds: ["read_recent_events"] } } as ActionResult;
      if (action === "set_survival_policy") {
        const changes = input.changes as { combat?: Partial<typeof DEFAULT_SURVIVAL_POLICY.combat> };
        policy = { ...policy, effective: { ...policy.effective,
          combat: { ...policy.effective.combat, ...changes.combat } } };
      }
      if (action === "view_status") result = { status: "succeeded", situation: observeLiveSituation(bot, data, () => ({ owner: "idle", activeAction: null })) } as ActionResult;
      return { action, durationMs: 1, result, summary: action, ...(action === "view_status" && { survivalPolicy: policy }) };
    },
  });
  try {
    // The fake clock's sleep: a driver's wait (ground-first-barter's pearl wait) must move the clock, a no-op sleep never ends it.
    const running = run(context, clock.sleep);
    // Advance server packets within Mine Labs' goal budget (trial/run.ts, default 120s), T9 2026-11-15.
    try {
      const completion = await clock.settle(running, (scenario.goal.timeout ?? 120) * 1_000);
      recorded.push({ action: "(completion)", input: { status: completion.status } });
    } catch (error) {
      if (error !== CENSUS_STOP) throw error;
    }
  } finally {
    data.close();
  }
  return recorded;
}

test("a driver exception is reported by the census", async () => {
  const file = path.join(MINECRAFT_DIR, "scenarios/pathfinder/movement-course.yaml");
  await assert.rejects(recordDriverRun(async () => { throw new Error("driver failure"); }, file, SIDEWAYS), /driver failure/);
});

/** The params with the wall-clock waits they name (`NO_WAIT_PARAMS`) cut to nothing. */
function withoutWallWaits(params: Record<string, unknown>): Record<string, unknown> {
  return { ...params, ...Object.fromEntries(Object.entries(NO_WAIT_PARAMS).filter(([key]) => key in params)) };
}

const shifted = (calls: readonly Recorded[], frame: ArenaFrame): Recorded[] =>
  calls.map(({ action, input }) => ({ action, input: arenaActionInput(input, frame) }));

/**
 * Each scenario with its driver's `run`, imported here at collection and not in the first test: the drivers import the
 * whole `@aibengineering/mine-ai-mcp` entry (667 exports), 3.8-5.5 s the first time on /mnt/d under 9P (WSL, load 5,
 * 2026-11-07, a timed `await import()` x3) against ~30 ms for the driver itself, so the first test of the file timed out
 * at 5000 ms (7099 ms seen at load 14-18). Loading a file is not under a test's timeout; the test bodies stay 50-190 ms.
 * The cost is in the drivers' own `@aibengineering/mine-ai-mcp` imports (10 drivers); naming `src/actions/*\/contract.ts`
 * there instead would touch them all and is left open.
 */
const scenarios = await Promise.all(
  yamlFilesUnder(path.join(MINECRAFT_DIR, "scenarios")).map(async (file) => {
    const scenario = await loadScenario(file);
    const driver = scenario.client.args.find((arg) => arg.startsWith("drivers/"))!;
    const { run } = (await import(path.join(MINECRAFT_DIR, driver))) as { run: ScenarioRun };
    return { file, driver, run, name: path.relative(MINECRAFT_DIR, file) };
  }),
);

// The drivers' module graphs load here, outside any test's 5 s clock: the first test used to pay the cold import itself
// and timed out in 3 of 6 runs of this file on a loaded machine (5.2-7.6 s against the 5 s default, 2026-11-07).
await Promise.all(
  [...new Set(scenarios.map(({ driver }) => driver))]
    .filter((driver) => !OWN_TEST.has(path.basename(driver)))
    .map((driver) => import(path.join(MINECRAFT_DIR, driver))),
);

/** The drivers that took coordinates from their params in at least one run, so the comparison above was not empty for them. */
const driversThatMoved = new Set<string>();

test("both resume YAMLs are handed to the framed resume fixture", () => {
  assert.deepEqual(scenarios.filter(({ name }) => RESUME_FIXTURE.has(name)).map(({ name }) => name).sort(), [...RESUME_FIXTURE].sort());
});

for (const { file, driver, run, name } of scenarios.filter(({ driver, name }) => !OWN_TEST.has(path.basename(driver)) && !RESUME_FIXTURE.has(name))) {
  test(`${name}: ${path.basename(driver)} asks for the zero run's cells moved into the lane`, async () => {
    const atZero = await recordDriverRun(run, file, arenaFrame(ZERO_ARENA));
    const inLane = await recordDriverRun(run, file, SIDEWAYS);
    assert.deepEqual(inLane, shifted(atZero, SIDEWAYS));
    if (name === "scenarios/combat/evade-flat-skeleton-held-cover.yaml") {
      assert.deepEqual(inLane.find(({ action }) => action === "summon"),
        { action: "summon", input: { mob: "skeleton", x: 58, y: -60, z: 1536 } });
      assert.ok(inLane.some(({ action, input }) => action === "hold" && String(input.command).includes("@e[type=minecraft:skeleton,limit=1,sort=nearest]")));
      assert.ok(inLane.some(({ action }) => action === "read_recent_events"));
    }
    if (JSON.stringify(inLane) !== JSON.stringify(atZero)) driversThatMoved.add(path.basename(driver));
  });
}

/**
 * Drivers that ask for no coordinate of their own, each with the reason. Every other driver must be seen asking for a
 * moved one: a new driver reading coordinates is held to the frame without an edit here, and a driver the stand-in
 * stops early (it answers from the params' expectations, not from craft receipts) fails this test instead of passing blind.
 */
const NO_COORDINATE_DRIVERS: Readonly<Record<string, string>> = {
  "arrow-reservation.ts": "runs single-action.ts; the scenario's action input holds no x or z",
  "burning-far-from-water.ts": "teleports by chat using arenaPoint; the action reads events without coordinates",
  "death-is-read.ts": "no action; the death is made by a chat command on the actor itself (@s)",
  "explore-frontier.ts": "a heading and a chunk count",
  "ground-first-barter.ts": "barter by the nearest piglin, no coordinate",
  "hovering-blaze-contact.ts": "summons the probe blaze by chat using arenaPoint; the collect_mob_drop input holds no x or z",
  "idle-then-breathe.ts": "no action, reads the air",
  "lava-pool-escape.ts": "asks only view_status; the teleport is a chat command built from the params' pool floor through arenaPoint",
  "unreachable-shooter-ledge.ts": "teleports by chat using arenaPoint; action inputs read claim identities without coordinates",
  "workshop.ts": "BLIND: its first call is a craft whose receipt the stand-in does not model, so it ends before the table and furnace cells",
  "zombie-at-night.ts": "no action; the zombie is summoned by a chat command relative to the actor (@s), and its position is never compared",
};

test("every driver but the listed ones was compared on a run that used coordinates", () => {
  const drivers = new Set(scenarios.filter(({ driver }) => !OWN_TEST.has(path.basename(driver))).map(({ driver }) => path.basename(driver)));
  assert.deepEqual([...drivers].filter((driver) => !driversThatMoved.has(driver) && !(driver in NO_COORDINATE_DRIVERS)), []);
  assert.deepEqual(Object.keys(NO_COORDINATE_DRIVERS).filter((driver) => driversThatMoved.has(driver)), [], "a listed driver moved: take it off the list");
});

test("at offset zero the params reach the runtime as written (a plain mine-labs run changes nothing)", async () => {
  const route = path.join(MINECRAFT_DIR, "scenarios/pathfinder/movement-course.yaml");
  const { params } = await loadScenario(route);
  const [{ target: [x, y, z], range }] = (params as { legs: { target: number[]; range: number }[] }).legs as [{ target: number[]; range: number }];
  const { run: runRoute } = (await import("./navigate-route.ts")) as { run: ScenarioRun };
  const [firstLeg] = await recordDriverRun(runRoute, route, arenaFrame(ZERO_ARENA));
  assert.deepEqual(firstLeg, { action: "navigate", input: { x, y, z, range, dig: false, scaffold: false } });

  const single = path.join(MINECRAFT_DIR, "scenarios/pathfinder/vine-chasm-parkour.yaml");
  const { params: singleParams } = await loadScenario(single);
  const { run: runSingle } = (await import("./single-action.ts")) as { run: ScenarioRun };
  const [only] = await recordDriverRun(runSingle, single, arenaFrame(ZERO_ARENA));
  assert.deepEqual(only, { action: singleParams.action, input: singleParams.input });
});
