import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as mineLabs from "mine-labs";
import * as goalRunner from "../../../node_modules/mine-labs/src/trial/run.ts";
import * as goals from "../../../node_modules/mine-labs/src/trial/goals.ts";
import { preparePlayerForTrial } from "../../../node_modules/mine-labs/src/player/prepare.ts";
import { createFakeBot, createFakeClock, createFakeServer, type FakeClock } from "../../../src/test-support/fake-bot/index.js";

const NO_OP_REFUSAL = "Could not set the block";

/** Entity-data wording: Mine Labs prepare.test.ts; foodLevel measured in tsan-k5's Task 5 lane trace, 2026-11-15. */
async function prepareFood(options: { food?: number; foods?: readonly number[]; saturation?: readonly number[]; reused?: boolean; stopped?: boolean; cancel?: boolean }) {
  const clock = createFakeClock({ mode: "manual" });
  const abort = new AbortController();
  const commands = new RecordingRcon([], {
    "data get entity Actor foodLevel": (options.foods ?? [20, 18, 15]).map(food => `Actor has the following entity data: ${food}`),
    "data get entity Actor foodSaturationLevel": (options.saturation ?? [0]).map(saturation => `Actor has the following entity data: ${saturation}.0f`),
    "data get entity Actor Fire": ["Actor has the following entity data: -20s"],
    "data get entity Actor active_effects": ["Found no elements matching active_effects"],
  });
  const command = commands.command.bind(commands);
  const result = preparePlayerForTrial({
    commands: { command: name => name === "time query gametime" ? Promise.resolve(`The time is ${options.stopped ? 0 : Math.floor(clock.now() / 1_000) * 20}`) : command(name) },
    resetReusablePlayer: options.reused ?? false,
    player: { name: "Actor", inventory: [], op: false, food: options.food },
    goalStallMs: 1_000, signal: abort.signal, now: clock.now,
    sleep: async ms => { await clock.advance(ms); if (options.cancel) abort.abort("food cancelled"); },
  });
  return { sent: commands.sent, result, foodReads: () => commands.sent.filter(command => command.endsWith(" foodLevel")).length, elapsed: clock.now };
}

test("food preparation reaches the declared food with zero saturation, bounds failures and always releases hunger", async () => {
  const cases: { options: Parameters<typeof prepareFood>[0]; reads?: number; elapsed?: number; error?: RegExp }[] = [
    { options: { food: 15 }, reads: 3 },
    { options: { food: 15, reused: true }, reads: 3 },
    { options: { food: 0, foods: [0] }, reads: 1 },
    { options: { food: 20, foods: [20], saturation: [5, 0] }, reads: 2 },
    { options: {}, reads: 0 },
    { options: { food: 15, foods: [20] }, elapsed: 10_000, error: /food did not fall to 15 \(at 20\)/u },
    { options: { food: 15, foods: [20], stopped: true }, elapsed: 1_000, error: /food did not fall to 15 \(at 20\)/u },
    { options: { food: 15, foods: [20], cancel: true }, error: /food cancelled/u },
  ];
  for (const { options, reads, elapsed, error } of cases) {
    const fixture = await prepareFood(options);
    if (error) await assert.rejects(fixture.result, error);
    else await fixture.result;
    if (reads !== undefined) assert.equal(fixture.foodReads(), reads);
    if (elapsed !== undefined) assert.equal(fixture.elapsed(), elapsed, "200 ticks at 20 tps, or the independent wall stall bound");
    if (options.food === undefined) { assert.deepEqual(fixture.sent, []); continue; }
    assert.equal(fixture.sent.at(-1), "effect clear Actor minecraft:hunger");
    const dose = fixture.sent.indexOf("effect give Actor minecraft:hunger infinite 255 true");
    assert.ok(dose >= 0);
    if (options.reused) assert.ok(dose > fixture.sent.indexOf("effect give Actor minecraft:saturation 1 9 true"));
  }
});

/**
 * The commands a trial sends over RCON, in order. `setblock` answers as vanilla does: a block placed over air is
 * "Changed the block", the same block placed over itself, or air over air, is "Could not set the block" and fails
 * the command, which `executeChecked` accepts only when the caller names that answer as a no-op.
 */
class RecordingRcon {
  readonly sent: string[] = [];
  private readonly standing = new Map<string, string>();
  constructor(private readonly refused: readonly string[] = [], private readonly scriptedAnswers: Readonly<Record<string, readonly string[]>> = {}) {}
  private readonly reads = new Map<string, number>();
  async command(command: string): Promise<string> {
    this.sent.push(command);
    const read = this.reads.get(command) ?? 0;
    this.reads.set(command, read + 1);
    const answers = this.scriptedAnswers[command];
    return answers?.[Math.min(read, answers.length - 1)] ?? "";
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
  async playerDeaths(): Promise<number> { return 0; }
}

/** RCON answers measured by .tmp/probe/heal-order.ts, 2026-11-16 (scenario-lane-frame.md).
 * The restore lasts until the player's next tick, including while world time is frozen. */
// Scripted drain stopgap: hunger-restore.jsonl (2026-11-16), one trace/rate, both finish at 78 ticks.
// These are the measured reserve/food decrease ticks, not a model of arbitrary exhaustion histories.
const HUNGER_DRAIN_TICKS = {
  20: [3, 7, 10, 13, 16, 19, 22, 25, 28, 32, 35, 38, 41, 44, 47, 50, 53, 57, 60, 63, 66, 69, 72, 75, 78],
  10: [3, 6, 9, 13, 16, 19, 22, 25, 28, 31, 34, 38, 41, 44, 47, 50, 53, 56, 59, 63, 66, 69, 72, 75, 78],
} as const;

class PlayerVitalsRcon extends RecordingRcon {
  readonly server;
  health = 20;
  food = 20;
  saturation = 0;
  restorePending = false;
  neverConsume = false;
  ignoreDamage = false;
  hungry = false;
  private hungerTicks = 0;
  foodBeforeDose?: number;
  tickAnswers: (string | Error)[] = [];
  healthAnswer?: string;
  before?: (command: string) => void | Promise<void>;
  private readonly removeTick;
  constructor(readonly clock: FakeClock, rate: 20 | 10 = 20) {
    super();
    this.server = createFakeServer(clock, { ticksPerSecond: rate, startAge: 0 });
    this.removeTick = this.server.onTick(() => {
      if (this.restorePending && !this.neverConsume) {
        this.health = this.food = this.saturation = 20;
        this.restorePending = false;
      }
      if (this.hungry) this.hungerTicks += 1;
      if (this.hungry && HUNGER_DRAIN_TICKS[rate].some(tick => tick === this.hungerTicks)) {
        if (this.saturation > 0) this.saturation -= 1;
        else this.food = Math.max(0, this.food - 1);
      }
    });
  }
  [Symbol.dispose]() { this.removeTick(); this.server.stop(); }
  context() { return `fake ${this.clock.now()} ms, game tick ${this.server.gameTime}`; }
  override async command(command: string): Promise<string> {
    await super.command(command);
    await this.before?.(command);
    if (command === "time query gametime") {
      const answer = this.tickAnswers.length > 1 ? this.tickAnswers.shift() : this.tickAnswers[0];
      if (answer instanceof Error) throw answer;
      return answer ?? `The time is ${this.server.gameTime}`;
    }
    if (command.endsWith(" active_effects")) return this.restorePending
      ? 'Actor has the following entity data: [{duration: 1, show_icon: 0b, amplifier: 9b, id: "minecraft:saturation", show_particles: 0b}, {duration: 1, show_icon: 0b, amplifier: 9b, id: "minecraft:instant_health", show_particles: 0b}]'
      : "Found no elements matching active_effects";
    if (command.endsWith(" Fire")) return "Actor has the following entity data: -20s";
    if (command.endsWith(" Health")) return this.healthAnswer ?? `Actor has the following entity data: ${this.health.toFixed(1)}f`;
    if (command.endsWith(" foodLevel")) return `Actor has the following entity data: ${this.food}`;
    if (command.endsWith(" foodSaturationLevel")) return `Actor has the following entity data: ${this.saturation.toFixed(1)}f`;
    if (command.startsWith("damage ") && !this.ignoreDamage) this.health -= Number(command.split(" ")[2]);
    if (command === "effect give Actor minecraft:saturation 1 9 true") this.restorePending = true;
    if (command === "effect give Actor minecraft:hunger infinite 255 true") { this.foodBeforeDose = this.food; this.hungry = true; this.hungerTicks = 0; }
    if (command === "effect clear Actor minecraft:hunger") this.hungry = false;
    return "ok";
  }
}

/** Run the real preparation on the shared clock; production defaults are exercised separately below. */
function prepareVitals(rcon: PlayerVitalsRcon, options: {
  health?: number; food?: number; fresh?: boolean; signal?: AbortSignal; defaults?: boolean;
} = {}) {
  return preparePlayerForTrial({ commands: rcon, resetReusablePlayer: !options.fresh, dimension: "the_nether",
    player: { name: "Actor", inventory: [], op: false, pos: [0.5, -60, 0.5], health: options.health, food: options.food },
    signal: options.signal,
    ...(options.defaults ? {} : { now: rcon.clock.now, sleep: ms => rcon.clock.sleep(ms), goalStallMs: 1_000 }),
  });
}

for (const rate of [20, 10] as const) {
  test(`a reused declared wound survives the restore at ${rate} tps`, async () => {
    const clock = createFakeClock({ mode: "manual" });
    using rcon = new PlayerVitalsRcon(clock, rate);
    await clock.settle(prepareVitals(rcon, { health: 7 }), 1_000);
    await clock.advance(2_000 / rate);
    assert.equal(rcon.health, 7, rcon.context());
  });
  test(`a stopped restore fails without wounding or draining at ${rate} tps`, async () => {
    const clock = createFakeClock({ mode: "manual" });
    using rcon = new PlayerVitalsRcon(clock, rate);
    rcon.before = command => { if (command === "effect give Actor minecraft:saturation 1 9 true") rcon.server.stop(); };
    await clock.settle(assert.rejects(prepareVitals(rcon, { health: 7, food: 15 }), /restore was not applied \(at tick \d+\)/u), 1_100);
    assert.equal(rcon.sent.some(command => command.startsWith("damage ") || command.includes("hunger infinite")), false, rcon.context());
  });
}

for (const rate of [20, 10] as const) for (const food of [15, 20]) {
  test(`hungry reused bodies are restored before declared food ${food} is drained at ${rate} tps`, async () => {
    const clock = createFakeClock({ mode: "manual" });
    using rcon = new PlayerVitalsRcon(clock, rate);
    rcon.food = 10;
    let settled = false;
    const result = prepareVitals(rcon, { food }).then(() => { settled = true; });
    await clock.advance(63_000 / rate);
    assert.equal(settled, false, rcon.context());
    // hunger-restore probe, 2026-11-16: 78 ticks at both rates (n=1 each); worst x2.
    await clock.settle(result, 156_000 / rate);
    assert.equal(rcon.foodBeforeDose, 20, rcon.context());
    assert.equal(rcon.food, food, rcon.context());
    assert.equal(rcon.saturation, 0, rcon.context());
    assert.equal(rcon.hungry, false, rcon.context());
  });
}

test("restore tick bound permits the measured worst times two and fails on the next tick", async () => {
  const clock = createFakeClock({ mode: "manual" });
  using rcon = new PlayerVitalsRcon(clock);
  rcon.neverConsume = true;
  let settled = false;
  const rejection = assert.rejects(prepareVitals(rcon, { health: 7 }), /restore was not applied/u).then(() => { settled = true; });
  await clock.advance(100);
  assert.equal(rcon.server.gameTime, 2, rcon.context());
  assert.equal(settled, false, rcon.context());
  await clock.advance(50);
  await rejection;
  assert.equal(rcon.server.gameTime, 3, rcon.context());
});

test("restore tick reads tolerate malformed and rejected reads without resetting the stall baseline", async () => {
  for (const answers of [["bad", "The time is 1"], [new Error("tick unavailable"), "The time is 1"],
    ["bad"], [new Error("tick unavailable")], ["The time is 9007199254740992"], ["The time is 0", "bad"]]) {
    const clock = createFakeClock({ mode: "manual" });
    using rcon = new PlayerVitalsRcon(clock);
    rcon.tickAnswers = answers;
    const stalled = answers.length === 1 || answers[0] === "The time is 0";
    if (stalled) rcon.server.stop();
    const barrierTicks: number[] = [];
    if (!stalled) {
      // Deliberately delay consumption so malformed -> valid baseline -> valid progress are all observed.
      rcon.neverConsume = true;
      rcon.before = command => {
        if (command !== "time query gametime" || !rcon.restorePending) return;
        barrierTicks.push(rcon.server.gameTime);
        if (barrierTicks.length > 1) rcon.tickAnswers = [];
      };
      clock.after(150, () => { rcon.neverConsume = false; });
    }
    const result = prepareVitals(rcon, { health: 7 });
    if (stalled) {
      await clock.settle(assert.rejects(result, answers.length === 1 ? /at tick unknown/u : /at tick 0/u), 1_100);
      assert.equal(clock.now(), 1_000, rcon.context());
    } else {
      await clock.settle(result, 1_000);
      assert.deepEqual(barrierTicks, [0, 1, 2], rcon.context());
      await clock.advance(100);
      assert.equal(rcon.health, 7, rcon.context());
    }
  }
});

test("failed restore and wound reads propagate", async () => {
  for (const field of ["active_effects", "Health"]) {
    const clock = createFakeClock({ mode: "manual" });
    using rcon = new PlayerVitalsRcon(clock);
    rcon.before = command => { if (command.endsWith(` ${field}`)) throw new Error(`${field} unavailable`); };
    await clock.settle(assert.rejects(prepareVitals(rcon, { health: 7 }), new RegExp(`${field} unavailable`, "u")), 1_100);
  }
});

for (const [declared, answer, advanceTick, accepted] of [
    [7, "7.0f", false, true], [7, "8.0f", true, true], [7, "8.0f", false, false],
    [7, "8.5f", true, false], [7, "6.5f", false, false], [7, "0.0f", false, false],
    [7, "bad", false, false], [19, "20.0f", false, false], [1, "1.0f", false, true], [7.5, "7.5f", false, true],
  ] as const) {
  test(`wound ${declared} readback ${answer}, tick ${advanceTick}: accepted ${accepted}`, async () => {
    const clock = createFakeClock({ mode: "manual" });
    using rcon = new PlayerVitalsRcon(clock);
    rcon.healthAnswer = `Actor has the following entity data: ${answer}`;
    rcon.ignoreDamage = declared === 19;
    rcon.before = async command => { if (advanceTick && command.endsWith(" Health")) await clock.advance(50); };
    const result = prepareVitals(rcon, { health: declared, fresh: true });
    if (accepted) {
      await clock.settle(result, 1_000);
      assert.ok(rcon.sent.some(command => command.endsWith(" Health")), rcon.context());
    }
    else await clock.settle(assert.rejects(result, new RegExp(`health did not settle at ${declared} \\(at `, "u")), 1_000);
  });
}

for (const point of ["entry", "active_effects", "sleep", "final barrier", "Health", "before hunger", "hunger dose", "fresh teleport"]) {
  test(`preparation abort at ${point} leaves no delayed mutation or hunger`, async () => {
    const clock = createFakeClock({ mode: "manual" });
    using rcon = new PlayerVitalsRcon(clock);
    const abort = new AbortController();
    const reason = new Error(`abort at ${point}`);
    let stoppedAt = -1;
    const cancel = () => { abort.abort(reason); stoppedAt = rcon.sent.length; };
    if (point === "entry") cancel();
    if (point === "sleep") clock.after(25, cancel);
    rcon.before = command => {
      if ((point === "active_effects" && command.endsWith(" active_effects")) ||
        (point === "final barrier" && command.endsWith(" active_effects") && !rcon.restorePending) ||
        (point === "Health" && command.endsWith(" Health")) ||
        (point === "before hunger" && command === "effect clear Actor minecraft:saturation") ||
        (point === "hunger dose" && command === "effect give Actor minecraft:hunger infinite 255 true") ||
        (point === "fresh teleport" && command === "time query gametime" && rcon.sent.some(sent => sent.endsWith(" Health")))) cancel();
    };
    await clock.settle(assert.rejects(prepareVitals(rcon, { health: 7, food: point.includes("hunger") ? 15 : undefined,
      fresh: point === "fresh teleport", signal: abort.signal }), error => error === reason), 1_100);
    const sent = [...rcon.sent];
    const doseSent = sent.includes("effect give Actor minecraft:hunger infinite 255 true");
    assert.deepEqual(sent.slice(stoppedAt), doseSent ? ["effect clear Actor minecraft:hunger"] : [], `${point}: ${rcon.context()}`);
    await clock.advance(2_000);
    assert.deepEqual(rcon.sent, sent, rcon.context());
    assert.equal(rcon.hungry, false, rcon.context());
    assert.equal(clock.pendingTimers(), 0, rcon.context());
  });
}

test("undeclared reused health still waits for the restore without wounding or reading Health", async () => {
  const clock = createFakeClock({ mode: "manual" });
  using rcon = new PlayerVitalsRcon(clock);
  await clock.settle(prepareVitals(rcon), 1_000);
  assert.equal(rcon.sent.some(command => command.startsWith("damage ")), false, rcon.context());
  assert.equal(rcon.sent.some(command => command.endsWith(" Health")), false, rcon.context());
  assert.equal(rcon.sent.some(command => command.endsWith(" active_effects")), true, rcon.context());
});

test("default preparation clock observes a restore and bounds a stopped server at thirty seconds", async () => {
  for (const stopped of [false, true]) {
    const clock = createFakeClock({ mode: "mocked" });
    using _timers = clock.install();
    using rcon = new PlayerVitalsRcon(clock);
    if (stopped) rcon.server.stop();
    const result = prepareVitals(rcon, { health: 7, defaults: true });
    if (stopped) {
      await clock.settle(assert.rejects(result, /restore was not applied/u), 30_100);
      assert.equal(clock.now(), 30_000, rcon.context());
    } else {
      await clock.settle(result, 1_000);
      await clock.advance(100);
      assert.equal(rcon.health, 7, rcon.context());
    }
  }
});

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
    signal?: AbortSignal;
  },
) {
  const root = await mkdtemp(join(tmpdir(), "mine-labs-patch-trial-"));
  try {
    return await mineLabs.runScenarioTrial({
      server: neverStartedServer(join(root, "world"), rcon), scenario: options.scenario, runDir: root, log: () => {}, reuseServer: true, arena: options.arena,
      onArranged: options.onArranged, clientProvider: options.clientProvider, signal: options.signal,
      arrangeSettleMs: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("a lane whose arrangement fails ends in an error result, its tick blocks gone before the restore, never touching a neighbour", async () => {
  const rcon = new RecordingRcon(["bogus"]);
  let calls = 0;
  const result = await runLaneTrial(rcon, { arena: ARENA, scenario: scenario(["bogus"]), onArranged: () => { calls += 1; } });

  assert.equal(calls, 0, "failed arrangement never calls onArranged");
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
  const base = { server: neverStartedServer("unused", rcon), scenario: scenario(), runDir: "unused", log: () => {}, arena: ARENA, arrangeSettleMs: 0 };
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
test("the arrangement's settle wait is a parameter: arrangeSettleMs 0 waits 0 ms, nothing given waits the upstream 1500 ms", async () => {
  const waits: number[] = [];
  const root = await mkdtemp(join(tmpdir(), "mine-labs-patch-trial-"));
  try {
    // A recorder per trial: the second arrangement would find the first one's stone block standing and refuse it.
    const trial = { runDir: root, log: () => {}, reuseServer: true, arena: ARENA, settle: async (ms: number) => { waits.push(ms); } };
    await mineLabs.runScenarioTrial({ ...trial, server: neverStartedServer(join(root, "world"), new RecordingRcon()), scenario: scenario(), arrangeSettleMs: 0 });
    await mineLabs.runScenarioTrial({ ...trial, server: neverStartedServer(join(root, "world"), new RecordingRcon()), scenario: scenario() });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
  assert.deepEqual(waits, [0, 1500]);
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

test("a lane's arrangement clears its box twice before the setup: the second takes the loot the first one dropped", async () => {
  const rcon = new RecordingRcon();
  await runLaneTrial(rcon, { arena: ARENA, scenario: scenario(["setblock 1281 -59 1281 minecraft:stone"]) });

  const clearsBeforeSetup = rcon.sent.slice(0, rcon.sent.indexOf("setblock 1281 -59 1281 minecraft:stone")).filter((command) => command === BOXED_KILL);
  assert.equal(clearsBeforeSetup.length, 2);
});

// 2026-11-01 (plan 2026-10-30-contract-batch-timing T9): the entities of a chunk pinned again after it unloaded load some
// ticks after the pin (13-25 of 168 gap-run trials: 31 or 40 live zombies in the box after the restore's kills, killed by
// the next arrangement, their loot picked up by the next player). The kill that finds them all runs while the trial's own
// player keeps the chunks loaded, before the clients stop and before the restore pins the arena again.
test("a lane kills its box twice when its trial ends, before the restore starts", async () => {
  const rcon = new RecordingRcon();
  await runLaneTrial(rcon, { arena: ARENA, scenario: scenario(["setblock 1281 -59 1281 minecraft:stone"]) });

  const restoreStartsAt = rcon.sent.lastIndexOf(HEAD_REMOVAL);
  const killsBeforeRestore = rcon.sent.slice(0, restoreStartsAt).filter((command) => command === BOXED_KILL);
  assert.equal(killsBeforeRestore.length, 4, "two before the setup, two when the trial ended");
  assert.ok(rcon.sent.slice(restoreStartsAt).filter((command) => command === BOXED_KILL).length >= 2, "the restore still kills twice");
});

test("a lane's end-of-trial kill runs while its client is still running: the client's chunks are what keep the entities loaded", async () => {
  const rcon = new RecordingRcon();
  // A client that never says ready and leaves when the trial tells it to stop (the init message before it is ignored).
  const ahead = mineLabs.spawnClientAhead({ command: process.execPath, args: ["-e", "process.stdin.on('data', (d) => String(d).includes('\"stop\"') && process.exit(0)); setInterval(() => {}, 1e6)"], env: {} });
  void ahead.closed.then(() => rcon.sent.push("<client closed>"));
  const abort = new AbortController();
  // Cancelled once the trial launched the client: it waits for the client's `ready`, ends in its `finally` and stops the client there.
  const provider = () => (setTimeout(() => abort.abort("test"), 50), ahead);
  await runLaneTrial(rcon, { arena: ARENA, scenario: scenarioWithClient(), clientProvider: provider, signal: abort.signal });
  await ahead.closed;
  await Promise.resolve();

  const closedAt = rcon.sent.indexOf("<client closed>");
  assert.ok(closedAt >= 0, "the trial stopped its client");
  assert.equal(rcon.sent.slice(0, closedAt).filter((command) => command === BOXED_KILL).length, 4, "two before the setup, two before the client stopped");
});

test("a trial on a server of its own kills everywhere when it ends, before its restore starts (the same race, no lane)", async () => {
  const rcon = new RecordingRcon();
  await runLaneTrial(rcon, { scenario: scenario() });

  const restoreStartsAt = rcon.sent.lastIndexOf("reload");
  const killsBeforeRestore = rcon.sent.slice(0, restoreStartsAt).filter((command) => command === "kill @e[type=!minecraft:player]");
  assert.equal(killsBeforeRestore.length, 2, "one before the setup, one when the trial ended");
});

/** RCON's gametime wording was measured by the audit's section 6.3 prototype (scenario-ticks spec section 2). */
class GameTimeRcon extends RecordingRcon {
  private read = 0;
  constructor(private readonly answers: readonly (number | string | Error)[], private readonly onRead?: (read: number) => void, private readonly matches?: () => boolean) { super(); }
  async blockMatches(): Promise<boolean> { return this.matches?.() ?? false; }
  override async command(command: string): Promise<string> {
    if (command !== "time query gametime") return super.command(command);
    const answer = this.answers[Math.min(this.read++, this.answers.length - 1)]!;
    this.onRead?.(this.read);
    if (answer instanceof Error) throw answer;
    return typeof answer === "number" ? `The time is ${answer}` : answer;
  }
}

/** Drive the real settlement loop with scripted server reads and a monotonic wall clock, without a server or wall sleeps. */
async function settleGameTime(options: {
  answers: readonly (number | string | Error)[];
  wallStep?: number;
  stallMs?: number;
  survive?: boolean;
  cancelAfter?: number;
  cancelDuringRead?: number;
  completionOnCancel?: "succeeded" | "failed";
  initiallyCancelled?: boolean;
  cancelDuringObservation?: "goal" | "position";
}) {
  const abort = new AbortController();
  if (options.initiallyCancelled) abort.abort("before clock");
  let wall = 0;
  let polls = 0;
  const observations: string[] = [];
  const completions: Parameters<typeof goalRunner.awaitScenarioGoal>[0]["clients"]["completions"] = new Map();
  let reads = 0;
  const logs: string[] = [];
  const rcon = new GameTimeRcon(options.answers, (read) => {
    reads = read;
    if (read !== options.cancelDuringRead) return;
    abort.abort("during clock");
    if (options.completionOnCancel) completions.set("Walker", { status: options.completionOnCancel, detail: "test completion" });
  });
  if (options.cancelDuringObservation) {
    rcon.playerDeaths = async () => { if (options.cancelDuringObservation === "goal") abort.abort("during goal"); return 0; };
    const command = rcon.command.bind(rcon);
    rcon.command = async name => { if (options.cancelDuringObservation === "position" && name.endsWith(" Pos")) abort.abort("during position"); return command(name); };
  }
  const result = await goalRunner.awaitScenarioGoal({
    scenario: mineLabs.scenarioSchema.parse({
      name: "game-time", players: options.cancelDuringObservation ? [{ name: "Walker" }, { name: "Actor" }] : [{ name: "Walker" }], client: { command: "true" },
      goal: options.survive ? { kind: "survive", seconds: 1, timeout: 1 } : { kind: "completion", timeout: 1 },
    }),
    server: neverStartedServer("unused", rcon),
    clients: { processes: new Map(), chat: new Map(), completions },
    signal: abort.signal,
    goalStallMs: options.stallMs ?? 30_000,
    now: () => wall,
    sleep: async () => {
      wall += options.wallStep ?? 250;
      if (++polls === options.cancelAfter) abort.abort("observed pending");
    },
    onGoalProgress: (goal) => { observations.push(goal.state); },
    log: line => logs.push(line),
  });
  return { ...result, observations, wall, reads, logs, positions: rcon.sent.filter(command => command.endsWith(" Pos")) };
}

test("budget counts game ticks from the first readable sample, including after an unreadable start", async () => {
  for (const [answers, pending] of [[[100, 119, 120, 121], 3], [["", 100, 121], 2]] as const) {
    const result = await settleGameTime({ answers });
    assert.equal(result.outcome, "timeout");
    assert.match(result.log, /within 1s of game time \(20 ticks\)/u);
    assert.equal(result.observations.length, pending, "19/20 ticks and the late baseline must stay pending before 121");
  }
});

test("slow server is not timed out by the wall while game time moves", async () => {
  const result = await settleGameTime({ answers: [100, 100, 110], wallStep: 5_000, cancelAfter: 2 });
  assert.equal(result.outcome, "cancelled");
  assert.match(result.log, /observed pending/u);
  assert.equal(result.wall, 10_000);
});

test("stopped or unreadable game time ends the goal at the monotonic stall bound", async () => {
  for (const answer of [100, "Unknown command", new Error("rcon command timed out after 10000ms")]) {
    const result = await settleGameTime({ answers: [answer], stallMs: 1_000 });
    assert.equal(result.outcome, "timeout");
    assert.match(result.log, /stood still for 1000 ms/u);
    assert.equal(result.wall, 1_000);
  }
});

test("cancellation before or during a clock read wins over completion and the tick budget", async () => {
  const before = await settleGameTime({ answers: [100, 121], initiallyCancelled: true });
  const results = [before];
  for (const completionOnCancel of [undefined, "succeeded", "failed"] as const) {
    results.push(await settleGameTime({ answers: [100, 121], cancelDuringRead: 2, completionOnCancel }));
  }
  assert.deepEqual(results.map((result) => result.outcome), ["cancelled", "cancelled", "cancelled", "cancelled"]);
  assert.equal(before.reads, 0, "an already cancelled goal must not start an RCON request");
  for (const cancelDuringObservation of ["goal", "position"] as const) {
    const result = await settleGameTime({ answers: [100], survive: true, cancelDuringObservation });
    assert.equal(result.outcome, "cancelled");
    assert.deepEqual(result.positions, cancelDuringObservation === "goal" ? [] : ["data get entity Walker Pos"]);
    assert.match(result.logs.at(-1) ?? "", /^goal still spans:/u);
  }
});

test("survive counts game seconds: 19 ticks is pending, 20 passes", async () => {
  const result = await settleGameTime({ answers: [100, 119, 120], survive: true, wallStep: 5_000 });
  assert.equal(result.outcome, "pass");
  assert.deepEqual(result.observations, ["pending", "passed"]);
});

test("parseGameTime accepts a vanilla answer and refuses unreadable answers", () => {
  for (const [answer, expected] of [["The time is 2400", 2400], ["", null], ["Unknown command", null]] as const) {
    assert.equal(goalRunner.parseGameTime(answer), expected);
  }
});

/** The live cave reproduction reads a block over RCON after the client's success (T4, 2026-11-15). */
async function settleCompletion(options: { passingAt?: number; cancel?: boolean; stopped?: boolean; unreadableBaseline?: boolean; failedDuringRead?: boolean }) {
  const abort = new AbortController();
  let wall = 0;
  let tick = 0;
  let reads = 0;
  const logs: string[] = [];
  const completions: Parameters<typeof goalRunner.awaitScenarioGoal>[0]["clients"]["completions"] = new Map();
  if (!options.failedDuringRead) completions.set("Walker", { status: "succeeded" });
  const answers = options.stopped ? [100] : [100, 100, ...(options.unreadableBaseline ? ["unreadable"] : []), 200, 220, 239, 240];
  const rcon = new GameTimeRcon(answers, read => {
    reads = read;
    const answer = answers[Math.min(read - 1, answers.length - 1)]!;
    if (typeof answer === "number") tick = answer;
  }, () => {
    if (options.failedDuringRead) completions.set("Walker", { status: "failed", detail: "action failed during the goal read" });
    return tick >= (options.passingAt ?? Infinity);
  });
  const result = await goalRunner.awaitScenarioGoal({
    scenario: mineLabs.scenarioSchema.parse({
      name: "completion-settle", players: [{ name: "Walker" }], client: { command: "true" },
      goal: options.failedDuringRead
        ? { kind: "all", goals: [{ kind: "completion" }, { kind: "blockAt", pos: [0, 0, 0], block: "air" }] }
        : { kind: "blockAt", pos: [0, 0, 0], block: "air" },
    }),
    server: neverStartedServer("unused", rcon),
    clients: { processes: new Map(), chat: new Map(), completions },
    signal: abort.signal, goalStallMs: 1_000, now: () => wall,
    log: line => logs.push(line),
    sleep: async () => { wall += 250; if (options.cancel) abort.abort("during settle"); },
  });
  assert.match(logs.at(-1) ?? "", /^goal still spans: longest \d+ ticks at tick \d+$/u);
  return { ...result, tick, reads, wall };
}

test("completion re-reads after 40 fresh ticks, then passes or fails on the server's answer", async () => {
  for (const [passingAt, unreadableBaseline, outcome, wall] of [
    [240, false, "pass", 750], [240, true, "pass", 1_000], [undefined, false, "fail", 750],
  ] as const) {
    const result = await settleCompletion({ passingAt, unreadableBaseline });
    assert.equal(result.outcome, outcome);
    assert.equal(result.tick, 240);
    assert.equal(result.wall, wall);
    if (outcome === "fail") assert.match(result.log, /goal not satisfied on client completion/u);
  }
});

test("passing and terminally failed completions do not wait or read game time again", async () => {
  for (const [options, outcome] of [[{ passingAt: 100 }, "pass"], [{ failedDuringRead: true }, "fail"]] as const) {
    const result = await settleCompletion(options);
    assert.equal(result.outcome, outcome);
    assert.equal(result.reads, 2);
    assert.equal(result.wall, 0);
    if (outcome === "fail") assert.match(result.goal.detail, /Walker failed/u);
  }
});

test("abort during the completion settle cancels; a stopped clock times out", async () => {
  const cancelled = await settleCompletion({ cancel: true });
  assert.equal(cancelled.outcome, "cancelled");
  assert.match(cancelled.log, /during settle/u);
  const stopped = await settleCompletion({ stopped: true });
  assert.equal(stopped.outcome, "timeout");
  assert.match(stopped.log, /stood still for 1000 ms/u);
  assert.equal(stopped.wall, 1_000);
});

test("goal progress ignores survive elapsed time but retains death and every counted child", () => {
  const goal = mineLabs.scenarioSchema.parse({ client: { command: "true" }, goal: { kind: "all", goals: [{ kind: "survive", seconds: 5 }, { kind: "hasItem", item: "iron_ingot", count: 8 }] } }).goal;
  const result = (elapsed: number, count: number, alive = true): goals.GoalResult => ({ state: "pending", detail: `all pending: alive ${elapsed}/5s`, children: [
    { state: "pending", detail: `${alive ? "alive" : "dead"} ${elapsed}/5s` },
    { state: "pending", detail: `iron_ingot: ${count}/8` },
  ] });
  assert.equal(goals.progressKey(goal, result(3, 2)), goals.progressKey(goal, result(4, 2)));
  assert.notEqual(goals.progressKey(goal, result(4, 2)), goals.progressKey(goal, result(4, 3)));
  assert.notEqual(goals.progressKey(goal, result(4, 2)), goals.progressKey(goal, result(4, 2, false)));
});

test("goal progress logs block moves at most once per 20 game ticks and includes the terminal still span", async () => {
  const ticks = [100, 100, 110, 120, 130, 140, 150, 160, 180];
  // Measured .tmp/endpoint-before RCON Pos: <body> has the following entity data: [0.5d, -59.0d, 512.5d].
  const rcon = new RecordingRcon([], { "time query gametime": ticks.map(tick => `The time is ${tick}`), "data get entity Actor Pos": [
    "Actor has the following entity data: [1.5d, -60.0d, 2.5d]",
    "Actor has the following entity data: [1.9d, -60.0d, 2.9d]",
    "Actor has the following entity data: [1.5d, -60.0d, 3.5d]",
    "Actor has the following entity data: [1.5d, -60.0d, 3.5d]",
  ] });
  const logs: string[] = [];
  const result = await goalRunner.awaitScenarioGoal({
    scenario: mineLabs.scenarioSchema.parse({ client: { command: "true" }, players: [{ name: "Actor" }], goal: { kind: "survive", seconds: 4 } }),
    server: neverStartedServer("unused", rcon),
    clients: { processes: new Map(), chat: new Map(), completions: new Map() },
    now: () => 0, sleep: async () => {}, log: line => logs.push(line),
  });
  assert.equal(result.outcome, "pass");
  assert.deepEqual(logs.filter(line => line.startsWith("goal progress")), ["goal progress at tick 100", "goal progress at tick 140"]);
  assert.equal(logs.at(-1), "goal still spans: longest 40 ticks at tick 180");
  assert.equal(rcon.sent.filter(command => command.endsWith(" Pos")).length, 5);
});

/** RCON time and Pos use the measured wording cited by GameTimeRcon and the progress test above. */
async function settleStillGoal(options: { rate: number; stillTicks?: number; moveAt?: number; completeAt?: number; stopped?: boolean }) {
  const clock = createFakeClock({ mode: "manual" });
  const harness = createFakeBot({ clock, server: { startAge: 0, ticksPerSecond: options.rate } });
  if (options.stopped) harness.server.stop();
  const abort = new AbortController();
  const rcon = new RecordingRcon();
  const completions: Parameters<typeof goalRunner.awaitScenarioGoal>[0]["clients"]["completions"] = new Map();
  rcon.command = async command => {
    // The fake client reports completion at the first read at or after `completeAt` (the server's answer, not a timer).
    if (harness.server.gameTime >= (options.completeAt ?? Infinity)) completions.set("Actor", { status: "succeeded" });
    return command === "time query gametime"
      ? `The time is ${harness.server.gameTime}`
      : `Actor has the following entity data: [${harness.server.gameTime >= (options.moveAt ?? Infinity) ? 1.5 : 0.5}d, -60.0d, 0.5d]`;
  };
  const logs: string[] = [];
  const pendingTicks: number[] = [];
  const result = await clock.settle(goalRunner.awaitScenarioGoal({
    scenario: mineLabs.scenarioSchema.parse({
      client: { command: "true" }, players: [{ name: "Actor" }],
      goal: { kind: "completion", timeout: 120, ...(options.stillTicks === undefined ? {} : { stillTicks: options.stillTicks }) },
    }),
    server: neverStartedServer("unused", rcon),
    clients: { processes: new Map(), chat: new Map(), completions },
    now: clock.now, sleep: ms => clock.sleep(ms), signal: abort.signal,
    onGoalProgress: () => pendingTicks.push(harness.server.gameTime), log: line => logs.push(line),
  }), options.stopped ? 31_000 : 250_000, 250);
  const endedAt = harness.server.gameTime;
  const wall = clock.now();
  const logsAtEnd = [...logs];
  await clock.advance(31_000);
  assert.deepEqual(logs, logsAtEnd, "no work remains after settlement");
  assert.equal(clock.pendingTimers(), 0);
  return { ...result, tick: endedAt, wall, pendingTicks, logs };
}

/** The pacing fixture's own root override and its longest passing span (plan 2026-11-16-p1-reds T2: 1836 ticks at 20 tps, measured in `pacing-target.yaml`'s comment). */
const PACING_YAML = join(import.meta.dirname, "../scenarios/combat/pacing-target.yaml");
const PACING_LONGEST_SPAN = 1836;

test("a still goal uses the default or root override at both rates; a stopped server remains a timeout", async () => {
  const pacingStill = (await mineLabs.loadScenario(PACING_YAML)).goal.stillTicks;
  assert.ok(pacingStill !== undefined && pacingStill >= 2 * PACING_LONGEST_SPAN, `pacing-target.yaml sets stillTicks ${pacingStill}`);
  for (const rate of [20, 10]) {
    // Each row: the root override, the server tick at which the fake client reports completion (none: never), and the end the goal gets.
    for (const { stillTicks, completeAt, outcome, tick } of [
      { stillTicks: undefined, outcome: "fail", tick: 520 },
      { stillTicks: 40, outcome: "fail", tick: 40 },
      { stillTicks: 600, outcome: "fail", tick: 600 },
      { stillTicks: 600, completeAt: 580, outcome: "pass", tick: 580 },
      { stillTicks: 600, completeAt: 620, outcome: "fail", tick: 600 },
      // The pacing fixture: its override lets the longest measured span (1836 ticks) pass; the default 520 ended it (0/10 at 20 tps, 2026-11-16).
      { stillTicks: pacingStill, completeAt: PACING_LONGEST_SPAN, outcome: "pass", tick: PACING_LONGEST_SPAN },
      { stillTicks: undefined, completeAt: PACING_LONGEST_SPAN, outcome: "fail", tick: 520 },
    ] as const) {
      const label = `${rate} tps, stillTicks ${stillTicks}, completion at ${completeAt}`;
      const result = await settleStillGoal({ rate, stillTicks, completeAt });
      assert.equal(result.outcome, outcome, label);
      if (outcome === "pass") {
        // The goal reads the client's report at its next poll (250 ms of clock): within 20 ticks after the completion tick.
        assert.ok(result.tick >= tick && result.tick < tick + 20, `${label}: passes at tick ${result.tick}, fake time ${result.wall} ms`);
        assert.ok(result.wall >= tick * 1000 / rate, `${label}: passes at fake time ${result.wall} ms`);
      } else {
        assert.equal(result.tick, tick, label);
        assert.equal(result.wall, tick * 1000 / rate, `${label}: ends at fake time ${tick * 1000 / rate} ms`);
        assert.match(result.log, new RegExp(`no progress for ${tick} game ticks: Actor has not reported completion`), label);
      }
      if (stillTicks !== undefined || completeAt !== undefined) continue;
      assert.ok(result.pendingTicks.includes(rate === 20 ? 515 : 517), "one poll before the boundary stays pending");
    }
    const stopped = await settleStillGoal({ rate, stopped: true });
    assert.equal(stopped.outcome, "timeout");
    assert.match(stopped.log, /game time stood still for 30000 ms/u);
    assert.equal(stopped.wall, 30_000);
    assert.equal(stopped.tick, 0);
  }
});

test("a block move twenty ticks before the still boundary resets the deadline", async () => {
  for (const rate of [20, 10]) {
    const result = await settleStillGoal({ rate, moveAt: 500 });
    assert.equal(result.outcome, "fail");
    assert.equal(result.tick, 1_020);
    assert.match(result.log, /no progress for 520 game ticks/u);
    assert.deepEqual(result.logs.filter(line => line.startsWith("goal progress")), ["goal progress at tick 0", "goal progress at tick 500"]);
  }
});

test("stillTicks accepts positive root integers only", () => {
  const parse = (goal: unknown) => mineLabs.scenarioSchema.safeParse({ client: { command: "true" }, goal });
  for (const stillTicks of [1, 520]) assert.equal(parse({ kind: "completion", stillTicks }).success, true);
  for (const stillTicks of [0, -1, 1.5]) assert.equal(parse({ kind: "completion", stillTicks }).success, false);
  assert.equal(parse({ kind: "all", goals: [{ kind: "completion", stillTicks: 1 }] }).success, false);
});
