import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as mineLabs from "mine-labs";

const NO_OP_REFUSAL = "Could not set the block";

/**
 * The commands a trial sends over RCON, in order. `setblock` answers as vanilla does: a block placed over air is
 * "Changed the block", the same block placed over itself, or air over air, is "Could not set the block" and fails
 * the command, which `executeChecked` accepts only when the caller names that answer as a no-op.
 */
class RecordingRcon {
  readonly sent: string[] = [];
  private readonly standing = new Map<string, string>();
  constructor(private readonly refused: readonly string[] = []) {}
  async command(command: string): Promise<string> {
    this.sent.push(command);
    return "";
  }
  async executeChecked(command: string, options: { acceptedNoOp?: RegExp } = {}): Promise<string> {
    this.sent.push(command);
    if (this.refused.includes(command)) throw new Error(`refused: ${command}`);
    const placed = /^setblock (-?\d+ -?\d+ -?\d+) (\S+)/u.exec(command);
    if (!placed) return "";
    const [, position, block] = placed;
    const isAir = block === "minecraft:air";
    const before = this.standing.get(position!);
    const changes = isAir ? before !== undefined : before !== block;
    if (isAir) this.standing.delete(position!);
    else this.standing.set(position!, block!);
    if (changes) return "Changed the block";
    if (options.acceptedNoOp?.test(NO_OP_REFUSAL)) return NO_OP_REFUSAL;
    throw new Error(`setup command failed: ${command} → ${NO_OP_REFUSAL}`);
  }
  async playerOnline(): Promise<boolean> {
    return false;
  }
}

const ARENA = {
  id: "lane-3",
  entityBox: { minX: -512, minY: -64, minZ: 1280, maxX: 1535, maxY: 319, maxZ: 1791 },
  controlChunk: { x: -496, z: 1296 },
};
const BOXED_KILL = mineLabs.boxedClearEntities(ARENA.entityBox);
const HEAD_REMOVAL = "setblock -496 -63 1296 minecraft:air";
const TICK_TAIL = "setblock -495 -63 1296 minecraft:chain_command_block[facing=east]{Command:\"say two\",auto:1b,TrackOutput:0b}";

/** A resettable scenario with two tick commands, as a lane runs one; `setup` may name a command the server refuses. */
function scenario(setup: string[] = []) {
  return mineLabs.scenarioSchema.parse({
    name: "lane-trial",
    client: { command: "true" },
    reset: ["fill 1273 -59 1273 1289 -40 1289 air"],
    geometry: [{ setblock: { block: "stone", at: [1281, -59, 1281] } }],
    setup,
    tick: ["say one", "say two"],
    goal: { kind: "survive", seconds: 1 },
  });
}

function neverStartedServer(worldDir: string, rcon: RecordingRcon) {
  const server = new mineLabs.MinecraftServer(
    { version: "1.21.4", host: "127.0.0.1", worldDir, gamePort: 0, rconPort: 0, rconPassword: "x", worldType: "flat", structures: false, operators: [] },
    "unused.jar",
    () => {},
    { gamePort: 0, rconPort: 0, release() {} },
  );
  server.rcon = rcon as unknown as NonNullable<typeof server.rcon>;
  return server;
}

async function runLaneTrial(
  rcon: RecordingRcon,
  options: {
    arena?: typeof ARENA;
    scenario: ReturnType<typeof scenario>;
    onArranged?: () => void | Promise<void>;
    clientProvider?: mineLabs.ClientProvider;
  },
) {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-patch-trial-"));
  try {
    return await mineLabs.runScenarioTrial({
      server: neverStartedServer(join(root, "world"), rcon), scenario: options.scenario, runDir: root, log: () => {}, reuseServer: true, arena: options.arena,
      onArranged: options.onArranged, clientProvider: options.clientProvider,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a lane whose arrangement fails ends in an error result, its tick blocks gone before the restore, never touching a neighbour", async () => {
  const rcon = new RecordingRcon(["bogus"]);
  const result = await runLaneTrial(rcon, { arena: ARENA, scenario: scenario(["bogus"]) });

  assert.equal(result.outcome, "error");
  assert.match(result.error ?? "", /bogus/u, "the error is the setup command's, not a cleanup failure");
  const installAt = rcon.sent.indexOf(TICK_TAIL);
  const failedAt = rcon.sent.indexOf("bogus");
  const removals = rcon.sent.flatMap((command, index) => (command === HEAD_REMOVAL ? [index] : []));
  assert.ok(installAt >= 0 && installAt < failedAt, "tick blocks stand before the setup command that fails");
  assert.equal(removals.length, 2, "the failed arrangement stops the ticks at once, the restore removes them again");
  assert.ok(removals[0]! > failedAt);
  const restoreClone = rcon.sent.findIndex((command, index) => index > removals[1]! && command.startsWith("clone "));
  assert.ok(removals[1]! < restoreClone, "the restore removes the blocks before it clones the arena back");
  assert.ok(rcon.sent.includes(BOXED_KILL));
  assert.ok(rcon.sent.includes("forceload remove -496 1296 -495 1296"), "the control chunk pin is released");
  assert.equal(rcon.sent.includes("reload"), false);
  assert.equal(rcon.sent.includes("kill @e[type=!minecraft:player]"), false);
  assert.equal(rcon.sent.some((command) => command.includes("forceload remove all")), false);
  assert.equal(rcon.sent.some((command) => command.startsWith("gamerule commandModificationBlockLimit")), false);
});

test("a trial without arena options reloads its datapack, kills everywhere and releases every pin, as before", async () => {
  const rcon = new RecordingRcon(["bogus"]);
  await runLaneTrial(rcon, { scenario: scenario(["bogus"]) });

  assert.ok(rcon.sent.includes("reload"));
  assert.ok(rcon.sent.includes("kill @e[type=!minecraft:player]"));
  assert.ok(rcon.sent.includes("forceload remove all"));
  assert.ok(rcon.sent.includes("gamerule commandModificationBlockLimit 1000000"));
  assert.equal(rcon.sent.some((command) => command.includes("command_block")), false);
});

test("a lane trial the lane cannot honour is refused before the world is touched", async () => {
  const rcon = new RecordingRcon();
  const base = { server: neverStartedServer("unused", rcon), scenario: scenario(), runDir: "unused", log: () => {}, arena: ARENA };
  const nether = mineLabs.scenarioSchema.parse({ ...scenario(), world: { dimension: "the_nether" }, players: [{ name: "Walker", pos: [0, 70, 0] }] });
  await assert.rejects(mineLabs.runScenarioTrial(base), /lane-3.*reuseServer/u);
  await assert.rejects(mineLabs.runScenarioTrial({ ...base, reuseServer: true, holdPreparedWorld: true }), /lane-3.*spectator lanes/u);
  await assert.rejects(mineLabs.runScenarioTrial({ ...base, scenario: nether, reuseServer: true }), /lane-3.*overworld/u);
  assert.deepEqual(rcon.sent, []);
});

test("a lane's tick command RCON cannot carry fails the trial before the arena is snapshotted, naming the way out", async () => {
  const rcon = new RecordingRcon();
  const tooLong = mineLabs.scenarioSchema.parse({ ...scenario(), tick: [`say ${"x".repeat(1500)}`] });
  const result = await runLaneTrial(rcon, { arena: ARENA, scenario: tooLong });

  assert.equal(result.outcome, "error");
  assert.match(result.error ?? "", /tick command 1 needs a \d+-byte setblock.*shorten it/u);
  assert.equal(rcon.sent.some((command) => command.startsWith("clone ")), false);
});

test("onArranged is called once the setup commands all succeeded, after the snapshot and before the settle delay", async () => {
  const rcon = new RecordingRcon();
  let sentAtCall = -1;
  let calls = 0;
  await runLaneTrial(rcon, {
    arena: ARENA, scenario: scenario(["setblock 1281 -59 1281 minecraft:stone"]),
    onArranged: () => { calls += 1; sentAtCall = rcon.sent.length; },
  });

  const before = rcon.sent.slice(0, sentAtCall);
  assert.equal(calls, 1);
  assert.ok(before.some((command) => command.startsWith("clone ")), "the snapshot is taken before");
  assert.equal(before.at(-1), "setblock 1281 -59 1281 minecraft:stone", "every setup command ran before, and it is the last command sent");
  assert.equal(before.includes("forceload remove -496 1296 -495 1296"), false, "the arena pins are released after the call, the clients' join is what follows");
});

test("onArranged is not called when the arrangement throws", async () => {
  const rcon = new RecordingRcon(["bogus"]);
  let calls = 0;
  const result = await runLaneTrial(rcon, { arena: ARENA, scenario: scenario(["bogus"]), onArranged: () => { calls += 1; } });

  assert.equal(calls, 0);
  assert.equal(result.outcome, "error");
});

test("an onArranged that throws ends the trial as an error, the tick blocks stop and the restore runs", async () => {
  const rcon = new RecordingRcon();
  const result = await runLaneTrial(rcon, { arena: ARENA, scenario: scenario(), onArranged: async () => { throw new Error("mutex lost"); } });

  assert.equal(result.outcome, "error");
  assert.match(result.error ?? "", /mutex lost/u);
  const removals = rcon.sent.flatMap((command, index) => (command === HEAD_REMOVAL ? [index] : []));
  assert.equal(removals.length, 2, "the failed arrangement stops the ticks at once, the restore removes them again");
  assert.ok(rcon.sent.some((command, index) => index > removals[1]! && command.startsWith("clone ")), "the arena is cloned back");
  assert.ok(rcon.sent.includes("forceload remove -496 1296 -495 1296"), "the control chunk pin is released");
});
/** A scenario with one client; its player is never online, so a trial that gets past the launch would wait for it. */
function scenarioWithClient() {
  return mineLabs.scenarioSchema.parse({ ...scenario(), players: [{ name: "Walker" }] });
}

test("a trial launches its client from the provider it was given, and a client dead at the handover ends it as an error with its stderr", async () => {
  const ahead = mineLabs.spawnClientAhead({ command: process.execPath, args: ["-e", "console.error(\"driver import failed\"); process.exit(3)"], env: {} });
  await ahead.closed;
  const asked: string[] = [];
  const rcon = new RecordingRcon();
  const result = await runLaneTrial(rcon, {
    arena: ARENA, scenario: scenarioWithClient(), clientProvider: (spec, username) => (asked.push(username), ahead),
  });

  assert.deepEqual(asked, ["Walker"]);
  assert.equal(result.outcome, "error");
  assert.match(result.error ?? "", /client .Walker. exited with code 3 before it was handed over: driver import failed/u);
  assert.ok(rcon.sent.includes("forceload remove -496 1296 -495 1296"), "the lane is restored after the failed handover");
});

test("a provider that throws ends the trial as an error naming the client", async () => {
  const result = await runLaneTrial(new RecordingRcon(), {
    arena: ARENA, scenario: scenarioWithClient(), clientProvider: () => { throw new Error("pool is gone"); },
  });

  assert.equal(result.outcome, "error");
  assert.match(result.error ?? "", /client .Walker.: the client provider failed: pool is gone/u);
});
