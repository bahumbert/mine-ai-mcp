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
import { createFakeBot } from "../../../src/test-support/fake-bot/index.ts";
import { DEFAULT_SURVIVAL_POLICY } from "../../../src/survival/policy/contract.ts";
import { temporaryBotData } from "../../../src/test-support/bot-data.ts";
import { ZERO_ARENA, arenaActionInput, arenaFrame, type ArenaFrame } from "../arena/frame.ts";
import type { ScenarioRun } from "../scenario.ts";
import { scenarioTestContext } from "../scenario-test-context.ts";

const MINECRAFT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
/** A lane's z offset (`LANE_SPACING` 512) and an x offset no lane has, so a driver that forgets or doubles either axis is seen. */
const SIDEWAYS = arenaFrame({ x: 64, z: 1536 });
/** Drivers that wait on the wall clock for a boat ride have their own test (`cancel-mid-ride.test.ts`). */
const OWN_TEST = new Set(["cancel-mid-ride.ts"]);
/** Wall-clock waits of a driver's params, cut to nothing: the census reads what the driver asks, not how long it waits. */
const NO_WAIT_PARAMS = { walkMs: 1, silentMs: 0 };

/** A step of `params.actions` (action-sequence, buried-items-stay-buried): the status it must end with, and the text its error must hold. */
interface ParamsStep {
  readonly expect?: "succeeded" | "failed";
  readonly error_contains?: string;
}

interface Recorded {
  readonly action: string;
  readonly input: Record<string, unknown>;
}

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
async function recordDriverRun(run: ScenarioRun, file: string, frame: ArenaFrame): Promise<Recorded[]> {
  const { client: _launch, ...scenario } = await loadScenario(file);
  const definition = scenarioDefinitionSchema.parse({ ...scenario, params: withoutWallWaits(scenario.params) });
  const [x, y, z] = frame.world(scenario.players[0]!.pos as [number, number, number]);
  const { bot } = createFakeBot({ position: new Vec3(x, y, z) });
  const data = temporaryBotData({ botId: "Actor" });
  const recorded: Recorded[] = [];
  const steps = (definition.params.actions ?? []) as ParamsStep[];
  const refused = definition.params.refuse as { x: number; y: number; z: number } | undefined;
  const [refusedX, refusedY, refusedZ] = refused === undefined ? [] : frame.world([refused.x, refused.y, refused.z]);
  const cancelsFirstNavigate = "settleWithinMs" in definition.params;
  let cancelFirstNavigate: () => void = () => {};
  const firstNavigateCancelled = new Promise<void>((resolve) => void (cancelFirstNavigate = resolve));
  let calls = 0;
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
      if (action === "view_status") result = { status: "succeeded", situation: observeLiveSituation(bot, data, () => ({ owner: "idle", activeAction: null })) } as ActionResult;
      return { action, durationMs: 1, result, summary: action, ...(action === "view_status" && { survivalPolicy: POLICY_SNAPSHOT }) };
    },
  });
  try {
    const completion = await run(context);
    recorded.push({ action: "(completion)", input: { status: completion.status } });
  } catch {
    // A stand-in result a driver cannot read ends its run here; what it asked before that is what is compared.
  } finally {
    data.close();
  }
  return recorded;
}

/** The params with the wall-clock waits they name (`NO_WAIT_PARAMS`) cut to nothing. */
function withoutWallWaits(params: Record<string, unknown>): Record<string, unknown> {
  return { ...params, ...Object.fromEntries(Object.entries(NO_WAIT_PARAMS).filter(([key]) => key in params)) };
}

const shifted = (calls: readonly Recorded[], frame: ArenaFrame): Recorded[] =>
  calls.map(({ action, input }) => ({ action, input: arenaActionInput(input, frame) }));

const scenarios = await Promise.all(
  yamlFilesUnder(path.join(MINECRAFT_DIR, "scenarios")).map(async (file) => {
    const scenario = await loadScenario(file);
    const driver = scenario.client.args.find((arg) => arg.startsWith("drivers/"))!;
    return { file, driver, name: path.relative(MINECRAFT_DIR, file) };
  }),
);

/** The drivers that took coordinates from their params in at least one run, so the comparison above was not empty for them. */
const driversThatMoved = new Set<string>();

for (const { file, driver, name } of scenarios.filter(({ driver }) => !OWN_TEST.has(path.basename(driver)))) {
  test(`${name}: ${path.basename(driver)} asks for the zero run's cells moved into the lane`, async () => {
    const { run } = (await import(path.join(MINECRAFT_DIR, driver))) as { run: ScenarioRun };
    const atZero = await recordDriverRun(run, file, arenaFrame(ZERO_ARENA));
    const inLane = await recordDriverRun(run, file, SIDEWAYS);
    assert.deepEqual(inLane, shifted(atZero, SIDEWAYS));
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
  "explore-frontier.ts": "a heading and a chunk count",
  "ground-first-barter.ts": "barter by the nearest piglin, no coordinate",
  "idle-then-breathe.ts": "no action, reads the air",
  "workshop.ts": "BLIND: its first call is a craft whose receipt the stand-in does not model, so it ends before the table and furnace cells",
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
