/** Run one Mine Labs driver with a prepared bot and the Minecraft runtime. */
import path from "node:path";
import { mkdtempDisposable } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { runNodeClient, type ClientCompletion, type NodeClientSession } from "mine-labs/client";
import {
  createMinecraftRuntime,
  type Action,
  type ActionOutput,
  type ActionResult,
  type MinecraftRuntime,
  type MinecraftRuntimeOptions,
} from "@aibengineering/mine-ai-mcp";
import { createScenarioBot, prepareScenarioBot, closeScenarioBot } from "./scenario-bot.ts";
import { openScenarioHighlighter } from "./scenario-highlighter.ts";
import type { ScenarioContext, ScenarioRun, ScenarioCall } from "./scenario.ts";
import { WITHOUT_RUNTIME_FLAG, parseClientHostArgs } from "./client-host-args.ts";
import { arenaFrame, decodeArena, type ArenaFrame } from "./arena/frame.ts";
import { clientBootedLine } from "./client-boot-marker.ts";

const { driverFile, withRuntime } = parseClientHostArgs(process.argv.slice(2));

// Started before init: a host booted ahead of its trial has its driver loaded when the trial's values arrive. A load
// failure is kept and thrown inside the session, where it becomes the failed completion the trial reads.
const driverLoading = loadDriver(driverFile).then(
  (driver) => ({ driver }),
  (cause: unknown) => ({ cause }),
);

// The daemon times a host's boot from this line (client boot ahead, T7h-b); it comes whether the driver loaded or failed, a failure
// being the trial's to report once init arrives.
void driverLoading.then(() => process.stdout.write(clientBootedLine()));

await runNodeClient((session) => runScenario(withRuntime, session));

async function runScenario(withRuntime: boolean, session: NodeClientSession): Promise<void> {
  // A host booted before its trial gets the lane's environment in init, over the one it was spawned with (the later
  // value wins); started the old way init carries none and the environment is the process's own.
  Object.assign(process.env, session.env);
  const loaded = await driverLoading;
  if ("cause" in loaded) throw loaded.cause;
  const { driver } = loaded;
  // Read before the bot exists: a malformed lane offset must fail the client, never run it at offset zero inside a lane.
  const arena = arenaFrame(decodeArena(process.env));
  const bot = createScenarioBot(session);
  try {
    await prepareScenarioBot(bot, session);
    const completion = withRuntime ? await runWithRuntime(driver, bot, session, arena) : await runWithoutRuntime(driver, bot, session, arena);
    session.signal.throwIfAborted();
    if (completion.status === "failed") session.log(`scenario driver failed: ${completion.detail}`);
    session.finish(completion);
  } catch (cause) {
    closeScenarioBot(bot);
    // Mine Labs already owns cancellation; it is not a second failed result.
    if (!session.signal.aborted) throw cause;
  }
}

/** The runtime is disposed before this promise resolves and completion is reported. */
async function runWithRuntime(driver: ScenarioRun, bot: Bot, session: NodeClientSession, arena: ArenaFrame): Promise<ClientCompletion> {
  const retainEvidence = process.env.MINE_AI_SCENARIO_EVIDENCE === "1";
  const artifacts = retainEvidence ? process.env.MINE_LABS_ARTIFACTS_DIR : undefined;
  if (retainEvidence && !artifacts) throw new Error("Retaining scenario evidence requires MINE_LABS_ARTIFACTS_DIR.");

  // Dispose in reverse order: let the runtime flush its incidents, then remove
  // their temporary directory, including on failure or cancellation.
  await using scratch = artifacts ? undefined : await mkdtempDisposable(path.join(tmpdir(), "mine-ai-scenario-"));
  const incidents = artifacts ? path.join(artifacts, session.username, "incidents") : scratch!.path;
  await using overlay = await openScenarioHighlighter(bot, session);
  await using runtime = await createMinecraftRuntime(bot, { ...runtimeOptions(session, artifacts, incidents), highlighter: overlay?.highlighter });
  overlay?.follow(runtime.navigation);
  const context = scenarioContextOf(bot, session, arena, (action, input) => callScenarioAction(runtime, session, action, input));
  return await runTimedDriver(driver, context, session);
}

/** The driver on the bare bot, no runtime created (`--without-runtime`): `call` refuses, everything else is the same. */
async function runWithoutRuntime(driver: ScenarioRun, bot: Bot, session: NodeClientSession, arena: ArenaFrame): Promise<ClientCompletion> {
  const context = scenarioContextOf(bot, session, arena, async (action) => {
    throw new Error(`'${action}' cannot run: this scenario's client runs ${WITHOUT_RUNTIME_FLAG}`);
  });
  return await runTimedDriver(driver, context, session);
}

/** What a driver receives: the scenario, its lane, the bot and its client-side controls, and `call` for actions. */
function scenarioContextOf(bot: Bot, session: NodeClientSession, arena: ArenaFrame, call: ScenarioContext["call"]): ScenarioContext {
  let windowsOpened = 0;
  bot.on("windowOpen", () => {
    windowsOpened += 1;
  });
  return {
    scenario: session.scenario,
    arena,
    bot,
    waitForTicks: async (ticks) => {
      await bot.waitForTicks(ticks);
      session.signal.throwIfAborted();
    },
    physics: {
      pause: () => {
        bot.physicsEnabled = false;
      },
      resume: () => {
        bot.physicsEnabled = true;
      },
    },
    client: {
      setCell: async ([x, y, z], stateId) => bot.world.setBlockStateId(new Vec3(x, y, z), stateId),
      body: () => ({ ...bot.entity.position, onGround: bot.entity.onGround }),
      windowsOpened: () => windowsOpened,
    },
    call,
  };
}

/** Report prepared, wait for the start, then time the driver's run (preparation is outside the trial budget). */
async function runTimedDriver(driver: ScenarioRun, context: ScenarioContext, session: NodeClientSession): Promise<ClientCompletion> {
  session.signal.throwIfAborted();
  session.prepared();
  await session.start;
  session.signal.throwIfAborted();

  // Preparation is outside the trial budget; only the driver's run is timed.
  const startedAt = Date.now();
  try {
    const completion = await driver(context);
    const detail = [completion.detail, `duration ${Date.now() - startedAt} ms`].filter(Boolean).join("; ");
    return { ...completion, detail };
  } catch (cause) {
    session.signal.throwIfAborted();
    const error = cause instanceof Error ? cause.message : String(cause);
    const detail = [error, `duration ${Date.now() - startedAt} ms`].filter(Boolean).join("; ");
    return { status: "failed", detail };
  }
}

/** Record and execute an action; the driver decides whether its result passes. */
async function callScenarioAction(
  runtime: MinecraftRuntime,
  session: NodeClientSession,
  actionName: string,
  input: Record<string, unknown>,
): Promise<ScenarioCall> {
  const action = runtime.actions.find((candidate) => candidate.name === actionName);
  if (!action) throw new Error(`The Minecraft runtime registers no '${actionName}' action.`);
  const rationale = `Scenario '${session.scenario.name ?? "unnamed"}' requested it.`;
  session.log(`${actionName} ${JSON.stringify(input)}`);
  const requestId = runtime.recordActionRequest({
    actionName,
    rationale,
    requestedAt: new Date().toISOString(),
    request: input,
  });
  const output: ActionOutput<string, ActionResult> = await runtime.run(action, input, session.signal, requestId);
  const summary = summarise(action, output);
  runtime.recordActionResponse({
    requestId,
    respondedAt: new Date().toISOString(),
    durationMs: output.durationMs,
    status: output.result.status,
    response: { ...output, summary },
  });
  session.log(summary);
  return { ...output, summary };
}

function summarise(action: Action, output: ActionOutput<string, ActionResult>): string {
  const { result } = output;
  const runtimeFailure = "kind" in result && result.kind === "runtime_failure";
  const evidence = runtimeFailure ? `runtime failure: ${result.error}` : foldMarkdown(action.formatResult(result));
  const interruptions = output.interruptions?.length ? `; interrupted by ${output.interruptions.join(" | ")}` : "";
  return `${action.name} ${result.status} in ${output.durationMs} ms; ${evidence}${interruptions}`;
}

/** An action's Markdown report as one log line: bullets become clauses, emphasis is dropped. */
function foldMarkdown(markdown: string): string {
  return markdown
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s+/u, "").replace(/\*\*|`/gu, ""))
    .filter((line) => line.length > 0)
    .join("; ");
}

/** Runtime behavior stays the same; only explicitly requested evidence survives the trial. */
function runtimeOptions(session: NodeClientSession, artifacts: string | undefined, incidents: string): MinecraftRuntimeOptions {
  const worldId = session.scenario.name ?? "scenario";
  return {
    incidents: { directory: incidents },
    botData: {
      // Repeated trials use in-memory SQLite. Persist the chronology only
      // when the host's evidence switch is enabled for an investigation.
      storage: artifacts ? { kind: "persistent", root: path.join(artifacts, "bot-data") } : { kind: "temporary" },
      identity: { worldId, scope: { kind: "bot", botId: session.username } },
    },
    onDisconnect: (reason) => session.log(`runtime disconnected: ${reason}`),
    // A scenario that shows the pinned watch shortens its ten minutes to seconds.
    ...(typeof session.scenario.params?.pinnedWindowMs === "number" && { pinned: { windowMs: session.scenario.params.pinnedWindowMs } }),
  };
}

/**
 * Load test behavior separately so scenarios can choose different logic while
 * sharing this host's bot setup, runtime lifetime and action recording.
 * Ordinary scenarios all select single-action.ts and vary their YAML action,
 * input and goals; only custom logic needs another driver module. Each module
 * exports run(context), which receives scenario data and recorded action calls.
 */
async function loadDriver(file: string): Promise<ScenarioRun> {
  const absolutePath = path.resolve(process.cwd(), file);
  const module = (await import(pathToFileURL(absolutePath).href)) as Record<string, unknown>;
  const { run } = module;
  if (typeof run !== "function") throw new Error(`scenario driver '${file}' must export run(context)`);
  return run as ScenarioRun;
}
